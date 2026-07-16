import Foundation

/// 버전 매칭 · 범위 충돌 검사 · 클라이언트 릴리스 판정 — 기획서 4.3 / 8.2 / 11.3.
public enum Matching {
    struct Bound { let version: SemVer; let inclusive: Bool }
    struct Interval { let lower: Bound?; let upper: Bound? }

    static func interval(_ comparators: [SemVerParser.Comparator]) -> Interval {
        var lower: Bound?
        var upper: Bound?
        func tightenLower(_ b: Bound) {
            guard let cur = lower else { lower = b; return }
            let c = SemVerParser.compare(b.version, cur.version)
            if c > 0 || (c == 0 && !b.inclusive && cur.inclusive) { lower = b }
        }
        func tightenUpper(_ b: Bound) {
            guard let cur = upper else { upper = b; return }
            let c = SemVerParser.compare(b.version, cur.version)
            if c < 0 || (c == 0 && !b.inclusive && cur.inclusive) { upper = b }
        }
        for c in comparators {
            switch c.op {
            case ">=": tightenLower(Bound(version: c.version, inclusive: true))
            case ">": tightenLower(Bound(version: c.version, inclusive: false))
            case "<=": tightenUpper(Bound(version: c.version, inclusive: true))
            case "<": tightenUpper(Bound(version: c.version, inclusive: false))
            default:
                tightenLower(Bound(version: c.version, inclusive: true))
                tightenUpper(Bound(version: c.version, inclusive: true))
            }
        }
        return Interval(lower: lower, upper: upper)
    }

    static func overlaps(_ a: Interval, _ b: Interval) -> Bool {
        let lo = maxLower(a.lower, b.lower)
        let hi = minUpper(a.upper, b.upper)
        guard let lo, let hi else { return true }
        let c = SemVerParser.compare(lo.version, hi.version)
        if c < 0 { return true }
        if c > 0 { return false }
        return lo.inclusive && hi.inclusive
    }

    static func maxLower(_ a: Bound?, _ b: Bound?) -> Bound? {
        guard let a else { return b }
        guard let b else { return a }
        let c = SemVerParser.compare(a.version, b.version)
        if c != 0 { return c > 0 ? a : b }
        return a.inclusive ? b : a
    }
    static func minUpper(_ a: Bound?, _ b: Bound?) -> Bound? {
        guard let a else { return b }
        guard let b else { return a }
        let c = SemVerParser.compare(a.version, b.version)
        if c != 0 { return c < 0 ? a : b }
        return a.inclusive ? b : a
    }

    public struct ConflictInput { public let id: String; public let versionMatch: VersionMatch
        public init(id: String, versionMatch: VersionMatch) { self.id = id; self.versionMatch = versionMatch }
    }

    /// publish 충돌: 겹치는 semver 범위 또는 동일 exact-label. 반환은 충돌 id 쌍.
    public static func findRangeConflicts(_ releases: [ConflictInput]) -> [(String, String)] {
        var conflicts: [(String, String)] = []
        let semver = releases.filter { $0.versionMatch.strategy == "semver-range" }
        let intervals = semver.compactMap { r -> Interval? in
            guard let c = try? SemVerParser.parseRange(r.versionMatch.value) else { return nil }
            return interval(c)
        }
        if intervals.count == semver.count {
            for i in 0..<semver.count {
                for j in (i + 1)..<semver.count where overlaps(intervals[i], intervals[j]) {
                    conflicts.append((semver[i].id, semver[j].id))
                }
            }
        }
        var byLabel: [String: [String]] = [:]
        for r in releases where r.versionMatch.strategy == "exact-label" {
            byLabel[r.versionMatch.value, default: []].append(r.id)
        }
        for ids in byLabel.values where ids.count > 1 {
            for i in 1..<ids.count { conflicts.append((ids[0], ids[i])) }
        }
        // 정수 범위(M4): 자기 전략끼리만 구간 교집합 검사.
        let ints = releases.filter { $0.versionMatch.strategy == "integer-range" }
        let intIvs = ints.compactMap { r -> IntRange.Interval? in
            guard let c = try? IntRange.parse(r.versionMatch.value) else { return nil }
            return IntRange.interval(c)
        }
        if intIvs.count == ints.count {
            for i in 0..<ints.count {
                for j in (i + 1)..<ints.count where IntRange.overlaps(intIvs[i], intIvs[j]) {
                    conflicts.append((ints[i].id, ints[j].id))
                }
            }
        }
        return conflicts
    }

