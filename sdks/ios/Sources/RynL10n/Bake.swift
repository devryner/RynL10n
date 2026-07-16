import Foundation

/// 빌드타임 자동 번들링 — bake 코어 (기획서 3.2 / 6.3, 차별점 ①).
/// 1차 산출물은 우리 스냅샷 JSON(SDK 번들). 커버리지 검증·base 무결성·lockfile을 담당.
/// 서버 fetch·마지막 캐시 fallback은 이 순수 코어를 감싸는 플러그인 계층이 처리.
public enum Bake {
    public struct CoverageGap: Equatable, Sendable {
        public let key: String
        public let presentIn: [String]
    }

    /// 기본 로케일 커버리지 검사: 다른 로케일엔 있으나 기본 로케일에 없는 키(3.1).
    public static func baseLocaleCoverage(_ snap: Snapshot) -> [CoverageGap] {
        let baseKeys = Set(snap.locales[snap.defaultLocale]?.keys ?? [String: TranslationValue]().keys)
        var gaps: [String: [String]] = [:]
        for (locale, keys) in snap.locales where locale != snap.defaultLocale {
            for key in keys.keys where !baseKeys.contains(key) {
                gaps[key, default: []].append(locale)
            }
        }
        return gaps.keys.sorted().map { CoverageGap(key: $0, presentIn: gaps[$0]!.sorted()) }
    }

    /// 스냅샷의 선언 base가 콘텐츠 해시와 일치하는가.
    public static func verifyBase(_ snap: Snapshot) -> (ok: Bool, expected: String) {
        let full = ContentHash.snapshotHash(release: snap.release, defaultLocale: snap.defaultLocale,
                                            locales: localesJson(snap))
        let expected = ContentHash.fileId(full)
        return (expected == snap.base, expected)
    }

    public struct Lockfile: Equatable, Sendable {
        public let schemaVersion: Int
        public let release: String
        public let base: String
        public let keyCount: Int
        public let locales: [String]
    }

    public static func buildLockfile(_ snap: Snapshot) -> Lockfile {
        var allKeys = Set<String>()
        for keys in snap.locales.values { allKeys.formUnion(keys.keys) }
        return Lockfile(schemaVersion: 1, release: snap.release, base: snap.base,
                        keyCount: allKeys.count, locales: snap.locales.keys.sorted())
    }

    /// lockfile 결정적 직렬화(JCS).
    public static func lockfileString(_ lock: Lockfile) -> String {
        JCS.canonicalString(.object([
            "schemaVersion": .int(lock.schemaVersion),
            "release": .string(lock.release),
            "base": .string(lock.base),
            "keyCount": .int(lock.keyCount),
            "locales": .array(lock.locales.map { .string($0) }),
        ]))
    }

    /// SDK가 읽는 번들 리소스 바이트(정규화 스냅샷).
    public static func bundleString(_ snap: Snapshot) -> String {
        JCS.canonicalString(snapshotJson(snap))
    }

    public enum BakeError: Error { case coverageGaps([CoverageGap]); case baseMismatch(String, String) }

    public struct Result {
        public let bundlePath: String
        public let bundle: String
        public let lockfile: Lockfile
        public let lockfileText: String
        public let warnings: [String]
    }

    /// bake 실행: 검증 → 산출. strict면 갭/무결성 위반 시 throw.
    public static func run(_ snap: Snapshot, strict: Bool = false) throws -> Result {
        var warnings: [String] = []
        let gaps = baseLocaleCoverage(snap)
        if !gaps.isEmpty {
            if strict { throw BakeError.coverageGaps(gaps) }
            warnings.append("기본 로케일(\(snap.defaultLocale)) 커버리지 갭 \(gaps.count)건: \(gaps.map(\.key).joined(separator: ", "))")
        }
        let base = verifyBase(snap)
        if !base.ok {
            if strict { throw BakeError.baseMismatch(snap.base, base.expected) }
            warnings.append("base 해시 불일치: 선언=\(snap.base) 실제=\(base.expected)")
        }
        let lock = buildLockfile(snap)
        return Result(bundlePath: "rynl10n/snapshot-\(snap.base).json", bundle: bundleString(snap),
                      lockfile: lock, lockfileText: lockfileString(lock), warnings: warnings)
    }

    // ── Snapshot/TranslationValue → JSONValue ────────────────────────────────
    static func snapshotJson(_ snap: Snapshot) -> JSONValue {
        .object([
            "schemaVersion": .int(snap.schemaVersion),
            "release": .string(snap.release),
            "base": .string(snap.base),
            "defaultLocale": .string(snap.defaultLocale),
            "locales": localesJson(snap),
        ])
    }
    static func localesJson(_ snap: Snapshot) -> JSONValue {
        .object(snap.locales.mapValues { keys in
            JSONValue.object(keys.mapValues { tvJson($0) })
        })
    }
    static func tvJson(_ v: TranslationValue) -> JSONValue {
        switch v {
        case .text(let s): return .string(s)
        case .plural(let m): return .object(m.mapValues { .string($0) })
        }
    }
}
