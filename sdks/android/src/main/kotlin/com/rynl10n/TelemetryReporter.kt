package com.rynl10n

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** 서버 스키마(9.3) 그대로의 이벤트 1건. 필드가 더 늘면 서버가 배치를 거부한다. */
@Serializable
data class TelemetryEvent(
    val projectId: String,
    val releaseId: String,
    val event: String,
    val count: Int,
    val appVersionBucket: String,
)

/**
 * 익명 집계 텔레메트리 전송(옵트인) — 기획서 9.3, 카나리 판정(8.4)의 입력.
 * iOS `TelemetryReporter`와 동작 대칭.
 *
 * 클라이언트가 모으는 것은 4종 카운트뿐이고([TelemetryCounts]), 이 타입은 그것을 관리 플레인의
 * `POST /projects/{p}/telemetry` 한 곳으로 보낸다. 본문 필드는 서버가 정의한 5개가 전부다 —
 * **그 외 필드는 서버가 거부하므로**(프라이버시 가드) 키 이름·번역 값·기기 식별자는 구조적으로
 * 나갈 수 없다. 카나리 버킷의 `installId`도 포함되지 않는다(기기 로컬 값, 8.4).
 *
 * 옵트인은 두 겹이다: 수집은 `RynL10nClient(telemetry = "aggregate")`, 전송은 이 객체를 만들어야 한다.
 *
 * @param endpoint 관리 플레인 루트(로컬 셀프호스트는 `http://localhost:8787`). 배포 플레인이 아니다 —
 *   읽기가 아니라 쓰기(집계 업로드) 경로다.
 */
class TelemetryReporter @JvmOverloads constructor(
    endpoint: String,
    private val project: String,
    private val connectTimeoutMs: Int = 10_000,
    private val readTimeoutMs: Int = 15_000,
) {
    private val url: String = endpoint.trimEnd('/') + "/projects/" + project.trim('/') + "/telemetry"
    private val json = Json { encodeDefaults = true }

    private val lock = ReentrantLock()
    private var job: Job? = null

    /**
     * 누적 카운트를 비우고 한 번 전송한다.
     *
     * 전송에 실패하면 드레인한 카운트를 **되돌려** 다음 주기에 다시 시도한다 — 그러지 않으면
     * 네트워크가 끊긴 구간의 거부율이 통째로 사라져 카나리 판정(8.4)이 실제보다 건강해 보인다.
     * @return 서버가 수용했으면 true. 보낼 것이 없어도 true(할 일 없음).
     */
    suspend fun flush(client: RynL10nClient): Boolean {
        // 릴리스가 정해지기 전(번들만)에는 귀속시킬 릴리스가 없다 → 드레인하지 않고 다음 기회로 미룬다.
        val releaseId = client.status().releaseId ?: return true
        val counts = client.drainTelemetry()
        val events = events(counts, project, releaseId, versionBucket(client.clientContext.appVersion))
        if (events.isEmpty()) return true

        val body = json.encodeToString(ListSerializer(TelemetryEvent.serializer()), events)
        val ok = withContext(Dispatchers.IO) { post(body) }
        if (!ok) client.mergeTelemetry(counts)
        return ok
    }

    /**
     * 주기 전송 시작(기본 5분). 첫 전송은 한 주기 뒤다 — 부팅 직후엔 보낼 것이 거의 없다.
     * 백그라운드 전환처럼 마지막 카운트를 확실히 올리고 싶은 시점에는 [flush]를 직접 부른다.
     */
    @JvmOverloads
    fun start(
        client: RynL10nClient,
        intervalMs: Long = 300_000,
        scope: CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob()),
    ) {
        stop()
        val started = scope.launch {
            while (isActive) {
                delay(intervalMs)
                if (!isActive) return@launch
                runCatching { flush(client) }
            }
        }
        lock.withLock { job = started }
    }

    /** 주기 전송 중단. 아직 안 보낸 카운트는 클라이언트에 남는다(다음 [flush]에서 함께 나간다). */
    fun stop() {
        val running = lock.withLock { val j = job; job = null; j }
        running?.cancel()
    }

    private fun post(body: String): Boolean {
        val connection = try {
            (URI(url).toURL().openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = connectTimeoutMs
                readTimeout = readTimeoutMs
                useCaches = false
                doOutput = true
                setRequestProperty("content-type", "application/json")
            }
        } catch (_: IOException) {
            return false
        }
        return try {
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            (if (status in 200..299) connection.inputStream else connection.errorStream)?.use { it.readBytes() }
            status == 200
        } catch (_: IOException) {
            false
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        /** 카운트 → 서버 이벤트 배치. 0인 이벤트는 보내지 않는다(빈 행으로 집계를 부풀리지 않기 위해). */
        fun events(counts: TelemetryCounts, projectId: String, releaseId: String, bucket: String): List<TelemetryEvent> =
            listOf(
                "overlay_applied" to counts.overlayApplied,
                "format_guard_rejected" to counts.formatGuardRejected,
                "key_unresolved" to counts.keyUnresolved,
                "delta_failed" to counts.deltaFailed,
            ).filter { it.second > 0 }
                .map { (event, count) -> TelemetryEvent(projectId, releaseId, event, count, bucket) }

        /**
         * 앱 버전군 라벨(`3.2.1` → `3.2`). 개별 빌드가 아니라 **군**이라야 익명 집계로 남는다.
         * 관측성 탭의 "릴리스 × 앱 버전군" 표가 이 라벨을 그대로 쓴다.
         */
        fun versionBucket(appVersion: String?): String {
            if (appVersion.isNullOrEmpty()) return "unknown"
            val parts = appVersion.split(".")
            return if (parts.size >= 2) "${parts[0]}.${parts[1]}" else parts[0]
        }
    }
}
