package com.rynl10n

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * 배포 플레인(CDN/오브젝트 스토리지) HTTP 참조 구현 — 기획서 4.1 / 6.4 / 7.2.
 *
 * **관리 API는 절대 호출하지 않는다.** 읽는 것은 정적 파일 세 종류뿐이다(11.2):
 * ```
 * {baseUrl}/{project}/manifest.json                            짧은 TTL + ETag
 * {baseUrl}/{project}/releases/{r}/snapshot-{hash}.json        불변 → 영구 캐시
 * {baseUrl}/{project}/releases/{r}/delta-{base}-{target}.json  불변 → 영구 캐시
 * ```
 *
 * [DeliveryStore]는 동기 인터페이스다(`refresh(manifest)`가 동기라 화면이 절대 네트워크를 기다리지
 * 않는다). 그래서 이 타입은 **비동기 다운로드와 동기 조회를 분리**한다 — [update]가 필요한 산출물을
 * 먼저 캐시에 채운 뒤 `refresh`를 호출하고, 인터페이스 메서드는 캐시만 들여다본다(네트워크 접근 없음).
 *
 * 산출물은 내용해시 URL이라 한 번 받으면 영구 유효하다 → 디스크 캐시에 그대로 둔다.
 * manifest만 ETag로 재검증하며, 네트워크가 없으면 **마지막 캐시로 진행**한다(오프라인 실행 보장).
 *
 * iOS `RemoteDeliveryStore`와 동작이 대칭이나 **스왑 스레드만 다르다** — iOS는 메인 액터로 넘기지만
 * 여기서는 호출한 코루틴 컨텍스트에서 그대로 스왑한다. [RynL10nClient]의 상태는 잠금으로 보호되고
 * 갱신 통지는 [RynL10nState]의 `StateFlow`로 흘러 어느 스레드에서 바뀌어도 Compose가 안전하게 읽는다.
 *
 * @param baseUrl 배포 플레인 루트. 로컬 셀프호스트는 `http://localhost:8788`, 운영은 CDN 도메인.
 * @param project 프로젝트 ID(정적 레이아웃의 첫 경로 세그먼트).
 * @param cacheDirectory 캐시 루트. Android 앱은 `context.cacheDir`를 넘긴다 — OS가 비울 수 있는 자리가
 *   맞다(번들 fallback이 항상 있으므로 캐시가 사라져도 번역 공백은 생기지 않는다).
 */
