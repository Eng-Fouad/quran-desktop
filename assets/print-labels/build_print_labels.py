#!/usr/bin/env python3
"""Build the "Quran Print Labels" OpenType (CFF) font.

The font carries the non-Quranic page furniture of the KFGQPC 1441H Madinah
print as outlines cut from vector artwork: the running heads «سُورَةُ name» and
«الجُزۡءُ …», the stacked margin rub/hizb/juz labels, the single label words and
the Eastern Arabic digits. Outlines come from the Mushaf Database
"Ligature-Based SVG Mushaf" V1.01 (one SVG per printed page, absolute "M"
sub-paths, nonzero fill, viewBox 0 0 382.68 547.09).

Inputs are read-only data; nothing from them is executed.

  --pages DIR            NNN.svg (or pN.svg) pages; any subset of 1..604
  --db FILE              core.db of the app (SQLite, opened read-only): page
                         ranges of mushaf 1, ayah flags, surah names
  --license FILE         LICENSE of the SVG dataset (embedded in the name table)
  --out DIR              output directory
  --reference-pages DIR  optional pages used ONLY to check composed glyphs in
                         the QA pages (never used for outlines)

Outputs: QuranPrintLabels.otf, map.json (every glyph: kind, key, code point,
source), report.json (checks and measurements) and qa-*.html (QA sheets that
load the font through @font-face; render them with any browser).

Code points (fixed scheme):
  U+0660..U+0669   Eastern Arabic digits cut from the margin labels
  U+F500..U+F505   words رُبُع نِصۡف ثَلَاثَةُ أَرۡبَاعِ الحِزۡبُ الجُزۡءُ سُورَةُ
  U+F600 + n       running head «سُورَةُ name» of surah n (2..114)
  U+F700 + j       running head «الجُزۡءُ …» of juz j (1..30)
  U+F800 + r       stacked margin label of rub r (1..240)

Geometry (all deterministic):
  * One scale for every glyph: 1 SVG unit = SCALE font units (UPM 1000), so the
    print's relative sizes survive. The single words and digits are the only
    exception: they are normalised to the size of the rub labels' «الحِزۡبُ»
    (the print sets the fraction words, the juz-label words and «سُورَةُ» at
    other sizes), so they compose into one-line labels.
  * Header glyphs share one baseline: the running-head baseline of the page
    band (median bottom of the alef of «الجُزۡءُ»); same transform for all.
  * Margin labels are anchored on the baseline (alef bottom) of their
    «الحِزۡبُ» word; words and digits use the same baseline.
  * Labels and words get SIDE font units of side bearing; digits keep the
    print's spacing (side bearings fitted to the printed numbers).
  * Margin labels whose page is missing are composed from the cut words and
    digits with the layout measured on the real labels; the composer is also
    run for the real ones and compared (report.json, qa-margin.html).
"""
from __future__ import annotations

import argparse
import html
import json
import math
import re
import sqlite3
import statistics
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.svgLib.path import parse_path
from fontTools.ttLib import TTFont

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------

FAMILY = "Quran Print Labels"
PS_NAME = "QuranPrintLabels-Regular"
VERSION = "1.000"
UPM = 1000
SCALE = 40.0          # font units per SVG user unit (every glyph kind)
SIDE = 50             # side bearing of labels and words (0.05 em)
# Fixed head.created/modified (2026-10-11T00:00:00Z, seconds since 1904) so
# that the output is byte-for-byte reproducible.
TIMESTAMP = 3874521600

CP_DIGIT0, CP_WORD, CP_SURAH, CP_JUZ, CP_RUB = 0x0660, 0xF500, 0xF600, 0xF700, 0xF800

SOURCE_TEXT = ("Outlines from the Mushaf Database Ligature-Based SVG Mushaf V1.01, "
               "derived from the King Fahd Glorious Qur'an Printing Complex printing-use "
               "Madinah Mushaf; used under the Mushaf Database open permission")
URL_DATASET = "https://mushafdatabase.com/"
URL_ARTWORK = "https://dm.qurancomplex.gov.sa/"

G_SURAH, G_JUZ, G_MARGIN = ("md-non-quranic-header-surah-name", "md-non-quranic-header-juz-name",
                            "md-non-quranic-margin-juz-hisb")
SVG_NS = "{http://www.w3.org/2000/svg}"

HEADER_LABEL_GAP = 6.0   # x gap separating two «سُورَةُ …» labels on one page (in-label gaps < 2)
MARGIN_BLOCK_GAP = 3.0   # y gap separating two stacked labels in one margin group (in-label < 2)
MATCH_TOL = 0.3          # template matching tolerance (SVG units; data is quantised to 0.1)
HEADER_TOL = 0.5         # running heads: a few pages redraw the shared word slightly

# The running head names the surah(s) that start on the page, or the running
# surah when none starts. Two pages of the print deviate from that rule; their
# headers were checked visually (qa-surah.html shows core.db's name beside
# every glyph).
HEADER_OVERRIDES = {
    578: (75,),   # 75:20–76:5: the print names only القيامة, not الإنسان (starts line 10)
    587: (82,),   # 82:1–83:4: the print names only الانفطار, not المطففين (starts line 12)
}

# Words: key, code point offset, plain text (for map.json / accessibility)
WORDS = [("rub", 0, "رُبُع"), ("nisf", 1, "نِصۡف"), ("thalatha", 2, "ثَلَاثَةُ أَرۡبَاعِ"),
         ("hizb", 3, "الحِزۡبُ"), ("juz", 4, "الجُزۡءُ"), ("surah", 5, "سُورَةُ")]
JUZ_ORDINALS = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس", "السابع", "الثامن",
                "التاسع", "العاشر", "الحادي عشر", "الثاني عشر", "الثالث عشر", "الرابع عشر",
                "الخامس عشر", "السادس عشر", "السابع عشر", "الثامن عشر", "التاسع عشر", "العشرون",
                "الحادي والعشرون", "الثاني والعشرون", "الثالث والعشرون", "الرابع والعشرون",
                "الخامس والعشرون", "السادس والعشرون", "السابع والعشرون", "الثامن والعشرون",
                "التاسع والعشرون", "الثلاثون"]
EASTERN = "٠١٢٣٤٥٦٧٨٩"


def eastern(n: int) -> str:
    return "".join(EASTERN[int(c)] for c in str(n))


class BuildError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# Geometry
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Contour:
    """One closed sub-path: pen operations with absolute points, and its exact bounds."""
    ops: tuple
    bbox: tuple

    @staticmethod
    def from_ops(ops) -> "Contour":
        bp = BoundsPen(None)
        for op, pts in ops:
            getattr(bp, op)(*pts)
        return Contour(tuple(ops), bp.bounds)

    x0 = property(lambda s: s.bbox[0])
    y0 = property(lambda s: s.bbox[1])
    x1 = property(lambda s: s.bbox[2])
    y1 = property(lambda s: s.bbox[3])
    w = property(lambda s: s.bbox[2] - s.bbox[0])
    h = property(lambda s: s.bbox[3] - s.bbox[1])
    cx = property(lambda s: (s.bbox[0] + s.bbox[2]) / 2)
    cy = property(lambda s: (s.bbox[1] + s.bbox[3]) / 2)

    def map(self, sx: float, sy: float, tx: float, ty: float) -> "Contour":
        """Affine map x' = sx*x + tx, y' = sy*y + ty."""
        ops = tuple((op, tuple((sx * x + tx, sy * y + ty) for x, y in pts)) for op, pts in self.ops)
        x0, y0, x1, y1 = self.bbox
        xs, ys = sorted((sx * x0 + tx, sx * x1 + tx)), sorted((sy * y0 + ty, sy * y1 + ty))
        return Contour(ops, (xs[0], ys[0], xs[1], ys[1]))

    def shift(self, dx: float, dy: float) -> "Contour":
        return self.map(1, 1, dx, dy)


def parse_contours(d: str) -> list[Contour]:
    """Split SVG path data into contours (one per moveTo)."""
    rp = RecordingPen()
    parse_path(d, rp)
    out, cur = [], None
    for op, pts in rp.value:
        if op == "moveTo":
            cur = [(op, pts)]
            out.append(cur)
        elif op in ("lineTo", "curveTo", "qCurveTo", "closePath", "endPath"):
            if cur is None:
                raise BuildError("path data does not start with a moveto")
            cur.append(("closePath", ()) if op == "endPath" else (op, pts))
        else:
            raise BuildError(f"unexpected pen operation {op}")
    return [Contour.from_ops(c) for c in out]


def union(cs) -> tuple:
    cs = list(cs)
    if not cs:
        raise BuildError("bounds of an empty contour set")
    return (min(c.x0 for c in cs), min(c.y0 for c in cs), max(c.x1 for c in cs), max(c.y1 for c in cs))


def shift_all(cs, dx, dy):
    return [c.shift(dx, dy) for c in cs]


def map_all(cs, sx, sy, tx, ty):
    return [c.map(sx, sy, tx, ty) for c in cs]


def svg_path(cs) -> str:
    pen = SVGPathPen(None, ntos=lambda v: ("%.2f" % v).rstrip("0").rstrip("."))
    for c in cs:
        for op, pts in c.ops:
            getattr(pen, op)(*pts)
    return pen.getCommands()


def split_runs(cs, key0, key1, gap):
    """Group contours whose [key0, key1] intervals are closer than `gap`; sorted by key0."""
    groups = []
    for c in sorted(cs, key=lambda c: (key0(c), key1(c))):
        if groups and key0(c) <= groups[-1][1] + gap:
            groups[-1][0].append(c)
            groups[-1][1] = max(groups[-1][1], key1(c))
        else:
            groups.append([[c], key1(c)])
    return [g[0] for g in groups]


def x_runs(cs, gap):
    return split_runs(cs, lambda c: c.x0, lambda c: c.x1, gap)


