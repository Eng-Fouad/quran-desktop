dependencyResolutionManagement {
    versionCatalogs {
        create("deps") {
            version("dockerPluginVersion", "9.4.0") // https://plugins.gradle.org/plugin/com.bmuschko.docker-remote-api
            version("javafxPluginVersion", "0.1.0") // https://plugins.gradle.org/plugin/org.openjfx.javafxplugin
            version("quarkusLibVersion", "3.17.4") // https://central.sonatype.com/artifact/io.quarkus/quarkus-bom
            version("javafxLibVersion", "23.0.1") // https://central.sonatype.com/artifact/org.openjfx/javafx
            version("quarkusFxLibVersion", "0.9.0") // https://central.sonatype.com/artifact/io.quarkiverse.fx/quarkus-fx
            version("controlsFxLibVersion", "11.2.1") // https://central.sonatype.com/artifact/org.controlsfx/controlsfx
            version("ikonliLibVersion", "12.3.1") // https://central.sonatype.com/artifact/org.kordamp.ikonli/ikonli-javafx
            version("jdbiLibVersion", "3.47.0") // https://central.sonatype.com/artifact/org.jdbi/jdbi3-bom
            version("sqliteJdbcLibVersion", "3.47.1.0") // https://central.sonatype.com/artifact/org.xerial/sqlite-jdbc
            version("jacksonLibVersion", "2.18.2") // https://central.sonatype.com/artifact/com.fasterxml.jackson.core/jackson-core
            version("osgiAnnotationLibVersion", "8.1.0") // https://central.sonatype.com/artifact/org.osgi/osgi.annotation

            plugin("docker", "com.bmuschko.docker-remote-api").versionRef("dockerPluginVersion")
            plugin("javafx", "org.openjfx.javafxplugin").versionRef("javafxPluginVersion")
            plugin("quarkus", "io.quarkus").versionRef("quarkusLibVersion")

            library("libs.quarkus.bom", "io.quarkus", "quarkus-bom").versionRef("quarkusLibVersion")
            library("libs.quarkus.rest.client", "io.quarkus", "quarkus-rest-client-jackson").versionRef("quarkusLibVersion")
            library("libs.quarkus.arc", "io.quarkus", "quarkus-arc").versionRef("quarkusLibVersion")
            library("libs.quarkus.agroal", "io.quarkus", "quarkus-agroal").versionRef("quarkusLibVersion")
            library("libs.quarkusFx", "io.quarkiverse.fx", "quarkus-fx").versionRef("quarkusFxLibVersion")
            library("libs.controlsFx", "org.controlsfx", "controlsfx").versionRef("controlsFxLibVersion")
            library("libs.ikonli", "org.kordamp.ikonli", "ikonli-javafx").versionRef("ikonliLibVersion")
            library("libs.ikonli.carbonicons", "org.kordamp.ikonli", "ikonli-carbonicons-pack").versionRef("ikonliLibVersion") // https://kordamp.org/ikonli/cheat-sheet-carbonicons.html
            library("libs.jdbi.sqlobject", "org.jdbi", "jdbi3-sqlobject").versionRef("jdbiLibVersion")
            library("libs.sqlite.jdbc", "org.xerial", "sqlite-jdbc").versionRef("sqliteJdbcLibVersion")
            library("libs.jackson", "com.fasterxml.jackson.core", "jackson-databind").versionRef("jacksonLibVersion")
            library("libs.osgi.annotation", "org.osgi", "osgi.annotation").versionRef("osgiAnnotationLibVersion")
        }
    }
}

rootProject.name = "quran-desktop"