#!/usr/bin/env node
// Logical-CSS and Quran-text lint. Run by `pnpm lint:css` and CI.
//
//   node scripts/check-logical-css.mjs                 lint every .css and .svelte file under src/
//   node scripts/check-logical-css.mjs <file|dir>…     lint only these
//   node scripts/check-logical-css.mjs --json …        print the violations as JSON (for tooling and tests)
//
// The UI mirrors under RTL, so styles use logical properties only. A violation is:
//   physical properties    margin-left|right, padding-left|right, left, right, border-left|right*, the
//                          border-{top,bottom}-{left,right}-radius corners, scroll-margin/padding-left|right
//   physical values        text-align / text-align-last / float / clear / justify-* : left | right
//   asymmetric shorthands  margin, padding, inset, scroll-margin, scroll-padding, border-width|style|color with four
//                          values whose 2nd and 4th differ, and border-radius whose left and right corners differ
//   :dir() selectors       the build's CSS target (chrome111) rewrites :dir(rtl) into a :lang(ar, he, fa, …) list, which
//                          mirrors inside Arabic content in the English UI; use [dir='rtl'] / [dir='ltr'] or .icon-dir
// in CSS files, Svelte <style> blocks, `style="…"` attributes and `style:prop` directives.
//
// Exemption: a declaration is allowed when one of its lines carries a comment starting with `physical-ok`
// (`left: 0; /* physical-ok: Mushaf outer margin */`) — Mushaf geometry, transport, scrubber, readout and page rail
// only. In markup, an HTML comment `<!-- physical-ok -->` on the line above the element also counts.
//
// Quran text: qd-hafs and the QCF fonts have one regular weight, so on any selector that contains `.quran-text` or
// `.mp-glyphs` (and on elements carrying those classes) these are rejected unless they keep the neutral value:
// font-weight (400/normal), font-style (normal), font-synthesis (none), letter-spacing (0/normal), word-spacing
// (0/normal), text-transform (none), and the `font` shorthand. On Arabic selectors (`:lang(ar)`, `[lang="ar"]`) a
// non-zero letter-spacing is rejected: it is never applied to Arabic text.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXTENSIONS = new Set(['.css', '.svelte'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', '.git', 'fixtures'])
const EXEMPT = /physical-ok/

/** Logical replacements, for the message. */
const PROPERTY_FIX = {
  'margin-left': 'margin-inline-start',
  'margin-right': 'margin-inline-end',
  'padding-left': 'padding-inline-start',
  'padding-right': 'padding-inline-end',
  left: 'inset-inline-start',
  right: 'inset-inline-end',
  'border-left': 'border-inline-start',
  'border-right': 'border-inline-end',
  'border-left-width': 'border-inline-start-width',
  'border-right-width': 'border-inline-end-width',
  'border-left-style': 'border-inline-start-style',
  'border-right-style': 'border-inline-end-style',
  'border-left-color': 'border-inline-start-color',
  'border-right-color': 'border-inline-end-color',
  'border-top-left-radius': 'border-start-start-radius',
  'border-top-right-radius': 'border-start-end-radius',
  'border-bottom-left-radius': 'border-end-start-radius',
  'border-bottom-right-radius': 'border-end-end-radius',
  'scroll-margin-left': 'scroll-margin-inline-start',
  'scroll-margin-right': 'scroll-margin-inline-end',
  'scroll-padding-left': 'scroll-padding-inline-start',
  'scroll-padding-right': 'scroll-padding-inline-end',
}
/** Properties whose `left`/`right` keyword values are physical, with the logical keywords. */
const VALUE_FIX = {
  'text-align': ['start', 'end'],
  'text-align-last': ['start', 'end'],
  float: ['inline-start', 'inline-end'],
  clear: ['inline-start', 'inline-end'],
  'justify-content': ['start', 'end'],
  'justify-items': ['start', 'end'],
  'justify-self': ['start', 'end'],
}
/** Four-value box shorthands: top right bottom left. */
const BOX_SHORTHANDS = new Set([
  'margin',
  'padding',
  'inset',
  'scroll-margin',
  'scroll-padding',
  'border-width',
  'border-style',
  'border-color',
])
/** The only values a Quran-text selector may declare for these properties. */
const QURAN_NEUTRAL = {
  'font-weight': ['400', 'normal'],
  'font-style': ['normal'],
  'font-synthesis': ['none'],
  'letter-spacing': ['0', 'normal', '0px', '0em'],
  'word-spacing': ['0', 'normal', '0px', '0em'],
  'text-transform': ['none'],
  font: [],
}
/** `:dir()` is rewritten by the build's CSS target (chrome111) into a `:lang()` list, which has other semantics. */
const DIR_MESSAGE =
  "`:dir()` becomes a `:lang(ar, he, fa, …)` list in the production build (CSS target chrome111): use `[dir='rtl']` / `[dir='ltr']`, or `.icon-dir` for icons"
