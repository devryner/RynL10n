// RynL10n Android SDK 코어 — 순수 Kotlin/JVM.
// 배포 아티팩트는 :library(AAR) 하나이고(기획서 6.5), 이 모듈은 배포하지 않는다.
// 여기 남는 이유는 두 가지다: ① bake CLI(빌드 도구)를 JVM에서 실행 ② 골든 벡터 정합 검증을
// Android SDK 없이 돌린다. :library가 이 모듈의 src/main/kotlin을 그대로 컴파일해 AAR에 넣는다.
// 코어 알고리즘은 M0 TS 참조 구현과 골든 벡터(fixtures/golden)로 정합성 검증.
plugins {
    kotlin("jvm") version "2.1.0"
    kotlin("plugin.serialization") version "2.1.0"
    // :library(AAR)가 쓰는 AGP를 여기서 선언만 해 둔다(적용은 하지 않음).
    // 루트에서 선언해야 KGP와 AGP가 같은 buildscript 클래스로더에 올라간다 —
    // 서브프로젝트에서만 버전을 지정하면 KGP가 AGP 클래스를 보지 못해 적용 단계에서 깨진다.
    id("com.android.library") version "8.7.3" apply false
    // Compose 어댑터(:library의 Compose.kt) 컴파일용. Kotlin 2.x부터 Compose 컴파일러는 KGP에 속한다.
    kotlin("plugin.compose") version "2.1.0" apply false
}

repositories { mavenCentral() }

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0") // StateFlow 바인딩(6.2)
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

kotlin { jvmToolchain(21) }

// bake CLI는 `java.net.http`(JDK 11+)를 쓰는 빌드 도구다 — Android 런타임에는 없는 API라
// AAR에 들어가면 안 된다. 그래서 소스셋을 나눠 이 모듈에서만 컴파일한다.
sourceSets["main"].kotlin.srcDir("src/cli/kotlin")

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
