#!/usr/bin/env node
// @ts-check
/* global document, FontFace -- measureInPage and the Hafs loader run inside the browser page (page.evaluate). */
// measure-glyph-scale — measures `--glyph-scale` per Mushaf style from data (ARCHITECTURE §8.2; WP8b).
//
//   node scripts/measure-glyph-scale.mjs [--fonts data/cache/qcf-all] [--core src-tauri/resources/core.db]
//                                        [--styles qcf_v2,qcf_v1,qcf_v4,hafs] [--pages 1-604] [--hafs-gap 0.22]
//                                        [--channel msedge|chrome|bundled] [--json artifacts/glyph-scale.json]
//                                        [--write] [--allow-partial]
//
// glyphScale = floor2(16.5 / p99(natural line width in em)) over every justified line of all 604 pages:
//   - line data (words per line, centring, glyph codes, Hafs text) comes from core.db (node:sqlite, read-only);
//   - each QCF page font comes from the --fonts directory, laid out like the app's packs/ directory
//     (`mushaf/{v1,v2,v4}/p{N}.woff2`). Fetch every page once with
//       cargo xtask fetch-dev-packs --all-pages --out data/cache/qcf-all
//     (gitignored, local development only: never commit or upload it, QF terms);
//   - the hafs style uses the bundled KFGQPC Hafs V30 face (public/fonts) and its justified lines keep a minimum word
//     gap of `--center-gap` em (lines.css, Unicode renditions), so its natural width is words + (n − 1) × gap; the gap
//     defaults to 0.22 em, the face's own space advance, and the table also shows 0.15–0.30 for comparison;
//   - widths are measured in the installed Edge/Chrome (playwright-core, no browser download) with the renderer's own
//     line rules: a max-content flex row of inline-block word spans at 100 px, one layout pass per page.
// It prints, per style: lines, median/p90/p99/max natural width, the glyph scale, and the share of lines that then fit
// at --fit ≥ 0.98 (target ≥ 99 %, §8.2). The fallback rendition (Hafs metrics in the V1 and V4 layouts) is reported too.
// The hafs style is drawn fitted per spread (src/lib/mushaf/unicodeFit.ts): scale = clamp(floor2(fill / max demand),
// floor, cap) per spread, the floor being the global scale above. The report adds that distribution (the scales'
// histogram) and the words-to-line fill and word-gap percentiles of the justified lines, globally and per spread.
// --write records the result and the date in src/lib/mushaf/metrics.ts (between the `measured` markers), which moves
// the per-spread floor with it; it never touches unicodeFit.ts (`UNICODE_FIT`). --json writes the raw statistics.
//
// Exit codes: 0 ok; 1 measurement failed; 2 bad usage or missing inputs.
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TB_W = 16.5
const FIT_TARGET = 0.98
const PAGES = 604
/** Fonts loaded and measured in parallel inside the page. */
const BATCH = 24
const MEASURE_PX = 100
const METRICS_FILE = join(ROOT, 'src', 'lib', 'mushaf', 'metrics.ts')
const UNICODE_FIT_FILE = join(ROOT, 'src', 'lib', 'mushaf', 'unicodeFit.ts')
const GEOMETRY_FILE = join(ROOT, 'src', 'lib', 'mushaf', 'geometry.ts')

/** @typedef {'hafs' | 'qcf_v2' | 'qcf_v1' | 'qcf_v4'} Style */
/** @typedef {'v2' | 'v1' | 'v4'} Layout */
/** @type {Record<Style, { layout: Layout, mushafId: number, glyph: 'code_v1' | 'code_v2' | 'text_hafs' }>} */
const STYLE = {
  qcf_v2: { layout: 'v2', mushafId: 1, glyph: 'code_v2' },
  qcf_v1: { layout: 'v1', mushafId: 2, glyph: 'code_v1' },
  qcf_v4: { layout: 'v4', mushafId: 19, glyph: 'code_v2' },
  hafs: { layout: 'v2', mushafId: 1, glyph: 'text_hafs' },
}
const ALL_STYLES = /** @type {Style[]} */ (['qcf_v2', 'qcf_v1', 'qcf_v4', 'hafs'])
/** The fallback rendition: Hafs text and metrics in the QCF layouts (§8.5 c). */
const FALLBACK_LAYOUTS = /** @type {{ layout: Layout, mushafId: number }[]} */ ([
  { layout: 'v1', mushafId: 2 },
  { layout: 'v4', mushafId: 19 },
])

