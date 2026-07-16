package com.rynl10n

/** 정수(빌드 넘버) 범위 매칭 — M4. 포함 정수 하한/상한 정규화(정확한 인접 판정). */
object IntRangeMatch {
    data class Comparator(val op: String, val n: Int)
    data class Interval(val lower: Int?, val upper: Int?)

    class IntRangeException(message: String) : Exception(message)

    private val COMPARATOR = Regex("""^(>=|<=|>|<|=)?(-?\d+)$""")

    fun parse(input: String): List<Comparator> {
        val raw = input.trim()
        if (raw.isEmpty()) throw IntRangeException("빈 정수 범위식")
        for (pat in listOf("||", "^", "~", " - ")) if (raw.contains(pat)) throw IntRangeException("미지원 정수 범위 문법 \"$pat\"")
        return raw.split(Regex("\\s+")).map { tok ->
            val m = COMPARATOR.matchEntire(tok) ?: throw IntRangeException("유효하지 않은 정수 비교자 \"$tok\"")
            Comparator(m.groupValues[1].ifEmpty { "=" }, m.groupValues[2].toInt())
        }
    }

    fun interval(comparators: List<Comparator>): Interval {
        var lower: Int? = null
        var upper: Int? = null
        for (c in comparators) when (c.op) {
            ">=" -> if (lower == null || c.n > lower!!) lower = c.n
            ">" -> { val v = c.n + 1; if (lower == null || v > lower!!) lower = v }
            "<=" -> if (upper == null || c.n < upper!!) upper = c.n
            "<" -> { val v = c.n - 1; if (upper == null || v < upper!!) upper = v }
            else -> { if (lower == null || c.n > lower!!) lower = c.n; if (upper == null || c.n < upper!!) upper = c.n }
        }
        return Interval(lower, upper)
    }

    fun satisfies(n: Int, comparators: List<Comparator>): Boolean {
        val iv = interval(comparators)
        if (iv.lower != null && n < iv.lower!!) return false
        if (iv.upper != null && n > iv.upper!!) return false
        return true
    }

    fun inRange(n: Int, range: String): Boolean = satisfies(n, parse(range))

    fun overlaps(a: Interval, b: Interval): Boolean {
        val lo = if (a.lower == null) b.lower else if (b.lower == null) a.lower else maxOf(a.lower, b.lower)
        val hi = if (a.upper == null) b.upper else if (b.upper == null) a.upper else minOf(a.upper, b.upper)
        if (lo == null || hi == null) return true
        return lo <= hi
    }
}