def y_runs(cs, gap):
    return split_runs(cs, lambda c: c.y0, lambda c: c.y1, gap)


def rel_box(c: Contour, a: Contour) -> tuple:
    return (c.x0 - a.x1, c.y0 - a.y1, c.x1 - a.x1, c.y1 - a.y1)


def box_dist(p, q) -> float:
    return max(abs(u - v) for u, v in zip(p, q))


def common_template(instances, anchor_of, tol=MATCH_TOL, exclude=None, quorum=1.0):
    """Contours of instances[0] present (same place relative to the anchor) in the other instances.

    Used to cut words that recur identically (e.g. «الحِزۡبُ» in every rub
    label): what varies between instances (numbers, names) drops out. A
    contour is kept when at least `quorum` of the other instances have it.
    Returns relative boxes and the reference contours.
    """
    if len(instances) < 2:
        raise BuildError("a word template needs at least two instances")
    exclude = exclude or [set() for _ in instances]
    refs = []
    a0 = anchor_of(instances[0])
    for c in instances[0]:
        if id(c) in exclude[0]:
            continue
        rb = rel_box(c, a0)
        hits = 0
        for inst, ex in zip(instances[1:], exclude[1:]):
            a = anchor_of(inst)
            hits += any(box_dist(rel_box(o, a), rb) <= tol for o in inst if id(o) not in ex)
        if hits >= quorum * (len(instances) - 1):
            refs.append(c)
    return [rel_box(c, a0) for c in refs], refs


def match_template(cs, anchor, template, tol=MATCH_TOL, exclude=()):
    """Find, for every template box, the contour of `cs` at that place; raise if any is missing."""
    taken, out = set(exclude), []
    for tb in template:
        best = None
        for c in cs:
            if id(c) in taken:
                continue
            d = box_dist(rel_box(c, anchor), tb)
            if d <= tol and (best is None or d < best[0]):
                best = (d, c)
        if best is None:
            raise BuildError("template contour not found")
        taken.add(id(best[1]))
        out.append(best[1])
    return out


# --------------------------------------------------------------------------
# Rasteriser (for composed-vs-real ink comparison)
# --------------------------------------------------------------------------

def _flatten(c: Contour, steps=10):
    pts, cur, start = [], None, None
    for op, p in c.ops:
        if op == "moveTo":
            cur = start = p[0]
            pts.append(cur)
        elif op == "lineTo":
            cur = p[0]
            pts.append(cur)
        elif op == "curveTo":
            (x1, y1), (x2, y2), (x3, y3) = p
            x0, y0 = cur
            for i in range(1, steps + 1):
                t = i / steps
                mt = 1 - t
                pts.append((mt ** 3 * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t ** 3 * x3,
                            mt ** 3 * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t ** 3 * y3))
            cur = p[-1]
        elif op == "closePath":
            if start is not None and cur != start:
                pts.append(start)
    return pts


def rasterize(cs, x0, y0, res, w, h) -> set:
    """Pixels (sampled at centres) covered under the nonzero rule."""
    rows = [[] for _ in range(h)]
    for c in cs:
        pts = _flatten(c)
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            if ay == by:
                continue
            wdir = 1 if by > ay else -1
            lo, hi = (ay, by) if ay < by else (by, ay)
            r0 = max(0, math.ceil((lo - y0) * res - 0.5))
            r1 = min(h - 1, math.floor((hi - y0) * res - 0.5))
            for r in range(r0, r1 + 1):
                yc = y0 + (r + 0.5) / res
                if lo <= yc < hi:
                    xc = ax + (yc - ay) * (bx - ax) / (by - ay)
                    rows[r].append((xc, wdir))
    on = set()
    for r, xs in enumerate(rows):
        xs.sort()
        wind = 0
        for i, (xc, wd) in enumerate(xs):
            prev = wind
            wind += wd
            if prev == 0 and wind != 0:
                start = xc
            elif prev != 0 and wind == 0:
                c0 = max(0, math.ceil((start - x0) * res - 0.5))
                c1 = min(w - 1, math.floor((xc - x0) * res - 0.5))
                for col in range(c0, c1 + 1):
                    on.add((r, col))
    return on


def ink_iou(a, b, res=12.0):
    x0, y0, x1, y1 = union(list(a) + list(b))
    x0, y0 = x0 - 0.5, y0 - 0.5
    w, h = int((x1 - x0 + 1) * res) + 1, int((y1 - y0 + 1) * res) + 1
    pa, pb = rasterize(a, x0, y0, res, w, h), rasterize(b, x0, y0, res, w, h)
    inter = len(pa & pb)
    return inter / max(1, len(pa | pb)), len(pa ^ pb) / (res * res)


# --------------------------------------------------------------------------
# Inputs
# --------------------------------------------------------------------------

def find_pages(directory: Path) -> dict:
    pages = {}
    for f in sorted(directory.iterdir()):
        m = re.fullmatch(r"(\d{3})\.svg|p(\d{1,3})\.svg", f.name)
        if m:
            pages.setdefault(int(m.group(1) or m.group(2)), f)
    return pages


def read_groups(path: Path) -> dict:
    """Contours of the three label groups of one page (absent groups are omitted)."""
    root = ET.parse(path).getroot()
    out = {}
    for g in root.iter(SVG_NS + "g"):
        gid = g.get("id")
        if gid in (G_SURAH, G_JUZ, G_MARGIN):
            if g.get("transform") or any(p.get("transform") for p in g.iter(SVG_NS + "path")):
                raise BuildError(f"{path.name}: transforms are not supported")
            cs = []
            for p in g.iter(SVG_NS + "path"):
                cs.extend(parse_contours(p.get("d", "")))
            if cs:
                out[gid] = cs
    return out


class Meta:
    """Read-only view of core.db (mushaf 1 = the 604-page Madani layout of the SVGs)."""

    def __init__(self, db: Path):
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        self.ayah = {r[0]: r[1:] for r in con.execute(
            "SELECT id, surah, ayah, juz, hizb, rub, flags FROM ayah ORDER BY id")}
        self.pages = {p: (a, b) for p, a, b in con.execute(
            "SELECT page, first_ayah_id, last_ayah_id FROM page WHERE mushaf_id = 1")}
        self.surah_name = dict(con.execute("SELECT id, name_ar FROM surah"))
        con.close()
        self.page_of_ayah = {}
        for p, (a, b) in sorted(self.pages.items()):
            for i in range(a, b + 1):
                self.page_of_ayah.setdefault(i, p)
        self.rub_start = {}
        for i, (s, a, j, h, r, fl) in self.ayah.items():
            if fl & 1:
                self.rub_start[r] = i

    def ids(self, p):
        a, b = self.pages[p]
        return range(a, b + 1)

    def surahs_on(self, p):
        return sorted({self.ayah[i][0] for i in self.ids(p)})

    def header_surahs(self, p):
        if p in HEADER_OVERRIDES:
            return list(HEADER_OVERRIDES[p])
        starting = [self.ayah[i][0] for i in self.ids(p) if self.ayah[i][5] & 8]
        return starting or [self.ayah[self.pages[p][0]][0]]

    def juz_of_page(self, p):
        return sorted({self.ayah[i][2] for i in self.ids(p)})

    def rubs_starting(self, p):
        return [self.ayah[i][4] for i in self.ids(p) if self.ayah[i][5] & 1]

    def rub_info(self, r):
        i = self.rub_start[r]
        s, a, j, h, rr, fl = self.ayah[i]
        q = (r - 1) % 4
        cls = "J" if fl & 4 else ("H" if q == 0 else "R")
        return {"rub": r, "hizb": (r - 1) // 4 + 1, "juz": j, "q": q, "cls": cls,
                "page": self.page_of_ayah[i], "ayah": f"{s}:{a}"}


# --------------------------------------------------------------------------
# Running heads
# --------------------------------------------------------------------------

@dataclass
class HeaderLabel:
    kind: str       # surah | juz
    key: int
    page: int
    contours: list


def alef_of(cs):
    """The alef of a word: rightmost tall thin contour."""
    cands = [c for c in cs if c.h > 4 * c.w]
    if not cands:
        raise BuildError("no alef found")
    return max(cands, key=lambda c: c.x1)


def analyse_headers(pages, meta, report):
    """Cut the running-head labels; returns ({surah: [HeaderLabel]}, {juz: [HeaderLabel]}, baseline)."""
    surahs, juzs, mism, alef_bottoms = {}, {}, [], []
    for p, groups in sorted(pages.items()):
        if G_SURAH in groups:
            clusters = x_runs(groups[G_SURAH], HEADER_LABEL_GAP)[::-1]   # reading order: right to left
            on_page = meta.surahs_on(p)
            chosen = meta.header_surahs(p)
            if len(clusters) != len(on_page):
                mism.append({"page": p, "clusters": len(clusters), "surahs_with_ayahs": on_page,
                             "header_names": chosen, "override": p in HEADER_OVERRIDES})
            if len(clusters) != len(chosen):
                raise BuildError(f"page {p}: {len(clusters)} header labels but rule gives {chosen}")
            for s, cl in zip(chosen, clusters):
                surahs.setdefault(s, []).append(HeaderLabel("surah", s, p, cl))
        if G_JUZ in groups:
            clusters = x_runs(groups[G_JUZ], HEADER_LABEL_GAP)
            juz = meta.juz_of_page(p)
            if len(clusters) != 1 or len(juz) != 1:
                raise BuildError(f"page {p}: juz header has {len(clusters)} parts, juz {juz}")
            juzs.setdefault(juz[0], []).append(HeaderLabel("juz", juz[0], p, clusters[0]))
            alef_bottoms.append(alef_of(clusters[0]).y1)
    baseline = statistics.median(alef_bottoms)
    report["header"] = {
        "baseline_svg_y": round(baseline, 3),
        "baseline_spread": [round(min(alef_bottoms), 2), round(max(alef_bottoms), 2)],
        "cluster_count_vs_core_db_mismatches": mism,
        "overrides": {str(k): list(v) for k, v in HEADER_OVERRIDES.items()},
    }
    return surahs, juzs, baseline