class UsageError extends Error {}

function usage() {
  return readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n')
    .slice(2, 8)
    .map((l) => l.replace(/^\/\/ ?/, ''))
    .join('\n')
}

/** @param {string} spec */
function parsePages(spec) {
  const m = /^(\d+)(?:-(\d+))?$/.exec(spec.trim())
  if (!m) throw new UsageError(`--pages must be N or A-B (got "${spec}")`)
  const from = Number(m[1])
  const to = Number(m[2] ?? m[1])
  if (from < 1 || to > PAGES || from > to) throw new UsageError(`--pages must lie within 1-${PAGES}`)
  return { from, to }
}

/** @param {number} x */
const floor2 = (x) => Math.floor(x * 100 + 1e-9) / 100

/**
 * Nearest-rank percentile of a sorted array.
 * @param {number[]} sorted
 * @param {number} q 0..1
 */
function percentile(sorted, q) {
  if (sorted.length === 0) return Number.NaN
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)))
  return /** @type {number} */ (sorted[rank - 1])
}

/** @param {number} v */
const r2 = (v) => Math.round(v * 100) / 100

// --- data ----------------------------------------------------------------------------------------------------------

/**
 * @typedef {{ page: number, line: number, centered: boolean, words: string[] }} Line
 */

/**
 * Every ayah line of a layout (kind 0), grouped by page, with the requested glyph column.
 * @param {DatabaseSync} db
 * @param {number} mushafId
 * @param {'code_v1' | 'code_v2' | 'text_hafs'} column
 * @param {{ from: number, to: number }} pages
 * @returns {Map<number, Line[]>}
 */
function readLines(db, mushafId, column, pages) {
  const rows = db
    .prepare(
      `SELECT l.page AS page, l.line AS line, l.centered AS centered, w.${column} AS glyph
         FROM line AS l JOIN word AS w ON w.id BETWEEN l.first_word_id AND l.last_word_id
        WHERE l.mushaf_id = ? AND l.kind = 0 AND l.page BETWEEN ? AND ?
        ORDER BY l.page, l.line, w.id`,
    )
    .all(mushafId, pages.from, pages.to)
  /** @type {Map<number, Line[]>} */
  const byPage = new Map()
  /** @type {Line | null} */
  let current = null
  for (const row of rows) {
    const page = Number(row.page)
    const line = Number(row.line)
    if (!current || current.page !== page || current.line !== line) {
      current = { page, line, centered: Number(row.centered) === 1, words: [] }
      const list = byPage.get(page)
      if (list) list.push(current)
      else byPage.set(page, [current])
    }
    current.words.push(String(row.glyph))
  }
  return byPage
}

// --- browser -------------------------------------------------------------------------------------------------------

const HARNESS = `<!doctype html>
<html><head><meta charset="utf-8"><title>glyph scale</title>
<style>
  html, body { margin: 0; background: #fff; }
  #stage { position: absolute; inset-block-start: 0; inset-inline-start: 0; visibility: hidden; contain: layout style; }
  .lw { display: flex; inline-size: max-content; white-space: nowrap; font-size: ${MEASURE_PX}px; line-height: 1;
        direction: rtl; font-weight: 400; font-style: normal; font-synthesis: none; letter-spacing: 0;
        font-kerning: normal; font-feature-settings: normal; font-variant-ligatures: normal; }
  .w { display: inline-block; white-space: nowrap; }
</style></head><body><div id="stage"></div></body></html>`

/**
 * Serves the harness page, the page fonts and the Hafs face on 127.0.0.1 (an ephemeral port).
 * @param {string} fontsDir
 * @param {string} hafsFile
 */
async function startServer(fontsDir, hafsFile) {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?', 1)[0] ?? '/'
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(HARNESS)
      return
    }
    let file = null
    let type = 'font/woff2'
    const m = /^\/mushaf\/(v[124])\/p(\d{1,3})\.woff2$/.exec(path)
    if (m) file = join(fontsDir, 'mushaf', m[1] ?? '', `p${m[2]}.woff2`)
    else if (path === '/hafs.ttf') {
      file = hafsFile
      type = 'font/ttf'
    }
    if (!file || !existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(readFileSync(file))
  })
  await new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => done(undefined))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('the harness server has no port')
  return { url: `http://127.0.0.1:${address.port}/`, close: () => new Promise((done) => server.close(done)) }
}

