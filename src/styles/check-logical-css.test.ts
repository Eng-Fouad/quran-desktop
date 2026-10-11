/**
 * Tests for scripts/check-logical-css.mjs (`pnpm lint:css`, ARCHITECTURE §11.3 and §9.3). Owner: WP7a.
 * The script is run as a CLI on fixture files in a temporary directory, exactly as CI runs it.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const SCRIPT = resolve(process.cwd(), 'scripts/check-logical-css.mjs')
/**
 * Every assertion starts a Node process (the CLI, as CI runs it): fast alone, but with the other unit files running in
 * parallel on a busy machine a single test can pass vitest's 5 s default. The assertions are unchanged.
 */
const SPAWNS = { timeout: 30_000 }

interface Violation {
  file: string
  line: number
  column: number
  message: string
}

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qd-logical-css-'))
})
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

let counter = 0
/** Writes a fixture and lints it; returns the exit status and the violations as `line: message` strings. */
function lint(ext: '.css' | '.svelte', source: string): { status: number | null; found: string[] } {
  const file = join(dir, `fixture-${counter++}${ext}`)
  writeFileSync(file, source)
  const run = spawnSync(process.execPath, [SCRIPT, '--json', file], { encoding: 'utf8' })
  if (run.status === 2) throw new Error(run.stderr)
  const { violations } = JSON.parse(run.stdout) as { violations: Violation[] }
  return { status: run.status, found: violations.map((v) => `${v.line}: ${v.message}`) }
}
const lines = (r: { found: string[] }): number[] => r.found.map((f) => Number(f.split(':')[0]))

describe('physical properties and values', SPAWNS, () => {
  it('passes logical CSS', () => {
    const r = lint(
      '.css',
      `.a { margin-inline-start: 4px; padding-inline: 8px; inset-inline-end: 0; text-align: start;
         border-inline-start: 1px solid; border-start-end-radius: 4px; float: inline-end; }
       .b { margin: 0 auto; padding: 4px 8px 12px; inset: 0; border-radius: 0 0 6px 6px; margin: 1px 2px 3px 2px; }
       .c { transition: left 200ms; --left: 4px; background-position: left center; }`,
    )
    expect(r).toEqual({ status: 0, found: [] })
  })

  it('flags every physical property and value with its logical replacement', () => {
    const r = lint(
      '.css',
      [
        '.a {',
        '  margin-left: 4px;',
        '  padding-right: 2px;',
        '  left: 0;',
        '  right: 0;',
        '  border-left: 1px solid;',
        '  border-right-color: red;',
        '  border-top-left-radius: 4px;',
        '  text-align: right;',
        '  float: left;',
        '  justify-content: left;',
        '  scroll-margin-left: 4px;',
        '}',
      ].join('\n'),
    )
    expect(r.status).toBe(1)
    expect(r.found).toEqual([
      '2: physical property `margin-left`: use `margin-inline-start`',
      '3: physical property `padding-right`: use `padding-inline-end`',
      '4: physical property `left`: use `inset-inline-start`',
      '5: physical property `right`: use `inset-inline-end`',
      '6: physical property `border-left`: use `border-inline-start`',
      '7: physical property `border-right-color`: use `border-inline-end-color`',
      '8: physical property `border-top-left-radius`: use `border-start-start-radius`',
      '9: physical value `text-align: right`: use `end`',
      '10: physical value `float: left`: use `inline-start`',
      '11: physical value `justify-content: left`: use `start`',
      '12: physical property `scroll-margin-left`: use `scroll-margin-inline-start`',
    ])
  })

  it('flags asymmetric four-value shorthands and border-radius corners', () => {
    const r = lint(
      '.css',
      [
        '.a { margin: 0 8px 0 4px; }',
        '.b { inset: 0 auto auto 0; }',
        '.c { border-radius: 8px 0 0 8px; }',
        '.d { border-radius: 4px 0; }',
        '.e { padding: 1px 2px 3px 2px; border-radius: 50%; border-radius: 4px 4px 0 0 / 2px 2px 0 0; }',
      ].join('\n'),
    )
    expect(lines(r)).toEqual([1, 2, 3, 4])
    expect(r.found[0]).toContain('asymmetric `margin: 0 8px 0 4px`')
  })

  it('sees declarations inside nesting, @media, @layer, @keyframes and :global()', () => {
    const r = lint(
      '.css',
      [
        '@layer components {',
        '  @media (min-width: 600px) {',
        '    :global(.x) .y {',
        '      &:hover { margin-right: 1px; }',
        '    }',
        '  }',
        '}',
        '@keyframes slide { from { left: 0; } to { left: 10px; } }',
      ].join('\n'),
    )
    expect(lines(r)).toEqual([4, 8, 8])
  })

  it('rejects :dir() selectors, which the production CSS target rewrites into a :lang() list', () => {
    const r = lint(
      '.css',
      ['.ok[dir="rtl"] .x { scale: -1 1; }', '.chev:dir(rtl) { scale: -1 1; }'].join('\n'),
    )
    expect(lines(r)).toEqual([2])
    expect(r.found[0]).toContain("use `[dir='rtl']` / `[dir='ltr']`")
  })

  it('ignores comments, strings and custom properties', () => {
    const r = lint(
      '.css',
      `/* margin-left: 4px; */ .a::before { content: "left: 0; right: 0"; --pad-left: 4px; }`,
    )
    expect(r.found).toEqual([])
  })
})

