pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

rootProject.name = "rynl10n-android"

// 루트 = 결정적 코어 + bake CLI(빌드 도구). JVM에 남겨 Android SDK 없이 골든 벡터를 검증한다.
// :library = 배포 아티팩트(AAR). 루트의 코어 소스를 그대로 컴파일해 넣고 Android 바인딩만 더한다(기획서 6.5).
include(":library")
