package com.quran.labs.desktop.tasks;

import io.quarkus.arc.Unremovable;
import jakarta.enterprise.context.Dependent;
import javafx.concurrent.Task;

@Dependent
@Unremovable
public class PreparingDataTask extends Task<Void> {

    @Override
    protected Void call() throws Exception {
        // TODO: check all required files exist
        // TODO: load database files
        return null;
    }
}