def header_consistency(instances):
    """Largest difference (SVG units) between repeated instances of the same label."""
    worst = 0.0
    ref = instances[0].contours
    rb = union(ref)
    for inst in instances[1:]:
        ob = union(inst.contours)
        dy = ob[3] - rb[3]
        worst = max(worst, abs((ob[2] - ob[0]) - (rb[2] - rb[0])), abs((ob[3] - ob[1]) - (rb[3] - rb[1])), abs(dy))
        if len(inst.contours) != len(ref):
            worst = max(worst, 99.0)
    return worst


def header_word_template(labels, anchor_of):
    """The word every label starts with (سُورَةُ / الجُزۡءُ), relative to the rightmost contour."""
    insts = [lab.contours for lab in labels]
    # pages 529 and 535 draw the shared word slightly differently: majority vote
    tmpl, refs = common_template(insts, anchor_of, quorum=0.9)
    return tmpl, refs


def rightmost_body(cs):
    return max((c for c in cs if c.h > 4), key=lambda c: c.x1)


# --------------------------------------------------------------------------
# Margin labels
# --------------------------------------------------------------------------

@dataclass
class MarginLabel:
    page: int
    info: dict
    contours: list
    parts: dict = field(default_factory=dict)    # name -> contours (words, fractions)
    numbers: list = field(default_factory=list)  # [(n, [(digit_char, contours)], line)]
    anchors: dict = field(default_factory=dict)  # name -> anchor contour

    @property
    def cls(self):
        return self.info["cls"]

    @property
    def q(self):
        return self.info["q"]


def widest(cs):
    return max(cs, key=lambda c: (c.w, c.x1))


def split_j_lines(cs):
    lines = y_runs(cs, 0.3)
    if len(lines) != 2:
        raise BuildError(f"juz-start label has {len(lines)} lines")
    return lines


def collect_margin_labels(pages, meta, report):
    labels, problems = [], []
    pages_with_rubs = sorted({meta.rub_info(r)["page"] for r in range(1, 241)})
    for p, groups in sorted(pages.items()):
        rubs = meta.rubs_starting(p) if p in meta.pages else []
        if G_MARGIN not in groups:
            if rubs:   # page 1: the print has no label for rub 1 (al-Fatiha page)
                problems.append({"page": p, "rubs": rubs,
                                 "problem": "rub starts but the page has no margin label"})
            continue
        blocks = y_runs(groups[G_MARGIN], MARGIN_BLOCK_GAP)
        if len(blocks) != len(rubs):
            problems.append({"page": p, "problem": f"{len(blocks)} margin blocks for rubs {rubs}"})
            continue
        for r, block in zip(rubs, blocks):
            info = meta.rub_info(r)
            labels.append(MarginLabel(p, info, block))
    report["margin_collect"] = {"labels": len(labels), "problems": problems,
                                "pages_starting_rubs_in_input": len([p for p in pages_with_rubs if p in pages])}
    return labels


def decompose_margin(labels, report):
    """Cut words, fractions and digits out of every real margin label (template matching)."""
    by = {}
    for lab in labels:
        key = lab.cls if lab.cls != "R" else f"R{lab.q}"
        by.setdefault(key, []).append(lab)
    templates = {}
    # «الحِزۡبُ» of the rub labels (all three fractions together) and of the hizb labels
    rlabs = by.get("R1", []) + by.get("R2", []) + by.get("R3", [])
    rlabs.sort(key=lambda lab: lab.info["rub"])
    templates["hizb_R"], _ = common_template([lab.contours for lab in rlabs], widest)
    templates["hizb_H"], _ = common_template([lab.contours for lab in by["H"]], widest)
    jl = by["J"]
    jl1 = [split_j_lines(lab.contours)[0] for lab in jl]
    jl2 = [split_j_lines(lab.contours)[1] for lab in jl]
    templates["juz_J"], _ = common_template(jl1, widest)
    templates["hizb_J"], _ = common_template(jl2, widest)

    for lab in rlabs + by["H"]:
        a = widest(lab.contours)
        word = match_template(lab.contours, a, templates["hizb_R" if lab.cls == "R" else "hizb_H"])
        lab.parts["hizb"], lab.anchors["hizb"] = word, a
    # fractions: what the labels of one q share once «الحِزۡبُ» is removed
    for q in (1, 2, 3):
        group = sorted(by[f"R{q}"], key=lambda lab: lab.info["rub"])
        excl = [{id(c) for c in lab.parts["hizb"]} for lab in group]
        templates[f"frac{q}"], _ = common_template([lab.contours for lab in group], widest, exclude=excl)
        for lab in group:
            lab.parts["frac"] = match_template(lab.contours, lab.anchors["hizb"], templates[f"frac{q}"],
                                               exclude=[id(c) for c in lab.parts["hizb"]])
    for lab in jl:
        l1, l2 = split_j_lines(lab.contours)
        a1, a2 = widest(l1), widest(l2)
        lab.parts["juz"] = match_template(l1, a1, templates["juz_J"])
        lab.parts["hizb"] = match_template(l2, a2, templates["hizb_J"])
        lab.anchors.update(juz=a1, hizb=a2)

    bad = []
    for lab in labels:
        used = {id(c) for part in lab.parts.values() for c in part}
        rest = [c for c in lab.contours if id(c) not in used]
        if lab.cls == "J":
            l1, l2 = split_j_lines(lab.contours)
            ids1 = {id(c) for c in l1}
            groups = [(lab.info["juz"], [c for c in rest if id(c) in ids1], 1),
                      (lab.info["hizb"], [c for c in rest if id(c) not in ids1], 2)]
        else:
            groups = [(lab.info["hizb"], rest, 2)]
        for n, cs, line in groups:
            digits = x_runs(cs, -0.05)
            s = eastern(n)
            if len(digits) != len(s):
                bad.append({"page": lab.page, "rub": lab.info["rub"], "number": n, "found": len(digits)})
                continue
            lab.numbers.append((n, list(zip(s, digits)), line))
    if bad:
        raise BuildError(f"digit split failed: {bad}")
    report["margin_templates"] = {k: len(v) for k, v in templates.items()}
    report["margin_classes"] = {k: sorted(lab.info["rub"] for lab in v) for k, v in sorted(by.items())}
    return templates


# --------------------------------------------------------------------------
# Measurements on the real margin labels
# --------------------------------------------------------------------------

def med(xs):
    xs = list(xs)
    if not xs:
        raise BuildError("median of nothing")
    return statistics.median(xs)


def word_frame(word_cs):
    """(ink centre x, baseline y = alef bottom, ink bounds) of a margin word."""
    b = union(word_cs)
    return (b[0] + b[2]) / 2, alef_of(word_cs).y1, b


def winding(c: Contour, x: float, y: float) -> int:
    pts = _flatten(c)
    wn = 0
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        if (ay <= y < by) or (by <= y < ay):
            if ax + (y - ay) * (bx - ax) / (by - ay) > x:
                wn += 1 if by > ay else -1
    return wn


def is_dot(c, others):
    """A nuqta: small, square-ish, few segments and not a counter inside another contour."""
    if not (0.3 < c.w < 1.6 and 0.8 <= c.w / max(c.h, 1e-6) <= 1.25 and len(c.ops) <= 25):
        return False
    return not any(o is not c and o.x0 < c.cx < o.x1 and o.y0 < c.cy < o.y1 and winding(o, c.cx, c.cy)
                   for o in others)


def solve_least_squares(names, eqs):
    """Weighted linear least squares by normal equations (tiny systems)."""
    idx = {n: i for i, n in enumerate(names)}
    k = len(names)
    A = [[0.0] * k for _ in range(k)]
    v = [0.0] * k
    for coeffs, rhs, wgt, _tag in eqs:
        items = [(idx[n], a) for n, a in coeffs.items()]
        for i, ai in items:
            v[i] += wgt * wgt * ai * rhs
            for j, aj in items:
                A[i][j] += wgt * wgt * ai * aj
    for col in range(k):
        piv = max(range(col, k), key=lambda r: abs(A[r][col]))
        if abs(A[piv][col]) < 1e-12:
            raise BuildError(f"singular system at {names[col]}")
        A[col], A[piv] = A[piv], A[col]
        v[col], v[piv] = v[piv], v[col]
        for r in range(k):
            if r != col and A[r][col]:
                f = A[r][col] / A[col][col]
                for c2 in range(col, k):
                    A[r][c2] -= f * A[col][c2]
                v[r] -= f * v[col]
    return {n: v[i] / A[i][i] for n, i in idx.items()}


def residual(sol, eq):
    coeffs, rhs, _w, _t = eq
    return sum(sol[n] * a for n, a in coeffs.items()) - rhs


@dataclass
class Layout:
    """Everything the composer and the word/digit glyphs need (SVG units)."""
    word_scale: dict          # size of a word relative to the rub labels' «الحِزۡبُ»
    digit_scale: dict         # digit size per label class relative to the rub labels
    bearings: dict            # digit -> (left, right) side bearing, rub-label size
    consts: dict              # fitted constants (centring, gaps)
    frac: dict                # q -> (dx of ink centre, ink bottom) relative to «الحِزۡبُ»
    num_base: dict            # (class, line or q) -> number baseline relative to word baseline
    j_line1: float            # line-1 baseline relative to line-2 baseline (juz labels)
    raised: dict              # digit -> raise above the number baseline (rub size)
    words: dict = field(default_factory=dict)    # key -> (contours in word space, source page)
    digits: dict = field(default_factory=dict)   # digit char -> (contours, width, source page)
    frac_baseline: float = 0.0


def number_baseline(digits, raised):
    """Baseline of a printed number: bottoms of the digits that sit on it."""
    on = [union(cs)[3] for ch, cs in digits if raised.get(ch, 0.0) < 0.25]
    return max(on) if on else None


