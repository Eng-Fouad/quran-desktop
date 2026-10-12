#!/usr/bin/env python3
"""Print the numbers-only metrics table of src/lib/mushaf/printLabels.ts from the committed font.

    python print_label_metrics.py ../../public/fonts/QuranPrintLabels.woff2

Reads only the font (no core.db, no map.json): the vertical metrics, the space advance, and per kind of glyph the
union of the ink boxes (rounded outwards) and the widest advance, in font units (UPM 1000). The margin labels are
grouped by their stacked layout, which follows from the rub number r alone: q = (r - 1) % 4; q = 0 is a hizb start
(«الحِزۡبُ h»), or a juz start («الجُزۡءُ j» / «الحِزۡبُ h») when (r - 1) % 8 = 0; q = 1..3 is a quarter (its word
over «الحِزۡبُ» over h). Paste the output over the `PRINT_METRICS` literal.
"""
from __future__ import annotations

import json
import math
import sys

from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont


def margin_kind(r: int) -> str:
    q = (r - 1) % 4
    if q:
        return f"quarter{q}"
    return "juz" if (r - 1) % 8 == 0 else "hizb"


def main(path: str) -> None:
    font = TTFont(path)
    cmap = font.getBestCmap()
    glyphs = font.getGlyphSet()
    hmtx = font["hmtx"].metrics
    groups: dict[str, list[int]] = {"surah": [], "juz": []}
    groups.update({k: [] for k in ("marginJuz", "marginHizb", "marginQuarter1", "marginQuarter2", "marginQuarter3")})
    for cp in cmap:
        if 0xF602 <= cp <= 0xF600 + 114:
            groups["surah"].append(cp)
        elif 0xF701 <= cp <= 0xF700 + 30:
            groups["juz"].append(cp)
        elif 0xF801 <= cp <= 0xF800 + 240:
            kind = margin_kind(cp - 0xF800)
            groups["margin" + kind[0].upper() + kind[1:]].append(cp)
    out = {
        "unitsPerEm": font["head"].unitsPerEm,
        "ascent": font["hhea"].ascent,
        "descent": -font["hhea"].descent,
        "space": hmtx[cmap[0x20]][0],
    }
    for name, cps in groups.items():
        boxes = []
        for cp in cps:
            pen = BoundsPen(glyphs)
            glyphs[cmap[cp]].draw(pen)
            boxes.append(pen.bounds)
        out[name] = {
            "count": len(cps),
            "yMin": math.floor(min(b[1] for b in boxes)),
            "yMax": math.ceil(max(b[3] for b in boxes)),
            "advance": max(hmtx[cmap[cp]][0] for cp in cps),
        }
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "public/fonts/QuranPrintLabels.woff2")
