#!/usr/bin/env python3
"""Print the ink table of src/lib/mushaf/suraNames.ts from the decor pack's sura-names face.

    python scripts/sura_names_ink.py data/dev-packs/decor/sura-names.woff2

Needs fontTools and brotli (`pip install -r assets/print-labels/requirements.txt`, in a virtual environment outside the
repository); the font comes from `pnpm dev-packs`. Reads only the font: for each surah n, the glyph mapped from U+E000 +
the zero-padded number read as hex, its advance and the horizontal extent of its ink (the exact bounds of the outline),
in font units. Prints the literals to paste over `SURA_NAMES_SHA256` (which must be the hash the catalog pins for
`sura-names.woff2`), `SURA_NAMES_UPM` and `SURA_NAMES_INK`.
"""
from __future__ import annotations

import hashlib
import sys

from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont


def main(path: str) -> None:
    with open(path, "rb") as f:
        sha = hashlib.sha256(f.read()).hexdigest()
    font = TTFont(path)
    cmap = font.getBestCmap()
    glyphs = font.getGlyphSet()
    hmtx = font["hmtx"].metrics
    rows = []
    for n in range(1, 115):
        name = cmap[0xE000 + int(f"{n:03d}", 16)]
        pen = BoundsPen(glyphs)
        glyphs[name].draw(pen)
        if pen.bounds is None:
            raise SystemExit(f"surah {n}: glyph {name} has no ink")
        x_min, _, x_max, _ = pen.bounds
        rows.append((hmtx[name][0], round(x_min), round(x_max)))
    print(f"export const SURA_NAMES_SHA256 = '{sha}'")
    print(f"export const SURA_NAMES_UPM = {font['head'].unitsPerEm}")
    print("export const SURA_NAMES_INK: readonly SuraNameMetrics[] = [")
    for n, (advance, x_min, x_max) in enumerate(rows, start=1):
        print(f"  [{advance}, {x_min}, {x_max}], // {n}")
    print("]")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
