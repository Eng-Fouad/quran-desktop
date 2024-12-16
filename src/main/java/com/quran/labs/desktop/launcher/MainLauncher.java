package com.quran.labs.desktop.launcher;

import io.quarkiverse.fx.FxApplication;
import io.quarkus.runtime.Quarkus;
import io.quarkus.runtime.QuarkusApplication;
import io.quarkus.runtime.annotations.QuarkusMain;
import javafx.application.Application;

/// The main entry point for launching the application.
///
/// @author Fouad Almalki
@QuarkusMain
public class MainLauncher implements QuarkusApplication {

    @Override
    public int run(String... args) {
        Application.launch(FxApplication.class, args);
        return 0;
    }

    public static void main(String[] args) {
        Quarkus.run(MainLauncher.class);
    }
}