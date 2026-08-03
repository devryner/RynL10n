package com.rynl10n

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.io.File
import java.net.InetSocketAddress
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 배포 플레인 HTTP 구현([RemoteDeliveryStore]) 검증 — 기획서 4.1 / 6.4 / 7.2.
 *
 * iOS는 `URLProtocol` 스텁으로 네트워크를 가로채지만, 여기서는 JDK 내장 [HttpServer]로 **실제 배포
 * 플레인을 세워** 검증한다 — HttpURLConnection·ETag 헤더·304 처리까지 실제 스택을 지나간다.
 * 오프라인은 서버를 내려 재현한다(연결 거부 = 진짜 네트워크 실패).
 */
class RemoteDeliveryTest {

    // --- 픽스처 (배포 플레인이 실제로 내려주는 정적 파일 그대로) ---

    private val bundleJson = """
        {"schemaVersion":1,"release":"R42","base":"base0","defaultLocale":"en",
         "locales":{"en":{"pay.button":"Pay"},"ja":{"pay.button":"支払―"}}}
    """.trimIndent()

    /** base가 번들과 다른 릴리스용 스냅샷(스냅샷 다운로드 경로 검증에 쓴다). */
    private val remoteSnapshotJson = """
        {"schemaVersion":1,"release":"R42","base":"base9","defaultLocale":"en",
         "locales":{"en":{"pay.button":"Pay"},"ja":{"pay.button":"支払(원격)"}}}
    """.trimIndent()

    private val deltaJson = """
        {"schemaVersion":1,"release":"R42","from":"base0","to":"base1",
         "ops":[{"op":"set","key":"pay.button","locale":"ja","value":"支払い"}]}
    """.trimIndent()

    private fun manifestJson(base: String, overlay: String, delta: String?): String {
        val deltaField = if (delta != null) "\"delta\":\"$delta\"" else "\"delta\":null"
        return """
            {"schemaVersion":1,"project":"demo","defaultLocale":"en","updatedAt":"2026-08-03T00:00:00Z",
             "releases":[{"id":"R42","state":"published",
                          "versionMatch":{"strategy":"semver-range","value":">=1.0.0 <2.0.0"},
                          "base":"$base","overlay":"$overlay","rollout":100,
                          "snapshot":"releases/R42/snapshot-$base.json",$deltaField}]}
        """.trimIndent()
    }

    private val bundle: Snapshot = Snapshot(
        1, "R42", "base0", "en",
        mapOf(
            "en" to mapOf("pay.button" to TranslationValue.Text("Pay")),
            "ja" to mapOf("pay.button" to TranslationValue.Text("支払―")),
        ),
    )

    // --- 하네스 ---

    private lateinit var plane: FakeDeliveryPlane
    private lateinit var tempDir: File

    @BeforeEach fun setUp() {
        plane = FakeDeliveryPlane().apply { start() }
        tempDir = Files.createTempDirectory("rynl10n-test").toFile()
    }

    @AfterEach fun tearDown() {
        plane.stop()
        tempDir.deleteRecursively()
    }

    private fun makeStore(cacheName: String = "cache") =
        RemoteDeliveryStore(plane.baseUrl, "demo", File(tempDir, cacheName))

    private fun makeClient(store: DeliveryStore) =
        RynL10nClient(bundle, store, Matching.ClientContext(appVersion = "1.2.0"))

    // --- 갱신 사이클 ---

    @Test fun update_델타를_받아_오버레이를_적용한다() = runBlocking {
        plane.route("/demo/manifest.json", manifestJson("base0", "base1", "releases/R42/delta-base0-base1.json"))
        plane.route("/demo/releases/R42/delta-base0-base1.json", deltaJson)

        val store = makeStore()
        val client = makeClient(store)
        assertEquals("支払―", client.t("pay.button", locale = "ja"), "갱신 전에는 번들 값")

        val changed = store.update(client)

        assertTrue(changed)
        assertEquals("支払い", client.t("pay.button", locale = "ja"), "오버레이가 키 단위로 덮어써야 한다")
        assertEquals("R42", client.status().releaseId)
        // base가 번들과 같으므로 스냅샷은 내려받지 않아야 한다(불필요한 트래픽 차단).
        assertFalse(plane.requested.any { it.contains("snapshot") }, "번들과 base가 같으면 스냅샷을 받지 않는다")
    }