def measure(labels, report) -> Layout:
    R = [lab for lab in labels if lab.cls == "R"]
    H = [lab for lab in labels if lab.cls == "H"]
    J = [lab for lab in labels if lab.cls == "J"]
    for lab in labels:
        for name in list(lab.parts):
            if name in ("hizb", "juz"):
                lab.anchors[name + "_frame"] = word_frame(lab.parts[name])

    def alef_h(lab, name):
        return alef_of(lab.parts[name]).h

    alef_R = med(alef_h(lab, "hizb") for lab in R)
    word_scale = {
        "hizb_R": 1.0,
        "hizb_H": med(alef_h(lab, "hizb") for lab in H) / alef_R,
        "hizb_J": med(alef_h(lab, "hizb") for lab in J) / alef_R,
        "juz_J": med(alef_h(lab, "juz") for lab in J) / alef_R,
    }
    # fraction words: alef of «أَرۡبَاعِ» where there is one, nuqtas otherwise
    dot_R = med(c.w for lab in R for c in lab.parts["hizb"] if is_dot(c, lab.parts["hizb"]))
    frac_dots, frac_alef = {}, {}
    for q in (1, 2, 3):
        labs = [lab for lab in R if lab.q == q]
        frac_dots[q] = med(c.w for lab in labs for c in lab.parts["frac"] if is_dot(c, lab.parts["frac"]))
        al = [c.h for lab in labs for c in lab.parts["frac"] if c.h > 4 * c.w and c.h > 1.5]
        frac_alef[q] = med(al) if al else None
    for q in (1, 2, 3):
        word_scale[f"frac{q}"] = (frac_alef[q] / alef_R) if frac_alef[q] else frac_dots[q] / dot_R
    report["word_scale_evidence"] = {
        "alef_height_rub_hizb": round(alef_R, 3), "nuqta_rub_hizb": round(dot_R, 3),
        **{f"frac{q}": {"nuqta_ratio": round(frac_dots[q] / dot_R, 3),
                        "alef_ratio": round(frac_alef[q] / alef_R, 3) if frac_alef[q] else None}
           for q in (1, 2, 3)}}

    # digit sizes per class (relative to rub labels), and raised digits
    def digit_items(labs):
        for lab in labs:
            for n, digs, line in lab.numbers:
                for ch, cs in digs:
                    yield lab, line, ch, cs
    size_R = {}
    for _lab, _l, ch, cs in digit_items(R):
        b = union(cs)
        size_R.setdefault(ch, []).append((b[2] - b[0], b[3] - b[1]))
    size_R = {ch: (med(w for w, _ in v), med(h for _, h in v)) for ch, v in size_R.items()}
    missing_R = [d for d in EASTERN if d not in size_R]
    if missing_R:
        raise BuildError(f"digits missing from the rub labels: {missing_R}")
    digit_scale = {"R": 1.0}
    for name, labs in (("H", H), ("J", J)):
        ratios = []
        for _lab, _l, ch, cs in digit_items(labs):
            b = union(cs)
            ratios += [(b[2] - b[0]) / size_R[ch][0], (b[3] - b[1]) / size_R[ch][1]]
        digit_scale[name] = med(ratios)
    offs = {}
    for lab in R + H + J:
        for n, digs, line in lab.numbers:
            if len(digs) < 2:
                continue
            bottom = max(union(cs)[3] for _, cs in digs)
            sc = digit_scale[lab.cls]
            for ch, cs in digs:
                offs.setdefault(ch, []).append((bottom - union(cs)[3]) / sc)
    raised = {ch: max(0.0, med(v)) for ch, v in offs.items()}
    raised = {ch: (v if v >= 0.25 else 0.0) for ch, v in raised.items()}

    # number baselines and fraction placement relative to the «الحِزۡبُ» frame
    num_base, frac = {}, {}
    for key, labs in [((f"R", q), [lab for lab in R if lab.q == q]) for q in (1, 2, 3)] + [(("H", 0), H)]:
        vals = []
        for lab in labs:
            cx, base, _b = lab.anchors["hizb_frame"]
            nb = number_baseline(lab.numbers[0][1], raised)
            if nb is not None:
                vals.append(nb - base)
        num_base[key] = med(vals)
    for line, word in ((1, "juz"), (2, "hizb")):
        vals = []
        for lab in J:
            n, digs, _l = [x for x in lab.numbers if x[2] == line][0]
            nb = number_baseline(digs, raised)
            if nb is not None:
                vals.append(nb - lab.anchors[word + "_frame"][1])
        num_base[("J", line)] = med(vals)
    j_line1 = med(lab.anchors["juz_frame"][1] - lab.anchors["hizb_frame"][1] for lab in J)
    for q in (1, 2, 3):
        boxes = [(union(lab.parts["frac"]), lab.anchors["hizb_frame"]) for lab in R if lab.q == q]
        frac[q] = (med((b[0] + b[2]) / 2 - frame[0] for b, frame in boxes),
                   med(b[3] - frame[1] for b, frame in boxes))

    # digit side bearings and number columns: weighted least squares.
    # Every printed number is centred (by its advance box) on a fixed column
    # of its label: under «الحِزۡبُ» in rub/hizb labels, and one column for
    # both lines of the juz labels, whose words do not move.
    def coeffs(*terms):
        out = {}
        for name, a in terms:
            out[name] = out.get(name, 0.0) + a
        return out

    names = [f"l{d}" for d in EASTERN] + [f"r{d}" for d in EASTERN] + ["C_R", "C_H", "C_J1", "C_J2"]
    eqs = []
    for lab in R + H + J:
        sc = digit_scale[lab.cls]
        wb = lab.anchors["hizb_frame"][2]
        for n, digs, line in lab.numbers:
            boxes = [union(cs) for _, cs in digs]
            chars = [c for c, _ in digs]
            for i in range(len(digs) - 1):
                eqs.append((coeffs((f"r{chars[i]}", sc), (f"l{chars[i + 1]}", sc)),
                            boxes[i + 1][0] - boxes[i][2], 1.0, ("pair", lab.page, n)))
            key = f"C_{lab.cls}" if lab.cls != "J" else f"C_J{line}"
            eqs.append((coeffs((f"l{chars[0]}", sc), (f"r{chars[-1]}", -sc), (key, 1.0)),
                        (boxes[0][0] + boxes[-1][2]) - (wb[0] + wb[2]), 0.5, ("centre", lab.page, n)))
    reg = [(coeffs((f"l{d}", 1.0), (f"r{d}", -1.0)), 0.0, 0.05, ("gauge", d)) for d in EASTERN]
    sol = solve_least_squares(names, eqs + reg)
    res = [abs(residual(sol, e)) for e in eqs]
    cut = max(0.25, 5 * med(res))
    dropped = [e[3] for e, r in zip(eqs, res) if r > cut]
    kept = [e for e, r in zip(eqs, res) if r <= cut]
    sol = solve_least_squares(names, kept + reg)
    stats = {}
    for e in kept:
        stats.setdefault(e[3][0], []).append(abs(residual(sol, e)))
    report["fit"] = {
        "solution": {k: round(v, 4) for k, v in sol.items()},
        "residuals_svg_units": {k: {"n": len(v), "median": round(med(v), 3), "max": round(max(v), 3)}
                                for k, v in sorted(stats.items())},
        "dropped_outliers": [list(map(str, d)) for d in dropped],
    }
    bearings = {d: (sol[f"l{d}"], sol[f"r{d}"]) for d in EASTERN}
    consts = {k: sol[k] for k in ("C_R", "C_H", "C_J1", "C_J2")}
    # juz labels: the «الجُزۡءُ» line keeps a fixed place over «الحِزۡبُ»
    consts["J_word_dx"] = med(lab.anchors["juz_frame"][2][2] - lab.anchors["hizb_frame"][2][2] for lab in J)
    # space: the print's ink gap between «الحِزۡبُ» and its number (juz labels), at rub size
    gaps = []
    for lab in J:
        n, digs, _l = [x for x in lab.numbers if x[2] == 2][0]
        g = lab.anchors["hizb_frame"][2][0] - union(digs[-1][1])[2]
        gaps.append(g / word_scale["hizb_J"] - bearings[digs[-1][0]][1])
    consts["word_number_gap"] = med(gaps)
    consts["alef_height_R"] = alef_R
    lay = Layout(word_scale, digit_scale, bearings, consts, frac, num_base, j_line1, raised)
    report["layout"] = {
        "word_scale": {k: round(v, 4) for k, v in word_scale.items()},
        "digit_scale": {k: round(v, 4) for k, v in digit_scale.items()},
        "digit_raise": {k: round(v, 3) for k, v in sorted(raised.items())},
        "fraction_centre_and_bottom": {q: [round(a, 3), round(b, 3)] for q, (a, b) in frac.items()},
        "number_baseline": {f"{k[0]}{k[1]}": round(v, 3) for k, v in num_base.items()},
        "juz_label_line1_baseline": round(j_line1, 3),
    }
    return lay


# --------------------------------------------------------------------------
# Words, digits and the composer
# --------------------------------------------------------------------------

def to_word_space(cs, cx, base):
    """Contours relative to (ink centre, baseline)."""
    return shift_all(cs, -cx, -base)


