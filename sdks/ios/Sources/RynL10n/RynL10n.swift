import Foundation

/// 배포 플레인(CDN/스토리지)의 정적 파일 접근 추상화. SDK 런타임은 관리 API를 절대 호출하지 않음(플레인 분리).
public protocol DeliveryStore: Sendable {
    func snapshot(_ path: String) -> Snapshot?
    func delta(_ path: String) -> Delta?
}

/// 테스트/오프라인용 인메모리 배포 저장소.
public final class InMemoryDeliveryStore: DeliveryStore, @unchecked Sendable {
    private var snapshots: [String: Snapshot] = [:]
    private var deltas: [String: Delta] = [:]
    public init() {}
    public func put(snapshot: Snapshot, at path: String) { snapshots[path] = snapshot }
    public func put(delta: Delta, at path: String) { deltas[path] = delta }
    public func snapshot(_ path: String) -> Snapshot? { snapshots[path] }
    public func delta(_ path: String) -> Delta? { deltas[path] }
}

public struct UpdateInfo: Sendable { public let release: String; public let overlayTarget: String }
public struct ClientStatus: Sendable {
    public let selection: String
    public let releaseId: String?
    public let activeBase: String
    public let overlayTarget: String?
}

/// RynL10n SDK 런타임 — 기획서 6.1 / 6.4.
/// 부팅 시 번들 즉시 로드(네트워크 대기 없음), `t`는 항상 번들 fallback이 있어 동기.
public final class RynL10nClient: @unchecked Sendable {
    private let bundle: Snapshot
    private let store: DeliveryStore
    private let context: Matching.ClientContext
    private let localeOverrides: [String: String]
    private let installId: String?      // 카나리(8.4) — 서버 미전송
    private let telemetryMode: String   // "off" | "aggregate"

    private var activeBundle: Snapshot
    private var overlay = OverlayLayer()
    private var selection: Matching.Selection = .bundleOnly
    private var overlayTarget: String?
    private var listeners: [(UpdateInfo) -> Void] = []
    private var tel = TelemetryCounts()
    private let lock = NSLock()

    public init(bundle: Snapshot, store: DeliveryStore, context: Matching.ClientContext,
                localeOverrides: [String: String] = [:], installId: String? = nil, telemetry: String = "off") {
        self.bundle = bundle
        self.store = store
        self.context = context
        self.localeOverrides = localeOverrides
        self.installId = installId
        self.telemetryMode = telemetry
        self.activeBundle = bundle
    }

    /// 이 클라이언트의 버전 매칭 컨텍스트(앱 버전·빌드넘버 등).
    /// 원격 갱신기(`RemoteDeliveryStore.update`)가 **받아야 할 산출물을 미리 고르기 위해** 읽는다 —
    /// 릴리스 선택 규칙이 클라이언트 안에만 있으면 갱신기가 불필요한 스냅샷까지 내려받게 된다.
    public var clientContext: Matching.ClientContext { context }

    /// 배포 건전성 익명 집계 카운트(9.3).
    public struct TelemetryCounts: Sendable, Equatable {
        public var overlayApplied = 0, formatGuardRejected = 0, keyUnresolved = 0, deltaFailed = 0
    }
    private func bump(_ kp: WritableKeyPath<TelemetryCounts, Int>) {
        guard telemetryMode == "aggregate" else { return }
        lock.lock(); tel[keyPath: kp] += 1; lock.unlock()
    }
    /// 누적 텔레메트리 카운트 반환 + 리셋(옵트인 리포터가 배치 전송).
    public func drainTelemetry() -> TelemetryCounts {
        lock.lock(); defer { tel = TelemetryCounts(); lock.unlock() }
        return tel
    }

    @discardableResult
    public func onCatalogUpdated(_ listener: @escaping (UpdateInfo) -> Void) -> Int {
        lock.lock(); defer { lock.unlock() }
        listeners.append(listener)
        return listeners.count - 1
    }

    /// manifest 갱신 사이클(6.4). 실패는 조용히 이전 상태 유지 — 화면 번역은 절대 깨지지 않음.
    @discardableResult
    public func refresh(manifest: Manifest) -> Bool {
        let sel = Matching.selectRelease(manifest.releases, context)
        lock.lock(); selection = sel; lock.unlock()

        switch sel {
        case .bundleOnly:
            return swap(bundle: bundle, overlay: OverlayLayer(), releaseId: nil, overlayTarget: nil)
        case .matched(let release), .nearestLower(let release):
            // 1) 활성 번들 결정
            var active = bundle
            if release.base != bundle.base {
                guard let fetched = store.snapshot(release.snapshot) else { return false }
                active = fetched
            }
            // 2) 오버레이 결정
            if release.overlay == release.base || release.delta == nil {
                return swap(bundle: active, overlay: OverlayLayer(), releaseId: release.id, overlayTarget: release.base)
            }
            // 카나리 게이트(8.4): rollout 대상이 아니면 오버레이 미수신 → base만.
            if !Canary.inRollout(release.rollout, installId: installId, releaseId: release.id) {
                return swap(bundle: active, overlay: OverlayLayer(), releaseId: release.id, overlayTarget: release.base)
            }
            guard let deltaPath = release.delta, let d = store.delta(deltaPath) else { bump(\.deltaFailed); return false }
            guard d.from == active.base else { bump(\.deltaFailed); return false } // 체크섬 가드
            let changed = swap(bundle: active, overlay: OverlayLayer.from(delta: d), releaseId: release.id, overlayTarget: release.overlay)
            if changed { bump(\.overlayApplied) }
            return changed
        }
    }

    /// 동기 조회(6.1). 미해결 키는 개발 모드 표면화.
    public func t(_ key: String, args: [String: JSONValue] = [:], locale: String? = nil) -> String {
        lock.lock()
        let bundleRef = activeBundle
        let overlayRef = overlay
        lock.unlock()
        let loc = locale ?? context.releaseLabel ?? bundleRef.defaultLocale
        let r = Resolve.resolveValue(bundle: bundleRef, overlay: overlayRef, key: key, locale: loc, localeOverrides: localeOverrides)
        if r.guardFallback { bump(\.formatGuardRejected) }
        guard let value = r.value else { bump(\.keyUnresolved); return "⟪\(key)⟫" }
        return Resolve.format(value, locale: r.matchedLocale ?? loc, args: args)
    }

    public func resolve(_ key: String, locale: String) -> ResolveResult {
        lock.lock(); let b = activeBundle; let o = overlay; lock.unlock()
        return Resolve.resolveValue(bundle: b, overlay: o, key: key, locale: locale, localeOverrides: localeOverrides)
    }

    public func status() -> ClientStatus {
        lock.lock(); defer { lock.unlock() }
        return ClientStatus(selection: selection.kind, releaseId: selection.releaseId,
                            activeBase: activeBundle.base, overlayTarget: overlayTarget)
    }

    private func swap(bundle: Snapshot, overlay: OverlayLayer, releaseId: String?, overlayTarget: String?) -> Bool {
        lock.lock()
        let changed = bundle.base != activeBundle.base || overlayTarget != self.overlayTarget
        activeBundle = bundle
        self.overlay = overlay
        self.overlayTarget = overlayTarget
        let toNotify = listeners
        lock.unlock()
        if changed, let releaseId, let overlayTarget {
            let info = UpdateInfo(release: releaseId, overlayTarget: overlayTarget)
            for l in toNotify { l(info) }
        }
        return changed
    }
}