const QURAN_SELECTOR = /\.(?:quran-text|mp-glyphs)(?![\w-])/
const ARABIC_SELECTOR = /:lang\(\s*ar\s*\)|\[\s*lang\s*=\s*["']?ar["']?\s*\]/

// ───────────────────────────── text helpers ─────────────────────────────

/** Line starts of a text, for offset → line:column. */
function lineIndex(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, column: offset - starts[lo] + 1 }
  }
}

/** Replaces every character except newlines with spaces (keeps offsets and lines). */
const blank = (s) => s.replace(/[^\n]/g, ' ')

/** Splits a value on top-level whitespace (parentheses and quotes kept together). */
function valueTokens(value) {
  const out = []
  let depth = 0
  let quote = ''
  let cur = ''
  for (const ch of value) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    if (depth === 0 && /\s/.test(ch)) {
      if (cur) out.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** Removes `:not(…)` arguments, so `:not([lang="ar"])` does not count as an Arabic selector. */
function withoutNot(selector) {
  let out = ''
  for (let i = 0; i < selector.length; i++) {
    if (selector.startsWith(':not(', i)) {
      let depth = 0
      let j = i + 4
      for (; j < selector.length; j++) {
        if (selector[j] === '(') depth++
        else if (selector[j] === ')' && --depth === 0) break
      }
      i = j
      continue
    }
    out += selector[i]
  }
  return out
}

// ───────────────────────────── checks ─────────────────────────────

/**
 * Checks one declaration. `context` = { quran: boolean, arabic: boolean } from the enclosing selectors.
 * Returns the violation messages (without location).
 */
function checkDeclaration(rawProp, rawValue, context) {
  const prop = rawProp.trim().toLowerCase()
  if (prop.startsWith('--') || prop === '') return []
  const value = rawValue
    .replace(/!\s*important\s*$/i, '')
    .trim()
    .replace(/\s+/g, ' ')
  const lower = value.toLowerCase()
  const problems = []

  if (prop in PROPERTY_FIX) problems.push(`physical property \`${prop}\`: use \`${PROPERTY_FIX[prop]}\``)
  else if (/^border-(?:left|right)-/.test(prop)) {
    const side = prop.includes('-left') ? 'start' : 'end'
    problems.push(
      `physical property \`${prop}\`: use \`${prop.replace(/-(?:left|right)/, `-inline-${side}`)}\``,
    )
  }

  if (prop in VALUE_FIX && /^(left|right)$/.test(lower)) {
    const [start, end] = VALUE_FIX[prop]
    problems.push(`physical value \`${prop}: ${lower}\`: use \`${lower === 'left' ? start : end}\``)
  }

  if (BOX_SHORTHANDS.has(prop)) {
    const parts = valueTokens(value)
    if (parts.length === 4 && parts[1] !== parts[3])
      problems.push(
        `asymmetric \`${prop}: ${value}\` (right ${parts[1]} ≠ left ${parts[3]}): use \`${prop}-block\` / \`${prop}-inline-start|end\``,
      )
  }

  if (prop === 'border-radius') {
    const asymmetric = value.split('/').some((part) => {
      const r = valueTokens(part.trim())
      if (r.length < 2 || r.length > 4) return false
      const [tl, tr = tl, br = tl, bl = tr] = r
      return tl !== tr || bl !== br
    })
    if (asymmetric)
      problems.push(
        `asymmetric \`border-radius: ${value}\`: use \`border-start-start-radius\` / \`border-start-end-radius\` / …`,
      )
  }

  if (context.quran && prop in QURAN_NEUTRAL && !QURAN_NEUTRAL[prop].includes(lower))
    problems.push(
      `\`${prop}: ${value}\` on Quran text: qd-hafs/QCF have one weight; only ${
        QURAN_NEUTRAL[prop].length ? QURAN_NEUTRAL[prop].map((v) => `\`${v}\``).join(' / ') : 'longhands'
      } allowed`,
    )

  if (
    context.arabic &&
    !context.quran &&
    prop === 'letter-spacing' &&
    !QURAN_NEUTRAL['letter-spacing'].includes(lower)
  )
    problems.push(`\`letter-spacing: ${value}\` on Arabic text: never letter-space Arabic`)

  return problems
}

/**
 * Lints CSS text. `base` is the offset of `css` inside the file (for Svelte <style> blocks), `exempt(line)` tells
 * whether a line carries a physical-ok marker, `at(offset)` maps a file offset to line:column.
 */