/**
 * Runs in the page: loads each item's face (or uses an already loaded family), lays out every line as the renderer
 * does (gap 0) and returns the words' total advance per line in em.
 * @param {{ items: { key: string, url: string | null, family: string, lines: string[][] }[], px: number }} arg
 */
async function measureInPage({ items, px }) {
  const stage = /** @type {HTMLElement} */ (document.getElementById('stage'))
  return Promise.all(
    items.map(async (item) => {
      /** @type {FontFace | null} */
      let face = null
      if (item.url) {
        face = new FontFace(item.family, `url("${item.url}")`)
        document.fonts.add(face)
        try {
          await face.load()
        } catch (e) {
          document.fonts.delete(face)
          return { key: item.key, error: String(e), widths: [] }
        }
      }
      const box = document.createElement('div')
      for (const words of item.lines) {
        const lw = document.createElement('div')
        lw.className = 'lw'
        lw.style.fontFamily = `"${item.family}"`
        for (const glyph of words) {
          const span = document.createElement('span')
          span.className = 'w'
          span.textContent = glyph
          lw.append(span)
        }
        box.append(lw)
      }
      stage.append(box)
      const widths = [...box.children].map((lw) => lw.getBoundingClientRect().width / px)
      box.remove()
      if (face) document.fonts.delete(face)
      return { key: item.key, error: null, widths }
    }),
  )
}

/**
 * @param {string | undefined} requested
 * @returns {string | undefined}
 */
function browserChannel(requested) {
  const channel = requested ?? process.env.QD_BROWSER_CHANNEL
  if (channel === 'bundled') return undefined
  return channel ?? (!process.env.CI && process.platform === 'win32' ? 'msedge' : undefined)
}

// --- statistics ----------------------------------------------------------------------------------------------------

/**
 * @typedef {{ page: number, line: number, words: number, width: number }} Measured
 *   `width`: the words' total advance in em (no gaps).
 */

/**
 * @param {Measured[]} lines
 * @param {number} gap minimum word gap in em (Unicode renditions), 0 for QCF
 * @param {number | null} scale a fixed glyph scale to evaluate (else the measured one)
 */
function summarise(lines, gap, scale = null) {
  const widths = lines.map((l) => l.width + Math.max(0, l.words - 1) * gap).sort((a, b) => a - b)
  const p99 = percentile(widths, 0.99)
  const glyphScale = scale ?? floor2(TB_W / p99)
  const fits = widths.filter((w) => Math.min(1, TB_W / (w * glyphScale)) >= FIT_TARGET).length
  const worst = lines
    .map((l) => ({ page: l.page, line: l.line, width: l.width + Math.max(0, l.words - 1) * gap }))
    .sort((a, b) => b.width - a.width)
    .slice(0, 3)
    .map((l) => `p${l.page} l${l.line} ${r2(l.width)}`)
  return {
    lines: widths.length,
    median: r2(percentile(widths, 0.5)),
    p90: r2(percentile(widths, 0.9)),
    p99: r2(p99),
    max: r2(widths.at(-1) ?? Number.NaN),
    glyphScale,
    fitPct: widths.length ? r2((fits / widths.length) * 100) : 0,
    worst,
  }
}

// --- the hafs per-spread fit (unicodeFit.ts) ------------------------------------------------------------------------

/**
 * A numeric constant of an app source file (`name: 0.92` or `export const NAME = 2`), so the fit is evaluated with the
 * renderer's own values.
 * @param {string} file
 * @param {RegExp} pattern with one capture group
 */
function sourceNumber(file, pattern) {
  const m = pattern.exec(readFileSync(file, 'utf8'))
  const value = Number(m?.[1])
  if (!m || !Number.isFinite(value)) throw new Error(`${file}: ${pattern} not found`)
  return value
}

