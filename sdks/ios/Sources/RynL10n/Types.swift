import Foundation

/// 번역 값: 단순 문자열(ICU) 또는 CLDR 복수형 카테고리 맵 — 기획서 5 / 11.
public enum TranslationValue: Equatable, Sendable {
    case text(String)
    case plural([String: String])
}

extension TranslationValue: Decodable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) {
            self = .text(s)
        } else {
            self = .plural(try c.decode([String: String].self))
        }
    }
}

/// 스냅샷(전체 카탈로그) — 11.1.
public struct Snapshot: Decodable, Sendable {
    public let schemaVersion: Int
    public let release: String
    public let base: String
    public let defaultLocale: String
    public let locales: [String: [String: TranslationValue]]
}

/// 델타 연산 — 11.1.
public struct DeltaOp: Decodable, Sendable {
    public let op: String // "set" | "delete"
    public let key: String
    public let locale: String
    public let value: TranslationValue?
}

/// 델타(sparse) — 11.1.
public struct Delta: Decodable, Sendable {
    public let schemaVersion: Int
    public let release: String
    public let from: String
    public let to: String
    public let ops: [DeltaOp]
}

/// 버전 매칭 규칙 — 11.3.
public struct VersionMatch: Decodable, Sendable, Equatable {
    public let strategy: String // "semver-range" | "exact-label"
    public let value: String
}

public enum ReleaseState: String, Decodable, Sendable {
    case draft, published, superseded, archived
}

/// manifest 릴리스 엔트리 — 11.2.
public struct ManifestRelease: Decodable, Sendable {
    public let id: String
    public let state: ReleaseState
    public let versionMatch: VersionMatch
    public let base: String
    public let overlay: String
    public let rollout: Int
    public let snapshot: String
    public let delta: String?
}

/// 배포 manifest — 11.2.
public struct Manifest: Decodable, Sendable {
    public let schemaVersion: Int
    public let project: String
    public let defaultLocale: String
    public let updatedAt: String
    public let releases: [ManifestRelease]
}

/// 미매칭 fallback 정책 — 11.3.
public enum FallbackPolicy: String, Sendable {
    case nearestLower = "nearest-lower"
    case bundleOnly = "bundle-only"
}
