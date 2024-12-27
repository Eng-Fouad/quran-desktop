package com.quran.labs.desktop.core.errors;

/**
 * Core errors.
 *
 * @author Fouad Almalki
 */
public enum CoreError implements LabelAndCode {
    UNCAUGHT_ERROR("QD-C0000"),

    ;

    private final String code;

    CoreError(String code) {
        this.code = code;
    }

    @Override
    public String label(){return name();}

    @Override
    public String code(){return code;}

    @Override
    public String toString() {
        return "%s (%s)".formatted(label(), code());
    }
}