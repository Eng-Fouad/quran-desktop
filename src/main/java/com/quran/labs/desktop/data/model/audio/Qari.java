package com.quran.labs.desktop.data.model.audio;

public record Qari(int id, int nameResource, String url, String path, boolean hasGaplessAlternative, String db) {

    public Qari(int id, int nameResource, String url, String path, boolean hasGaplessAlternative) {
        this(id, nameResource, url, path, hasGaplessAlternative, null);
    }

    public String databaseName() {
        return db == null || db.isBlank() ? null : db;
    }

    public boolean isGapless() {
        return databaseName() != null;
    }
}