function lintCss(css, base, exempt, at, report) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, blank)
  let pos = 0
  /** Stack of enclosing contexts (selectors), innermost last. */
  const stack = [{ quran: false, arabic: false }]

  const readChunk = () => {
    let quote = ''
    let depth = 0
    const start = pos
    while (pos < text.length) {
      const ch = text[pos]
      if (quote) {
        if (ch === '\\') pos++
        else if (ch === quote) quote = ''
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '(' || ch === '[') depth++
      else if (ch === ')' || ch === ']') depth--
      else if (depth <= 0 && (ch === '{' || ch === ';' || ch === '}')) {
        pos++
        return { start, end: pos - 1, delim: ch }
      }
      pos++
    }
    return { start, end: pos, delim: '' }
  }

  while (pos < text.length) {
    const { start, end, delim } = readChunk()
    const chunk = text.slice(start, end)
    const trimmed = chunk.trim()
    if (delim === '{') {
      const parent = stack[stack.length - 1]
      if (trimmed.startsWith('@')) stack.push({ ...parent })
      else {
        if (chunk.includes(':dir(')) report(base + start + chunk.indexOf(':dir('), DIR_MESSAGE)
        const sel = withoutNot(trimmed)
        stack.push({
          quran: parent.quran || QURAN_SELECTOR.test(sel),
          arabic: parent.arabic || ARABIC_SELECTOR.test(sel),
        })
      }
      continue
    }
    if (trimmed && !trimmed.startsWith('@')) {
      const colon = chunk.indexOf(':')
      if (colon > 0) {
        const lead = chunk.length - chunk.trimStart().length
        const declStart = base + start + lead
        const declEnd = base + end
        const first = at(declStart).line
        const last = at(declEnd).line
        let isExempt = false
        for (let l = first; l <= last; l++) if (exempt(l)) isExempt = true
        const problems = checkDeclaration(
          chunk.slice(0, colon),
          chunk.slice(colon + 1),
          stack[stack.length - 1],
        )
        for (const message of problems) {
          const physical = !message.includes('` on Quran text:') && !message.includes('` on Arabic text:')
          if (physical && isExempt) continue
          report(declStart, message)
        }
      }
    }
    if (delim === '}' && stack.length > 1) stack.pop()
  }
}

/** Scans Svelte markup (scripts and styles already blanked) for `style="…"` attributes and `style:` directives. */
function lintMarkup(markup, exemptMarkup, at, report) {
  let i = 0
  const skipBraces = (j) => {
    let depth = 0
    let quote = ''
    for (; j < markup.length; j++) {
      const ch = markup[j]
      if (quote) {
        if (ch === '\\') j++
        else if (ch === quote) quote = ''
      } else if (ch === '"' || ch === "'" || ch === '`') quote = ch
      else if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) return j + 1
    }
    return j
  }
  while (i < markup.length) {
    if (markup[i] === '{') {
      i = skipBraces(i)
      continue
    }
    if (markup[i] !== '<' || !/[a-zA-Z]/.test(markup[i + 1] ?? '')) {
      i++
      continue
    }
    // A tag: read attributes up to the closing `>`.
    const attrs = []
    let j = i + 1
    while (j < markup.length && /[^\s/>]/.test(markup[j])) j++ // tag name
    while (j < markup.length && markup[j] !== '>') {
      if (/[\s/]/.test(markup[j])) {
        j++
        continue
      }
      if (markup[j] === '{') {
        j = skipBraces(j)
        continue
      }
      const nameStart = j
      while (j < markup.length && /[^\s=/>]/.test(markup[j])) j++
      const name = markup.slice(nameStart, j)
      let value = null
      let valueStart = j
      if (markup[j] === '=') {
        j++
        const q = markup[j]
        if (q === '"' || q === "'") {
          valueStart = j + 1
          j++
          while (j < markup.length && markup[j] !== q) {
            if (markup[j] === '{') j = skipBraces(j)
            else j++
          }
          value = { text: markup.slice(valueStart, j), static: true }
          j++
        } else if (q === '{') {
          valueStart = j
          j = skipBraces(j)
          value = { text: markup.slice(valueStart, j), static: false }
        } else {
          valueStart = j
          while (j < markup.length && /[^\s>]/.test(markup[j])) j++
          value = { text: markup.slice(valueStart, j), static: true }
        }
      }
      attrs.push({ name, nameStart, value, valueStart })
    }
    const tagEnd = j
    const classText = attrs
      .filter((a) => a.name === 'class' || a.name.startsWith('class:'))
      .map((a) => `${a.name.startsWith('class:') ? `.${a.name.slice(6)}` : ''} ${a.value?.text ?? ''}`)
      .join(' ')
    const quran = /(?:^|[\s.])(?:quran-text|mp-glyphs)(?![\w-])/.test(classText)
    for (const a of attrs) {
      const lineOf = (offset) => at(offset).line
      if (a.name === 'style' && a.value?.static) {
        // Svelte expressions inside the value become same-length placeholders.
        const text = a.value.text.replace(/\{[^{}]*\}/g, (m) => 'x'.repeat(m.length))
        let offset = 0
        for (const decl of text.split(';')) {
          const colon = decl.indexOf(':')
          if (colon > 0) {
            const lead = decl.length - decl.trimStart().length
            const at0 = a.valueStart + offset + lead
            const exempt = exemptMarkup(lineOf(at0))
            for (const message of checkDeclaration(decl.slice(0, colon), decl.slice(colon + 1), {
              quran,
              arabic: false,
            })) {
              if (exempt && !message.includes('` on Quran text:')) continue
              report(at0, message)
            }
          }
          offset += decl.length + 1
        }
      } else if (a.name.startsWith('style:')) {
        const prop = a.name.slice('style:'.length).split('|')[0]
        const value = a.value?.static ? a.value.text : a.value ? '{expression}' : prop
        const exempt = exemptMarkup(lineOf(a.nameStart))
        for (const message of checkDeclaration(prop, value, { quran, arabic: false })) {
          if (exempt && !message.includes('` on Quran text:')) continue
          report(a.nameStart, message)
        }
      }
    }
    i = tagEnd + 1
  }
}

