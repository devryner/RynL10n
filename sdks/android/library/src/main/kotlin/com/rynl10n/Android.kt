package com.rynl10n

import android.content.Context
import android.content.pm.PackageInfo
import android.os.Build
import java.util.UUID

/**
 * Android 바인딩 — 기획서 6.1 / 6.2 / 6.3.
 *
 * 실제 로직은 전부 코어(JVM에서 골든 벡터로 검증되는 쪽)에 있고 여기는 **Android 자원에 연결하는
 * 얇은 층**이다: assets에서 구운 번들 읽기, `PackageInfo`에서 앱 버전 읽기, 캐시 디렉토리 넘기기.
 */

// --- 번들 로더 (6.3) ---

/**
 * `assets/`에 구워진 번들 스냅샷을 로드한다.
 *
 * `rynl10nBake` Gradle 태스크를 앱 모듈의 `preBuild`에 물리고 출력을 assets로 보내면
 * (`-Pout=src/main/assets -PstableName=true`) 빌드마다 이 자리가 채워진다 — 커밋할 파일은 없다.
 */
fun BakedBundle.fromAssets(context: Context): Snapshot {
    for (candidate in ASSET_CANDIDATES) {
        val stream = runCatching { context.assets.open(candidate) }.getOrNull() ?: continue
        return snapshot(stream, "assets/$candidate")
    }
    throw BakedBundle.BakedException(
        """
        [rynl10n] assets에서 bake된 스냅샷을 찾지 못했습니다(${ASSET_CANDIDATES.joinToString(", ")}).
        확인: ① 앱 모듈 build.gradle.kts 에서 preBuild 가 rynl10nBake 에 의존하는지
        ② 태스크 출력이 assets 로 향하는지(-Pout=src/main/assets -PstableName=true)
        ③ 에어갭이면 vendored 스냅샷을 그 자리에 커밋했는지.
        """.trimIndent()
    )
}

/** 함께 구워진 lockfile(진단용). 없으면 null — 런타임 동작에는 쓰이지 않는다. */
fun BakedBundle.lockfileFromAssets(context: Context): Bake.Lockfile? {
    for (candidate in LOCKFILE_CANDIDATES) {
        val stream = runCatching { context.assets.open(candidate) }.getOrNull() ?: continue
        return lockfile(stream)
    }
    return null
}

// --- SDK 표면 (6.1) ---

/**
 * 앱 전역 진입점 — 기획서 6.1의 `configure` / `t` / `onCatalogUpdated`.
 *
 * ```kotlin
 * // Application.onCreate
 * RynL10n.configure(this, project = "myapp", endpoint = "https://cdn.example.com")
 *
 * // 화면
 * textView.text = RynL10n.t("home.title")
 *
 * // 앱 시작·포그라운드 복귀
 * lifecycleScope.launch { RynL10n.update() }
 * ```
 *
 * 인스턴스를 직접 들고 싶으면 [RynL10nClient]와 [RemoteDeliveryStore]를 그대로 써도 된다 —
 * 이 객체는 그 조합에 대한 편의 파사드일 뿐이다.
 */
object RynL10n {

    @Volatile private var _client: RynL10nClient? = null
    @Volatile private var _store: RemoteDeliveryStore? = null
    @Volatile private var _state: RynL10nState? = null
    @Volatile private var _project: String? = null
    @Volatile private var _push: ServerPushChannel? = null
    @Volatile private var _reporter: TelemetryReporter? = null

    /** [configure] 이후에만 유효하다. */
    val client: RynL10nClient
        get() = _client ?: error("[rynl10n] RynL10n.configure(...)를 먼저 호출하세요(Application.onCreate 권장).")

    /** 배포 플레인 접근자. [configure]에서 endpoint를 넘기지 않았으면 null. */
    val store: RemoteDeliveryStore? get() = _store

    /** Compose/StateFlow 바인딩(6.2). 갱신 시 `version`이 올라간다. */
    val state: RynL10nState
        get() = _state ?: synchronized(this) {
            _state ?: RynL10nState(client).also { _state = it }
        }

