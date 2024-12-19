package com.quran.labs.desktop.data.model.selection;

public record SelectionRectangle(float left, float top, float right, float bottom) {

    public float centerX() {
        return left + ((right - left) / 2);
    }

    public float centerY() {
        return top + ((bottom - top) / 2);
    }

    public SelectionRectangle offset(float x, float y) {
        return new SelectionRectangle(left + x, top + y, right + x, bottom + y);
    }
}