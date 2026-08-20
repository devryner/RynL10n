package com.rynl10n

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.BufferedReader
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * 실시간 푸시 신호 구독(옵트인) — 기획서 4.1 / 8, M4. iOS `ServerPushChannel`과 동작 대칭.
 *
 * **데이터 없는 신호만 받는다.** SSE 프레임이 전하는 것은 "manifest가 바뀌었다"는 사실뿐이고,
 * 번역 데이터는 여전히 배포 플레인의 정적 파일에서 내려받는다 → 읽기 데이터 경로는 정적으로 유지된다(4.1).
 * 그래서 이 채널의 엔드포인트는 배포 플레인이 **아니라** 알림(관리) 플레인이다.
 *
 * 폴링([RemoteDeliveryStore.startPolling])이 갱신의 보장선이고 이 채널은 **지연 단축용**이다.
 *
 * @param endpoint 알림(관리) 플레인 루트. 로컬 셀프호스트는 `http://localhost:8787`.
 * @param readTimeoutMs 스트림 무음 허용 시간. 백엔드는 하트비트를 보내지 않으므로 이 시간마다
 *   끊고 다시 붙는다(끊긴 연결을 영원히 붙잡지 않기 위한 상한). 0이면 무한 대기.
 */
class ServerPushChannel @JvmOverloads constructor(
    endpoint: String,
    project: String,
    private val connectTimeoutMs: Int = 10_000,
    private val readTimeoutMs: Int = 300_000,
) {
    sealed class PushException(message: String, cause: Throwable? = null) : Exception(message, cause) {
        /** 200이 아닌 응답(알림 플레인 미배치·경로 오타 등). */
        class BadStatus(val status: Int) : PushException("알림 플레인이 $status 를 반환했습니다")
        /** 연결 자체가 실패(오프라인·타임아웃). */
        class Unavailable(cause: Throwable?) : PushException("알림 플레인에 접근할 수 없습니다", cause)
    }

    private val eventsUrl: String = endpoint.trimEnd('/') + "/projects/" + project.trim('/') + "/events"

    private val lock = ReentrantLock()
    private var job: Job? = null
    private var connection: HttpURLConnection? = null

    /**
     * 연결 하나를 붙잡고 신호를 처리한다. 스트림이 끝나거나 [stop]으로 끊기면 반환한다(재연결 없음).
     *
     * `event: manifest` 프레임만 신호로 센다 — 알림 플레인이 다른 이벤트를 추가해도 조용히 무시된다.
     * @return 처리한 신호 수.
     */
    suspend fun receive(onSignal: suspend () -> Unit): Int = withContext(Dispatchers.IO) {
        val conn = try {
            (URI(eventsUrl).toURL().openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = connectTimeoutMs
                readTimeout = readTimeoutMs
                useCaches = false
                setRequestProperty("accept", "text/event-stream")
            }
        } catch (e: IOException) {
            throw PushException.Unavailable(e)
        }
        lock.withLock { connection = conn }

        try {
            val status = try {
                conn.responseCode
            } catch (e: IOException) {
                throw PushException.Unavailable(e)
            }
            if (status != 200) throw PushException.BadStatus(status)

            var isManifestFrame = false
            var signals = 0
            try {
                conn.inputStream.bufferedReader().use { reader: BufferedReader ->
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isEmpty()) {
                            // 빈 줄 = 프레임 경계(SSE).
                            if (isManifestFrame) { signals++; onSignal() }
                            isManifestFrame = false
                        } else if (line.startsWith("event:")) {
                            isManifestFrame = line.removePrefix("event:").trim() == "manifest"
                        }
                    }
                }
            } catch (_: IOException) {
                // 끊김(stop·타임아웃·네트워크) — 폴링이 안전망이므로 받은 데까지만 반환한다.
            }
            // 서버가 프레임 경계(빈 줄) 없이 스트림을 닫아도 신호는 잃지 않는다.
            if (isManifestFrame) { signals++; onSignal() }
            signals
        } finally {
            lock.withLock { if (connection === conn) connection = null }
            conn.disconnect()
        }
    }

    /**
     * 백그라운드 구독 시작 — 끊기면 백오프(3초 → 최대 60초)로 재연결한다.
     * 신호를 실제로 받으면 백오프를 초기화한다.
     *
     * @param scope 구독을 소유하는 스코프. 액티비티/뷰모델 스코프를 넘기면 생명주기와 함께 정리된다.
     */
    @JvmOverloads
    fun start(
        scope: CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob()),
        onSignal: suspend () -> Unit,
    ) {
        stop()
        val started = scope.launch {
            var backoffMs = 3_000L
            while (isActive) {
                try {
                    if (receive(onSignal) > 0) backoffMs = 3_000L
                } catch (_: Exception) {
                    // 알림 플레인이 없거나 끊김 — 폴링이 안전망이므로 조용히 재시도한다.
                }
                if (!isActive) return@launch
                delay(backoffMs)
                backoffMs = minOf(backoffMs * 2, 60_000L)
            }
        }
        lock.withLock { job = started }
    }

    /** 신호를 받을 때마다 배포 플레인에서 갱신 사이클을 한 번 돌리는 기본 배선. */
    @JvmOverloads
    fun start(
        client: RynL10nClient,
        store: RemoteDeliveryStore,
        scope: CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob()),
    ) {
        start(scope) { runCatching { store.update(client) } }
    }

    /** 구독 중단(백그라운드 전환·로그아웃). 붙잡고 있던 스트림을 끊어 대기 중인 읽기를 깨운다. */
    fun stop() {
        val (running, conn) = lock.withLock {
            val pair = job to connection
            job = null; connection = null
            pair
        }
        running?.cancel()
        // 코루틴 취소는 블로킹 중인 readLine을 깨우지 못한다 — 연결을 직접 끊어야 한다.
        runCatching { conn?.disconnect() }
    }
}