/**
 * The per-spread fit of the hafs style (src/lib/mushaf/unicodeFit.ts), and the resulting fill and word gaps against
 * the global scale. A line's **demand** is its natural width (words + (n − 1) × gap, in em) over its line box (16.5 qfs;
 * less the opening medallion's insets on the opening pages); every ayah line counts (centred ones must fit too), and a
 * spread without a justified line keeps the floor. **Fill**: a justified line's words over its box at the scale;
 * **gap**: the free width shared by its n − 1 gaps, in qfs; **below fit**: lines the scale leaves at fit < 0.98.
 * @param {(Measured & { centered: boolean })[]} lines every ayah line of the hafs style
 * @param {number} gap minimum word gap (em)
 * @param {number} floor the global scale (`STYLE_METRICS.hafs.glyphScale`)
 */
function spreadFit(lines, gap, floor) {
  const cap = sourceNumber(UNICODE_FIT_FILE, /\bmax:\s*([\d.]+)/)
  const fill = sourceNumber(UNICODE_FIT_FILE, /\bfill:\s*([\d.]+)/)
  const inset = sourceNumber(GEOMETRY_FILE, /export const OPENING_INSET = ([\d.]+)/)
  const openingLast = sourceNumber(GEOMETRY_FILE, /export const OPENING_LAST_PAGE = (\d+)/)
  const box = (/** @type {number} */ page) => (page <= openingLast ? TB_W - 2 * inset : TB_W)
  const natural = (/** @type {Measured} */ l) => l.width + Math.max(0, l.words - 1) * gap

  /** @type {Map<number, (Measured & { centered: boolean })[]>} */
  const bySpread = new Map()
  for (const l of lines) {
    const spread = Math.ceil(l.page / 2)
    const list = bySpread.get(spread)
    if (list) list.push(l)
    else bySpread.set(spread, [l])
  }
  /** @type {{ pages: [number, number], scale: number, demand: number }[]} */
  const spreads = []
  /** @type {Map<number, number>} spread → scale */
  const scaleOf = new Map()
  for (const [spread, list] of [...bySpread].sort((a, b) => a[0] - b[0])) {
    const demand = Math.max(...list.map((l) => natural(l) / box(l.page)))
    const justified = list.some((l) => !l.centered)
    const scale = justified && demand > 0 ? Math.min(cap, Math.max(floor, floor2(fill / demand))) : floor
    spreads.push({ pages: [spread * 2 - 1, spread * 2], scale, demand: Math.round(demand * 1000) / 1000 })
    scaleOf.set(spread, scale)
  }

  const justified = lines.filter((l) => !l.centered)
  const r3 = (/** @type {number} */ v) => Math.round(v * 1000) / 1000
  /** @param {(l: Measured) => number} scaleFor */
  const evaluate = (scaleFor) => {
    /** @type {number[]} */
    const fills = []
    /** @type {number[]} */
    const gaps = []
    let belowFit = 0
    for (const l of justified) {
      const s = scaleFor(l)
      const b = box(l.page)
      fills.push((l.width * s) / b)
      if (l.words > 1) gaps.push((b - l.width * s) / (l.words - 1))
      if (Math.min(1, b / (natural(l) * s)) < FIT_TARGET) belowFit++
    }
    fills.sort((a, b) => a - b)
    gaps.sort((a, b) => a - b)
    return {
      fillMedian: r3(percentile(fills, 0.5)),
      fillP5: r3(percentile(fills, 0.05)),
      gapMedian: r3(percentile(gaps, 0.5)),
      gapP95: r3(percentile(gaps, 0.95)),
      gapMax: r3(gaps.at(-1) ?? Number.NaN),
      belowFit,
    }
  }
  /** @type {Record<string, number>} */
  const histogram = {}
  for (const { scale } of spreads) histogram[scale.toFixed(2)] = (histogram[scale.toFixed(2)] ?? 0) + 1
  return {
    floor,
    cap,
    fill,
    spreads: spreads.length,
    histogram,
    atFloor: spreads.filter((x) => x.scale <= floor).length,
    atCap: spreads.filter((x) => x.scale >= cap).length,
    global: evaluate(() => floor),
    perSpread: evaluate((l) => scaleOf.get(Math.ceil(l.page / 2)) ?? floor),
    bySpread: spreads,
  }
}

// --- metrics.ts --------------------------------------------------------------------------------------------------

/**
 * Rewrites the measured block of metrics.ts.
 * @param {Record<string, { glyphScale: number, p99: number, lines: number, fitPct: number }>} results
 * @param {Record<string, { p99: number, lines: number, fitPct: number }>} fallback
 * @param {number} hafsGap
 * @param {{ date: string, pages: string, source: string }} meta
 */
