package com.rynl10n

/** 2계층 resolve + ICU/CLDR 포맷팅 — 기획서 3.1. */
sealed class OverlayEntry {
    data class Value(val value: TranslationValue) : OverlayEntry()
    object Tombstone : OverlayEntry()
}

/** 오버레이 계층: locale → key → 값/tombstone. 델타를 번들 위에 적용한 sparse 결과. */
class OverlayLayer {
    private val map = mutableMapOf<String, MutableMap<String, OverlayEntry>>()

    fun set(locale: String, key: String, value: TranslationValue) {
        map.getOrPut(locale) { mutableMapOf() }[key] = OverlayEntry.Value(value)
    }
    fun tombstone(locale: String, key: String) {
        map.getOrPut(locale) { mutableMapOf() }[key] = OverlayEntry.Tombstone
    }
    fun get(locale: String, key: String): OverlayEntry? = map[locale]?.get(key)

    companion object {
        /** 델타 → 오버레이 계층(set=값, delete=tombstone). */
        fun from(delta: Delta): OverlayLayer {
            val o = OverlayLayer()
            for (op in delta.ops) {
                if (op.op == "set" && op.value != null) o.set(op.locale, op.key, op.value)
                else if (op.op == "delete") o.tombstone(op.locale, op.key)
            }
            return o
        }
    }
}

data class ResolveResult(
    val value: TranslationValue?,
    val source: String, // "overlay" | "bundle" | "unresolved"
    val matchedLocale: String?,
    val guardFallback: Boolean,
)

object Resolve {
    /** BCP 47 fallback 체인: 구체→일반 절단 + 기본 로케일. overrides로 명시적 부모 재지정(5.1). */
    fun fallbackChain(locale: String, defaultLocale: String, overrides: Map<String, String> = emptyMap()): List<String> {
        val chain = mutableListOf<String>()
        val seen = mutableSetOf<String>()
        var cur: String? = locale
        while (cur != null && cur !in seen) {
            seen.add(cur)
            chain.add(cur)
            val parent = overrides[cur]
            if (parent != null) { cur = parent; continue }
            val dash = cur.lastIndexOf('-')
            cur = if (dash > 0) cur.substring(0, dash) else null
        }
        if (defaultLocale !in seen) chain.add(defaultLocale)
        return chain
    }

    fun resolveValue(
        bundle: Snapshot,
        overlay: OverlayLayer,
        key: String,
        locale: String,
        localeOverrides: Map<String, String> = emptyMap(),
    ): ResolveResult {
        val chain = fallbackChain(locale, bundle.defaultLocale, localeOverrides)
        for (loc in chain) {
            val bundleVal = bundle.locales[loc]?.get(key)
            when (val entry = overlay.get(loc, key)) {
                is OverlayEntry.Tombstone -> continue // 삭제됨: 번들까지 가리고 다음 로케일
                is OverlayEntry.Value -> {
                    if (bundleVal != null && !Placeholder.matches(entry.value, bundleVal)) {
                        return ResolveResult(bundleVal, "bundle", loc, guardFallback = true) // 포맷 가드
                    }
                    return ResolveResult(entry.value, "overlay", loc, guardFallback = false)
                }
                null -> if (bundleVal != null) return ResolveResult(bundleVal, "bundle", loc, guardFallback = false)
            }
        }
        return ResolveResult(null, "unresolved", null, guardFallback = false)
    }

    // ── ICU named 치환 + CLDR 복수형(스파이크 최소 규칙) ─────────────────────

    fun format(value: TranslationValue, locale: String, args: Map<String, Any?> = emptyMap()): String =
        when (value) {
            is TranslationValue.Text -> substitute(value.value, args, null)
            is TranslationValue.Plural -> {
                val count = pickCount(args)
                val cat = pluralCategory(locale, count)
                substitute(value.map[cat] ?: value.map["other"] ?: "", args, count)
            }
        }

    private fun pluralCategory(locale: String, n: Int): String {
        val lang = locale.lowercase().substringBefore('-')
        if (lang in listOf("ko", "ja", "zh", "vi", "th", "id", "ms")) return "other"
        if (lang in listOf("en", "de", "nl", "sv", "da", "no", "es", "it", "pt")) return if (n == 1) "one" else "other"
        return "other"
    }

    private val SUB = Regex(Icu.SIMPLE_ARG)

    private fun substitute(template: String, args: Map<String, Any?>, count: Int?): String {
        var out = SUB.replace(template) { m ->
            val name = m.groupValues[1]
            if (args.containsKey(name)) stringOf(args[name]) else "{$name}"
        }
        if (count != null) out = out.replace("#", count.toString())
        return out
    }

    private fun pickCount(args: Map<String, Any?>): Int {
        for (name in listOf("count", "n")) intOf(args[name])?.let { return it }
        for (v in args.values) intOf(v)?.let { return it }
        return 0
    }

    private fun intOf(v: Any?): Int? = when (v) {
        is Int -> v
        is Long -> v.toInt()
        is Double -> if (v == Math.floor(v)) v.toInt() else null
        else -> null
    }

    private fun stringOf(v: Any?): String = when (v) {
        null -> ""
        is Double -> if (v == Math.floor(v)) v.toLong().toString() else v.toString()
        else -> v.toString()
    }
}
