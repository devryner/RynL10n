package com.rynl10n

/** 플레이스홀더 서명 & 포맷 안전 가드 — 기획서 3.1 / 5.3. */
object Placeholder {
    private val RE = Regex(
        """\{\s*([A-Za-z0-9_]+)\s*(?:,\s*(plural|selectordinal|select|number|date|time|spellout|ordinal|duration))?"""
    )

    fun signature(value: TranslationValue): String {
        val args = mutableMapOf<String, String>()
        when (value) {
            is TranslationValue.Text -> collect(value.value, args)
            is TranslationValue.Plural -> value.map.keys.sorted().forEach { collect(value.map.getValue(it), args) }
        }
        return args.keys.sorted().joinToString(",") { "$it:${args.getValue(it)}" }
    }

    fun matches(a: TranslationValue, b: TranslationValue): Boolean = signature(a) == signature(b)

    private fun collect(icu: String, args: MutableMap<String, String>) {
        for (m in RE.findAll(icu)) {
            val name = m.groupValues[1]
            val type = m.groupValues[2].ifEmpty { "simple" }
            val prev = args[name]
            if (prev == null) args[name] = type
            else if (prev != type) args[name] = "$prev|$type"
        }
    }
}
