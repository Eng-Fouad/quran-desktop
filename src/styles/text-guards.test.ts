/**
 * Two guards over every style rule of the app (component `<style>` blocks and the CSS files):
 *
 * 1. **Arabic ink is never clipped by a one-line ellipsis.** IBM Plex Sans Arabic needs ≈ 1.5 em for its dots and marks
 *    (Noto Naskh more), above the 1.2–1.4 line boxes of labels. A rule that truncates with `text-overflow: ellipsis`
 *    and `overflow: hidden` cuts the dots below the baseline («التالي» reads «التالى»). It clips the inline axis only:
 *    `overflow-x: clip; overflow-y: visible` (base.css `.truncate`). Multi-line clamps (`line-clamp`) must clip both
 *    axes; those give Arabic a 1.6 line box instead.
 * 2. **`--text-faint` is no text colour for information** (§9.2: decoration and disabled states only, ≥ 3:1). Small
 *    text needs 4.5:1, which is `--text-muted`. `color: var(--text-faint)` is allowed only on selectors that name a
 *    disabled or inactive state, a separator or joiner glyph, a placeholder, or a non-text graphic.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(process.cwd(), 'src')

interface Rule {
  file: string
  line: number
  selector: string
  body: string
}

function* styleFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (name === 'node_modules' || name === 'fixtures') continue
    if (statSync(path).isDirectory()) yield* styleFiles(path)
    else if (/\.(svelte|css)$/.test(name)) yield path
  }
}

/** The innermost `selector { declarations }` blocks of a file (comments blanked, line numbers kept). */
function rules(file: string): Rule[] {
  let text = readFileSync(file, 'utf8')
  if (file.endsWith('.svelte')) {
    // Only the <style> block: markup and script braces are no CSS.
    const start = text.indexOf('<style')
    if (start < 0) return []
    text = text.slice(0, start).replace(/[^\n]/g, ' ') + text.slice(start)
  }
  text = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  const out: Rule[] = []
  const block = /([^{}]*)\{([^{}]*)\}/g
  for (let m = block.exec(text); m !== null; m = block.exec(text)) {
    const selector = (m[1] ?? '').trim().replace(/\s+/g, ' ')
    out.push({
      file: relative(process.cwd(), file).split(sep).join('/'),
      line: text.slice(0, m.index + (m[1] ?? '').length).split('\n').length,
      selector,
      body: m[2] ?? '',
    })
  }
  return out
}

const ALL = [...styleFiles(SRC)].flatMap(rules)

describe('style guards', () => {
  it('reads the app’s style rules', () => {
    expect(ALL.length).toBeGreaterThan(2000)
    expect(ALL.some((r) => r.file === 'src/styles/base.css' && r.selector.endsWith('.truncate'))).toBe(true)
  })

  it('a one-line ellipsis clips the inline axis only, never Arabic dots below the baseline', () => {
    const offenders = ALL.filter(
      (r) =>
        /text-overflow:\s*ellipsis/.test(r.body) &&
        !/line-clamp/.test(r.body) &&
        (/(^|[\s;])overflow(-y)?:\s*(hidden|clip)\b/.test(r.body) || !/overflow-y:\s*visible/.test(r.body)),
    ).map((r) => `${r.file}:${r.line} ${r.selector}`)
    expect(offenders).toEqual([])
  })

  it('an ellipsis rule keeps its element shrinkable (`overflow: clip` is no scroll container)', () => {
    const offenders = ALL.filter(
      (r) => /text-overflow:\s*ellipsis/.test(r.body) && /overflow-x:\s*clip/.test(r.body),
    )
      .filter((r) => !/(^|[\s;])(min-inline-size|min-width):/.test(r.body))
      .map((r) => `${r.file}:${r.line} ${r.selector}`)
    expect(offenders).toEqual([])
  })

  it('sizes a text field by its row, never by a fixed or percent height (Blink would clip its Arabic dots)', () => {
    // Blink resets a single-line input's line box to `normal` when the input has a fixed height taller than its
    // line-height, or a percent or calc() height. IBM Plex Sans Arabic's normal line box is shorter than its dots, so
    // such a field draws «في» as «فى». Fields stretch in their flex row instead (`align-self: stretch`).
    const offenders: string[] = []
    for (const file of styleFiles(join(SRC, 'components'))) {
      if (!file.endsWith('.svelte')) continue
      const text = readFileSync(file, 'utf8')
      const classes = new Set<string>()
      for (const m of text.matchAll(
        /<input\b(?![^>]*type="(?:checkbox|radio|range|color)")[^>]*?class=(?:"([^"]*)"|\{([^}]*)\})/gs,
      )) {
        for (const c of (m[1] ?? m[2] ?? '').matchAll(/([a-z][a-z0-9-]*)/g)) classes.add(c[1] ?? '')
      }
      if (classes.size === 0) continue
      for (const r of rules(file)) {
        const targets = [...classes].some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(r.selector))
        if (targets && /(^|[\s;])(block-size|height)\s*:\s*[^;]*(px|%|calc|vh)/.test(r.body)) {
          offenders.push(`${r.file}:${r.line} ${r.selector}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('uses --text-faint as a text colour only for decoration and disabled states (§9.2)', () => {
    /**
     * Selectors that may: a disabled, inactive, locked or blocked state; a separator or joiner glyph (`·`, `+`); a
     * placeholder; a footnote marker without its note; a status dot (a graphic, 3:1 as a UI component).
     */
    const ALLOWED =
      /disabled|\binactive\b|\.locked\b|\.blocked\b|\.sep\b|\.plus\b|placeholder|\.orphan\b|\.rs-dot\b/
    const offenders = ALL.filter(
      (r) => /(^|[\s;])color:\s*var\(--text-faint\)/.test(r.body) && !ALLOWED.test(r.selector),
    ).map((r) => `${r.file}:${r.line} ${r.selector}`)
    expect(offenders).toEqual([])
  })
})