def cut_words_and_digits(labels, lay: Layout, hdr_surah_word, hdr_baseline, report):
    """Word assets (word space: x from ink centre, y from baseline, SVG units at the labels' size)."""
    R = sorted([lab for lab in labels if lab.cls == "R"], key=lambda lab: lab.info["rub"])
    H = sorted([lab for lab in labels if lab.cls == "H"], key=lambda lab: lab.info["rub"])
    J = sorted([lab for lab in labels if lab.cls == "J"], key=lambda lab: lab.info["rub"])
    words = {}
    lab = R[0]
    cx, base, _ = lab.anchors["hizb_frame"]
    words["hizb_R"] = (to_word_space(lab.parts["hizb"], cx, base), lab.page)
    lab = H[0]
    cx, base, _ = lab.anchors["hizb_frame"]
    words["hizb_H"] = (to_word_space(lab.parts["hizb"], cx, base), lab.page)
    lab = J[0]
    for name in ("juz", "hizb"):
        cx, base, _ = lab.anchors[name + "_frame"]
        words[f"{name}_J"] = (to_word_space(lab.parts[name], cx, base), lab.page)
    # fraction words: their own baseline is the fraction line of the labels (alef of
    # «أَرۡبَاعِ», the only isolated alef of the three, measured in q = 3 labels)
    q3 = [lab for lab in R if lab.q == 3]
    frac_base = med(max((c for c in lab.parts["frac"] if c.h > 4 * c.w and c.h > 1.5), key=lambda c: c.h).y1
                    - lab.anchors["hizb_frame"][1] for lab in q3)
    lay.frac_baseline = frac_base
    report["layout"]["fraction_word_baseline"] = round(frac_base, 3)
    for q in (1, 2, 3):
        lab = [lab for lab in R if lab.q == q][0]
        hcx, hbase, _ = lab.anchors["hizb_frame"]
        b = union(lab.parts["frac"])
        words[f"frac{q}"] = (to_word_space(lab.parts["frac"], (b[0] + b[2]) / 2, hbase + frac_base), lab.page)
    hb = union(hdr_surah_word[0])
    words["surah_hdr"] = (to_word_space(hdr_surah_word[0], (hb[0] + hb[2]) / 2, hdr_baseline), hdr_surah_word[1])
    lay.words = words
    # digits: first instance in a rub label (rub order), relative to (ink left, number baseline)
    digits = {}
    for lab in R:
        _cx, base, _ = lab.anchors["hizb_frame"]
        nbase = base + lay.num_base[("R", lab.q)]
        for n, digs, _line in lab.numbers:
            for ch, cs in digs:
                if ch not in digits:
                    b = union(cs)
                    digits[ch] = (shift_all(cs, -b[0], -nbase), b[2] - b[0], lab.page)
    lay.digits = digits
    report["sources"] = {"words": {k: v[1] for k, v in words.items()},
                         "digits": {ch: v[2] for ch, v in sorted(digits.items())}}


def layout_number(n, lay: Layout, scale):
    """Digits of n (left to right) at `scale`; x from the first digit's ink left, y from the baseline."""
    out, pen = [], 0.0
    for i, ch in enumerate(eastern(n)):
        cs, w, _ = lay.digits[ch]
        l, r = lay.bearings[ch]
        if i:
            pen += scale * l
        out.append((ch, map_all(cs, scale, scale, pen, 0.0)))
        pen += scale * (w + r)
    return out, union([c for _, cs in out for c in cs])


def place_number(n, lay: Layout, cls_scale, column_key, word_box, baseline_dy, prefix):
    """Centre the number's advance box on the label's number column (see measure())."""
    digs, ink = layout_number(n, lay, cls_scale)
    l_first, r_last = lay.bearings[digs[0][0]][0], lay.bearings[digs[-1][0]][1]
    ink_sum = (word_box[0] + word_box[2]) + cls_scale * (l_first - r_last) + lay.consts[column_key]
    dx = ink_sum / 2 - (ink[0] + ink[2]) / 2
    return {f"{prefix}{i}": shift_all(cs, dx, baseline_dy) for i, (_ch, cs) in enumerate(digs)}


def compose_margin(info, lay: Layout):
    """Compose a stacked label in label space (SVG units, y down; origin = «الحِزۡبُ» ink centre/baseline).

    Returns {component name: contours}; names match real_components().
    """
    cls, q = info["cls"], info["q"]
    if cls in "RH":
        word = lay.words["hizb_R" if cls == "R" else "hizb_H"][0]
        comp = {"hizb": word}
        comp.update(place_number(info["hizb"], lay, lay.digit_scale[cls], f"C_{cls}", union(word),
                                 lay.num_base[("R", q) if cls == "R" else ("H", 0)], "digit"))
        if cls == "R":
            fcs = lay.words[f"frac{q}"][0]
            fb = union(fcs)
            fdx, fbottom = lay.frac[q]
            comp["frac"] = shift_all(fcs, fdx - (fb[0] + fb[2]) / 2, fbottom - fb[3])
        return comp
    # juz-start label: «الجُزۡءُ j» over «الحِزۡبُ h»; fixed words, numbers centred on one column
    sc = lay.digit_scale["J"]
    w2 = lay.words["hizb_J"][0]
    b2 = union(w2)
    w1 = lay.words["juz_J"][0]
    comp = {"hizb": w2,
            "juz": shift_all(w1, b2[2] + lay.consts["J_word_dx"] - union(w1)[2], lay.j_line1)}
    comp.update(place_number(info["juz"], lay, sc, "C_J1", b2, lay.j_line1 + lay.num_base[("J", 1)], "n1digit"))
    comp.update(place_number(info["hizb"], lay, sc, "C_J2", b2, lay.num_base[("J", 2)], "n2digit"))
    return comp


def real_components(lab: MarginLabel):
    """The decomposed real label in label space, with the same component names as the composer."""
    cx, base, _ = lab.anchors["hizb_frame"]
    comp = {"hizb": to_word_space(lab.parts["hizb"], cx, base)}
    if "frac" in lab.parts:
        comp["frac"] = to_word_space(lab.parts["frac"], cx, base)
    if "juz" in lab.parts:
        comp["juz"] = to_word_space(lab.parts["juz"], cx, base)
    for n, digs, line in lab.numbers:
        prefix = "digit" if lab.cls != "J" else f"n{line}digit"
        for i, (_ch, cs) in enumerate(digs):
            comp[f"{prefix}{i}"] = to_word_space(cs, cx, base)
    return comp, to_word_space(lab.contours, cx, base)


def flat(comp):
    return [c for name in sorted(comp) for c in comp[name]]


# --------------------------------------------------------------------------
# Juz 1 running head (no page of juz 1 with a header is in the input set)
# --------------------------------------------------------------------------

@dataclass
class Letter:
    """A letter block of a running head: body (with its counters) and marks (dots, harakat)."""
    body: list
    marks: list

    @property
    def box(self):
        return union(self.body)


def letter_blocks(cs, baseline):
    """Split a running-head word into letter blocks, right to left.

    Bodies reach the baseline; a contour inside a body is its counter; every
    other contour (nuqta, haraka, hamza) joins the block of the assigned
    contour it overlaps most horizontally. Marks are taken from the letter
    zone outwards, so a fatha above a hamza follows the hamza.
    """
    bodies = sorted((c for c in cs if c.h >= 2.0 and c.y1 >= baseline - 1.0 and c.y0 <= baseline - 1.0),
                    key=lambda c: -c.x1)
    letters = [Letter([b], []) for b in bodies]
    owner = {id(b): letter for b, letter in zip(bodies, letters)}
    pending = []
    for c in cs:
        if id(c) in owner:
            continue
        host = next((owner[id(b)] for b in bodies if b.x0 < c.cx < b.x1 and b.y0 < c.cy < b.y1
                     and winding(b, c.cx, c.cy)), None)
        if host is not None:
            host.body.append(c)
            owner[id(c)] = host
        else:
            pending.append(c)
    assigned = [c for c in cs if id(c) in owner]
    for m in sorted(pending, key=lambda c: (abs(c.cy - (baseline - 3.0)), -c.x1)):
        def key(a):
            ov = min(a.x1, m.x1) - max(a.x0, m.x0)
            vgap = max(0.0, a.y0 - m.y1, m.y0 - a.y1)
            return (-max(0.0, ov) / m.w, vgap, max(0.0, -ov), -a.x1)
        a = min(assigned, key=key)
        owner[id(a)].marks.append(m)
        owner[id(m)] = owner[id(a)]
        assigned.append(m)
    return letters