    @Test fun update_base가_다르면_스냅샷을_내려받는다() = runBlocking {
        plane.route("/demo/manifest.json", manifestJson("base9", "base9", null))
        plane.route("/demo/releases/R42/snapshot-base9.json", remoteSnapshotJson)

        val store = makeStore()
        val client = makeClient(store)

        val changed = store.update(client)

        assertTrue(changed)
        assertEquals("base9", client.status().activeBase)
        assertEquals("支払(원격)", client.t("pay.button", locale = "ja"))
    }

    @Test fun update_매칭_릴리스가_없으면_번들만_쓰고_아무것도_받지_않는다() = runBlocking {
        // 앱 버전 1.2.0은 >=3.0.0 <4.0.0 에 매칭되지 않는다.
        plane.route(
            "/demo/manifest.json",
            """
            {"schemaVersion":1,"project":"demo","defaultLocale":"en","updatedAt":"2026-08-03T00:00:00Z",
             "releases":[{"id":"R99","state":"published",
                          "versionMatch":{"strategy":"semver-range","value":">=3.0.0 <4.0.0"},
                          "base":"baseX","overlay":"baseY","rollout":100,
                          "snapshot":"releases/R99/snapshot-baseX.json",
                          "delta":"releases/R99/delta-baseX-baseY.json"}]}
            """.trimIndent(),
        )

        val store = makeStore()
        val client = makeClient(store)

        store.update(client)

        assertEquals("bundle-only", client.status().selection)
        assertEquals("支払―", client.t("pay.button", locale = "ja"), "번들 값 유지")
        assertEquals(0, plane.requested.count { it.contains("releases/") }, "매칭 릴리스가 없으면 산출물을 받지 않는다")
    }

    // --- 캐싱 · 오프라인 ---

    @Test fun update_불변_산출물은_두_번_받지_않는다() = runBlocking {
        plane.route("/demo/manifest.json", manifestJson("base0", "base1", "releases/R42/delta-base0-base1.json"))
        plane.route("/demo/releases/R42/delta-base0-base1.json", deltaJson)

        val store = makeStore()
        val client = makeClient(store)
        store.update(client)
        store.update(client)

        assertEquals(1, plane.requested.count { it.contains("delta-") }, "내용해시 URL은 영구 캐싱 — 재요청하지 않는다")
    }

    @Test fun loadManifest_ETag_304면_캐시본을_쓴다() = runBlocking {
        plane.route("/demo/manifest.json", manifestJson("base0", "base0", null), etag = "\"v1\"")
        val store = makeStore()
        store.loadManifest()

        // 두 번째 요청부터는 304만 돌려준다 → 캐시본으로 복원되어야 한다.
        plane.setNotModified("/demo/manifest.json")
        val manifest = store.loadManifest()

        assertEquals("demo", manifest.project)
        assertEquals("R42", manifest.releases.first().id)
        assertTrue(plane.conditionalRequests.contains("\"v1\""), "저장해둔 ETag로 재검증해야 한다")
    }