    /** 설정됐는지 여부(테스트·조건부 초기화용). */
    val isConfigured: Boolean get() = _client != null

    /**
     * SDK 초기화. 번들 로드는 동기 디스크 I/O뿐이라 스플래시에서 네트워크를 기다릴 일이 없다(6.4).
     *
     * @param project 프로젝트 ID. 배포 플레인 정적 경로의 첫 세그먼트다(11.2).
     * @param endpoint 배포 플레인(CDN) 루트. **관리 API가 아니다**(4.1 플레인 분리).
     *   null이면 번들 전용으로 동작한다(에어갭·오프라인 전용 빌드).
     * @param bundle 번들 스냅샷. 기본값은 assets에서 로드([fromAssets]).
     * @param appVersion 릴리스 매칭 기준(4.3). 기본값은 `PackageInfo.versionName` —
     *   여기가 릴리스의 `versionMatch` 범위 밖이면 원격 갱신이 조용히 무시된다(가장 흔한 함정).
     * @param buildNumber `integer-range` 전략용. 기본값은 `PackageInfo.longVersionCode`.
     * @param enableCanary 카나리 버킷팅(8.4)에 참여할지. **기본은 false** — 8.4 프라이버시 검토가
     *   끝나기 전까지 안전 기본값을 유지한다(서버 rollout도 100 고정). true면 기기 로컬 익명
     *   installId(UUID v4)를 SharedPreferences에 만들어 쓴다. **서버로 전송되지 않는다.**
     */
    @JvmStatic
    @JvmOverloads
    fun configure(
        context: Context,
        project: String,
        endpoint: String? = null,
        bundle: Snapshot = BakedBundle.fromAssets(context),
        appVersion: String? = null,
        buildNumber: Int? = null,
        releaseLabel: String? = null,
        localeOverrides: Map<String, String> = emptyMap(),
        enableCanary: Boolean = false,
        telemetry: String = "off",
    ): RynL10nClient {
        val app = context.applicationContext
        val info = packageInfo(app)
        val clientContext = Matching.ClientContext(
            appVersion = appVersion ?: info?.versionName,
            releaseLabel = releaseLabel,
            buildNumber = buildNumber ?: info?.let { versionCode(it) },
        )
        val store = endpoint?.let { RemoteDeliveryStore(it, project, app.cacheDir) }
        val client = RynL10nClient(
            bundle = bundle,
            store = store ?: InMemoryDeliveryStore(),
            context = clientContext,
            localeOverrides = localeOverrides,
            installId = if (enableCanary) installId(app) else null,
            telemetry = telemetry,
        )
        synchronized(this) {
            _client = client
            _store = store
            _project = project
            _state = null // 새 클라이언트에 맞춰 다시 만든다.
        }
        return client
    }

    /** 동기 조회(6.1). 항상 번들 fallback이 있어 블로킹 네트워크가 없다. */
    @JvmStatic
    @JvmOverloads
    fun t(key: String, args: Map<String, Any?> = emptyMap(), locale: String? = null): String =
        client.t(key, args, locale)

    /** 갱신 통지 구독(6.1). */
    @JvmStatic
    fun onCatalogUpdated(listener: (UpdateInfo) -> Unit): Int = client.onCatalogUpdated(listener)

    /**
     * 원격 갱신 한 사이클(6.4) — manifest 조회 → 릴리스 선택 → 필요한 산출물만 다운로드 → 원자적 스왑.
     *
     * 앱 시작 직후와 포그라운드 복귀에 부르면 된다. 실패는 **이전 상태 유지**를 뜻할 뿐이라
     * 삼켜도 화면이 깨지지 않는다. endpoint 없이 configure 했으면 false.
     */
    suspend fun update(): Boolean = _store?.update(client) ?: false

    // --- 갱신 자동화 (6.4) ---

    /**
     * 주기 폴링 시작(기본 60초). `ON_START`에서 켜고 `ON_STOP`에서 [stopPolling]이 기본 패턴이다 —
     * 배터리·트래픽은 앱이 정한다. endpoint 없이 configure 했으면 아무 일도 없다.
     */
    @JvmStatic
    @JvmOverloads
    fun startPolling(intervalMs: Long = 60_000) {
        _store?.startPolling(client, intervalMs)
    }