    // ── 클라이언트 릴리스 판정 (11.3) ──────────────────────────────────────────

    public struct ClientContext: Sendable {
        public var appVersion: String?
        public var releaseLabel: String?
        public var buildNumber: Int? // integer-range 후보 평가용(M4)
        public var matchPrerelease: Bool
        public var fallbackPolicy: FallbackPolicy
        public init(appVersion: String? = nil, releaseLabel: String? = nil, buildNumber: Int? = nil,
                    matchPrerelease: Bool = false, fallbackPolicy: FallbackPolicy = .bundleOnly) {
            self.appVersion = appVersion; self.releaseLabel = releaseLabel; self.buildNumber = buildNumber
            self.matchPrerelease = matchPrerelease; self.fallbackPolicy = fallbackPolicy
        }
    }

    public enum Selection {
        case matched(ManifestRelease)
        case nearestLower(ManifestRelease)
        case bundleOnly

        public var kind: String {
            switch self {
            case .matched: return "matched"
            case .nearestLower: return "nearest-lower"
            case .bundleOnly: return "bundle-only"
            }
        }
        public var releaseId: String? {
            switch self {
            case .matched(let r), .nearestLower(let r): return r.id
            case .bundleOnly: return nil
            }
        }
    }

    /// manifest에서 클라이언트에 맞는 릴리스를 판정.
    /// 후보 = published·superseded(draft·archived 제외) — 8.1 조정(11.3 정정 반영).
    public static func selectRelease(_ releases: [ManifestRelease], _ ctx: ClientContext) -> Selection {
        let serving = releases.filter { $0.state == .published || $0.state == .superseded }
        var matched: [ManifestRelease] = []
        for r in serving {
            if r.versionMatch.strategy == "exact-label" {
                if let label = ctx.releaseLabel, label == r.versionMatch.value { matched.append(r) }
            } else if r.versionMatch.strategy == "integer-range" {
                if let bn = ctx.buildNumber, IntRange.inRange(bn, r.versionMatch.value) { matched.append(r) }
            } else {
                guard let appVersion = ctx.appVersion,
                      let v = try? SemVerParser.parseVersion(appVersion),
                      let comps = try? SemVerParser.parseRange(r.versionMatch.value) else { continue }
                if SemVerParser.satisfies(v, comps, matchPrerelease: ctx.matchPrerelease) { matched.append(r) }
            }
        }
        if matched.count == 1 { return .matched(matched[0]) }
        if matched.count > 1 { return .matched(tiebreak(matched)) }

        if ctx.fallbackPolicy == .nearestLower, let appVersion = ctx.appVersion,
           let nl = nearestLower(serving, appVersion) {
            return .nearestLower(nl)
        }
        return .bundleOnly
    }

    static func tiebreak(_ candidates: [ManifestRelease]) -> ManifestRelease {
        func iv(_ r: ManifestRelease) -> Interval? {
            guard r.versionMatch.strategy == "semver-range",
                  let c = try? SemVerParser.parseRange(r.versionMatch.value) else { return nil }
            return interval(c)
        }
        return candidates.sorted { x, y in
            let lo = compareBound(iv(x)?.lower, iv(y)?.lower, side: .lower)
            if lo != 0 { return lo > 0 } // 더 높은 하한 = 더 좁음
            let hi = compareBound(iv(x)?.upper, iv(y)?.upper, side: .upper)
            if hi != 0 { return hi < 0 } // 더 낮은 상한 = 더 좁음
            return x.id > y.id // id 최신
        }.first!
    }

    enum Side { case lower, upper }
    static func compareBound(_ a: Bound?, _ b: Bound?, side: Side) -> Int {
        if a == nil && b == nil { return 0 }
        if a == nil { return side == .lower ? -1 : 1 }
        if b == nil { return side == .lower ? 1 : -1 }
        return SemVerParser.compare(a!.version, b!.version)
    }

    static func nearestLower(_ serving: [ManifestRelease], _ appVersion: String) -> ManifestRelease? {
        guard let v = try? SemVerParser.parseVersion(appVersion) else { return nil }
        var best: (r: ManifestRelease, upper: SemVer)?
        for r in serving where r.versionMatch.strategy == "semver-range" {
            guard let c = try? SemVerParser.parseRange(r.versionMatch.value),
                  let upper = interval(c).upper else { continue }
            if SemVerParser.compare(upper.version, v) <= 0 {
                if best == nil || SemVerParser.compare(upper.version, best!.upper) > 0 {
                    best = (r, upper.version)
                }
            }
        }
        return best?.r
    }
}