    @Test fun update_네트워크가_끊겨도_마지막_캐시로_진행한다() = runBlocking {
        plane.route("/demo/manifest.json", manifestJson("base0", "base1", "releases/R42/delta-base0-base1.json"))
        plane.route("/demo/releases/R42/delta-base0-base1.json", deltaJson)

        // 1) 온라인에서 한 번 성공 → manifest·델타가 디스크 캐시에 남는다.
        val warm = makeStore()
        warm.update(makeClient(warm))

        // 2) 앱 재시작 + 완전 오프라인 (같은 캐시 디렉토리를 쓰는 새 인스턴스).
        plane.stop()
        val cold = makeStore()
        val client = makeClient(cold)
        val changed = cold.update(client)

        assertTrue(changed)
        assertEquals("支払い", client.t("pay.button", locale = "ja"), "오프라인이어도 마지막 캐시로 오버레이가 적용된다")
    }

    @Test fun update_캐시도_네트워크도_없으면_unavailable을_던진다() {
        plane.stop()
        val store = makeStore()

        assertThrows(RemoteDeliveryStore.DeliveryException.Unavailable::class.java) {
            runBlocking { store.update(makeClient(store)) }
        }
    }

    @Test fun update_실패해도_화면의_번역은_깨지지_않는다() = runBlocking {
        plane.stop()
        val store = makeStore()
        val client = makeClient(store)

        runCatching { store.update(client) }

        assertEquals("支払―", client.t("pay.button", locale = "ja"), "번들 fallback은 항상 살아 있다")
        assertEquals("Pay", client.t("pay.button"))
    }

    @Test fun clearCache_이후에는_다시_받는다() = runBlocking {
        plane.route("/demo/manifest.json", manifestJson("base0", "base1", "releases/R42/delta-base0-base1.json"))
        plane.route("/demo/releases/R42/delta-base0-base1.json", deltaJson)

        val store = makeStore()
        val client = makeClient(store)
        store.update(client)
        store.clearCache()
        store.update(client)

        assertEquals(2, plane.requested.count { it.contains("delta-") })
    }

    @Test fun 스냅샷_경로가_404여도_번들로_계속_동작한다() = runBlocking {
        // manifest는 멀쩡한데 산출물만 없는 상태(스토리지 유실·오배포).
        plane.route("/demo/manifest.json", manifestJson("base9", "base9", null))

        val store = makeStore()
        val client = makeClient(store)

        assertThrows(RemoteDeliveryStore.DeliveryException.BadStatus::class.java) {
            runBlocking { store.update(client) }
        }
        assertEquals("支払―", client.t("pay.button", locale = "ja"), "번들 fallback 유지")
    }
}

/** JDK 내장 HTTP 서버로 세운 가짜 배포 플레인(정적 파일만 서빙 — 애플리케이션 서버 없음, 4.1). */
private class FakeDeliveryPlane {
    private val server: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    private val routes = mutableMapOf<String, String>()
    private val etags = mutableMapOf<String, String>()
    private val notModified = mutableSetOf<String>()

    val requested = CopyOnWriteArrayList<String>()
    val conditionalRequests = CopyOnWriteArrayList<String>()

    val baseUrl: String get() = "http://127.0.0.1:${server.address.port}"

    fun route(path: String, body: String, etag: String? = null) {
        routes[path] = body
        if (etag != null) etags[path] = etag
    }

    fun setNotModified(path: String) {
        notModified.add(path)
    }

    fun start() {
        server.createContext("/") { exchange ->
            val path = exchange.requestURI.path
            requested.add(path)
            exchange.requestHeaders.getFirst("if-none-match")?.let { conditionalRequests.add(it) }

            val body = routes[path]
            when {
                body == null -> exchange.sendResponseHeaders(404, -1)
                path in notModified -> exchange.sendResponseHeaders(304, -1)
                else -> {
                    etags[path]?.let { exchange.responseHeaders.add("etag", it) }
                    exchange.responseHeaders.add("content-type", "application/json")
                    val bytes = body.toByteArray(Charsets.UTF_8)
                    exchange.sendResponseHeaders(200, bytes.size.toLong())
                    exchange.responseBody.use { it.write(bytes) }
                }
            }
            exchange.close()
        }
        server.start()
    }

    fun stop() = server.stop(0)
}
