package com.rynl10n

/** 버전 매칭 · 범위 충돌 검사 · 클라이언트 릴리스 판정 — 기획서 4.3 / 8.2 / 11.3. */
object Matching {
    private data class Bound(val version: SemVer, val inclusive: Boolean)
    private data class Interval(val lower: Bound?, val upper: Bound?)

    private fun interval(comparators: List<SemVerParser.Comparator>): Interval {
        var lower: Bound? = null
        var upper: Bound? = null
        fun tightenLower(b: Bound) {
            val cur = lower
            if (cur == null) { lower = b; return }
            val c = SemVerParser.compare(b.version, cur.version)
            if (c > 0 || (c == 0 && !b.inclusive && cur.inclusive)) lower = b
        }
        fun tightenUpper(b: Bound) {
            val cur = upper
            if (cur == null) { upper = b; return }
            val c = SemVerParser.compare(b.version, cur.version)
            if (c < 0 || (c == 0 && !b.inclusive && cur.inclusive)) upper = b
        }
        for (c in comparators) when (c.op) {
            ">=" -> tightenLower(Bound(c.version, true))
            ">" -> tightenLower(Bound(c.version, false))
            "<=" -> tightenUpper(Bound(c.version, true))
            "<" -> tightenUpper(Bound(c.version, false))
            else -> { tightenLower(Bound(c.version, true)); tightenUpper(Bound(c.version, true)) }
        }
        return Interval(lower, upper)
    }

    private fun overlaps(a: Interval, b: Interval): Boolean {
        val lo = maxLower(a.lower, b.lower)
        val hi = minUpper(a.upper, b.upper)
        if (lo == null || hi == null) return true
        val c = SemVerParser.compare(lo.version, hi.version)
        if (c < 0) return true
        if (c > 0) return false
        return lo.inclusive && hi.inclusive
    }

    private fun maxLower(a: Bound?, b: Bound?): Bound? {
        if (a == null) return b
        if (b == null) return a
        val c = SemVerParser.compare(a.version, b.version)
        if (c != 0) return if (c > 0) a else b
        return if (a.inclusive) b else a
    }
    private fun minUpper(a: Bound?, b: Bound?): Bound? {
        if (a == null) return b
        if (b == null) return a
        val c = SemVerParser.compare(a.version, b.version)
        if (c != 0) return if (c < 0) a else b
        return if (a.inclusive) b else a
    }

    data class ConflictInput(val id: String, val versionMatch: VersionMatch)

    /** publish 충돌: 겹치는 semver 범위 또는 동일 exact-label. 반환은 충돌 id 쌍. */
    fun findRangeConflicts(releases: List<ConflictInput>): List<Pair<String, String>> {
        val conflicts = mutableListOf<Pair<String, String>>()
        val semver = releases.filter { it.versionMatch.strategy == "semver-range" }
        val intervals = semver.map { interval(SemVerParser.parseRange(it.versionMatch.value)) }
        for (i in semver.indices) for (j in i + 1 until semver.size) {
            if (overlaps(intervals[i], intervals[j])) conflicts.add(semver[i].id to semver[j].id)
        }
        val byLabel = mutableMapOf<String, MutableList<String>>()
        for (r in releases) if (r.versionMatch.strategy == "exact-label") {
            byLabel.getOrPut(r.versionMatch.value) { mutableListOf() }.add(r.id)
        }
        for (ids in byLabel.values) if (ids.size > 1) {
            for (i in 1 until ids.size) conflicts.add(ids[0] to ids[i])
        }
        // 정수 범위(M4): 자기 전략끼리만 구간 교집합 검사.
        val ints = releases.filter { it.versionMatch.strategy == "integer-range" }
        val intIvs = ints.map { IntRangeMatch.interval(IntRangeMatch.parse(it.versionMatch.value)) }
        for (i in ints.indices) for (j in i + 1 until ints.size) {
            if (IntRangeMatch.overlaps(intIvs[i], intIvs[j])) conflicts.add(ints[i].id to ints[j].id)
        }
        return conflicts
    }

