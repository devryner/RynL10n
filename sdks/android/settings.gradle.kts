pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    // AAR의 JDK 17이 없으면 명시한 저장소에서 조달한다. 캐시된 JDK만 우연히 집는 빌드를 피한다.
    id("org.gradle.toolchains.foojay-resolver-convention") version "0.9.0"
}

rootProject.name = "rynl10n-android"

// 루트 = 결정적 코어 + bake CLI(빌드 도구). JVM에 남겨 Android SDK 없이 골든 벡터를 검증한다.
// :library = 배포 아티팩트(AAR). 루트의 코어 소스를 그대로 컴파일해 넣고 Android 바인딩만 더한다(기획서 6.5).
include(":library")
