plugins { id("com.android.library"); kotlin("android"); kotlin("plugin.compose") }
android {
 namespace = "guide.check"
 compileSdk = 35
 defaultConfig { minSdk = 26 }
 compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
 buildFeatures { compose = true }
 testOptions { unitTests.isIncludeAndroidResources = true }
}
kotlin { jvmToolchain(17) }
__ANDROID_DEPENDENCY__

dependencies {
 implementation("androidx.activity:activity-ktx:1.9.3")
 implementation("androidx.lifecycle:lifecycle-process:2.8.7")
 implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
 implementation("androidx.compose.material3:material3:1.3.1")
 testImplementation("junit:junit:4.13.2")
 testImplementation("androidx.compose.ui:ui-test-junit4:1.7.6")
 debugImplementation("androidx.compose.ui:ui-test-manifest:1.7.6")
 testImplementation("org.robolectric:robolectric:4.14.1")
 testImplementation("androidx.test:core:1.6.1")
}

__ANDROID_RESOURCES__
