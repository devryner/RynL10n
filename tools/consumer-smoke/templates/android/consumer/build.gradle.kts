plugins { id("com.android.library"); kotlin("android") }

android {
    namespace = "com.example.rynl10n.smoke"
    compileSdk = 35
    defaultConfig { minSdk = 26 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests.all { it.testLogging { showStandardStreams = true } } }
}

dependencies {
    implementation("com.devryner.rynl10n:android:__VERSION__") // Maven Central 실 좌표

    // 게시된 POM에서 kotlinx-serialization-json은 **runtime 스코프**다(SDK가 implementation으로
    // 쓰므로). 소비자 코드에서 컴파일 타임에 쓰려면 이렇게 직접 선언해야 한다 — 이 스모크가
    // JSON을 읽는 것은 검증 케이스(checks.json) 때문이지 SDK가 요구해서가 아니다.
    testImplementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    testImplementation("junit:junit:4.13.2")
}