/** Lints one file's text; returns [{ line, column, message }]. */
export function lintText(text, kind) {
  const at = lineIndex(text)
  const lines = text.split('\n')
  const markerLines = new Set()
  for (const m of text.matchAll(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g))
    if (EXEMPT.test(m[0]))
      for (let l = at(m.index).line; l <= at(m.index + m[0].length).line; l++) markerLines.add(l)
  const exempt = (line) => markerLines.has(line)
  /** In markup, an HTML comment marker on the previous line also exempts the element. */
  const exemptMarkup = (line) =>
    markerLines.has(line) || (markerLines.has(line - 1) && /^\s*<!--/.test(lines[line - 2] ?? ''))
  const found = []
  const report = (offset, message) => {
    const { line, column } = at(offset)
    found.push({ line, column, message })
  }
  if (kind === '.css') lintCss(text, 0, exempt, at, report)
  else {
    let markup = text
    for (const m of text.matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi))
      markup = markup.slice(0, m.index) + blank(m[0]) + markup.slice(m.index + m[0].length)
    for (const m of text.matchAll(/(<style\b[^>]*>)([\s\S]*?)<\/style\s*>/gi)) {
      lintCss(m[2], m.index + m[1].length, exempt, at, report)
      markup = markup.slice(0, m.index) + blank(m[0]) + markup.slice(m.index + m[0].length)
    }
    markup = markup.replace(/<!--[\s\S]*?-->/g, blank)
    lintMarkup(markup, exemptMarkup, at, report)
  }
  return found.sort((a, b) => a.line - b.line || a.column - b.column)
}

// ───────────────────────────── CLI ─────────────────────────────

function collect(path, out) {
  const stats = statSync(path)
  if (stats.isDirectory()) {
    for (const entry of readdirSync(path)) if (!SKIP_DIRS.has(entry)) collect(join(path, entry), out)
  } else if (EXTENSIONS.has(extname(path))) out.push(path)
}

function main(argv) {
  const json = argv.includes('--json')
  const unknown = argv.filter((a) => a.startsWith('-') && a !== '--json')
  if (unknown.length) {
    console.error(`check-logical-css: unknown option ${unknown.join(', ')}`)
    return 2
  }
  const targets = argv.filter((a) => !a.startsWith('-'))
  const files = []
  for (const target of targets.length ? targets : [join(ROOT, 'src')]) {
    const path = resolve(target)
    try {
      collect(path, files)
    } catch {
      console.error(`check-logical-css: cannot read ${target}`)
      return 2
    }
  }
  files.sort()
  const results = []
  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join('/')
    for (const v of lintText(readFileSync(file, 'utf8'), extname(file))) results.push({ file: rel, ...v })
  }
  if (json) console.log(JSON.stringify({ files: files.length, violations: results }, null, 2))
  else {
    for (const r of results) console.log(`${r.file}:${r.line}:${r.column}  ${r.message}`)
    const summary = `check-logical-css: ${files.length} files, ${results.length} violation${results.length === 1 ? '' : 's'}`
    if (results.length) {
      console.log(`\n${summary}`)
      console.log(
        'Use logical properties. Mushaf geometry, transport, scrubber, readout and page rail may mark a',
      )
      console.log('line `/* physical-ok: <reason> */` instead.')
    } else console.log(summary)
  }
  return results.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = main(process.argv.slice(2))
