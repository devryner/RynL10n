package com.rynl10n

import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** 배포 플레인 정적 파일 접근 추상화. SDK 런타임은 관리 API를 절대 호출하지 않음(플레인 분리). */
interface DeliveryStore {
    fun snapshot(path: String): Snapshot?
    fun delta(path: String): Delta?
}

/** 테스트/오프라인용 인메모리 배포 저장소. */
class InMemoryDeliveryStore : DeliveryStore {
    private val snapshots = mutableMapOf<String, Snapshot>()
    private val deltas = mutableMapOf<String, Delta>()
    fun put(snapshot: Snapshot, path: String) { snapshots[path] = snapshot }
    fun put(delta: Delta, path: String) { deltas[path] = delta }
    override fun snapshot(path: String): Snapshot? = snapshots[path]
    override fun delta(path: String): Delta? = deltas[path]
}

data class UpdateInfo(val release: String, val overlayTarget: String)
data class ClientStatus(val selection: String, val releaseId: String?, val activeBase: String, val overlayTarget: String?)

/**
 * RynL10n SDK 런타임 — 기획서 6.1 / 6.4.
 * 부팅 시 번들 즉시 로드(네트워크 대기 없음), `t`는 항상 번들 fallback이 있어 동기.
 */
class RynL10nClient(
    private val bundle: Snapshot,
    private val store: DeliveryStore,
    private val context: Matching.ClientContext,
    private val localeOverrides: Map<String, String> = emptyMap(),
) {
    private val lock = ReentrantLock()
    private var activeBundle: Snapshot = bundle
    private var overlay = OverlayLayer()
    private var selection: Matching.Selection = Matching.Selection.BundleOnly
    private var overlayTarget: String? = null
    private val listeners = mutableListOf<(UpdateInfo) -> Unit>()

    fun onCatalogUpdated(listener: (UpdateInfo) -> Unit): Int = lock.withLock {
        listeners.add(listener); listeners.size - 1
    }

    /** manifest 갱신 사이클(6.4). 실패는 조용히 이전 상태 유지 — 화면 번역은 절대 깨지지 않음. */
    fun refresh(manifest: Manifest): Boolean {
        val sel = Matching.selectRelease(manifest.releases, context)
        lock.withLock { selection = sel }

        return when (sel) {
            is Matching.Selection.BundleOnly ->
                swap(bundle, OverlayLayer(), null, null)
            is Matching.Selection.Matched, is Matching.Selection.NearestLower -> {
                val release = (sel as? Matching.Selection.Matched)?.release
                    ?: (sel as Matching.Selection.NearestLower).release
                var active = bundle
                if (release.base != bundle.base) {
                    val fetched = store.snapshot(release.snapshot) ?: return false
                    active = fetched
                }
                if (release.overlay == release.base || release.delta == null) {
                    return swap(active, OverlayLayer(), release.id, release.base)
                }
                val d = store.delta(release.delta) ?: return false
                if (d.from != active.base) return false // 체크섬 가드
                swap(active, OverlayLayer.from(d), release.id, release.overlay)
            }
        }
    }

    /** 동기 조회(6.1). 미해결 키는 개발 모드 표면화. */
    fun t(key: String, args: Map<String, Any?> = emptyMap(), locale: String? = null): String {
        val (b, o) = lock.withLock { activeBundle to overlay }
        val loc = locale ?: context.releaseLabel ?: b.defaultLocale
        val r = Resolve.resolveValue(b, o, key, loc, localeOverrides)
        val value = r.value ?: return "⟪$key⟫"
        return Resolve.format(value, r.matchedLocale ?: loc, args)
    }

    fun resolve(key: String, locale: String): ResolveResult {
        val (b, o) = lock.withLock { activeBundle to overlay }
        return Resolve.resolveValue(b, o, key, locale, localeOverrides)
    }

    fun status(): ClientStatus = lock.withLock {
        ClientStatus(selection.kind, selection.releaseId, activeBundle.base, overlayTarget)
    }

    private fun swap(bundle: Snapshot, overlay: OverlayLayer, releaseId: String?, overlayTarget: String?): Boolean {
        val (changed, toNotify) = lock.withLock {
            val changed = bundle.base != activeBundle.base || overlayTarget != this.overlayTarget
            activeBundle = bundle
            this.overlay = overlay
            this.overlayTarget = overlayTarget
            changed to listeners.toList()
        }
        if (changed && releaseId != null && overlayTarget != null) {
            val info = UpdateInfo(releaseId, overlayTarget)
            toNotify.forEach { it(info) }
        }
        return changed
    }
}