def compose_juz1(juz_labels, surah_labels, juz_tmpl, surah_tmpl, baseline, report):
    """«الجُزۡءُ الأَوَّلُ» from running-head pieces of the same typeface and baseline.

    «الجُزۡءُ», «وَ» and the fatha+shadda of «التَّاسِعُ» come from the juz 29
    head; «ا», «لأَ» and the isolated «ل» from «الأَنفَالِ» (surah 8); the
    damma of the lam from «لُقۡمَانَ» (surah 31). The shadda takes the place
    of the waw's own fatha and the fatha rides on it as in «التَّاسِعُ»; the
    damma keeps its offset from the lam's top. Gaps between letters are
    copied from the same contexts (لأ before a letter, و before alef).
    """
    def name_part(lab, tmpl):
        a = rightmost_body(lab.contours)
        word = match_template(lab.contours, a, tmpl, tol=HEADER_TOL)
        ids = {id(c) for c in word}
        return word, [c for c in lab.contours if id(c) not in ids]

    def check(c, w, h, what):
        if not (w[0] <= c.w <= w[1] and h[0] <= c.h <= h[1]):
            raise BuildError(f"juz 1 composition: unexpected {what} {c.w:.2f}x{c.h:.2f}")

    j29 = juz_labels[29][0]
    juz_word, rest29 = name_part(j29, juz_tmpl)
    l29 = letter_blocks(rest29, baseline)    # ا | لتَّا | سِعُ | وَ | ا | لعِشۡرُ | و | نَ
    lta, waw, alef2 = l29[1], l29[3], l29[4]
    check(waw.body[0], (4.0, 8.0), (4.5, 8.0), "waw")
    check(alef2.body[0], (0.5, 1.6), (6.0, 10.0), "alef after waw")
    waw_fatha = min(waw.marks, key=lambda c: c.y0)
    fatha, shadda = sorted(lta.marks, key=lambda c: c.y0)[:2]
    check(shadda, (2.0, 4.0), (1.5, 3.0), "shadda")
    s8 = surah_labels[8][0]
    _w, rest8 = name_part(s8, surah_tmpl)
    l8 = letter_blocks(rest8, baseline)      # ا | لأَ | نفَا | لِ
    alef, lamalef, nfa, lam = l8[0], l8[1], l8[2], l8[3]
    check(alef.body[0], (0.5, 1.6), (6.0, 10.0), "alef")
    check(lam.body[0], (3.0, 7.0), (8.0, 12.0), "lam")
    s31 = surah_labels[31][0]
    _w, rest31 = name_part(s31, surah_tmpl)
    l31 = letter_blocks(rest31, baseline)    # لُقۡمَا | نَ
    lq = l31[0]
    damma = min(lq.marks, key=lambda c: (c.y0, -c.x1))
    check(damma, (1.5, 4.0), (2.5, 5.0), "damma")

    gap_words = med(union(name_part(labs[0], juz_tmpl)[0])[0] - union(name_part(labs[0], juz_tmpl)[1])[2]
                    for labs in juz_labels.values())
    out = list(juz_word)
    x = union(juz_word)[0] - gap_words                   # right edge of the ordinal
    head = alef.body + alef.marks + lamalef.body + lamalef.marks
    dx = x - union(head)[2]
    out += shift_all(head, dx, 0.0)
    gap1 = lamalef.box[0] - nfa.box[2]                   # لأ → next letter (الأنفال)
    wdx = (lamalef.box[0] + dx - gap1) - waw.box[2]
    out += shift_all(waw.body, wdx, 0.0)
    sdx = (waw_fatha.cx + wdx) - shadda.cx
    sdy = waw_fatha.y1 - shadda.y1
    out += [shadda.shift(sdx, sdy), fatha.shift(sdx, sdy)]
    gap2 = waw.box[0] - alef2.box[2]                     # و → next letter (وَالعِشۡرُونَ)
    ldx = (waw.box[0] + wdx - gap2) - lam.box[2]
    out += shift_all(lam.body, ldx, 0.0)
    out.append(damma.shift((lam.box[2] + ldx) - lq.box[2], lam.box[1] - lq.box[1]))
    report.setdefault("composed", {})["juz1_header"] = {
        "pieces": {"الجُزۡءُ, وَ, shadda+fatha": f"juz 29 head, page {j29.page}",
                   "ا, لأَ, ل": f"surah 8 head, page {s8.page}", "damma": f"surah 31 head, page {s31.page}"},
        "gap_words": round(gap_words, 3), "gap_lamalef_waw": round(gap1, 3), "gap_waw_lam": round(gap2, 3)}
    return out


# --------------------------------------------------------------------------
# Font
# --------------------------------------------------------------------------

@dataclass
class Glyph:
    name: str
    cp: int | None
    contours: list            # font units, y up (already rounded)
    advance: int
    meta: dict = field(default_factory=dict)


def rounded(cs):
    """Round every point to whole font units."""
    return [Contour.from_ops(tuple((op, tuple((float(round(x)), float(round(y))) for x, y in pts))
                                   for op, pts in c.ops)) for c in cs]


def glyph_from(name, cp, cs, scale, baseline_y, meta):
    """Font-unit glyph from SVG-space contours: y' = (baseline_y - y) * scale; ink starts at x = SIDE."""
    b = union(cs)
    fc = rounded(map_all(cs, scale, -scale, -b[0] * scale + SIDE, baseline_y * scale))
    fb = union(fc)
    shift = SIDE - fb[0]
    fc = rounded(shift_all(fc, shift, 0)) if shift else fc
    adv = int(round(union(fc)[2])) + SIDE
    return Glyph(name, cp, fc, adv, meta)


def charstring(g: Glyph):
    pen = T2CharStringPen(g.advance, None)
    for c in g.contours:
        for op, pts in c.ops:
            getattr(pen, op)(*pts)
    return pen.getCharString()


def notdef_glyph():
    outer = [("moveTo", ((50.0, 0.0),)), ("lineTo", ((450.0, 0.0),)), ("lineTo", ((450.0, 550.0),)),
             ("lineTo", ((50.0, 550.0),)), ("closePath", ())]
    inner = [("moveTo", ((100.0, 50.0),)), ("lineTo", ((100.0, 500.0),)), ("lineTo", ((400.0, 500.0),)),
             ("lineTo", ((400.0, 50.0),)), ("closePath", ())]
    return Glyph(".notdef", None, [Contour.from_ops(outer), Contour.from_ops(inner)], 500)


def build_font(glyphs, license_text, path: Path):
    order = [g.name for g in glyphs]
    fb = FontBuilder(UPM, isTTF=False)
    fb.font.recalcTimestamp = False
    fb.setupHead(unitsPerEm=UPM, created=TIMESTAMP, modified=TIMESTAMP, fontRevision=float(VERSION))
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({g.cp: g.name for g in glyphs if g.cp is not None})
    charstrings = {g.name: charstring(g) for g in glyphs}
    fb.setupCFF(PS_NAME, {"FullName": FAMILY, "FamilyName": FAMILY, "Weight": "Regular",
                          "version": VERSION, "Notice": SOURCE_TEXT, "Copyright": SOURCE_TEXT},
                charstrings, {})
    metrics, ymax, ymin = {}, 0, 0
    for g in glyphs:
        if g.contours:
            b = union(g.contours)
            metrics[g.name] = (g.advance, int(math.floor(b[0])))
            ymax, ymin = max(ymax, math.ceil(b[3])), min(ymin, math.floor(b[1]))
        else:
            metrics[g.name] = (g.advance, 0)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=ymax, descent=ymin, lineGap=0)
    desc = (SOURCE_TEXT + ". Non-Quranic page furniture of the KFGQPC 1441H Madinah print: running "
            "heads (surah, juz), stacked margin rub/hizb/juz labels, label words and Eastern Arabic "
            "digits. Code points: U+0660-0669 digits, U+F500-F505 words, U+F600+surah, "
            "U+F700+juz, U+F800+rub.")
    fb.setupNameTable({
        "copyright": SOURCE_TEXT,
        "familyName": FAMILY, "styleName": "Regular",
        "uniqueFontIdentifier": f"{VERSION};NONE;{PS_NAME}",
        "fullName": FAMILY, "version": f"Version {VERSION}", "psName": PS_NAME,
        "description": desc,
        "vendorURL": URL_DATASET, "designerURL": URL_ARTWORK,
        "licenseDescription": license_text.strip(), "licenseInfoURL": URL_DATASET,
    })
    fb.setupOS2(sTypoAscender=ymax, sTypoDescender=ymin, sTypoLineGap=0, usWinAscent=ymax,
                usWinDescent=-ymin, achVendID="NONE", fsType=0, usWeightClass=400,
                fsSelection=0x40 | 0x80, ulCodePageRange1=1 << 6, ulCodePageRange2=0,
                sxHeight=0, sCapHeight=0, version=4)
    fb.font["OS/2"].recalcUnicodeRanges(fb.font)
    fb.setupPost()
    fb.save(str(path))
    return ymax, ymin


# --------------------------------------------------------------------------
# Glyph set
# --------------------------------------------------------------------------

def digit_glyphs(lay: Layout):
    """U+0660..U+0669 at the rub labels' size, side bearings fitted to the print."""
    out = []
    for i, ch in enumerate(EASTERN):
        cs, w, page = lay.digits[ch]
        left, right = lay.bearings[ch]
        out.append(Glyph(f"uni{CP_DIGIT0 + i:04X}", CP_DIGIT0 + i,
                         rounded(map_all(cs, SCALE, -SCALE, left * SCALE, 0.0)),
                         int(round((left + w + right) * SCALE)),
                         {"kind": "digit", "key": i, "text": ch, "source": {"page": page}}))
    return out


def word_glyphs(lay: Layout, juz_labels, juz_tmpl, report):
    """U+F500..U+F505, normalised to the size of the rub labels' «الحِزۡبُ»."""
    alef_hdr = med(alef_of(match_template(labs[0].contours, rightmost_body(labs[0].contours), juz_tmpl)).h
                   for labs in juz_labels.values())
    sizes = {"rub": ("frac1", lay.word_scale["frac1"]), "nisf": ("frac2", lay.word_scale["frac2"]),
             "thalatha": ("frac3", lay.word_scale["frac3"]), "hizb": ("hizb_R", 1.0),
             "juz": ("juz_J", lay.word_scale["juz_J"]),
             "surah": ("surah_hdr", alef_hdr / lay.consts["alef_height_R"])}
    report["layout"]["word_scale"]["surah_hdr"] = round(sizes["surah"][1], 4)
    out = []
    for key, off, txt in WORDS:
        asset, k = sizes[key]
        cs, page = lay.words[asset]
        out.append(glyph_from(f"uni{CP_WORD + off:X}", CP_WORD + off, cs, SCALE / k, 0,
                              {"kind": "word", "key": key, "text": txt,
                               "source": {"page": page, "print_size": round(k, 4)}}))
    return out


def header_glyphs(meta: Meta, heads, report):
    """U+F602..U+F672 and U+F701..U+F71E: one transform (scale, baseline) for all."""
    out, juz1 = [], None
    for n in range(2, 115):
        if n in heads["surah"]:
            lab = heads["surah"][n][0]
            out.append(glyph_from(f"uni{CP_SURAH + n:X}", CP_SURAH + n, lab.contours, SCALE, heads["baseline"],
                                  {"kind": "surah", "key": n, "text": "سورة " + meta.surah_name[n],
                                   "source": {"page": lab.page}}))
    for j in range(1, 31):
        text = "الجزء " + JUZ_ORDINALS[j - 1]
        if j in heads["juz"]:
            lab = heads["juz"][j][0]
            out.append(glyph_from(f"uni{CP_JUZ + j:X}", CP_JUZ + j, lab.contours, SCALE, heads["baseline"],
                                  {"kind": "juz", "key": j, "text": text, "source": {"page": lab.page}}))
        elif j == 1 and all(s in heads["surah"] for s in (8, 31)) and 29 in heads["juz"]:
            cs = compose_juz1(heads["juz"], heads["surah"], heads["juz_tmpl"], heads["surah_tmpl"],
                              heads["baseline"], report)
            juz1 = glyph_from(f"uni{CP_JUZ + 1:X}", CP_JUZ + 1, cs, SCALE, heads["baseline"],
                              {"kind": "juz", "key": 1, "text": text,
                               "source": {"composed": True,
                                          "pieces": report["composed"]["juz1_header"]["pieces"]}})
            out.append(juz1)
    return out, juz1


