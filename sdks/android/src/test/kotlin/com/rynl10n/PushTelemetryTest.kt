package com.rynl10n

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.io.File
import java.net.InetSocketAddress
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/**
 * 주기 폴링(6.4) · 실시간 푸시 신호(4.1/M4) · 익명 집계 텔레메트리 전송(9.3) 검증.
 * iOS `PushTelemetryTests`와 같은 축을 본다. 네트워크는 JDK 내장 [HttpServer]로 **실제 스택**을 지난다.
 */
class PushTelemetryTest {

    private val bundle = Snapshot(
        1, "R42", "b0", "en",
        mapOf("en" to mapOf("pay.button" to TranslationValue.Text("Pay"))),
    )

    private val manifestJson = """
        {"schemaVersion":1,"project":"demo","defaultLocale":"en","updatedAt":"2026-08-20T00:00:00Z",
         "releases":[{"id":"R42","state":"published",
                      "versionMatch":{"strategy":"semver-range","value":">=1.0.0 <2.0.0"},
                      "base":"b0","overlay":"b0","rollout":100,
                      "snapshot":"releases/R42/snapshot-b0.json","delta":null}]}
    """.trimIndent()

    private lateinit var plane: FakePlane
    private lateinit var tempDir: File

    @BeforeEach fun setUp() {
        plane = FakePlane().apply { start() }
        tempDir = Files.createTempDirectory("rynl10n-push").toFile()
    }

    @AfterEach fun tearDown() {
        plane.stop()
        tempDir.deleteRecursively()
    }

    private fun store() = RemoteDeliveryStore(plane.baseUrl, "demo", tempDir)
    private fun client(appVersion: String = "1.2.3", telemetry: String = "off") =
        RynL10nClient(bundle, store(), Matching.ClientContext(appVersion = appVersion), telemetry = telemetry)

    /** 릴리스가 정해진 클라이언트 + 미해결 키 1건. */
    private fun reportingClient(): RynL10nClient {
        val c = RynL10nClient(bundle, InMemoryDeliveryStore(), Matching.ClientContext(appVersion = "1.2.3"), telemetry = "aggregate")
        c.refresh(Json { ignoreUnknownKeys = true }.decodeFromString<Manifest>(manifestJson))
        c.t("missing.key")
        return c
    }

    // --- 주기 폴링 ---

    @Test fun `주기 폴링은 간격마다 갱신하고 stop이 확실히 멈춘다`() = runBlocking {
        plane.route("/demo/manifest.json", manifestJson)
        val store = store()
        val client = RynL10nClient(bundle, store, Matching.ClientContext(appVersion = "1.2.3"))

        val cycles = AtomicInteger()
        store.startPolling(client, intervalMs = 50) { cycles.incrementAndGet() }
        waitFor { cycles.get() >= 2 }

        store.stopPolling()
        // 중단 시점에 이미 나가 있던 사이클 하나는 착지할 수 있다. 계약은 **새 주기를 더 잡지 않는다**이지
        // "진행 중인 요청이 사라진다"가 아니므로, 드레인한 뒤에 스냅샷을 찍는다.
        Thread.sleep(300)
        val afterStop = plane.countOf("/demo/manifest.json")
        Thread.sleep(300) // 간격 6회분 — 폴링이 살아 있으면 여기서 늘어난다
        assertEquals(afterStop, plane.countOf("/demo/manifest.json"), "stopPolling 이후 새 주기가 잡히면 안 된다")
        assertTrue(afterStop >= 2, "멈추기 전에 주기가 실제로 돌았다")
        assertEquals("R42", client.status().releaseId, "폴링이 실제 갱신 사이클을 돌린다")
    }

    // --- 실시간 푸시 신호(SSE) ---

    @Test fun `manifest 프레임만 신호로 센다`() = runBlocking {
        // 알림 플레인이 내려주는 프레임 그대로 — 모르는 이벤트는 무시돼야 한다.
        plane.sse(
            "retry: 3000\n\n" +
                "event: manifest\ndata: {\"seq\":1}\n\n" +
                "event: something-else\ndata: {}\n\n" +
                "event: manifest\ndata: {\"seq\":2}\n\n",
        )
        val channel = ServerPushChannel(plane.baseUrl, "demo")
        val seen = AtomicInteger()

        assertEquals(2, channel.receive { seen.incrementAndGet() })
        assertEquals(2, seen.get(), "manifest 프레임 수만큼 갱신이 트리거돼야 한다")
    }

    @Test fun `신호를 받으면 배포 플레인에서 갱신한다`() = runBlocking {
        plane.route("/demo/manifest.json", manifestJson)
        plane.sse("event: manifest\ndata: {\"seq\":1}\n\n")
        val store = store()
        val client = RynL10nClient(bundle, store, Matching.ClientContext(appVersion = "1.2.3"))
        val channel = ServerPushChannel(plane.baseUrl, "demo")

        channel.receive { store.update(client) }

        assertEquals("R42", client.status().releaseId)
        // 신호 자체는 데이터를 나르지 않는다 — 번역은 배포 플레인에서 받아 온다(4.1).
        assertTrue(plane.requested.contains("/demo/manifest.json"))
    }

    @Test fun `알림 플레인이 없으면 BadStatus`() = runBlocking {
        val channel = ServerPushChannel(plane.baseUrl, "demo")
        val error = runCatching { channel.receive { } }.exceptionOrNull()
        assertTrue(error is ServerPushChannel.PushException.BadStatus, "실제: $error")
        assertEquals(404, (error as ServerPushChannel.PushException.BadStatus).status)
    }

