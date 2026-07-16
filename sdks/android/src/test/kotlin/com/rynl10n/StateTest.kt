package com.rynl10n

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** StateFlow 바인딩 검증 — 카탈로그 갱신 시 version 증가. */
class StateTest {
    @Test fun versionBumpsOnUpdate() {
        val bundle = Snapshot(1, "R1", "b0", "en", mapOf("en" to mapOf("greet" to TranslationValue.Text("Hello"))))
        val store = InMemoryDeliveryStore()
        store.put(Delta(1, "R1", "b0", "b1", listOf(DeltaOp("set", "greet", "en", TranslationValue.Text("Hi")))), "releases/R1/delta-b0-b1.json")
        val manifest = Manifest(1, "p", "en", "T", listOf(
            ManifestRelease("R1", ReleaseState.PUBLISHED, VersionMatch("semver-range", ">=1.0.0"), "b0", "b1", 100, "releases/R1/snapshot-b0.json", "releases/R1/delta-b0-b1.json")))

        val state = RynL10nState(RynL10nClient(bundle, store, Matching.ClientContext(appVersion = "1.0.0")))
        assertEquals(0, state.version.value)
        assertEquals("Hello", state.t("greet"))
        state.refresh(manifest)
        assertEquals(1, state.version.value)   // 갱신 → version 증가(Compose 리컴포지션)
        assertEquals("Hi", state.t("greet"))
    }
}
