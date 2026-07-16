package com.rynl10n

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** DoD ① — 시나리오 A/B/C를 public API(RynL10nClient)로 재현. */
class ScenarioTest {
    private fun snap(release: String, base: String, locales: Map<String, Map<String, TranslationValue>>) =
        Snapshot(1, release, base, "en", locales)
    private fun text(s: String) = TranslationValue.Text(s)

    @Test fun scenarioA_otaHotfix() {
        val v0 = snap("R42", "base0", mapOf("en" to mapOf("pay.button" to text("Pay")), "ja" to mapOf("pay.button" to text("支払―"))))
        val delta = Delta(1, "R42", "base0", "base1", listOf(DeltaOp("set", "pay.button", "ja", text("支払い"))))
        val store = InMemoryDeliveryStore()
        store.put(v0, "releases/R42/snapshot-base0.json")
        store.put(delta, "releases/R42/delta-base0-base1.json")

        val published = ManifestRelease("R42", ReleaseState.PUBLISHED,
            VersionMatch("semver-range", ">=3.2.0 <3.3.0"), "base0", "base1", 100,
            "releases/R42/snapshot-base0.json", "releases/R42/delta-base0-base1.json")
        val manifest = Manifest(1, "shop", "en", "T1", listOf(published))

        val client = RynL10nClient(v0, store, Matching.ClientContext(appVersion = "3.2.1"))
        var notified = 0
        client.onCatalogUpdated { notified++ }

        assertEquals("支払―", client.t("pay.button", locale = "ja"))
        assertTrue(client.refresh(manifest))
        assertEquals("支払い", client.t("pay.button", locale = "ja"))
        assertEquals(1, notified)

        val rolledBack = ManifestRelease("R42", ReleaseState.PUBLISHED,
            VersionMatch("semver-range", ">=3.2.0 <3.3.0"), "base0", "base0", 100,
            "releases/R42/snapshot-base0.json", null)
        client.refresh(Manifest(1, "shop", "en", "T2", listOf(rolledBack)))
        assertEquals("支払―", client.t("pay.button", locale = "ja"))
    }

    @Test fun scenarioB_deterministicBake() {
        val a = buildJsonObject {
            put("en", buildJsonObject { put("greet", JsonPrimitive("Hello")) })
            put("ko", buildJsonObject { put("greet", JsonPrimitive("안녕하세요")) })
        }
        val b = buildJsonObject {
            put("ko", buildJsonObject { put("greet", JsonPrimitive("안녕하세요")) })
            put("en", buildJsonObject { put("greet", JsonPrimitive("Hello")) })
        }
        val ha = ContentHash.snapshotHash("R1", "en", a)
        assertEquals(ha, ContentHash.snapshotHash("R1", "en", b))
        assertEquals(16, ContentHash.fileId(ha).length)
        // NFC: 조합형으로 들어와도 같은 해시
        val decomposed = buildJsonObject {
            put("en", buildJsonObject { put("greet", JsonPrimitive("Hello")) })
            put("ko", buildJsonObject { put("greet", JsonPrimitive(java.text.Normalizer.normalize("안녕하세요", java.text.Normalizer.Form.NFD))) })
        }
        assertEquals(ha, ContentHash.snapshotHash("R1", "en", decomposed))
    }

    @Test fun scenarioC_versionIsolation() {
        val r42 = snap("R42", "r42", mapOf("en" to mapOf("home.title" to text("Home"))))
        val r50 = snap("R50", "r50", mapOf("en" to mapOf("home.title" to text("Home"), "home.newBadge" to text("NEW"))))
        val store = InMemoryDeliveryStore()
        store.put(r42, "releases/R42/snapshot-r42.json")
        store.put(r50, "releases/R50/snapshot-r50.json")

        val releases = listOf(
            ManifestRelease("R42", ReleaseState.SUPERSEDED, VersionMatch("semver-range", ">=3.2.0 <3.3.0"),
                "r42", "r42", 100, "releases/R42/snapshot-r42.json", null),
            ManifestRelease("R50", ReleaseState.PUBLISHED, VersionMatch("semver-range", ">=3.3.0"),
                "r50", "r50", 100, "releases/R50/snapshot-r50.json", null),
        )
        val manifest = Manifest(1, "app", "en", "T", releases)

        val oldApp = RynL10nClient(r42, store, Matching.ClientContext(appVersion = "3.2.5"))
        oldApp.refresh(manifest)
        assertEquals("R42", oldApp.status().releaseId)
        assertEquals("Home", oldApp.t("home.title"))
        assertEquals("⟪home.newBadge⟫", oldApp.t("home.newBadge"))

        val newApp = RynL10nClient(r50, store, Matching.ClientContext(appVersion = "3.3.1"))
        newApp.refresh(manifest)
        assertEquals("R50", newApp.status().releaseId)
        assertEquals("NEW", newApp.t("home.newBadge"))
    }

    @Test fun rangeConflictDetection() {
        val overlapping = listOf(
            Matching.ConflictInput("R42", VersionMatch("semver-range", ">=3.2.0 <3.4.0")),
            Matching.ConflictInput("R60", VersionMatch("semver-range", ">=3.3.0 <3.5.0")),
        )
        assertEquals(1, Matching.findRangeConflicts(overlapping).size)
        val adjacent = listOf(
            Matching.ConflictInput("R42", VersionMatch("semver-range", ">=3.2.0 <3.3.0")),
            Matching.ConflictInput("R50", VersionMatch("semver-range", ">=3.3.0")),
        )
        assertEquals(0, Matching.findRangeConflicts(adjacent).size)
    }
}