    // --- 텔레메트리 전송(9.3) ---

    @Test fun `익명 집계만 5개 필드로 올린다`() = runBlocking {
        plane.route("/projects/demo/telemetry", """{"accepted":1,"rejected":0}""")
        val client = reportingClient()

        assertTrue(TelemetryReporter(plane.baseUrl, "demo").flush(client))

        assertEquals(1, plane.posted.size)
        val batch = Json.parseToJsonElement(plane.posted[0]) as JsonArray
        assertEquals(1, batch.size, "0인 이벤트는 보내지 않는다")
        val event = batch[0].jsonObject
        assertEquals(
            setOf("projectId", "releaseId", "event", "count", "appVersionBucket"), event.keys,
            "서버의 프라이버시 가드가 거부하는 필드가 하나라도 있으면 배치 전체가 버려진다",
        )
        assertEquals("key_unresolved", event["event"]!!.jsonPrimitive.content)
        assertEquals("R42", event["releaseId"]!!.jsonPrimitive.content)
        assertEquals(1, event["count"]!!.jsonPrimitive.content.toInt())
        assertEquals("1.2", event["appVersionBucket"]!!.jsonPrimitive.content, "개별 빌드가 아니라 버전군이어야 익명이다")
        assertFalse(plane.posted[0].contains("missing.key"), "키 이름은 실리지 않는다")

        assertEquals(TelemetryCounts(), client.drainTelemetry(), "성공하면 카운트는 비워진다")
    }

    @Test fun `전송 실패면 카운트를 되돌린다`() = runBlocking {
        // 라우트를 등록하지 않아 404 → 실패 경로.
        val client = reportingClient()
        assertFalse(TelemetryReporter(plane.baseUrl, "demo").flush(client))
        assertEquals(
            1, client.drainTelemetry().keyUnresolved,
            "실패 구간이 사라지면 카나리 판정(8.4)이 실제보다 건강해 보인다",
        )
    }

    @Test fun `릴리스가 없으면 드레인하지 않는다`() = runBlocking {
        plane.route("/projects/demo/telemetry", """{"accepted":0,"rejected":0}""")
        // 번들만 쓰는 상태(매칭 릴리스 없음) → 귀속시킬 릴리스가 없다.
        val client = RynL10nClient(bundle, InMemoryDeliveryStore(), Matching.ClientContext(appVersion = "9.9.9"), telemetry = "aggregate")
        client.t("missing.key")

        assertTrue(TelemetryReporter(plane.baseUrl, "demo").flush(client))
        assertTrue(plane.posted.isEmpty())
        assertEquals(1, client.drainTelemetry().keyUnresolved, "다음 기회에 릴리스와 함께 나가야 한다")
    }

    @Test fun `수집이 off면 보낼 것이 없다`() = runBlocking {
        plane.route("/projects/demo/telemetry", """{"accepted":0,"rejected":0}""")
        val c = client(telemetry = "off")
        c.refresh(Json { ignoreUnknownKeys = true }.decodeFromString<Manifest>(manifestJson))
        c.t("missing.key")

        assertTrue(TelemetryReporter(plane.baseUrl, "demo").flush(c))
        assertTrue(plane.posted.isEmpty(), "옵트인이 아니면 네트워크로 아무것도 나가지 않는다")
    }

    @Test fun `앱 버전군 라벨`() {
        assertEquals("3.2", TelemetryReporter.versionBucket("3.2.1"))
        assertEquals("3.2", TelemetryReporter.versionBucket("3.2.1-beta.4"))
        assertEquals("4", TelemetryReporter.versionBucket("4"))
        assertEquals("unknown", TelemetryReporter.versionBucket(null))
        assertEquals("unknown", TelemetryReporter.versionBucket(""))
    }

    private fun waitFor(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!condition()) {
            check(System.currentTimeMillis() < deadline) { "조건이 ${timeoutMs}ms 안에 만족되지 않음" }
            Thread.sleep(10)
        }
    }
}

/** 배포 플레인 + 알림 플레인 + 텔레메트리 수집을 한 서버로 흉내낸다(포트 하나로 충분하다). */
private class FakePlane {
    private val server: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    private val routes = mutableMapOf<String, String>()
    private var sseBody: String? = null

    val requested = CopyOnWriteArrayList<String>()
    val posted = CopyOnWriteArrayList<String>()

    val baseUrl: String get() = "http://127.0.0.1:${server.address.port}"

    fun route(path: String, body: String) { routes[path] = body }
    fun sse(body: String) { sseBody = body }
    fun countOf(path: String) = requested.count { it == path }

    fun start() {
        server.createContext("/") { exchange ->
            val path = exchange.requestURI.path
            requested.add(path)
            if (exchange.requestMethod == "POST") posted.add(String(exchange.requestBody.readBytes(), Charsets.UTF_8))

            val sse = sseBody
            when {
                path.endsWith("/events") && sse != null -> {
                    exchange.responseHeaders.add("content-type", "text/event-stream")
                    exchange.sendResponseHeaders(200, 0) // chunked
                    exchange.responseBody.use { it.write(sse.toByteArray(Charsets.UTF_8)); it.flush() }
                }
                routes[path] == null -> exchange.sendResponseHeaders(404, -1)
                else -> {
                    val bytes = routes[path]!!.toByteArray(Charsets.UTF_8)
                    exchange.responseHeaders.add("content-type", "application/json")
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