describe('the physical-ok exemption', SPAWNS, () => {
  it('allows a declaration whose line carries the marker, and only that one', () => {
    const r = lint(
      '.css',
      [
        '.mp[data-side="right"] .mp-block { right: calc(var(--qfs) * 2.75); }  /* physical-ok: outer margin */',
        '.mp[data-side="left"] .mp-block {',
        '  left: 0; /* physical-ok */',
        '  margin-left: 2px;',
        '}',
      ].join('\n'),
    )
    expect(r.found).toEqual(['4: physical property `margin-left`: use `margin-inline-start`'])
  })

  it('covers every line of a multi-line declaration', () => {
    const r = lint('.css', ['.a {', '  margin:', '    0 8px 0 4px; /* physical-ok */', '}'].join('\n'))
    expect(r.found).toEqual([])
  })
})

describe('Svelte files', SPAWNS, () => {
  it('lints <style> blocks with correct line numbers and skips <script>', () => {
    const r = lint(
      '.svelte',
      [
        '<script lang="ts">',
        "  const css = 'margin-left: 4px'",
        '  el.style.left = "3px"',
        '</script>',
        '',
        '<div class="row">x</div>',
        '',
        '<style>',
        '  .row { padding-left: 4px; }',
        '</style>',
      ].join('\n'),
    )
    expect(r.found).toEqual(['9: physical property `padding-left`: use `padding-inline-start`'])
  })

  it('lints style attributes (with expressions) and style: directives', () => {
    const r = lint(
      '.svelte',
      [
        '<div style="left: {x}px; top: 0">a</div>',
        '<div style:margin-right={gap} style:text-align="left" style:color="red">b</div>',
        '<div style="inset-inline-start: {x}px" style:text-align={align}>c</div>',
        '{#if a < b}<span style="right: 0">d</span>{/if}',
      ].join('\n'),
    )
    expect(r.found).toEqual([
      '1: physical property `left`: use `inset-inline-start`',
      '2: physical property `margin-right`: use `margin-inline-end`',
      '2: physical value `text-align: left`: use `start`',
      '4: physical property `right`: use `inset-inline-end`',
    ])
  })

  it('honours physical-ok in markup (inline comment or an HTML comment on the line above)', () => {
    const r = lint(
      '.svelte',
      [
        '<div style="left: {x}px /* physical-ok: pointer position */">a</div>',
        '<!-- physical-ok: context menu at the pointer -->',
        '<div style:left="{x}px" style:top="{y}px">b</div>',
        '<div style:right="0">c</div>',
      ].join('\n'),
    )
    expect(r.found).toEqual(['4: physical property `right`: use `inset-inline-end`'])
  })
})

