/**
 * Per-style rendering tunables.
 *
 * - `glyphScale` (`--glyph-scale`) is set from data, not by eye: `floor2(16.5 / p99(natural line width in em))`
 *   over every justified line of all 604 pages, measured by `node scripts/measure-glyph-scale.mjs` with each page's own
 *   QCF font (core.db line data, the renderer's line rules, the installed Edge). `--write` rewrites the block between
 *   the `measured` markers below; the statistics behind it are kept in `GLYPH_SCALE_MEASUREMENT`.
 * - `centerGap` (`--center-gap`, em) is the word gap of centred lines; for Unicode renditions (the hafs style and every
 *   fallback rendition) it is also the minimum word gap of justified lines (lines.css). Hafs uses 0.22 em, the KFGQPC
 *   Hafs V30 face's own space advance (U+0020 = 450/2048 em), measured together with its glyph scale.
 * - The fallback rendition of a QCF style uses the hafs metrics in that style's line layout; its dense lines (under
 *   1 % at 0.98) are scaled uniformly by the bounded line-fit.
 * - The hafs style itself draws at its spread's scale (unicodeFit.ts): the hafs `glyphScale` is the floor of that
 *   per-spread fit (up to 0.92), since one global value leaves the typical page loosely set. The fallback keeps it.
 *
 * Target: ≥ 99 % of lines fit at `--fit ≥ 0.98` (`GLYPH_SCALE_MEASUREMENT.styles[style].fitPct`).
 */
import type { MushafStyle } from '$lib/ipc/bindings'

export interface StyleMetrics {
  /** `--glyph-scale`: the glyph font size in qfs (1 em = qfs × glyphScale). */
  glyphScale: number
  /** Gap between words of a centred line, in em (and the minimum gap of justified Unicode lines). */
  centerGap: number
}

// <measured>
// Written by `node scripts/measure-glyph-scale.mjs --write` on 2026-10-10 (core.db qdc, QCF fonts data/cache/qcf-all, pages 1–604).
export const STYLE_METRICS: Readonly<Record<MushafStyle, StyleMetrics>> = {
  hafs: { glyphScale: 0.82, centerGap: 0.22 },
  qcf_v2: { glyphScale: 1.03, centerGap: 0.12 },
  qcf_v1: { glyphScale: 1.11, centerGap: 0.14 },
  qcf_v4: { glyphScale: 0.99, centerGap: 0.12 },
}

/**
 * The measurement behind `STYLE_METRICS`: natural line width p99 in em, lines measured, and the share of lines that
 * fit at `--fit ≥ 0.98` with the chosen scale; `fallback` is the Hafs fallback rendition in the V1 and V4 layouts.
 */
export const GLYPH_SCALE_MEASUREMENT = {
  date: '2026-10-10',
  source: 'core.db qdc, QCF fonts data/cache/qcf-all',
  pages: '1–604',
  styles: {
    hafs: { p99: 20, lines: 8791, fitPct: 99.67 },
    qcf_v2: { p99: 15.87, lines: 8791, fitPct: 99.99 },
    qcf_v1: { p99: 14.85, lines: 8801, fitPct: 100 },
    qcf_v4: { p99: 16.59, lines: 8793, fitPct: 100 },
  },
  fallback: {
    v1: { p99: 20.12, lines: 8801, fitPct: 99.48 },
    v4: { p99: 20.43, lines: 8793, fitPct: 99.17 },
  },
} as const
// </measured>

/** The audio-word glide spring: Svelte `Spring` options, played as a compositor easing (glide.ts). */
export const GLIDE_SPRING = { stiffness: 0.22, damping: 0.78 } as const
