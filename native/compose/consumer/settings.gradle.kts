pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement {
    repositories {
        maven { url = uri(providers.gradleProperty("motionRepository").get()) }
        google(); mavenCentral()
    }
}
rootProject.name = "motion-compose-consumer"