class RemoteDeliveryStore @JvmOverloads constructor(
    baseUrl: String,
    project: String,
    cacheDirectory: File,
    private val connectTimeoutMs: Int = 10_000,
    private val readTimeoutMs: Int = 15_000,
) : DeliveryStore {

    sealed class DeliveryException(message: String, cause: Throwable? = null) : Exception(message, cause) {
        /** 2xx가 아닌 응답. */
        class BadStatus(val status: Int, val path: String) :
            DeliveryException("배포 플레인이 $status 를 반환했습니다: $path")
        /** 네트워크 실패이고 캐시도 없음. */
        class Unavailable(val path: String, cause: Throwable?) :
            DeliveryException("배포 플레인에 접근할 수 없고 캐시도 없습니다: $path", cause)
        /** 본문을 기대 타입으로 디코딩하지 못함. */
        class Malformed(val path: String) :
            DeliveryException("배포 플레인 응답을 디코딩하지 못했습니다: $path")
    }

    private val projectUrl: String = baseUrl.trimEnd('/') + "/" + project.trim('/')
    private val cacheDir: File = File(File(cacheDirectory, "rynl10n"), project)
    private val json = Json { ignoreUnknownKeys = true }

    private val lock = ReentrantLock()
    private val snapshotCache = mutableMapOf<String, Snapshot>()
    private val deltaCache = mutableMapOf<String, Delta>()

    init {
        cacheDir.mkdirs()
    }

    // --- DeliveryStore (동기 — 캐시만 조회, 네트워크 접근 없음) ---

    override fun snapshot(path: String): Snapshot? {
        lock.withLock { snapshotCache[path] }?.let { return it }
        val decoded = decodeCached<Snapshot>(path) ?: return null
        lock.withLock { snapshotCache[path] = decoded }
        return decoded
    }

    override fun delta(path: String): Delta? {
        lock.withLock { deltaCache[path] }?.let { return it }
        val decoded = decodeCached<Delta>(path) ?: return null
        lock.withLock { deltaCache[path] = decoded }
        return decoded
    }

    private inline fun <reified T> decodeCached(path: String): T? {
        val file = fileFor(path)
        if (!file.isFile) return null
        return runCatching { json.decodeFromString<T>(file.readText()) }.getOrNull()
    }

    // --- 갱신 사이클 (6.4) ---

    /**
     * manifest 조회 → 내 앱 버전에 맞는 릴리스 선택 → 필요한 산출물만 내려받기 → 원자적 스왑.
     *
     * 릴리스 선택은 **클라이언트가 정적 manifest만으로** 수행한다(서버 라우팅 없음, 4.3).
     * 반환값은 카탈로그가 실제로 바뀌었는지 여부다. 네트워크 실패는 던지지 않고 마지막 캐시로 진행하며,
     * 캐시조차 없으면 [DeliveryException.Unavailable]을 던진다 — 어느 경우든 화면의 번역은 깨지지 않는다
     * (번들 fallback이 항상 살아 있다).
     *
     * 호출 시점은 앱 시작 직후와 포그라운드 복귀가 기본이다.
     */
    suspend fun update(client: RynL10nClient): Boolean {
        val manifest = loadManifest()

        val selection = Matching.selectRelease(manifest.releases, client.clientContext)
        val release = when (selection) {
            is Matching.Selection.Matched -> selection.release
            is Matching.Selection.NearestLower -> selection.release
            // 매칭 릴리스 없음 → 번들만. 내려받을 산출물이 없다.
            Matching.Selection.BundleOnly -> null
        }
        if (release != null) {
            // 활성 번들과 base가 같으면 스냅샷은 이미 손에 있다(빌드타임에 구운 것) → 받지 않는다.
            if (release.base != client.status().activeBase) fetchSnapshot(release.snapshot)
            // 델타는 sparse라 작다. 카나리 미대상이면 refresh가 무시하므로 실패해도 그냥 진행한다.
            val deltaPath = release.delta
            if (deltaPath != null && release.overlay != release.base) {
                runCatching { fetchDelta(deltaPath) }
            }
        }

        return client.refresh(manifest)
    }

    // --- 주기 폴링 ---

    private var pollJob: Job? = null

    /**
     * 주기 폴링 시작(기본 60초). 즉시 한 번 갱신한 뒤 간격마다 반복한다.
     *
     * 실패는 삼킨다 — 실패 = 이전 상태 유지이고 다음 주기에 다시 시도하면 되기 때문이다.
     * 앱이 [update]를 직접 부르는 것(앱 시작·포그라운드 복귀)과 배타적이지 않다: 산출물은 내용해시
     * URL이라 이미 가진 것은 다시 받지 않고, manifest는 ETag로 재검증된다.
     *
     * 배터리·트래픽은 **호출자가 정한다** — `ON_STOP`에서 [stopPolling], `ON_START`에서 다시
     * [startPolling]이 기본 패턴이다. SDK가 앱 생명주기를 가로채지 않는다.
     *
     * @param scope 폴링을 소유하는 스코프. 뷰모델 스코프를 넘기면 생명주기와 함께 정리된다.
     * @param onUpdate 사이클마다 호출(카탈로그가 실제로 바뀌었으면 true). 메인 스레드 보장은 없다 —
     *   UI 갱신은 [RynL10nState]의 `StateFlow`로 흐른다.
     */
    @JvmOverloads
    fun startPolling(
        client: RynL10nClient,
        intervalMs: Long = 60_000,
        scope: CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob()),
        onUpdate: ((Boolean) -> Unit)? = null,
    ) {
        stopPolling()
        val started = scope.launch {
            while (isActive) {
                val changed = runCatching { update(client) }.getOrDefault(false)
                if (!isActive) return@launch // stopPolling 직후 콜백이 한 번 더 나가지 않게
                onUpdate?.invoke(changed)
                delay(intervalMs)
            }
        }
        lock.withLock { pollJob = started }
    }

    /** 폴링 중단(백그라운드 전환·로그아웃). 이미 적용된 카탈로그는 그대로 남는다. */
    fun stopPolling() {
        val running = lock.withLock { val j = pollJob; pollJob = null; j }
        running?.cancel()
    }

    /** manifest 조회(짧은 TTL + ETag 재검증, 7.2). 네트워크 실패·304면 캐시본을 쓴다. */
    suspend fun loadManifest(): Manifest = withContext(Dispatchers.IO) {
        val cached = cachedManifest()
        // 304를 받아도 되돌릴 캐시본이 실제로 있을 때만 조건부 요청을 보낸다
        // (ETag만 남고 본문 캐시가 사라진 상태에서 304가 오면 복원할 것이 없다).
        val etag = if (cached != null && etagFile.isFile) etagFile.readText() else null

        try {
            val response = request("manifest.json", etag)
            when (response.status) {
                200 -> {
                    val manifest = decode<Manifest>(response.body)
                        ?: throw DeliveryException.Malformed("manifest.json")
                    writeAtomic(manifestFile, response.body)
                    response.etag?.let { writeAtomic(etagFile, it.toByteArray()) }
                    manifest
                }
                304 -> cached ?: throw DeliveryException.Malformed("manifest.json")
                // 서버가 살아 있으나 응답이 이상함 → 캐시가 있으면 캐시로 진행.
                else -> cached ?: throw DeliveryException.BadStatus(response.status, "manifest.json")
            }
        } catch (e: DeliveryException) {
            throw e
        } catch (e: IOException) {
            // 오프라인·타임아웃 — 마지막으로 성공한 manifest로 진행한다.
            cached ?: throw DeliveryException.Unavailable("manifest.json", e)
        }
    }

    /** 스냅샷 내려받기(불변 → 이미 캐시에 있으면 네트워크를 타지 않는다). */
    suspend fun fetchSnapshot(path: String): Snapshot {
        snapshot(path)?.let { return it }
        val body = download(path)
        val decoded = decode<Snapshot>(body) ?: throw DeliveryException.Malformed(path)
        writeAtomic(fileFor(path), body)
        lock.withLock { snapshotCache[path] = decoded }
        return decoded
    }

    /** 델타 내려받기(불변 → 이미 캐시에 있으면 네트워크를 타지 않는다). */
    suspend fun fetchDelta(path: String): Delta {
        delta(path)?.let { return it }
        val body = download(path)
        val decoded = decode<Delta>(body) ?: throw DeliveryException.Malformed(path)
        writeAtomic(fileFor(path), body)
        lock.withLock { deltaCache[path] = decoded }
        return decoded
    }

    private suspend fun download(path: String): ByteArray = withContext(Dispatchers.IO) {
        try {
            val response = request(path, null)
            if (response.status != 200) throw DeliveryException.BadStatus(response.status, path)
            response.body
        } catch (e: DeliveryException) {
            throw e
        } catch (e: IOException) {
            throw DeliveryException.Unavailable(path, e)
        }
    }

    // --- HTTP ---

    private class HttpResponse(val status: Int, val body: ByteArray, val etag: String?)

    private fun request(path: String, ifNoneMatch: String?): HttpResponse {
        val connection = URI("$projectUrl/$path").toURL().openConnection() as HttpURLConnection
        connection.requestMethod = "GET"
        connection.connectTimeout = connectTimeoutMs
        connection.readTimeout = readTimeoutMs
        connection.useCaches = false // 재검증은 ETag로 직접 한다.
        if (ifNoneMatch != null) connection.setRequestProperty("if-none-match", ifNoneMatch)
        try {
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.use { it.readBytes() } ?: ByteArray(0)
            return HttpResponse(status, body, connection.getHeaderField("etag"))
        } finally {
            connection.disconnect()
        }
    }

    // --- 디스크 캐시 ---

    private val manifestFile: File get() = File(cacheDir, "manifest.json")
    private val etagFile: File get() = File(cacheDir, "manifest.etag")

    private fun cachedManifest(): Manifest? {
        if (!manifestFile.isFile) return null
        return runCatching { json.decodeFromString<Manifest>(manifestFile.readText()) }.getOrNull()
    }

    /** 산출물 경로(`releases/R1/snapshot-<hash>.json`)를 평평한 캐시 파일명으로. 내용해시가 들어 있어 충돌하지 않는다. */
    private fun fileFor(path: String): File = File(cacheDir, path.replace('/', '_'))

    private inline fun <reified T> decode(body: ByteArray): T? =
        runCatching { json.decodeFromString<T>(String(body, Charsets.UTF_8)) }.getOrNull()

    private fun writeAtomic(target: File, bytes: ByteArray) {
        cacheDir.mkdirs()
        val tmp = File(target.parentFile, target.name + ".tmp")
        tmp.writeBytes(bytes)
        Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
    }

    /** 캐시 비우기(로그아웃·프로젝트 전환 등). 번들 fallback은 그대로라 번역 공백은 생기지 않는다. */
    fun clearCache() {
        lock.withLock { snapshotCache.clear(); deltaCache.clear() }
        cacheDir.deleteRecursively()
        cacheDir.mkdirs()
    }
}
