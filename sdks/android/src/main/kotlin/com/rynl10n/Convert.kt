package com.rynl10n

/**
 * 네이티브 포맷 변환 (bake) — 기획서 5.3. Android는 `strings.xml`을 방출한다.
 * 플레이스홀더 `{name}` → `%1$s`(string)·`%1$d`(number) 위치 재매핑. 복수형 → <plurals>.
 * M0 TS 참조 구현과 fixtures/golden/convert.json로 정확 문자열 정합.
 */
object Convert {
    private val CLDR_ORDER = listOf("zero", "one", "two", "few", "many", "other")

    private data class Arg(val name: String, val type: String) // type: "string" | "number"
    private sealed class Token {
        data class Lit(val s: String) : Token()
        data class Ref(val name: String) : Token()
    }

    private val INNER = Regex("""^([A-Za-z0-9_]+)\s*(?:,\s*([a-z]+))?""")

    private fun tokenize(icu: String): Pair<List<Token>, List<Arg>> {
        val tokens = mutableListOf<Token>()
        val args = mutableListOf<Arg>()
        var i = 0
        val lit = StringBuilder()
        fun flush() { if (lit.isNotEmpty()) { tokens.add(Token.Lit(lit.toString())); lit.clear() } }
        while (i < icu.length) {
            val ch = icu[i]
            if (ch == '#') { flush(); tokens.add(Token.Ref("#")); i++; continue }
            if (ch == '{') {
                val end = icu.indexOf('}', i)
                if (end == -1) { lit.append(ch); i++; continue }
                val inner = icu.substring(i + 1, end).trim()
                val m = INNER.find(inner)
                if (m != null) {
                    val name = m.groupValues[1]
                    val type = if (m.groupValues[2] == "number") "number" else "string"
                    flush()
                    tokens.add(Token.Ref(name))
                    if (args.none { it.name == name }) args.add(Arg(name, type))
                    i = end + 1
                    continue
                }
            }
            lit.append(ch); i++
        }
        flush()
        return tokens to args
    }

    private fun orderedArgs(value: TranslationValue): List<Arg> {
        if (value is TranslationValue.Text) return tokenize(value.value).second
        val plural = (value as TranslationValue.Plural).map
        val seen = LinkedHashMap<String, String>()
        var countName: String? = null
        for (cat in CLDR_ORDER) {
            val s = plural[cat] ?: continue
            val (tokens, args) = tokenize(s)
            if (countName == null) (tokens.firstOrNull { it is Token.Ref } as? Token.Ref)?.let { countName = it.name }
            for (a in args) if (!seen.containsKey(a.name)) seen[a.name] = a.type
        }
        val result = mutableListOf<Arg>()
        when (countName) {
            null -> {}
            "#" -> result.add(Arg("#", "number"))
            else -> result.add(Arg(countName!!, "number"))
        }
        for ((name, type) in seen) if (name != countName) result.add(Arg(name, type))
        return result
    }

    private fun indexMap(args: List<Arg>): Map<String, Pair<Int, String>> {
        val map = LinkedHashMap<String, Pair<Int, String>>()
        args.forEachIndexed { i, a -> map[a.name] = (i + 1) to a.type }
        return map
    }

    private fun xmlEscape(s: String): String = s
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("\"", "&quot;").replace("'", "\\'")

    private fun androidName(key: String): String {
        var n = key.replace(Regex("[^A-Za-z0-9_]"), "_")
        if (n.isNotEmpty() && n[0].isDigit()) n = "_$n"
        return n
    }

    private fun androidValue(icu: String, idx: Map<String, Pair<Int, String>>): String {
        val (tokens, _) = tokenize(icu)
        val sb = StringBuilder()
        for (t in tokens) when (t) {
            is Token.Lit -> sb.append(xmlEscape(t.s))
            is Token.Ref -> {
                val info = idx[t.name]
                if (info != null) sb.append("%${info.first}\$${if (info.second == "number") "d" else "s"}")
                else sb.append(xmlEscape("{${t.name}}"))
            }
        }
        return sb.toString()
    }

    data class Result(val output: String, val warnings: List<String>)

    /** 한 로케일 카탈로그 → strings.xml 문자열. */
    fun toAndroidStringsXml(catalog: Map<String, TranslationValue>): Result {
        val warnings = mutableListOf<String>()
        val lines = mutableListOf("""<?xml version="1.0" encoding="utf-8"?>""", "<resources>")
        for (key in catalog.keys.sorted()) {
            val value = catalog.getValue(key)
            val name = androidName(key)
            if (name != key) warnings.add("키 \"$key\" → 리소스명 \"$name\"로 sanitize")
            val idx = indexMap(orderedArgs(value))
            if (value is TranslationValue.Plural) {
                lines.add("""  <plurals name="$name">""")
                for (cat in CLDR_ORDER) {
                    val s = value.map[cat] ?: continue
                    lines.add("""    <item quantity="$cat">${androidValue(s, idx)}</item>""")
                }
                lines.add("  </plurals>")
            } else {
                val text = (value as TranslationValue.Text).value
                lines.add("""  <string name="$name">${androidValue(text, idx)}</string>""")
            }
        }
        lines.add("</resources>")
        return Result(lines.joinToString("\n") + "\n", warnings)
    }
}