def margin_glyphs(meta: Meta, labels, lay: Layout, report):
    """U+F801..U+F8F0: real artwork where the page is in the input, composed otherwise.

    The composer also runs for every real label; the difference is recorded.
    """
    real = {lab.info["rub"]: lab for lab in labels}
    out, comparisons, stats = [], {}, []
    for r in range(1, 241):
        info = meta.rub_info(r)
        comp = compose_margin(info, lay)
        comp_cs = flat(comp)
        name, cp = f"uni{CP_RUB + r:X}", CP_RUB + r
        if r in real:
            lab = real[r]
            rcomp, rcs = real_components(lab)
            g = glyph_from(name, cp, rcs, SCALE, 0,
                           {"kind": "margin", "key": r, "info": info, "source": {"page": lab.page}})
            shift = max(max(abs(u - v) for u, v in zip(union(rcomp[k]), union(comp[k]))) for k in rcomp) * SCALE
            iou, xor_area = ink_iou(rcs, comp_cs)
            cf = rounded(map_all(comp_cs, SCALE, -SCALE, -union(rcs)[0] * SCALE + SIDE, 0.0))
            comparisons[r] = {"iou": iou, "max_shift_fu": shift, "real_fu": svg_path(g.contours),
                              "comp_fu": svg_path(cf), "adv": max(g.advance, int(union(cf)[2]) + SIDE)}
            stats.append({"rub": r, "page": lab.page, "class": info["cls"] + (str(info["q"]) if info["q"] else ""),
                          "ink_iou": round(iou, 4), "xor_area_svg_units2": round(xor_area, 3),
                          "max_component_shift_font_units": round(shift, 1)})
        else:
            g = glyph_from(name, cp, comp_cs, SCALE, 0,
                           {"kind": "margin", "key": r, "info": info, "source": {"composed": True}})
        if info["cls"] == "J":
            g.meta["text"] = f"الجُزۡءُ {eastern(info['juz'])} الحِزۡبُ {eastern(info['hizb'])}"
        else:
            frac = {0: "", 1: "رُبُع ", 2: "نِصۡف ", 3: "ثَلَاثَةُ أَرۡبَاعِ "}[info["q"]]
            g.meta["text"] = f"{frac}الحِزۡبُ {eastern(info['hizb'])}"
        out.append(g)
    ious = [c["ink_iou"] for c in stats]
    shifts = [c["max_component_shift_font_units"] for c in stats]
    report["composed_vs_real"] = {
        "labels": len(stats), "ink_iou_min": min(ious), "ink_iou_median": med(ious),
        "max_component_shift_font_units": {"median": med(shifts), "max": max(shifts)},
        "note": "IoU of the rasterised ink (12 px per SVG unit) of composed vs real label; shift = largest "
                "bounding-box displacement of any component (word, fraction word, digit) in font units",
        "per_label": stats}
    return out, comparisons


