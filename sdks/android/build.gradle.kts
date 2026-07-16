// RynL10n Android SDK 코어 (M1 α) — 순수 Kotlin/JVM 공통 코어.
// Android 특화 바인딩(Context.getString 래퍼·StateFlow)은 AGP 필요 → 별도 모듈로 추후.
// 코어 알고리즘은 M0 TS 참조 구현과 골든 벡터(fixtures/golden)로 정합성 검증.
plugins {
    kotlin("jvm") version "2.1.0"
    kotlin("plugin.serialization") version "2.1.0"
}

repositories { mavenCentral() }

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

kotlin { jvmToolchain(21) }

tasks.test {
    useJUnitPlatform()
    testLogging { events("passed", "failed", "skipped") }
}

// 빌드타임 자동 번들링(6.3) — 현재 릴리스 스냅샷을 SDK 번들 리소스로 bake.
// 실제 프로젝트에서는 android { } 빌드 그래프에 preBuild 의존으로 엮인다(M1 α는 수동 실행 태스크).
// 사용: gradle rynl10nBake -Psource=<snapshot.json> -Pout=<dir> [-Pstrict=true]
tasks.register<JavaExec>("rynl10nBake") {
    group = "rynl10n"
    description = "현재 릴리스 스냅샷을 SDK 번들(snapshot-<base>.json)+lockfile로 bake"
    classpath = sourceSets["main"].runtimeClasspath
    mainClass.set("com.rynl10n.BakeCliKt")
    val source = (project.findProperty("source") as String?) ?: "release-snapshot.json"
    val out = (project.findProperty("out") as String?) ?: layout.buildDirectory.dir("rynl10n-bundle").get().asFile.path
    val strict = (project.findProperty("strict") as String?) == "true"
    val emitNative = (project.findProperty("emitNative") as String?) == "true"
    val fetch = project.findProperty("fetch") as String?   // 서버 스냅샷 URL(6.3)
    val cache = project.findProperty("cache") as String?   // 마지막 캐시 경로(fetch 실패 시)
    val token = project.findProperty("token") as String?
    val stableName = (project.findProperty("stableName") as String?) == "true"
    args = buildList {
        if (fetch != null) { add("--fetch"); add(fetch) } else add(source)
        add(out)
        if (cache != null) { add("--cache"); add(cache) }
        if (token != null) { add("--token"); add(token) }
        if (strict) add("--strict")
        if (emitNative) add("--emit-native")
        if (stableName) add("--stable-name")
    }
}
