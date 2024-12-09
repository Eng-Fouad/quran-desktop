dependencyResolutionManagement {
    versionCatalogs {
        create("deps") {
            version("dockerPluginVersion", "9.4.0") // https://plugins.gradle.org/plugin/com.bmuschko.docker-remote-api
            version("javafxPluginVersion", "0.1.0") // https://plugins.gradle.org/plugin/org.openjfx.javafxplugin
            version("quarkusLibVersion", "3.17.3") // https://central.sonatype.com/artifact/io.quarkus/quarkus-bom
            version("javafxLibVersion", "23.0.1") // https://central.sonatype.com/artifact/org.openjfx/javafx
            version("quarkusFxLibVersion", "0.9.0") // https://central.sonatype.com/artifact/io.quarkiverse.fx/quarkus-fx
            version("controlsFxLibVersion", "11.2.1") // https://central.sonatype.com/artifact/org.controlsfx/controlsfx
            version("jacksonLibVersion", "2.18.2") // https://central.sonatype.com/artifact/com.fasterxml.jackson.core/jackson-core
            version("osgiAnnotationLibVersion", "8.1.0") // https://central.sonatype.com/artifact/org.osgi/osgi.annotation

            plugin("docker", "com.bmuschko.docker-remote-api").versionRef("dockerPluginVersion")
            plugin("javafx", "org.openjfx.javafxplugin").versionRef("javafxPluginVersion")
            plugin("quarkus", "io.quarkus").versionRef("quarkusLibVersion")

            library("libs.quarkus.bom", "io.quarkus", "quarkus-bom").versionRef("quarkusLibVersion")
            library("libs.quarkus.rest.client", "io.quarkus", "quarkus-rest-client-jackson").versionRef("quarkusLibVersion")
            library("libs.quarkus.arc", "io.quarkus", "quarkus-arc").versionRef("quarkusLibVersion")
            library("libs.quarkus.grpc", "io.quarkus", "quarkus-grpc").versionRef("quarkusLibVersion")
            library("libs.quarkusFx", "io.quarkiverse.fx", "quarkus-fx").versionRef("quarkusFxLibVersion")
            library("libs.controlsFx", "org.controlsfx", "controlsfx").versionRef("controlsFxLibVersion")
            library("libs.jackson", "com.fasterxml.jackson.core", "jackson-databind").versionRef("jacksonLibVersion")
            library("libs.osgi.annotation", "org.osgi", "osgi.annotation").versionRef("osgiAnnotationLibVersion")
        }
    }
}

rootProject.name = "quran-desktop"