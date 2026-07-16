package com.rynl10n

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonElement

/** 번역 값: 단순 문자열(ICU) 또는 CLDR 복수형 카테고리 맵 — 기획서 5 / 11. */
@Serializable(with = TranslationValueSerializer::class)
sealed class TranslationValue {
    data class Text(val value: String) : TranslationValue()
    data class Plural(val map: Map<String, String>) : TranslationValue()
}

/** string이면 Text, object면 Plural로 디코딩(모양 기반). */
object TranslationValueSerializer : KSerializer<TranslationValue> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("TranslationValue")

    override fun deserialize(decoder: Decoder): TranslationValue {
        val input = decoder as JsonDecoder
        return when (val el = input.decodeJsonElement()) {
            is JsonPrimitive -> if (el.isString) TranslationValue.Text(el.content)
                else error("TranslationValue: 예상치 못한 원시값 ${el.content}")
            is JsonObject -> TranslationValue.Plural(el.mapValues { (it.value as JsonPrimitive).content })
            else -> error("TranslationValue: 예상치 못한 형태")
        }
    }

    override fun serialize(encoder: Encoder, value: TranslationValue) {
        val out = encoder as JsonEncoder
        val el: JsonElement = when (value) {
            is TranslationValue.Text -> JsonPrimitive(value.value)
            is TranslationValue.Plural -> JsonObject(value.map.mapValues { JsonPrimitive(it.value) })
        }
        out.encodeJsonElement(el)
    }
}

@Serializable
data class Snapshot(
    val schemaVersion: Int,
    val release: String,
    val base: String,
    val defaultLocale: String,
    val locales: Map<String, Map<String, TranslationValue>>,
)

@Serializable
data class DeltaOp(
    val op: String, // "set" | "delete"
    val key: String,
    val locale: String,
    val value: TranslationValue? = null,
)

@Serializable
data class Delta(
    val schemaVersion: Int,
    val release: String,
    val from: String,
    val to: String,
    val ops: List<DeltaOp>,
)

@Serializable
data class VersionMatch(val strategy: String, val value: String)

@Serializable
enum class ReleaseState {
    @SerialName("draft") DRAFT,
    @SerialName("published") PUBLISHED,
    @SerialName("superseded") SUPERSEDED,
    @SerialName("archived") ARCHIVED,
}

@Serializable
data class ManifestRelease(
    val id: String,
    val state: ReleaseState,
    val versionMatch: VersionMatch,
    val base: String,
    val overlay: String,
    val rollout: Int,
    val snapshot: String,
    val delta: String? = null,
)

@Serializable
data class Manifest(
    val schemaVersion: Int,
    val project: String,
    val defaultLocale: String,
    val updatedAt: String,
    val releases: List<ManifestRelease>,
)

enum class FallbackPolicy(val wire: String) {
    NEAREST_LOWER("nearest-lower"),
    BUNDLE_ONLY("bundle-only"),
}
