import Foundation

/// 빌드타임에 구운 번들 스냅샷을 런타임에 로드한다 — 기획서 3.2 / 6.3 (차별점 ①의 마지막 구간).
///
/// `RynL10nBakePlugin`(또는 `rynl10n-bake` CLI)이 빌드마다 `snapshot.json` + `rynl10n.lock`을 타깃의
/// 리소스 번들에 넣는다. 이 파일은 그 산출물을 찾아 `Snapshot`으로 되돌리는 표준 경로다.
///
/// ```swift
/// let bundled = try Snapshot.baked(in: .module)   // 플러그인을 붙인 타깃에서 호출
/// ```
///
/// **`Bundle.module`은 리소스를 소유한 타깃 안에서만 쓸 수 있다** — 즉 SDK가 아니라 앱(소비) 타깃에서
/// 호출해야 한다. 그래서 번들을 인자로 받는다.
extension Snapshot {

    public enum BakedError: Error, Sendable, CustomStringConvertible {
        /// 번들에서 bake 산출물을 찾지 못함(플러그인 미연결이거나 vendored 스냅샷 누락).
        case notFound(bundle: String)
        /// 파일은 있으나 스냅샷으로 디코딩되지 않음.
        case malformed(path: String)

        public var description: String {
            switch self {
            case .notFound(let bundle):
                return """
                [rynl10n] \(bundle)에서 bake된 스냅샷을 찾지 못했습니다.
                확인: ① 타깃에 RynL10nBakePlugin이 연결됐는지 ② vendored 스냅샷이
                Sources/<Target>/rynl10n/release-snapshot.json 에 있는지(Xcode 앱 타깃이면 타깃 소스 어딘가의
                rynl10n/release-snapshot.json) ③ rynl10n.lock의 release·base와 일치하는 번들이 있는지.
                """
            case .malformed(let path):
                return "[rynl10n] 번들 스냅샷을 디코딩하지 못했습니다: \(path)"
            }
        }
    }

    /// 번들에 구워진 스냅샷을 로드한다.
    ///
    /// lockfile이 있으면 release·base가 일치하는 번들만 고른다. 없으면 stable-name을 우선하고,
    /// 내용해시 파일은 하나뿐일 때만 선택한다(파일명·열거 순서는 최신 여부를 말해주지 않는다).
    public static func baked(in bundle: Bundle) throws -> Snapshot {
        guard let url = bakedURL(in: bundle) else {
            throw BakedError.notFound(bundle: bundle.bundleURL.lastPathComponent)
        }
        return try baked(contentsOf: url)
    }

    /// 파일 경로에서 직접 로드(vendored 스냅샷을 앱이 손수 배치한 경우).
    public static func baked(contentsOf url: URL) throws -> Snapshot {
        guard let data = try? Data(contentsOf: url),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) else {
            throw BakedError.malformed(path: url.path)
        }
        return snapshot
    }

    /// 번들 안의 bake 산출물 위치. 의도한 번들이 없거나 후보가 모호하면 nil.
    public static func bakedURL(in bundle: Bundle) -> URL? {
        let stable = [
            bundle.url(forResource: "snapshot", withExtension: "json", subdirectory: "rynl10n"),
            bundle.url(forResource: "snapshot", withExtension: "json"),
        ].compactMap { $0 }
        var hashed: [URL] = []
        for subdirectory in ["rynl10n", nil] as [String?] {
            for url in bundle.urls(forResourcesWithExtension: "json", subdirectory: subdirectory) ?? []
                where url.lastPathComponent.hasPrefix("snapshot-") && !hashed.contains(url) {
                hashed.append(url)
            }
        }
        if let lock = BakedLockfile.baked(in: bundle) {
            return (stable + hashed).first { url in
                guard let snapshot = try? baked(contentsOf: url) else { return false }
                return snapshot.base == lock.base && snapshot.release == lock.release
            }
        }
        return stable.first ?? (hashed.count == 1 ? hashed.first : nil)
    }
}

/// bake lockfile(`rynl10n.lock`) 판독 — 번들 선택과 빌드 진단의 release·base 기준.
public struct BakedLockfile: Decodable, Sendable, Equatable {
    public let schemaVersion: Int
    public let release: String
    public let base: String
    public let keyCount: Int
    public let locales: [String]

    /// 번들에 함께 구워진 `rynl10n.lock`을 읽는다. 없으면 nil.
    public static func baked(in bundle: Bundle) -> BakedLockfile? {
        let url = bundle.url(forResource: "rynl10n", withExtension: "lock", subdirectory: "rynl10n")
            ?? bundle.url(forResource: "rynl10n", withExtension: "lock")
        guard let url, let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(BakedLockfile.self, from: data)
    }
}
