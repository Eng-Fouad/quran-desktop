plugins {
    java
    alias(deps.plugins.quarkus)
    alias(deps.plugins.javafx)
    alias(deps.plugins.docker)
}

group = "com.quran.labs.desktop"
version = "0.1"

repositories {
    flatDir {
        dirs("${project.projectDir}/libs")
    }
    mavenLocal()
    mavenCentral()
}

dependencies {
    implementation(platform(deps.libs.quarkus.bom))
    implementation(deps.libs.quarkus.rest.client)
    implementation(deps.libs.quarkus.arc)
    implementation(deps.libs.quarkus.agroal)
    implementation(deps.libs.quarkus.container.image.docker)
    implementation(deps.libs.quarkusFx)
    implementation(deps.libs.controlsFx)
    implementation(deps.libs.ikonli)
    implementation(deps.libs.ikonli.carbonicons)
    implementation(deps.libs.jdbi.sqlobject)
    implementation(deps.libs.sqlite.jdbc)
    implementation(deps.libs.jackson)
    implementation("org.osgi:org.osgi.framework:1.10.0")
    compileOnly(files("libs/scenicview.jar"))
    quarkusDev(files("libs/scenicview.jar"))
}

tasks.compileJava {
    options.encoding = "UTF-8"
    options.compilerArgs = listOf("-parameters", "-Xdoclint:none", "-Xlint:all", "-Xlint:-exports",
                                  "-Xlint:-serial", "-Xlint:-try", "-Xlint:-requires-transitive-automatic",
                                  "-Xlint:-requires-automatic", "-Xlint:-missing-explicit-ctor")
}

tasks.compileTestJava {
    options.encoding = "UTF-8"
    options.compilerArgs = listOf("-parameters", "-Xdoclint:none", "-Xlint:all", "-Xlint:-exports",
                                  "-Xlint:-serial", "-Xlint:-try", "-Xlint:-requires-transitive-automatic",
                                  "-Xlint:-requires-automatic", "-Xlint:-missing-explicit-ctor")
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(25))
    }
}

javafx {
    version = deps.versions.javafxLibVersion.get()
    modules = listOf("javafx.controls", "javafx.fxml", "javafx.web")
}

tasks.test {
    useJUnitPlatform()
}

configurations.matching { it.name.contains("download", true) }
    .configureEach {
        attributes {
            val os = org.gradle.nativeplatform.platform.internal.DefaultNativePlatform.getCurrentOperatingSystem().toFamilyName()
            val arch = org.gradle.nativeplatform.platform.internal.DefaultNativePlatform.getCurrentArchitecture().name
            attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage::class, Usage.JAVA_RUNTIME))
            attribute(OperatingSystemFamily.OPERATING_SYSTEM_ATTRIBUTE, objects.named(OperatingSystemFamily::class, os))
            attribute(MachineArchitecture.ARCHITECTURE_ATTRIBUTE, objects.named(MachineArchitecture::class, arch))
        }
    }

configurations.matching {
    it.isCanBeResolved && it.name.contains("quarkus")
}.configureEach {
    val runtimeAttributes = configurations.runtimeClasspath.get().attributes
    runtimeAttributes.keySet().forEach { key ->
        @Suppress("UNCHECKED_CAST")
        attributes.attribute(key as Attribute<Any>, runtimeAttributes.getAttribute(key) as Any)
    }
}

val devEnvironmentVariables = emptyMap<String, String>()
val devSystemProperties = mutableMapOf<String, String>()

if (org.apache.tools.ant.taskdefs.condition.Os.isFamily(org.apache.tools.ant.taskdefs.condition.Os.FAMILY_WINDOWS)) {
    devSystemProperties.put("java.library.path", "${project.projectDir}/src/main/resources/win/")
}

tasks.quarkusDev {
    doFirst {
        System.setProperty("quarkus.analytics.disabled", "true")
    }
    workingDirectory.set(project.projectDir)
    environmentVariables.putAll(devEnvironmentVariables)
    devSystemProperties.forEach { jvmArguments.add("-D${it.key}=${it.value}") }
}

quarkus {
    //set("package.jar.enabled", "true")
    //set("native.enabled", "false")

    set("package.jar.enabled", "false")
    set("native.enabled", "true")

    //set("package.jar.enabled", "false")
    //set("native.enabled", "true")
    //set("native.container-build", "true")
    //set("native.container-runtime", "docker")
    //set("native.builder-image", deps.versions.quarkusGraalvmceBuilderImage.get())
    //set("container-image.build", "true")
}