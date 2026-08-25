// RynL10n Android SDK — 배포 아티팩트(AAR). 기획서 6.5 배포 채널 확정 사항.
//
// 좌표: com.devryner.rynl10n:android (Maven Central), 버전은 4개 SDK lockstep.
// 코어(직렬화·resolve·매칭·카나리·bake·배포 플레인 HTTP)는 **루트 JVM 모듈의 소스를 그대로 컴파일**해
// 넣는다 — 배포되는 것은 이 AAR 하나뿐이고, 루트는 bake CLI와 골든 벡터 검증을 Android SDK 없이
// 돌리기 위해 JVM으로 남는다.
plugins {
    // 툴체인: AGP 8.7.3 / Gradle 8.11.1 / Kotlin 2.1.0 / JDK 21(툴체인 17).
    // AGP 9는 쓸 수 없다 — Kotlin 컴파일을 내장하면서 KGP가 빌드 classpath에 있는 것 자체와
    // 충돌하는데, 루트 모듈이 kotlin("jvm")을 쓰는 이 저장소 구조가 정확히 그 상태다.
    // 플러그인 버전은 루트에서 선언한다(클래스로더 공유 — 루트 build.gradle.kts 주석 참조).
    id("com.android.library")
    kotlin("android")
    kotlin("plugin.serialization")
    kotlin("plugin.compose")
    `maven-publish`
    signing
}

repositories {
    google()
    mavenCentral()
}

val rynl10nVersion = "0.1.0" // lockstep — ios·web·flutter와 항상 동일(6.5)

android {
    namespace = "com.rynl10n"
    compileSdk = 35

    defaultConfig {
        // java.nio.file.Files(원자적 캐시 교체)가 API 26+ 라 하한이 여기서 정해진다.
        minSdk = 26
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // 코어 소스 공유 — 배포되는 것은 이 AAR 하나뿐이라 코어를 그대로 컴파일해 넣는다.
    // (bake CLI도 같이 컴파일되지만 앱에서 호출되지 않아 R8이 걷어낸다.)
    sourceSets["main"].kotlin.srcDir("../src/main/kotlin")

    testOptions {
        unitTests.all { it.useJUnitPlatform() }
    }

    publishing {
        singleVariant("release") {
            withSourcesJar()
            withJavadocJar()
        }
    }
}


dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    // suspend 표면(RemoteDeliveryStore.update)과 StateFlow 바인딩이 공개 API라 api로 노출한다.
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    api("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    // Compose 어댑터는 Compose를 쓰는 앱에서만 유효하다 → 우리가 Compose를 끌고 들어가지 않는다.
    compileOnly("androidx.compose.runtime:runtime:1.7.6")

    testImplementation("org.junit.jupiter:junit-jupiter:5.11.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

publishing {
    publications {
        register<MavenPublication>("release") {
            groupId = "com.devryner.rynl10n"
            artifactId = "android"
            version = rynl10nVersion

            afterEvaluate { from(components["release"]) }

            pom {
                name.set("RynL10n Android SDK")
                description.set("앱 업데이트·심사 없이 번역을 배포하는 오픈소스 원격 로컬라이제이션 SDK")
                url.set("https://github.com/devryner/RynL10n")
                licenses {
                    license {
                        name.set("Apache License 2.0")
                        url.set("https://www.apache.org/licenses/LICENSE-2.0.txt")
                    }
                }
                developers {
                    developer {
                        id.set("choichiwon")
                        name.set("ChoiChiwon")
                    }
                }
                scm {
                    url.set("https://github.com/devryner/RynL10n")
                    connection.set("scm:git:https://github.com/devryner/RynL10n.git")
                }
            }
        }
    }
}

/**
 * Maven Central 업로드 대상. URL·자격은 **환경에서만** 온다 — 저장소에 박아 두면 계정 종류
 * (레거시 OSSRH / Central Portal)가 바뀔 때 조용히 틀린 곳으로 올라간다. 값이 없으면 리포지토리를
 * 아예 등록하지 않으므로 로컬 개발에서는 `publishToMavenLocal`만 보인다.
 *
 * **빈 문자열도 "없음"이다.** GitHub Actions는 미설정 시크릿을 null이 아니라 빈 문자열로 주입한다
 * (`env:`로 넘긴 `secrets.X`). null만 걸러내면 `uri("")`로 리포지토리가 등록돼, 자격 없는 실행이
 * "리포지토리 미등록"이 아니라 업로드 실패로 나타난다.
 */
val centralUrl: String? = System.getenv("MAVEN_CENTRAL_URL")
if (!centralUrl.isNullOrBlank()) {
    publishing {
        repositories {
            maven {
                name = "mavenCentral"
                url = uri(centralUrl)
                credentials {
                    username = System.getenv("MAVEN_CENTRAL_USERNAME")
                    password = System.getenv("MAVEN_CENTRAL_PASSWORD")
                }
            }
        }
    }
}

/**
 * GPG 서명(6.5 레지스트리 요건). **키가 있을 때만** 활성화한다 — 서명을 무조건 켜면 키가 없는
 * 개발 환경에서 `publishToMavenLocal`과 `assembleRelease`까지 같이 죽는다.
 * 키는 파일이 아니라 **메모리로** 받는다(CI에 개인키 파일을 떨구지 않는다).
 *
 * **빈 문자열도 "없음"이다** — 미설정 시크릿은 빈 문자열로 들어오므로 null만 걸러내면 서명이 켜진 채
 * `useInMemoryPgpKeys("")`가 `Could not read PGP secret key`로 죽는다. 위 문단이 막으려던 바로 그 사고다.
 */
val signingKey: String? = System.getenv("SIGNING_KEY")
if (!signingKey.isNullOrBlank()) {
    signing {
        useInMemoryPgpKeys(signingKey, System.getenv("SIGNING_PASSWORD"))
        sign(publishing.publications)
    }
}

kotlin { jvmToolchain(17) }
