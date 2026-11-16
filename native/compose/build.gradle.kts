plugins {
    kotlin("multiplatform") version "2.2.21"
    id("com.android.library") version "8.13.2"
    `maven-publish`
}

group = "pics.lab"
version = providers.gradleProperty("publicationVersion").orElse("0.1.0").get()

kotlin {
    jvm("desktop")
    androidTarget {
        publishLibraryVariants("release")
        compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
    iosArm64()
    iosSimulatorArm64()
    jvmToolchain(21)
    targets.withType<org.jetbrains.kotlin.gradle.targets.jvm.KotlinJvmTarget>().configureEach {
        compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
    sourceSets {
        commonMain.dependencies {
            api("org.jetbrains.compose.animation:animation-core:1.12.2")
            api("org.jetbrains.compose.runtime:runtime:1.12.2")
            api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
        }
    }
}
tasks.withType<org.jetbrains.kotlin.gradle.targets.native.tasks.KotlinNativeSimulatorTest>().configureEach {
    providers.gradleProperty("iosSimulatorDevice").orNull?.let { device = it }
}
android {
    namespace = "pics.lab.motion"
    compileSdk = 36
    defaultConfig { minSdk = 33 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
publishing {
    repositories {
        maven {
            name = "distribution"
            url = uri(providers.gradleProperty("publicationRepository").orElse(layout.buildDirectory.dir("repository").map { it.asFile.path }))
        }
    }
    publications.withType<MavenPublication>().configureEach {
        pom {
            name = "Lab Motion for Compose"
            description = "Interruptible declarative motion on a shared Compose frame clock"
            url = "https://github.com/Labpics-Team/lab-motion"
            licenses { license { name = "MIT"; url = "https://opensource.org/license/mit" } }
            scm { url = "https://github.com/Labpics-Team/lab-motion" }
        }
    }
}
