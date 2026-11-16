plugins {
    kotlin("jvm") version "2.2.21"
    kotlin("plugin.compose") version "2.2.21"
    id("org.jetbrains.compose") version "1.12.2"
    application
}
kotlin { jvmToolchain(21) }
dependencies {
    implementation("pics.lab:motion-compose:${providers.gradleProperty("motionVersion").orElse("0.1.0").get()}")
    implementation(compose.desktop.currentOs)
    implementation(compose.foundation)
}
application { mainClass = "pics.lab.motion.consumer.MainKt" }