function writeMetrics(results, fallback, hafsGap, meta) {
  const text = readFileSync(METRICS_FILE, 'utf8')
  const start = text.indexOf('// <measured>')
  const end = text.indexOf('// </measured>')
  if (start < 0 || end < start)
    throw new Error(`${METRICS_FILE}: no "// <measured>" … "// </measured>" block`)
  /** @param {string} style @param {number} gap */
  const row = (style, gap) => {
    const r = results[style]
    if (!r) throw new Error(`no result for ${style}`)
    return `  ${style}: { glyphScale: ${r.glyphScale}, centerGap: ${gap} },`
  }
  /** @param {string} name @param {{ p99: number, lines: number, fitPct: number } | undefined} r */
  const stat = (name, r) =>
    r ? `    ${name}: { p99: ${r.p99}, lines: ${r.lines}, fitPct: ${r.fitPct} },` : ''
  const block = [
    '// <measured>',
    `// Written by \`node scripts/measure-glyph-scale.mjs --write\` on ${meta.date} (${meta.source}, pages ${meta.pages}).`,
    'export const STYLE_METRICS: Readonly<Record<MushafStyle, StyleMetrics>> = {',
    row('hafs', hafsGap),
    row('qcf_v2', 0.12),
    row('qcf_v1', 0.14),
    row('qcf_v4', 0.12),
    '}',
    '',
    '/**',
    ' * The measurement behind `STYLE_METRICS`: natural line width p99 in em, lines measured, and the share of lines that',
    ' * fit at `--fit ≥ 0.98` with the chosen scale; `fallback` is the Hafs fallback rendition in the V1 and V4 layouts.',
    ' */',
    'export const GLYPH_SCALE_MEASUREMENT = {',
    `  date: '${meta.date}',`,
    `  source: '${meta.source}',`,
    `  pages: '${meta.pages}',`,
    '  styles: {',
    ...['hafs', 'qcf_v2', 'qcf_v1', 'qcf_v4'].map((name) => stat(name, results[name])).filter(Boolean),
    '  },',
    '  fallback: {',
    ...['v1', 'v4'].map((layout) => stat(layout, fallback[`fallback_${layout}`])).filter(Boolean),
    '  },',
    '} as const',
    '',
  ].join('\n')
  writeFileSync(METRICS_FILE, text.slice(0, start) + block + text.slice(end))
}

// --- main ----------------------------------------------------------------------------------------------------------

