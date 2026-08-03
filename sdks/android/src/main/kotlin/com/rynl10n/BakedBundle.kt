package com.rynl10n

import kotlinx.serialization.json.Json
import java.io.File
import java.io.InputStream

/**
 * 빌드타임에 구운 번들 스냅샷을 런타임에 로드한다 — 기획서 3.2 / 6.3 (차별점 ①의 마지막 구간).
 *
 * `rynl10nBake` Gradle 태스크가 빌드마다 `snapshot.json` + `rynl10n.lock`을 앱 모듈의 `assets/`에
 * 넣는다(`-Pout=src/main/assets -PstableName=true` → `assets/rynl10n/snapshot.json`).
 * 이 타입은 그 산출물을 찾아 [Snapshot]으로 되돌리는 표준 경로다.
 *
 * 여기에는 **Android API가 하나도 들어 있지 않다** — `AssetManager`는 스트림만 넘겨주면 되므로
 * 로더 로직 전체가 JVM에서 그대로 테스트된다(AAR 쪽 `Context` 확장은 이 함수를 감싸는 세 줄이다).
 */
object BakedBundle {

    /** bake 산출물을 찾지 못했거나 디코딩하지 못함. */
    class BakedException(message: String) : Exception(message)

    /** assets 안에서 스냅샷을 찾을 때 시도하는 경로 순서. */
    val ASSET_CANDIDATES: List<String> = listOf("rynl10n/snapshot.json", "snapshot.json")

    /** lockfile(진단용) assets 경로 후보. */
    val LOCKFILE_CANDIDATES: List<String> = listOf("rynl10n/rynl10n.lock", "rynl10n.lock")

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * 열린 스트림에서 스냅샷을 읽는다(Android는 `assets.open(...)`, JVM은 파일 스트림).
     * 스트림은 이 함수가 닫는다.
     */
    fun snapshot(stream: InputStream, source: String = "stream"): Snapshot {
        val text = stream.use { it.readBytes().toString(Charsets.UTF_8) }
        return runCatching { json.decodeFromString<Snapshot>(text) }.getOrNull()
            ?: throw BakedException("[rynl10n] 번들 스냅샷을 디코딩하지 못했습니다: $source")
    }

    /**
     * 디렉토리에서 bake 산출물을 찾아 읽는다(vendored 배치·JVM 소비자용).
     *
     * 탐색 순서 — ① `rynl10n/snapshot.json` ② `snapshot.json`(둘 다 `--stable-name` 산출물)
     * ③ `snapshot-<base>.json`(CLI 기본, 내용해시 파일명).
     */
    fun snapshot(directory: File): Snapshot {
        val file = locate(directory)
            ?: throw BakedException(
                """
                [rynl10n] ${directory.path} 에서 bake된 스냅샷을 찾지 못했습니다.
                확인: ① 앱 모듈의 preBuild가 rynl10nBake 에 의존하는지
                ② 태스크 출력이 assets(-Pout=src/main/assets -PstableName=true)로 향하는지
                ③ 에어갭이면 vendored 스냅샷이 그 자리에 있는지.
                """.trimIndent()
            )
        return snapshot(file.inputStream(), file.path)
    }

    /** 디렉토리 안의 bake 산출물 위치. 못 찾으면 null. */
    fun locate(directory: File): File? {
        for (candidate in ASSET_CANDIDATES) {
            val file = File(directory, candidate)
            if (file.isFile) return file
        }
        // 내용해시 파일명(`snapshot-<base>.json`) — CLI를 --stable-name 없이 돌린 경우.
        for (dir in listOf(File(directory, "rynl10n"), directory)) {
            val hit = dir.listFiles()
                ?.filter { it.isFile && it.name.startsWith("snapshot-") && it.name.endsWith(".json") }
                ?.minByOrNull { it.name }
            if (hit != null) return hit
        }
        return null
    }

    /**
     * bake lockfile(`rynl10n.lock`) 판독 — 어느 릴리스·base가 이 빌드에 구워졌는지 진단용.
     * 런타임 동작에는 쓰이지 않는다(스냅샷 자신이 `release`·`base`를 들고 있다). 없으면 null.
     */
    fun lockfile(stream: InputStream): Bake.Lockfile? {
        val text = stream.use { it.readBytes().toString(Charsets.UTF_8) }
        return runCatching { json.decodeFromString<LockfileWire>(text) }.getOrNull()
            ?.let { Bake.Lockfile(it.schemaVersion, it.release, it.base, it.keyCount, it.locales) }
    }

    /** 디렉토리에서 lockfile을 찾아 읽는다. 없으면 null. */
    fun lockfile(directory: File): Bake.Lockfile? {
        val file = LOCKFILE_CANDIDATES.map { File(directory, it) }.firstOrNull { it.isFile } ?: return null
        return lockfile(file.inputStream())
    }

    /** [Bake.Lockfile]은 직렬화 대상이 아니라 빌더 산출 모델이라, 판독용 와이어 타입을 따로 둔다. */
    @kotlinx.serialization.Serializable
    private data class LockfileWire(
        val schemaVersion: Int,
        val release: String,
        val base: String,
        val keyCount: Int,
        val locales: List<String>,
    )
}
