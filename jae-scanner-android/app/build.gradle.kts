import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

val localProps = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use(::load)
}
val ocrBackendUrl = localProps.getProperty(
    "ocr.backend.url",
    "https://jae-ocr-2500276981.europe-west1.run.app"
)
val scannerBackendUrl = localProps.getProperty(
    "scanner.backend.url",
    "https://jae-scanner-2500276981.europe-west1.run.app"
)
val scannerApiKey = localProps.getProperty("scanner.api.key", "")

android {
    namespace = "com.jae.scanner"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.jae.scanner"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.2.0"

        buildConfigField("String", "OCR_BACKEND_URL", "\"$ocrBackendUrl\"")
        buildConfigField("String", "SCANNER_BACKEND_URL", "\"$scannerBackendUrl\"")
        buildConfigField("String", "SCANNER_API_KEY", "\"$scannerApiKey\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material.icons.extended)

    // CameraX (preview, capture, image analysis, flash/torch, tap-to-focus)
    implementation(libs.camerax.core)
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.view)

    // On-device text & MRZ recognition (ML Kit)
    implementation(libs.mlkit.text.recognition)

    // Networking & coroutines
    implementation(libs.okhttp)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.coroutines.play.services)

    testImplementation("junit:junit:4.13.2")
    debugImplementation(libs.androidx.ui.tooling)
}