describe('Quran text (§9.3) and Arabic letter-spacing (§11.3)', SPAWNS, () => {
  it('rejects weight, style, spacing and transform on Quran-text selectors, but allows the neutral values', () => {
    const r = lint(
      '.css',
      [
        '.quran-text { font-weight: 400 !important; letter-spacing: 0; text-transform: none; font-synthesis: none; }',
        '.hit .quran-text { font-weight: 600; }',
        '.mp-glyphs .w { letter-spacing: 0.02em; }',
        '.mp-glyphs { font: 20px qd-hafs; }',
        '.ayah.quran-text { font-style: italic; word-spacing: 2px; }',
        '.mp-glyphs { color: var(--ink); font-size: 20px; }',
        '.quran-textual { font-weight: 700; }',
      ].join('\n'),
    )
    expect(lines(r)).toEqual([2, 3, 4, 5, 5])
    expect(r.found[0]).toContain('`font-weight: 600` on Quran text (§9.3)')
  })

  it('applies the Quran rule through nesting and to elements carrying the class', () => {
    const css = lint('.css', '.mp-glyphs { .w { font-weight: bold; } }')
    expect(lines(css)).toEqual([1])
    const svelte = lint(
      '.svelte',
      [
        '<span class="ayah quran-text" style="font-weight: 600">a</span>',
        '<span class:quran-text={true} style:letter-spacing="1px">b</span>',
        '<span class="label" style="font-weight: 600">c</span>',
      ].join('\n'),
    )
    expect(lines(svelte)).toEqual([1, 2])
  })

  it('rejects letter-spacing on Arabic selectors, except under :not()', () => {
    const r = lint(
      '.css',
      [
        ':lang(ar) .heading { letter-spacing: 0.06em; }',
        "[lang='ar'] .x { letter-spacing: 0; font-weight: 600; }",
        "html:not([lang='ar']) .group { letter-spacing: 0.06em; text-transform: uppercase; }",
      ].join('\n'),
    )
    expect(r.found).toEqual(['1: `letter-spacing: 0.06em` on Arabic text (§11.3): never letter-space Arabic'])
  })

  it('never exempts Quran-text violations with physical-ok', () => {
    const r = lint('.css', '.quran-text { font-weight: 600; } /* physical-ok */')
    expect(lines(r)).toEqual([1])
  })
})

describe('CLI', SPAWNS, () => {
  it('lints a directory recursively and reports file:line:column', () => {
    const sub = mkdtempSync(join(dir, 'tree-'))
    writeFileSync(join(sub, 'ok.css'), '.a { margin-inline: 0; }')
    writeFileSync(join(sub, 'bad.svelte'), '<style>\n.a { margin-left: 0; }\n</style>')
    writeFileSync(join(sub, 'ignored.ts'), 'const s = "margin-left: 0"')
    const run = spawnSync(process.execPath, [SCRIPT, sub], { encoding: 'utf8' })
    expect(run.status).toBe(1)
    expect(run.stdout).toMatch(/bad\.svelte:2:6 {2}physical property `margin-left`/)
    expect(run.stdout).toContain('2 files, 1 violation')
  })

  it('exits 0 on a clean tree and 2 on bad arguments', () => {
    const sub = mkdtempSync(join(dir, 'clean-'))
    writeFileSync(join(sub, 'ok.css'), '.a { padding-inline-start: 0; }')
    expect(spawnSync(process.execPath, [SCRIPT, sub], { encoding: 'utf8' }).status).toBe(0)
    expect(spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' }).status).toBe(2)
    expect(spawnSync(process.execPath, [SCRIPT, join(dir, 'missing')], { encoding: 'utf8' }).status).toBe(2)
  })
})
