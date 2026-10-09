import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.androidMultiplatformLibrary)
    alias(libs.plugins.composeMultiplatform)
    alias(libs.plugins.composeCompiler)
    alias(libs.plugins.kotlinSerialization)
}

kotlin {
    listOf(
        iosArm64(),
        iosSimulatorArm64()
    ).forEach { iosTarget ->
        iosTarget.binaries.framework {
            baseName = "Shared"
            isStatic = true
        }
    }

    android {
       namespace = "com.antai.archai.shared"
       compileSdk = libs.versions.android.compileSdk.get().toInt()
       minSdk = libs.versions.android.minSdk.get().toInt()

       compilerOptions {
           jvmTarget = JvmTarget.JVM_11
       }
       androidResources {
           enable = true
       }
       withHostTest {
           isIncludeAndroidResources = true
       }
       withDeviceTestBuilder {
           sourceSetTreeName = "test"
       }.configure {
           instrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
       }
    }

    sourceSets {
        androidMain.dependencies {
            implementation(libs.compose.uiToolingPreview)
            implementation(libs.compose.uiTooling)
            implementation(libs.androidx.activity.compose)
            implementation(libs.androidx.webkit)
            implementation(libs.kotlinx.coroutines.android)
        }
        commonMain.dependencies {
            implementation(libs.compose.runtime)
            implementation(libs.compose.foundation)
            implementation(libs.compose.material3)
            implementation(libs.compose.ui)
            implementation(libs.compose.components.resources)
            implementation(libs.compose.uiToolingPreview)
            implementation(libs.androidx.lifecycle.viewmodelCompose)
            implementation(libs.androidx.lifecycle.runtimeCompose)
            implementation(libs.kotlinx.coroutines.core)
            implementation(libs.kotlinx.serialization.json)
        }
        commonTest.dependencies {
            implementation(libs.kotlin.test)
            implementation(libs.kotlinx.coroutines.test)
        }
    }
}

dependencies {
    androidRuntimeClasspath(libs.compose.uiTooling)
}

// ---- The hosted web app ----------------------------------------------------------------------
// The native shells run the ArchAI web build (the repository root, one level up) in a WebView.
// `vite build` output is packaged as Compose resources under files/web/, so Android and iOS both
// ship it without per-platform copy steps. Pass -PskipWebBuild to reuse an existing dist/.

val webRoot: File = rootProject.projectDir.parentFile
val webBundleDir = layout.buildDirectory.dir("generated/archaiWeb")
val skipWebBuild = providers.gradleProperty("skipWebBuild").isPresent

val buildWeb by tasks.registering(Exec::class) {
    description = "Builds the ArchAI web app (npm run build:web) for the native shells."
    group = "archai"
    workingDir = webRoot
    val npm = if (System.getProperty("os.name").lowercase().contains("windows")) "npm.cmd" else "npm"
    commandLine(npm, "run", "build:web")
    // A local copy: the lambda must not capture the build script (configuration cache).
    val skip = skipWebBuild
    onlyIf { !skip }
    inputs.dir(webRoot.resolve("src"))
    inputs.dir(webRoot.resolve("public"))
    inputs.dir(webRoot.resolve("shared"))
    inputs.file(webRoot.resolve("index.html"))
    inputs.file(webRoot.resolve("vite.config.ts"))
    inputs.file(webRoot.resolve("package.json"))
    outputs.dir(webRoot.resolve("dist"))
}

val syncWebBundle by tasks.registering(Sync::class) {
    description = "Copies the web build into the shared module's resources (files/web/)."
    group = "archai"
    dependsOn(buildWeb)
    from(webRoot.resolve("dist")) {
        exclude("**/*.map")
    }
    into(webBundleDir.map { it.dir("files/web") })
}

compose.resources {
    customDirectory(
        sourceSetName = "commonMain",
        // Mapping the task provider makes resource processing depend on the sync.
        directoryProvider = syncWebBundle.map { webBundleDir.get() },
    )
}
