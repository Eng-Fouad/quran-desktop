package com.quran.labs.desktop.launcher;

import io.quarkiverse.fx.QuarkusFxApplication;
import io.quarkus.runtime.Quarkus;
import io.quarkus.runtime.QuarkusApplication;
import io.quarkus.runtime.annotations.QuarkusMain;

/// The main entry point for launching the application.
///
/// @author Fouad Almalki
@QuarkusMain
public class MainLauncher implements QuarkusApplication {

    @Override
    public int run(String... args) {
        // the quarkus-fx launcher starts the JavaFX toolkit on the main thread in macOS native executables
        return new QuarkusFxApplication().run(args);
    }

    public static void main(String[] args) {
        Quarkus.run(MainLauncher.class);
    }
}