package com.rynl10n

/**
 * node-semver 부분집합 — 기획서 11.3.
 * 지원: 비교자 `>= > <= < =` + 공백 AND. 거부: `||`·`^`·`~`·x-range·hyphen-range.
 */
data class SemVer(
    val major: Int,
    val minor: Int,
    val patch: Int,
    val prerelease: List<PreId>,
) {
    sealed class PreId {
        data class Num(val value: Int) : PreId()
        data class Text(val value: String) : PreId()
    }

    val isPrerelease: Boolean get() = prerelease.isNotEmpty()
}

class SemVerException(message: String) : Exception(message)

object SemVerParser {
    private val CORE = Regex("""^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$""")
    private val COMPARATOR = Regex("""^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$""")

    fun parseVersion(input: String): SemVer {
        val m = CORE.matchEntire(input.trim()) ?: throw SemVerException("유효하지 않은 버전: \"$input\"")
        val pre = m.groupValues[4].takeIf { it.isNotEmpty() }?.split(".")?.map { id ->
            val n = id.toIntOrNull()
            if (n != null && n.toString() == id) SemVer.PreId.Num(n) else SemVer.PreId.Text(id)
        } ?: emptyList()
        return SemVer(m.groupValues[1].toInt(), m.groupValues[2].toInt(), m.groupValues[3].toInt(), pre)
    }

    fun compare(a: SemVer, b: SemVer): Int {
        if (a.major != b.major) return a.major.compareTo(b.major)
        if (a.minor != b.minor) return a.minor.compareTo(b.minor)
        if (a.patch != b.patch) return a.patch.compareTo(b.patch)
        val ap = a.prerelease; val bp = b.prerelease
        if (ap.isEmpty() && bp.isEmpty()) return 0
        if (ap.isEmpty()) return 1
        if (bp.isEmpty()) return -1
        for (i in 0 until minOf(ap.size, bp.size)) {
            val x = ap[i]; val y = bp[i]
            when {
                x is SemVer.PreId.Num && y is SemVer.PreId.Num -> if (x.value != y.value) return x.value.compareTo(y.value)
                x is SemVer.PreId.Num -> return -1
                y is SemVer.PreId.Num -> return 1
                x is SemVer.PreId.Text && y is SemVer.PreId.Text -> if (x.value != y.value) return x.value.compareTo(y.value)
            }
        }
        return ap.size.compareTo(bp.size)
    }

    data class Comparator(val op: String, val version: SemVer)

    fun parseRange(input: String): List<Comparator> {
        val raw = input.trim()
        if (raw.isEmpty()) throw SemVerException("빈 범위식")
        for (pat in listOf("||", "^", "~", " - ")) {
            if (raw.contains(pat)) throw SemVerException("미지원 범위 문법 \"$pat\"")
        }
        return raw.split(Regex("\\s+")).map { tok ->
            val m = COMPARATOR.matchEntire(tok) ?: throw SemVerException("미지원/유효하지 않은 비교자 \"$tok\"")
            Comparator(m.groupValues[1].ifEmpty { "=" }, parseVersion(m.groupValues[2]))
        }
    }

    fun satisfies(version: SemVer, comparators: List<Comparator>, matchPrerelease: Boolean = false): Boolean {
        if (version.isPrerelease) {
            if (!matchPrerelease) return false
            val tupleMatch = comparators.any {
                it.version.isPrerelease && it.version.major == version.major &&
                    it.version.minor == version.minor && it.version.patch == version.patch
            }
            if (!tupleMatch) return false
        }
        return comparators.all { c ->
            val cmp = compare(version, c.version)
            when (c.op) {
                ">=" -> cmp >= 0
                "<=" -> cmp <= 0
                ">" -> cmp > 0
                "<" -> cmp < 0
                else -> cmp == 0
            }
        }
    }

    fun versionInRange(version: String, range: String, matchPrerelease: Boolean = false): Boolean =
        satisfies(parseVersion(version), parseRange(range), matchPrerelease)
}