    /** 주기 폴링 중단. 이미 적용된 카탈로그는 그대로 남는다. */
    @JvmStatic
    fun stopPolling() {
        _store?.stopPolling()
    }

    /**
     * 실시간 푸시 신호 구독(옵트인, M4) — publish 즉시 갱신되게 한다.
     *
     * @param adminEndpoint 알림(관리) 플레인 루트. **배포 플레인/CDN이 아니다.** 프레임은 신호뿐이고
     *   번역 데이터는 여전히 배포 플레인에서 받으므로 플레인 분리는 유지된다(4.1).
     *   폴링이 갱신의 보장선이고 이 채널은 지연 단축용이다 — 둘 다 켜 두는 것이 정상 구성이다.
     */
    @JvmStatic
    fun connectServerPush(adminEndpoint: String) {
        val store = _store ?: return
        val project = _project ?: return
        disconnectServerPush()
        val channel = ServerPushChannel(adminEndpoint, project)
        channel.start(client, store)
        _push = channel
    }

    /** 푸시 구독 해제(백그라운드 전환·로그아웃). */
    @JvmStatic
    fun disconnectServerPush() {
        _push?.stop()
        _push = null
    }

    // --- 익명 집계 텔레메트리 (9.3, 옵트인) ---

    /**
     * 익명 집계 주기 전송 시작(기본 5분). **수집도 옵트인이다** — `configure(telemetry = "aggregate")`
     * 가 아니면 카운트 자체가 쌓이지 않아 보낼 것이 없다.
     *
     * @param adminEndpoint 관리 플레인 루트(업로드는 쓰기 경로라 배포 플레인이 아니다).
     */
    @JvmStatic
    @JvmOverloads
    fun startTelemetry(adminEndpoint: String, intervalMs: Long = 300_000) {
        val project = _project ?: return
        stopTelemetry()
        val reporter = TelemetryReporter(adminEndpoint, project)
        reporter.start(client, intervalMs)
        _reporter = reporter
    }

    /** 주기 전송 중단. 남은 카운트는 다음 [flushTelemetry]에서 함께 나간다. */
    @JvmStatic
    fun stopTelemetry() {
        _reporter?.stop()
        _reporter = null
    }

    /**
     * 지금 한 번 전송한다(백그라운드 전환처럼 확실히 올리고 싶은 시점).
     * [startTelemetry]를 부른 적이 없으면 보낼 곳이 없으므로 true를 돌려주고 아무 일도 하지 않는다.
     */
    suspend fun flushTelemetry(): Boolean = _reporter?.flush(client) ?: true

    /** 테스트·프로젝트 전환용. 캐시까지 비운다. */
    @JvmStatic
    fun reset() = synchronized(this) {
        _push?.stop()
        _reporter?.stop()
        _store?.stopPolling()
        _store?.clearCache()
        _client = null
        _store = null
        _state = null
        _project = null
        _push = null
        _reporter = null
    }

    // --- Android 자원 접근 ---

    private fun packageInfo(context: Context): PackageInfo? =
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0) }.getOrNull()

    @Suppress("DEPRECATION")
    private fun versionCode(info: PackageInfo): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode.toInt() else info.versionCode

    /** 기기 로컬 익명 설치 식별자(8.4). 생성도 보관도 기기 안에서만 한다. */
    private fun installId(context: Context): String {
        val prefs = context.getSharedPreferences("rynl10n", Context.MODE_PRIVATE)
        prefs.getString(KEY_INSTALL_ID, null)?.let { return it }
        val generated = UUID.randomUUID().toString()
        prefs.edit().putString(KEY_INSTALL_ID, generated).apply()
        return generated
    }

    private const val KEY_INSTALL_ID = "installId"
}

/** `Context.getString` 대체(6.2). 리소스 ID가 아니라 `namespace.key`를 받는다. */
fun Context.rynl10n(key: String, args: Map<String, Any?> = emptyMap(), locale: String? = null): String =
    RynL10n.t(key, args, locale)