    // ── 클라이언트 릴리스 판정 (11.3) ──────────────────────────────────────────

    data class ClientContext(
        val appVersion: String? = null,
        val releaseLabel: String? = null,
        val buildNumber: Int? = null, // integer-range 후보 평가용(M4)
        val matchPrerelease: Boolean = false,
        val fallbackPolicy: FallbackPolicy = FallbackPolicy.BUNDLE_ONLY,
    )

    sealed class Selection(val kind: String, val releaseId: String?) {
        class Matched(val release: ManifestRelease) : Selection("matched", release.id)
        class NearestLower(val release: ManifestRelease) : Selection("nearest-lower", release.id)
        object BundleOnly : Selection("bundle-only", null)
    }

    /** 후보 = published·superseded(draft·archived 제외) — 8.1 조정(11.3 정정 반영). */
    fun selectRelease(releases: List<ManifestRelease>, ctx: ClientContext): Selection {
        val serving = releases.filter { it.state == ReleaseState.PUBLISHED || it.state == ReleaseState.SUPERSEDED }
        val matched = mutableListOf<ManifestRelease>()
        for (r in serving) {
            if (r.versionMatch.strategy == "exact-label") {
                if (ctx.releaseLabel != null && ctx.releaseLabel == r.versionMatch.value) matched.add(r)
            } else if (r.versionMatch.strategy == "integer-range") {
                if (ctx.buildNumber != null && IntRangeMatch.inRange(ctx.buildNumber, r.versionMatch.value)) matched.add(r)
            } else {
                val appVersion = ctx.appVersion ?: continue
                val v = runCatching { SemVerParser.parseVersion(appVersion) }.getOrNull() ?: continue
                val comps = runCatching { SemVerParser.parseRange(r.versionMatch.value) }.getOrNull() ?: continue
                if (SemVerParser.satisfies(v, comps, ctx.matchPrerelease)) matched.add(r)
            }
        }
        if (matched.size == 1) return Selection.Matched(matched[0])
        if (matched.size > 1) return Selection.Matched(tiebreak(matched))

        if (ctx.fallbackPolicy == FallbackPolicy.NEAREST_LOWER && ctx.appVersion != null) {
            nearestLower(serving, ctx.appVersion)?.let { return Selection.NearestLower(it) }
        }
        return Selection.BundleOnly
    }

    private fun tiebreak(candidates: List<ManifestRelease>): ManifestRelease {
        fun iv(r: ManifestRelease): Interval? =
            if (r.versionMatch.strategy == "semver-range")
                runCatching { interval(SemVerParser.parseRange(r.versionMatch.value)) }.getOrNull()
            else null
        return candidates.sortedWith(Comparator { x, y ->
            val lo = compareBound(iv(x)?.lower, iv(y)?.lower, lower = true)
            if (lo != 0) return@Comparator -lo // 더 높은 하한 = 더 좁음
            val hi = compareBound(iv(x)?.upper, iv(y)?.upper, lower = false)
            if (hi != 0) return@Comparator hi // 더 낮은 상한 = 더 좁음
            y.id.compareTo(x.id) // id 최신
        }).first()
    }

    private fun compareBound(a: Bound?, b: Bound?, lower: Boolean): Int {
        if (a == null && b == null) return 0
        if (a == null) return if (lower) -1 else 1
        if (b == null) return if (lower) 1 else -1
        return SemVerParser.compare(a.version, b.version)
    }

    private fun nearestLower(serving: List<ManifestRelease>, appVersion: String): ManifestRelease? {
        val v = runCatching { SemVerParser.parseVersion(appVersion) }.getOrNull() ?: return null
        var best: Pair<ManifestRelease, SemVer>? = null
        for (r in serving) {
            if (r.versionMatch.strategy != "semver-range") continue
            val upper = runCatching { interval(SemVerParser.parseRange(r.versionMatch.value)).upper }.getOrNull() ?: continue
            if (SemVerParser.compare(upper.version, v) <= 0) {
                if (best == null || SemVerParser.compare(upper.version, best!!.second) > 0) best = r to upper.version
            }
        }
        return best?.first
    }
}
