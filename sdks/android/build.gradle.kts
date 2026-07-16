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