def write_map(out: Path, glyphs, ymax, ymin, space_adv):
    entries, present = [], {g.cp for g in glyphs}
    for g in glyphs:
        if g.cp is None or g.meta.get("kind") == "space":
            continue
        b = union(g.contours)
        e = {"codepoint": f"U+{g.cp:04X}", "cp": g.cp, "glyph": g.name, "kind": g.meta["kind"],
             "key": g.meta["key"], "text": g.meta.get("text"), "source": g.meta["source"], "advance": g.advance,
             "bbox": [math.floor(b[0]), math.floor(b[1]), math.ceil(b[2]), math.ceil(b[3])]}
        if g.meta["kind"] == "margin":
            e["rub"] = {k: g.meta["info"][k] for k in ("hizb", "juz", "q", "cls", "page", "ayah")}
        entries.append(e)
    missing = [{"codepoint": f"U+{cp:04X}", "kind": kind, "key": key,
                "reason": "no page of the input set shows this running head"}
               for kind, base, keys in (("surah", CP_SURAH, range(2, 115)), ("juz", CP_JUZ, range(1, 31)))
               for key in keys for cp in [base + key] if cp not in present]
    mapping = {
        "font": {"family": FAMILY, "file": "QuranPrintLabels.otf", "version": VERSION, "unitsPerEm": UPM,
                 "ascender": ymax, "descender": ymin, "space_advance": space_adv, "source": SOURCE_TEXT,
                 "baselines": {"surah/juz": "the running-head baseline, identical for every header glyph",
                               "margin": "the baseline of the label's «الحِزۡبُ»",
                               "word/digit": "shared with «الحِزۡبُ»"}},
        "glyphs": entries, "missing": missing}
    (out / "map.json").write_text(json.dumps(mapping, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                                  encoding="utf-8")
    return entries, missing


def reload_check(path: Path, glyphs):
    """Parse the written font again and draw every glyph."""
    font = TTFont(str(path))
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    for g in glyphs:
        if g.cp is not None and cmap.get(g.cp) != g.name:
            raise BuildError(f"cmap mismatch for U+{g.cp:04X}")
        gs[g.name].draw(BoundsPen(gs))
    return {"glyphs": len(font.getGlyphOrder()), "cmap": len(cmap), "tables": sorted(font.keys())}


def juz1_reference(args, meta: Meta, juz1_glyph, baseline, report):
    """The real juz-1 running head from --reference-pages, aligned on «الجُزۡءُ» (QA only)."""
    if not args.reference_pages or juz1_glyph is None:
        return None
    ref_pages = find_pages(args.reference_pages)
    for p in sorted(ref_pages):
        if p in meta.pages and meta.juz_of_page(p) == [1]:
            groups = read_groups(ref_pages[p])
            if G_JUZ not in groups:
                continue
            ref = glyph_from("ref", None, groups[G_JUZ], SCALE, baseline, {})
            a, b = alef_of(juz1_glyph.contours), alef_of(ref.contours)
            cs = shift_all(ref.contours, a.x1 - b.x1, a.y0 - b.y0)
            iou, _xor = ink_iou(map_all(juz1_glyph.contours, 1 / SCALE, 1 / SCALE, 0, 0),
                                map_all(cs, 1 / SCALE, 1 / SCALE, 0, 0))
            report["composed"]["juz1_header"]["vs_reference_page"] = {
                "page": p, "file": ref_pages[p].name, "ink_iou": round(iou, 4),
                "advance_composed": juz1_glyph.advance, "advance_reference": ref.advance}
            return cs
    return None


# --------------------------------------------------------------------------
# QA sheets
# --------------------------------------------------------------------------

QA_HEAD = """<!doctype html><html lang="ar"><meta charset="utf-8"><title>{title}</title>
<style>
@font-face {{ font-family: "Quran Print Labels"; src: url("QuranPrintLabels.otf") format("opentype"); }}
body {{ margin: 12px; background: #fff; color: #111;
       font: 13px/1.3 -apple-system, "Helvetica Neue", Arial, sans-serif; }}
h1 {{ font-size: 16px; margin: 0 0 8px; }}
.qpl {{ font-family: "Quran Print Labels"; }}
.ar {{ font-family: "Geeza Pro", "Noto Naskh Arabic", Arial, sans-serif; font-size: 20px; }}
.grid {{ display: flex; flex-wrap: wrap; gap: 6px; }}
.cell {{ border: 1px solid #ccc; padding: 4px 6px; }}
.row {{ display: flex; justify-content: space-between; align-items: center; gap: 12px; }}
.meta {{ color: #555; font-size: 11px; }}
.bad {{ color: #c00; font-weight: bold; }}
svg text {{ font-family: "Quran Print Labels"; }}
svg .lbl {{ font: 10px sans-serif; fill: #666; }}
</style><h1>{title}</h1>
"""


def qa_page(out: Path, name, title, body):
    (out / name).write_text(QA_HEAD.format(title=html.escape(title)) + body, encoding="utf-8")


def qa_glyph(cp, size):
    return f'<span class="qpl" dir="rtl" style="font-size:{size}px">&#x{cp:X};</span>'


def source_text(g):
    if g is None:
        return ""
    return f"page {g.meta['source']['page']}" if "page" in g.meta["source"] else "composed"


def write_qa(out: Path, glyphs, meta: Meta, comparisons, juz1_ref, juz1_glyph, layout_lines):
    by_cp = {g.cp: g for g in glyphs if g.cp is not None}

    rows = []
    for n in range(2, 115):
        cp, g = CP_SURAH + n, by_cp.get(CP_SURAH + n)
        rows.append(f'<div class="cell row" style="width:330px"><span class="meta">{n} · U+{cp:X}<br>'
                    f'{source_text(g)}</span><span class="ar">سورة {html.escape(meta.surah_name[n])}</span>'
                    + (qa_glyph(cp, 64) if g else '<span class="bad">no glyph</span>') + "</div>")
    qa_page(out, "qa-surah.html", "Quran Print Labels · surah running heads U+F602–U+F672 (core.db name beside)",
            '<div class="grid">' + "".join(rows) + "</div>")

    rows = []
    for j in range(1, 31):
        cp, g = CP_JUZ + j, by_cp.get(CP_JUZ + j)
        rows.append(f'<div class="cell row" style="width:440px"><span class="meta">juz {j} · U+{cp:X}<br>'
                    f'{source_text(g)}</span><span class="ar">الجزء {JUZ_ORDINALS[j - 1]}</span>'
                    + (qa_glyph(cp, 64) if g else '<span class="bad">no glyph</span>') + "</div>")
    extra = ""
    if juz1_ref is not None:
        a, b = svg_path(juz1_glyph.contours), svg_path(juz1_ref)
        x0, y0, x1, y1 = union(list(juz1_glyph.contours) + list(juz1_ref))
        vb = f"{x0 - 40:.0f} {-y1 - 40:.0f} {x1 - x0 + 80:.0f} {y1 - y0 + 80:.0f}"
        cells = []
        for label, body in (("composed glyph U+F701", f'<path d="{a}"/>'),
                            ("real running head of the reference page (QA only)", f'<path d="{b}"/>'),
                            ("overlay: reference black, composed red",
                             f'<path d="{b}"/><path d="{a}" fill="#e00" fill-opacity="0.5"/>')):
            cells.append(f'<div class="cell"><div class="meta">{label}</div>'
                         f'<svg height="{0.32 * (y1 - y0 + 80):.0f}" viewBox="{vb}">'
                         f'<g transform="scale(1,-1)">{body}</g></svg></div>')
        extra = ('<h1 style="margin-top:16px">Juz 1, composed (no page of juz 1 with a running head is in '
                 'the input)</h1><div class="grid">' + "".join(cells) + "</div>")
    qa_page(out, "qa-juz.html", "Quran Print Labels · juz running heads U+F701–U+F71E",
            '<div class="grid">' + "".join(rows) + "</div>" + extra)

    cells, k, base_y = [], 120 / UPM, 100
    for r in range(1, 241):
        cp, g = CP_RUB + r, by_cp[CP_RUB + r]
        info = g.meta["info"]
        frac = ("", "¼", "½", "¾")[info["q"]]
        title = f'r{r} {info["cls"]}{frac} h{info["hizb"]} j{info["juz"]} p{info["page"]}'
        parts = [f'<text x="6" y="{base_y}" font-size="120">&#x{cp:X};</text>']
        width, status = g.advance * k + 12, "composed"
        if r in comparisons:
            c = comparisons[r]
            status = f'real · IoU {c["iou"]:.3f} · max shift {c["max_shift_fu"]:.0f} fu'
            x = width + 8
            for label, body in (("SVG", f'<path d="{c["real_fu"]}"/>'),
                                ("composed", f'<path d="{c["comp_fu"]}" fill="#05a"/>'),
                                ("overlay", f'<path d="{c["real_fu"]}"/>'
                                            f'<path d="{c["comp_fu"]}" fill="#e00" fill-opacity="0.5"/>')):
                parts.append(f'<g transform="translate({x},{base_y}) scale({k},{-k})">{body}</g>'
                             f'<text class="lbl" x="{x}" y="{base_y + 58}">{label}</text>')
                x += c["adv"] * k + 8
            width = x
        parts.append(f'<line x1="0" x2="{width:.0f}" y1="{base_y}" y2="{base_y}" stroke="#4a90e2" '
                     f'stroke-width="0.5" stroke-dasharray="2 2"/>')
        cells.append(f'<div class="cell"><div class="meta">{title}<br>{status}</div>'
                     f'<svg width="{width:.0f}" height="{base_y + 62}">{"".join(parts)}</svg></div>')
    qa_page(out, "qa-margin.html", "Quran Print Labels · margin labels U+F801–U+F8F0 (font glyph; real labels "
            "also: SVG source, composer output, overlay with composed in red; dashed line = baseline)",
            '<div class="grid">' + "".join(cells) + "</div>")

    rlm = "&#x200F;"
    digits = "".join(f'<div class="cell" style="text-align:center">{qa_glyph(CP_DIGIT0 + i, 90)}'
                     f'<div class="meta">U+{CP_DIGIT0 + i:04X} <span class="ar">{EASTERN[i]}</span></div></div>'
                     for i in range(10))
    words = "".join(f'<div class="cell" style="text-align:center">{qa_glyph(CP_WORD + off, 90)}'
                    f'<div class="meta">U+{CP_WORD + off:X} <span class="ar">{txt}</span></div></div>'
                    for _key, off, txt in WORDS)
    examples = []
    for seq_words, n in (((0, 3), 27), ((1, 3), 60), ((2, 3), 13), ((4,), 14), ((5,), None)):
        seq = " ".join(f"&#x{CP_WORD + w:X};{rlm}" for w in seq_words)
        txt = " ".join(WORDS[w][2] for w in seq_words)
        if n is not None:
            seq, txt = f"{seq} {eastern(n)}", f"{txt} {eastern(n)}"
        examples.append(f'<div class="cell row"><span class="ar">{txt}</span>'
                        f'<span class="qpl" dir="rtl" style="font-size:90px;white-space:nowrap">{seq}</span></div>')
    qa_page(out, "qa-pieces.html", "Quran Print Labels · digits, words and one-line labels",
            '<h1>Digits U+0660–U+0669</h1><div class="grid">' + digits + "</div>"
            '<h1 style="margin-top:12px">Words U+F500–U+F505</h1><div class="grid">' + words + "</div>"
            '<h1 style="margin-top:12px">One-line labels set with the font: glyphs separated by spaces, each '
            'word followed by U+200F (PUA code points are bidi class L)</h1>'
            '<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">' + "".join(examples)
            + '</div><pre class="meta">' + html.escape("\n".join(layout_lines)) + "</pre>")


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def analyse_running_heads(pages, meta: Meta, report):
    surah_labels, juz_labels, baseline = analyse_headers(pages, meta, report)
    all_surah = [lab for s in sorted(surah_labels) for lab in surah_labels[s]]
    all_juz = [lab for j in sorted(juz_labels) for lab in juz_labels[j]]
    surah_tmpl, _ = header_word_template(all_surah, rightmost_body)
    juz_tmpl, _ = header_word_template(all_juz, rightmost_body)
    ref = surah_labels[min(surah_labels)][0]
    surah_word = match_template(ref.contours, rightmost_body(ref.contours), surah_tmpl)
    tops = {}
    for lab in all_surah:
        tops.setdefault(lab.page, []).append(rightmost_body(lab.contours).y1)
    mid = med(v for vals in tops.values() for v in vals)
    report["header"]["pages_offset_from_median_baseline"] = {
        str(p): round(med(v) - mid, 2) for p, v in sorted(tops.items()) if abs(med(v) - mid) >= 0.15}
    report["header"]["repeat_consistency_svg_units"] = {
        "surah": {str(s): round(header_consistency(v), 3) for s, v in sorted(surah_labels.items()) if len(v) > 1},
        "juz": {str(j): round(header_consistency(v), 3) for j, v in sorted(juz_labels.items()) if len(v) > 1}}
    return {"surah": surah_labels, "juz": juz_labels, "baseline": baseline, "surah_tmpl": surah_tmpl,
            "juz_tmpl": juz_tmpl, "surah_word": (surah_word, ref.page)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--pages", type=Path, required=True, help="directory of NNN.svg pages")
    ap.add_argument("--db", type=Path, required=True, help="core.db (opened read-only)")
    ap.add_argument("--license", type=Path, required=True, help="LICENSE of the SVG dataset")
    ap.add_argument("--out", type=Path, required=True, help="output directory")
    ap.add_argument("--reference-pages", type=Path, help="pages used only to check composed glyphs")
    args = ap.parse_args(argv)
    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    report = {"generator": Path(__file__).name, "version": VERSION, "scale_font_units_per_svg_unit": SCALE}

    meta = Meta(args.db)
    pages = {p: read_groups(f) for p, f in find_pages(args.pages).items()}
    report["input_pages"] = sorted(pages)

    heads = analyse_running_heads(pages, meta, report)
    labels = collect_margin_labels(pages, meta, report)
    decompose_margin(labels, report)
    lay = measure(labels, report)
    cut_words_and_digits(labels, lay, heads["surah_word"], heads["baseline"], report)

    # space: the print's gap between «الحِزۡبُ» and its number (juz labels), less the side bearing
    space_adv = max(0, int(round(lay.consts["word_number_gap"] * SCALE - SIDE)))
    glyphs = [notdef_glyph(), Glyph("space", 0x20, [], space_adv, {"kind": "space"}),
              Glyph("uni00A0", 0xA0, [], space_adv, {"kind": "space"})]
    glyphs += digit_glyphs(lay)
    glyphs += word_glyphs(lay, heads["juz"], heads["juz_tmpl"], report)
    head_glyphs, juz1_glyph = header_glyphs(meta, heads, report)
    glyphs += head_glyphs
    margin, comparisons = margin_glyphs(meta, labels, lay, report)
    glyphs += margin

    font_path = out / "QuranPrintLabels.otf"
    ymax, ymin = build_font(glyphs, args.license.read_text(encoding="utf-8"), font_path)
    entries, missing = write_map(out, glyphs, ymax, ymin, space_adv)
    report.update({
        "space_advance": space_adv, "vertical_metrics": {"ascender": ymax, "descender": ymin},
        "glyph_counts": {k: sum(e["kind"] == k for e in entries)
                         for k in ("digit", "word", "surah", "juz", "margin")},
        "composed_counts": {k: sum(e["kind"] == k and bool(e["source"].get("composed")) for e in entries)
                            for k in ("surah", "juz", "margin")},
        "missing": missing, "reload": reload_check(font_path, glyphs)})

    juz1_ref = juz1_reference(args, meta, juz1_glyph, heads["baseline"], report)
    layout_lines = [f"{k}: {v}" for k, v in report["layout"].items()] + [f"space advance: {space_adv}"]
    write_qa(out, glyphs, meta, comparisons, juz1_ref, juz1_glyph, layout_lines)
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                                     encoding="utf-8")
    print(f"{font_path}: {font_path.stat().st_size} bytes, {len(glyphs)} glyphs; composed: "
          f"{report['composed_counts']}; missing: {[m['codepoint'] for m in missing]}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BuildError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