async function main() {
  const { values: args } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      fonts: { type: 'string', default: 'data/cache/qcf-all' },
      core: { type: 'string' },
      styles: { type: 'string', default: ALL_STYLES.join(',') },
      pages: { type: 'string', default: `1-${PAGES}` },
      'hafs-gap': { type: 'string', default: '0.22' },
      channel: { type: 'string' },
      json: { type: 'string', default: 'artifacts/glyph-scale.json' },
      write: { type: 'boolean', default: false },
      'allow-partial': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  })
  if (args.help) {
    console.log(usage())
    return 0
  }
  const styles = /** @type {Style[]} */ (args.styles.split(',').map((s) => s.trim()))
  for (const s of styles) if (!ALL_STYLES.includes(s)) throw new UsageError(`unknown style "${s}"`)
  const pages = parsePages(args.pages)
  const hafsGap = Number(args['hafs-gap'])
  if (!Number.isFinite(hafsGap) || hafsGap < 0 || hafsGap > 1)
    throw new UsageError('--hafs-gap must be 0–1 (em)')
  const corePath = resolve(ROOT, args.core ?? process.env.QD_CORE_DB ?? 'src-tauri/resources/core.db')
  const fontsDir = resolve(ROOT, args.fonts)
  const hafsFile = join(ROOT, 'public', 'fonts', 'KFGQPC-Hafs-V30.ttf')
  if (!existsSync(corePath) || statSync(corePath).size < 1_000_000)
    throw new UsageError(`core.db not found (or a placeholder) at ${corePath}: run pnpm core:qdc`)
  if (styles.includes('hafs') && !existsSync(hafsFile))
    throw new UsageError(`${hafsFile} is missing: run pnpm assets (cargo xtask fetch-assets)`)

  const db = new DatabaseSync(corePath, { readOnly: true })
  const source = String(
    /** @type {{ value?: unknown } | undefined} */ (
      db.prepare("SELECT value FROM meta WHERE key = 'source'").get()
    )?.value ?? 'unknown',
  )

  // Plan: one item per (style, page); hafs shares one face.
  /** @type {{ key: string, style: string, url: string | null, family: string, lines: Line[] }[]} */
  const plan = []
  /** @type {Map<string, number>} */
  const missing = new Map()
  for (const style of styles) {
    const { layout, mushafId, glyph } = STYLE[style]
    const byPage = readLines(db, mushafId, glyph, pages)
    for (const [page, lines] of byPage) {
      const justified = lines.filter((l) => !l.centered)
      if (style === 'hafs') {
        // Every ayah line: the glyph scale is measured over the justified ones, the per-spread fit over all of them.
        plan.push({ key: `hafs:${page}`, style, url: null, family: 'qd-measure-hafs', lines })
        continue
      }
      if (justified.length === 0) continue
      const file = join(fontsDir, 'mushaf', layout, `p${page}.woff2`)
      if (!existsSync(file)) {
        missing.set(style, (missing.get(style) ?? 0) + 1)
        continue
      }
      plan.push({
        key: `${style}:${page}`,
        style,
        url: `/mushaf/${layout}/p${page}.woff2`,
        family: `qd-measure-${layout}-p${page}`,
        lines: justified,
      })
    }
  }
  // The fallback rendition: Hafs text in the V1 and V4 line layouts.
  if (styles.includes('hafs')) {
    for (const { layout, mushafId } of FALLBACK_LAYOUTS) {
      for (const [page, lines] of readLines(db, mushafId, 'text_hafs', pages)) {
        const justified = lines.filter((l) => !l.centered)
        if (justified.length > 0)
          plan.push({
            key: `fallback_${layout}:${page}`,
            style: `fallback_${layout}`,
            url: null,
            family: 'qd-measure-hafs',
            lines: justified,
          })
      }
    }
  }
  db.close()
  if (missing.size > 0) {
    const what = [...missing].map(([s, n]) => `${s} ${n} pages`).join(', ')
    const hint = `fetch them with: cargo xtask fetch-dev-packs --all-pages --out ${args.fonts}`
    if (!args['allow-partial']) throw new UsageError(`page fonts missing in ${fontsDir} (${what}); ${hint}`)
    console.warn(`[measure] WARNING: measuring without ${what} (${hint})`)
  }

  const { chromium } = await import('playwright-core')
  const server = await startServer(fontsDir, hafsFile)
  const browser = await chromium.launch({ channel: browserChannel(args.channel), headless: true })
  /** @type {Map<string, Measured[]>} */
  const measured = new Map()
  /** @type {(Measured & { centered: boolean })[]} every ayah line of the hafs style (the per-spread fit) */
  const hafsAll = []
  const started = Date.now()
  try {
    const page = await browser.newPage()
    await page.goto(server.url)
    if (styles.includes('hafs')) {
      await page.evaluate(async () => {
        const face = new FontFace('qd-measure-hafs', 'url("/hafs.ttf")')
        document.fonts.add(face)
        await face.load()
      })
    }
    for (let i = 0; i < plan.length; i += BATCH) {
      const batch = plan.slice(i, i + BATCH)
      const results = await page.evaluate(measureInPage, {
        px: MEASURE_PX,
        items: batch.map((b) => ({
          key: b.key,
          url: b.url,
          family: b.family,
          lines: b.lines.map((l) => l.words),
        })),
      })
      for (const [j, result] of results.entries()) {
        const item = batch[j]
        if (!item) continue
        if (result.error) throw new Error(`${item.key}: the font did not load (${result.error})`)
        const list = measured.get(item.style) ?? []
        item.lines.forEach((line, k) => {
          const m = {
            page: line.page,
            line: line.line,
            words: line.words.length,
            width: result.widths[k] ?? 0,
          }
          if (item.style === 'hafs') hafsAll.push({ ...m, centered: line.centered })
          if (!line.centered) list.push(m)
        })
        measured.set(item.style, list)
      }
      if ((i / BATCH) % 10 === 0)
        process.stdout.write(`\r[measure] ${Math.min(i + BATCH, plan.length)}/${plan.length}`)
    }
    process.stdout.write(
      `\r[measure] ${plan.length}/${plan.length} page renditions in ${((Date.now() - started) / 1000).toFixed(1)} s\n`,
    )
  } finally {
    await browser.close()
    await server.close()
  }

  // Report.
  /** @type {Record<string, ReturnType<typeof summarise>>} */
  const results = {}
  for (const style of styles) {
    const lines = measured.get(style) ?? []
    results[style] = summarise(lines, style === 'hafs' ? hafsGap : 0)
  }
  const hafsScale = results.hafs?.glyphScale ?? null
  /** @type {Record<string, ReturnType<typeof summarise>>} */
  const fallback = {}
  for (const { layout } of FALLBACK_LAYOUTS) {
    const lines = measured.get(`fallback_${layout}`)
    if (lines) fallback[`fallback_${layout}`] = summarise(lines, hafsGap, hafsScale)
  }
  /** @type {Record<string, ReturnType<typeof summarise>>} */
  const gaps = {}
  const hafsLines = measured.get('hafs')
  if (hafsLines) for (const gap of [0.15, 0.2, 0.25, 0.3]) gaps[`hafs gap ${gap}`] = summarise(hafsLines, gap)

  const table = [
    ['style', 'lines', 'median', 'p90', 'p99', 'max', 'glyphScale', 'fit≥0.98 %', 'widest lines (em)'],
    ...Object.entries({ ...results, ...fallback, ...gaps }).map(([name, r]) => [
      name,
      String(r.lines),
      String(r.median),
      String(r.p90),
      String(r.p99),
      String(r.max),
      String(r.glyphScale),
      String(r.fitPct),
      r.worst.join(', '),
    ]),
  ]
  const widths = table[0]?.map((_, c) => Math.max(...table.map((row) => (row[c] ?? '').length))) ?? []
  for (const row of table) console.log(row.map((cell, c) => cell.padEnd(widths[c] ?? 0)).join('  '))

  // The hafs style as drawn: fitted per spread.
  const spread = hafsScale !== null && hafsAll.length > 0 ? spreadFit(hafsAll, hafsGap, hafsScale) : null
  if (spread) {
    const scales = Object.entries(spread.histogram)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([scale, n]) => `${scale}×${n}`)
      .join(' ')
    console.log(
      `\nhafs per spread (unicodeFit.ts: clamp(floor2(${spread.fill} / max demand), ${spread.floor}, ${spread.cap})), ` +
        `${spread.spreads} spreads: ${spread.atFloor} at the floor, ${spread.atCap} at the cap`,
    )
    console.log(`  scales: ${scales}`)
    /** @type {[string, ReturnType<typeof spreadFit>['global']][]} */
    const rows = [
      [`global ${spread.floor}`, spread.global],
      ['per spread', spread.perSpread],
    ]
    for (const [name, row] of rows) {
      console.log(
        `  ${name.padEnd(12)}  fill median ${row.fillMedian} (p5 ${row.fillP5})  ` +
          `gap median ${row.gapMedian} / p95 ${row.gapP95} / max ${row.gapMax} qfs  below fit 0.98: ${row.belowFit}`,
      )
    }
  }

  const date = new Date().toISOString().slice(0, 10)
  const pagesLabel = `${pages.from}–${pages.to}`
  const out = resolve(ROOT, args.json)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(
    out,
    `${JSON.stringify({ date, source, pages: pagesLabel, hafsGap, results, fallback, gaps, hafsSpreads: spread }, null, 2)}\n`,
  )
  console.log(`[measure] statistics → ${out}`)
  if (args.write) {
    writeMetrics(results, fallback, hafsGap, {
      date,
      pages: pagesLabel,
      source: `core.db ${source}, QCF fonts ${args.fonts}`,
    })
    console.log(`[measure] recorded in ${METRICS_FILE}`)
  }
  for (const [style, r] of Object.entries(results)) {
    if (r.fitPct < 99)
      console.warn(`[measure] ${style}: only ${r.fitPct} % of lines fit at --fit ≥ 0.98 (target 99 %)`)
  }
  return 0
}

main().then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof UsageError) {
      console.error(`measure-glyph-scale: ${e.message}`)
      process.exit(2)
    }
    console.error(e)
    process.exit(1)
  },
)
