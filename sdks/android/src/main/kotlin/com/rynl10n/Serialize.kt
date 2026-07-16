package com.rynl10n

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.security.MessageDigest
import java.text.Normalizer

/**
 * RFC 8785 JSON Canonicalization Scheme + 콘텐츠 해시 — 기획서 11.1.
 * M0 TS 참조 구현과 바이트 단위로 동일해야 한다(fixtures/golden로 검증).
 *
 * 구현: JS JSON.stringify와 동일한 문자열 이스케이프를 손수 방출하고, 객체 키를 UTF-16
 * 코드유닛 순으로 정렬한다(Kotlin String.compareTo는 UTF-16 char 비교 → JCS와 일치).
 */
object Jcs {
    fun canonicalString(value: JsonElement): String {
        val sb = StringBuilder()
        emit(value, sb)
        return sb.toString()
    }

    fun canonicalBytes(value: JsonElement): ByteArray =
        canonicalString(value).toByteArray(Charsets.UTF_8)

    private fun emit(value: JsonElement, sb: StringBuilder) {
        when (value) {
            is JsonNull -> sb.append("null")
            is JsonObject -> {
                sb.append('{')
                val keys = value.keys.sorted() // UTF-16 코드유닛 순
                var first = true
                for (k in keys) {
                    if (!first) sb.append(',')
                    first = false
                    emitString(k, sb)
                    sb.append(':')
                    emit(value.getValue(k), sb)
                }
                sb.append('}')
            }
            is JsonArray -> {
                sb.append('[')
                for ((i, el) in value.withIndex()) {
                    if (i > 0) sb.append(',')
                    emit(el, sb)
                }
                sb.append(']')
            }
            is JsonPrimitive -> {
                if (value.isString) {
                    emitString(value.content, sb)
                } else when (value.content) {
                    "true", "false", "null" -> sb.append(value.content)
                    else -> {
                        val asLong = value.content.toLongOrNull()
                        if (asLong != null) {
                            sb.append(asLong.toString())
                        } else {
                            val d = value.content.toDouble()
                            require(d.isFinite() && d == Math.floor(d)) {
                                "JCS: 비정수 number는 이 스파이크 범위 밖 (${value.content})"
                            }
                            sb.append(d.toLong().toString())
                        }
                    }
                }
            }
        }
    }

    /** JS JSON.stringify와 동일한 이스케이프(= JCS): 짧은 형태 + 소문자 \u00xx, 비ASCII 리터럴. */
    private fun emitString(raw: String, sb: StringBuilder) {
        val s = Normalizer.normalize(raw, Normalizer.Form.NFC)
        sb.append('"')
        for (ch in s) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\b' -> sb.append("\\b")
                '\t' -> sb.append("\\t")
                '\n' -> sb.append("\\n")
                '\u000C' -> sb.append("\\f")
                '\r' -> sb.append("\\r")
                else -> if (ch.code < 0x20) sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
            }
        }
        sb.append('"')
    }
}

/** 콘텐츠 해시 — SHA-256 소문자 hex, 파일 식별자는 앞 16 hex 절단. */
object ContentHash {
    const val FILE_ID_HEX = 16
    const val FILE_ID_HEX_EXTENDED = 20

    fun sha256Hex(value: JsonElement): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(Jcs.canonicalBytes(value))
        return digest.joinToString("") { "%02x".format(it) }
    }

    fun fileId(fullHash: String, taken: Set<String> = emptySet()): String {
        val short = fullHash.substring(0, FILE_ID_HEX)
        return if (short in taken) fullHash.substring(0, FILE_ID_HEX_EXTENDED) else short
    }

    /** 스냅샷 콘텐츠 해시 — 대상은 {release, defaultLocale, locales}뿐(base·createdAt 제외). */
    fun snapshotHash(release: String, defaultLocale: String, locales: JsonElement): String =
        sha256Hex(
            JsonObject(
                mapOf(
                    "release" to JsonPrimitive(release),
                    "defaultLocale" to JsonPrimitive(defaultLocale),
                    "locales" to locales,
                )
            )
        )
}
