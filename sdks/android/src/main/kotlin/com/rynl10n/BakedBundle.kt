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
 * 로더 로직 전체가 JVM에서 그대로 테스트된다(AAR 쪽 `Context` 확장은 같은 선택 규칙을 쓴다).
 */
object BakedBundle {

    /** bake 산출물을 찾지 못했거나 디코딩하지 못함. */
    class BakedException(message: String) : Exception(message)

    /** assets 안에서 스냅샷을 찾을 때 시도하는 경로 순서. */
    val ASSET_CANDIDATES: List<String> = listOf("rynl10n/snapshot.json", "snapshot.json")

    /** 번들 선택·진단 기준인 lockfile의 assets 경로 후보. */
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
     * lockfile이 있으면 release·base와 일치하는 번들만 고른다. 없으면 stable-name을 우선하고
     * 내용해시 파일은 하나뿐일 때만 선택한다(파일명 순서는 최신 여부를 말해주지 않는다).
     */
    fun snapshot(directory: File): Snapshot {
        val file = locate(directory)
            ?: throw BakedException(
                """
                [rynl10n] ${directory.path} 에서 bake된 스냅샷을 찾지 못했습니다.
                확인: ① 앱 모듈의 preBuild가 rynl10nBake 에 의존하는지
                ② 태스크 출력이 assets(-Pout=src/main/assets -PstableName=true)로 향하는지
                ③ 에어갭이면 vendored 스냅샷이 그 자리에 있는지
                ④ rynl10n.lock의 release·base와 일치하는 번들이 있는지(복수 내용해시는 lockfile 필요).
                """.trimIndent()
            )
        return snapshot(file.inputStream(), file.path)
    }

    /** 디렉토리 안의 bake 산출물 위치. 의도한 번들이 없거나 후보가 모호하면 null. */
    fun locate(directory: File): File? {
        val candidates = ASSET_CANDIDATES.map { File(directory, it) }.filter { it.isFile } +
            listOf(File(directory, "rynl10n"), directory).flatMap { dir ->
                dir.listFiles()?.filter { it.isFile && it.name.startsWith("snapshot-") && it.name.endsWith(".json") }
                    ?.sortedBy { it.name } ?: emptyList()
            }
        return select(candidates.map { it.path }, lockfile(directory)) { path ->
            runCatching { snapshot(File(path).inputStream(), path) }.getOrNull()
        }?.let { File(it) }
    }

    /** 파일 시스템과 AssetManager가 같은 규칙으로 고른다. lockfile 값을 경로로 조합하지 않는다. */
    internal fun select(candidates: List<String>, lock: Bake.Lockfile?, read: (String) -> Snapshot?): String? {
        if (lock != null) return candidates.firstOrNull { path ->
            read(path)?.let { it.base == lock.base && it.release == lock.release } == true
        }
        return candidates.firstOrNull { it.substringAfterLast('/').substringAfterLast('\\') == "snapshot.json" }
            ?: candidates.singleOrNull()
    }

    /**
     * bake lockfile(`rynl10n.lock`) 판독 — 번들 선택·진단의 release·base 기준. 없거나 깨지면 null.
     */
    fun lockfile(stream: InputStream): Bake.Lockfile? {
        return runCatching {
            val text = stream.use { it.readBytes().toString(Charsets.UTF_8) }
            json.decodeFromString<LockfileWire>(text)
        }.getOrNull()
            ?.let { Bake.Lockfile(it.schemaVersion, it.release, it.base, it.keyCount, it.locales) }
    }

    /** 디렉토리에서 lockfile을 찾아 읽는다. 없으면 null. */
    fun lockfile(directory: File): Bake.Lockfile? {
        val file = LOCKFILE_CANDIDATES.map { File(directory, it) }.firstOrNull { it.isFile } ?: return null
        return runCatching { lockfile(file.inputStream()) }.getOrNull()
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
