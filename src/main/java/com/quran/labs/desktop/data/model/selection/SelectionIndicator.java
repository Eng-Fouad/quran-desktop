package com.quran.labs.desktop.data.model.selection;

public interface SelectionIndicator {

    SelectionIndicator NONE = new SelectionIndicator(){};
    SelectionIndicator SCROLL_ONLY = new SelectionIndicator(){};

    record SelectedPointPosition(float x, float y, float xScroll, float yScroll) implements SelectionIndicator {
        public SelectedPointPosition(float x, float y) {
            this(x, y, 0f, 0f);
        }
    }

    record SelectedItemPosition(SelectionRectangle firstItem, SelectionRectangle lastItem,
                                float xScroll, float yScroll) implements SelectionIndicator {
        public SelectedItemPosition(SelectionRectangle firstItem, SelectionRectangle lastItem) {
            this(firstItem, lastItem, 0f, 0f);
        }
    }

    default SelectionIndicator withXScroll(float xScroll) {
        if (this instanceof SelectedPointPosition spp) {
            return new SelectedPointPosition(spp.x(), spp.y(), xScroll, spp.yScroll());
        } else if (this instanceof SelectedItemPosition sip) {
            return new SelectedItemPosition(sip.firstItem(), sip.lastItem(), xScroll, sip.yScroll());
        } else {
            return this;
        }
    }

    default SelectionIndicator withYScroll(float yScroll) {
        if (this instanceof SelectedPointPosition spp) {
            return new SelectedPointPosition(spp.x(), spp.y(), spp.xScroll(), yScroll);
        } else if (this instanceof SelectedItemPosition sip) {
            return new SelectedItemPosition(sip.firstItem(), sip.lastItem(), sip.xScroll(), yScroll);
        } else {
            return this;
        }
    }
}