/**
 * Token test harness (ARCHITECTURE §9.2 contrast test, §8.7 highlight composites). Owner: WP7a. Test support only:
 * nothing in the app imports it.
 *
 * It reads tokens.css as text and computes what the browser would compute on <html> for a given set of attributes,
 * media features and inline custom properties: cascade layers (incl. sub-layers), selector specificity and source
 * order, `var()` substitution with fallbacks and cycle detection, `calc()`, `rgb()`, hex, `color-mix(in srgb, …)` and
 * alpha compositing. WCAG 2 contrast ratios are computed on the composited, opaque result.
 *
 *   const tokens = parseTokens(tokensCss)
 *   const paper = tokens.resolve({ attrs: { 'data-theme': 'paper', 'data-accent': 'teal' } })
 *   contrast(paper.color('--text'), paper.color('--surface-page'))   // ≥ 4.5
 *
 * WP8d extends the same harness for its highlight-layer composites (§8.7).
 *
 * The parser is deliberately strict: tokens.css may only contain `@layer` blocks and statements, `@media` blocks and
 * style rules whose selectors target the root element (`:root`, `html`, attribute selectors, `:not()`, `:is()`,
 * `:where()`). Anything else throws, so the test can never silently ignore a rule.
 */

// ───────────────────────────── colours ─────────────────────────────

/** sRGB colour with 0–255 channels and 0–1 alpha. */
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Source-over compositing of `top` onto `bottom`. */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a)
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
  const mix = (t: number, b: number): number => (t * top.a + b * bottom.a * (1 - top.a)) / a
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a }
}

/** Composites a stack of layers listed bottom first. */
export function stack(...layers: Rgba[]): Rgba {
  const [first, ...rest] = layers
  if (!first) throw new Error('stack() needs at least one layer')
  return rest.reduce((acc, layer) => over(layer, acc), first)
}

/** WCAG 2 relative luminance of an opaque colour. */
export function luminance(c: Rgba): number {
  const lin = (v: number): number => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

/**
 * WCAG 2 contrast ratio. A translucent foreground is composited over the background first; the background must be
 * opaque (composite it onto a surface with `over`/`stack` before calling).
 */
export function contrast(fg: Rgba, bg: Rgba): number {
  if (bg.a < 0.999) throw new Error(`contrast(): background ${hex(bg)} is not opaque; composite it first`)
  const f = fg.a < 0.999 ? over(fg, bg) : fg
  const [hi, lo] = [luminance(f), luminance(bg)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** `#rrggbb` (or `#rrggbbaa` when translucent), rounded; for messages and exact-value checks. */
export function hex(c: Rgba): string {
  const h = (v: number): string =>
    Math.round(clamp(v, 0, 255))
      .toString(16)
      .padStart(2, '0')
  const base = `#${h(c.r)}${h(c.g)}${h(c.b)}`
  return c.a < 0.999 ? `${base}${h(c.a * 255)}` : base
}

/** Whether two colours are equal within rounding (channels ±0.75, alpha ±0.004). */
export function sameColor(a: Rgba, b: Rgba): boolean {
  return (
    Math.abs(a.r - b.r) <= 0.75 &&
    Math.abs(a.g - b.g) <= 0.75 &&
    Math.abs(a.b - b.b) <= 0.75 &&
    Math.abs(a.a - b.a) <= 0.004
  )
}

const NAMED: Record<string, Rgba> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
}

/** Splits on top-level separators (outside parentheses and quotes). */
function splitTop(s: string, sep: ',' | ' ' | '/'): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let cur = ''
  for (const ch of s) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    if (depth === 0 && (sep === ' ' ? /\s/.test(ch) : ch === sep)) {
      if (cur.trim() !== '') out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim() !== '') out.push(cur.trim())
  return out
}

/** A number with an optional percent unit. */
interface Quantity {
  value: number
  percent: boolean
}

/** Evaluates a number, a percentage or a `calc()` expression of them (+ − × ÷ and parentheses). */
export function evalNumber(src: string): Quantity {
  const tokens = src.match(/\d*\.?\d+(?:e[+-]?\d+)?%?|[-+*/()]|calc|[^\s]/gi) ?? []
  let i = 0
  const peek = (): string | undefined => tokens[i]
  const next = (): string => {
    const t = tokens[i++]
    if (t === undefined) throw new Error(`unexpected end of number expression "${src}"`)
    return t
  }
  const combine = (a: Quantity, b: Quantity, op: string): Quantity => {
    switch (op) {
      case '*':
        if (a.percent && b.percent) throw new Error(`percent × percent in "${src}"`)
        return { value: a.value * b.value, percent: a.percent || b.percent }
      case '/':
        if (b.percent) throw new Error(`division by a percentage in "${src}"`)
        return { value: a.value / b.value, percent: a.percent }
      default:
        if (a.percent !== b.percent) throw new Error(`mixed units in "${src}"`)
        return { value: op === '+' ? a.value + b.value : a.value - b.value, percent: a.percent }
    }
  }
  const primary = (): Quantity => {
    const t = next()
    if (t.toLowerCase() === 'calc') {
      if (next() !== '(') throw new Error(`calc without "(" in "${src}"`)
      const v = sum()
      if (next() !== ')') throw new Error(`unbalanced calc() in "${src}"`)
      return v
    }
    if (t === '(') {
      const v = sum()
      if (next() !== ')') throw new Error(`unbalanced parentheses in "${src}"`)
      return v
    }
    if (t === '-') {
      const v = primary()
      return { value: -v.value, percent: v.percent }
    }
    const m = /^(\d*\.?\d+(?:e[+-]?\d+)?)(%?)$/i.exec(t)
    if (!m || m[1] === undefined) throw new Error(`not a number: "${t}" in "${src}"`)
    return { value: Number(m[1]), percent: m[2] === '%' }
  }
  const product = (): Quantity => {
    let v = primary()
    while (peek() === '*' || peek() === '/') {
      const op = next()
      v = combine(v, primary(), op)
    }
    return v
  }
  function sum(): Quantity {
    let v = product()
    while (peek() === '+' || peek() === '-') {
      const op = next()
      v = combine(v, product(), op)
    }
    return v
  }
  const v = sum()
  if (i !== tokens.length) throw new Error(`trailing input in number expression "${src}"`)
  return v
}

/** Parses an sRGB colour value: hex, rgb()/rgba(), color-mix(in srgb, …), color(srgb …) or a few keywords. */
export function parseColor(src: string): Rgba {
  const s = src.trim()
  const lower = s.toLowerCase()
  const named = NAMED[lower]
  if (named) return { ...named }
  if (s.startsWith('#')) {
    const h = s.slice(1)
    const full =
      h.length === 3 || h.length === 4
        ? [...h].map((c) => c + c).join('')
        : h.length === 6 || h.length === 8
          ? h
          : null
    if (!full || !/^[0-9a-f]+$/i.test(full)) throw new Error(`bad hex colour "${s}"`)
    const n = (k: number): number => parseInt(full.slice(k, k + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 }
  }
  const fn = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(s)
  if (!fn || fn[1] === undefined || fn[2] === undefined) throw new Error(`unsupported colour "${s}"`)
  const name = fn[1].toLowerCase()
  const body = fn[2]
  if (name === 'rgb' || name === 'rgba') {
    const [channelPart, alphaPart, ...extra] = body.includes(',')
      ? (() => {
          const parts = splitTop(body, ',')
          return [parts.slice(0, 3).join(' '), parts[3]]
        })()
      : splitTop(body, '/')
    if (extra.length || channelPart === undefined) throw new Error(`bad rgb() "${s}"`)
    const channels = splitTop(channelPart, ' ')
    if (channels.length !== 3) throw new Error(`rgb() needs 3 channels: "${s}"`)
    const [r, g, b] = channels.map((c) => {
      const q = evalNumber(c)
      return clamp(q.percent ? (q.value / 100) * 255 : q.value, 0, 255)
    }) as [number, number, number]
    const alpha = alphaPart === undefined ? 1 : evalNumber(alphaPart)
    const a = typeof alpha === 'number' ? alpha : alpha.percent ? alpha.value / 100 : alpha.value
    return { r, g, b, a: clamp(a, 0, 1) }
  }
  if (name === 'color') {
    const [space, ...rest] = splitTop(body.split('/')[0] ?? '', ' ')
    if (space !== 'srgb' || rest.length !== 3) throw new Error(`only color(srgb r g b) is supported: "${s}"`)
    const alphaSrc = body.split('/')[1]
    const [r, g, b] = rest.map((c) => evalNumber(c).value * 255) as [number, number, number]
    const a = alphaSrc === undefined ? 1 : evalNumber(alphaSrc).value
    return { r, g, b, a }
  }
  if (name === 'color-mix') return colorMix(body, s)
  throw new Error(`unsupported colour function "${name}" in "${s}"`)
}

/** CSS Color 5 `color-mix(in srgb, A [p1], B [p2])` with premultiplied alpha and the alpha multiplier rule. */
function colorMix(body: string, src: string): Rgba {
  const [space, ...colors] = splitTop(body, ',')
  if (space?.replace(/\s+/g, ' ') !== 'in srgb' || colors.length !== 2)
    throw new Error(`only color-mix(in srgb, a, b) is supported: "${src}"`)
  const parts = colors.map((part) => {
    const tokens = splitTop(part, ' ')
    const last = tokens.at(-1)
    const first = tokens[0]
    const isPct = (t: string | undefined): boolean =>
      t !== undefined && (/^-?\d*\.?\d+%$/.test(t) || (/^calc\(/i.test(t) && evalNumber(t).percent))
    if (tokens.length === 2 && isPct(last) && first !== undefined)
      return { color: parseColor(first), p: evalNumber(last ?? '').value }
    if (tokens.length === 2 && isPct(first) && last !== undefined)
      return { color: parseColor(last), p: evalNumber(first ?? '').value }
    if (tokens.length === 1 && first !== undefined) return { color: parseColor(first), p: undefined }
    throw new Error(`bad color-mix() component "${part}" in "${src}"`)
  })
  const [c1, c2] = parts as [{ color: Rgba; p?: number }, { color: Rgba; p?: number }]
  let p1 = c1.p
  let p2 = c2.p
  if (p1 === undefined && p2 === undefined) [p1, p2] = [50, 50]
  else if (p1 === undefined) p1 = 100 - (p2 ?? 0)
  else if (p2 === undefined) p2 = 100 - p1
  const total = (p1 ?? 0) + (p2 ?? 0)
  if (total <= 0) throw new Error(`color-mix() percentages sum to 0: "${src}"`)
  const alphaMultiplier = total < 100 ? total / 100 : 1
  const w1 = (p1 ?? 0) / total
  const w2 = (p2 ?? 0) / total
  const a = c1.color.a * w1 + c2.color.a * w2
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
  const ch = (k: 'r' | 'g' | 'b'): number =>
    (c1.color[k] * c1.color.a * w1 + c2.color[k] * c2.color.a * w2) / a
  return { r: ch('r'), g: ch('g'), b: ch('b'), a: a * alphaMultiplier }
}

// ───────────────────────────── parsing tokens.css ─────────────────────────────

interface Declaration {
  prop: string
  value: string
}

interface StyleRule {
  selectors: string[]
  media: string[]
  /** Layer path, e.g. ['tokens', 'theme']; [] = unlayered. */
  layer: string[]
  declarations: Declaration[]
  order: number
}

/** Attributes of <html>, active media features and inline custom properties (`style="--ink-alpha: .65"`). */
export interface TokenContext {
  attrs?: Record<string, string>
  media?: {
    'prefers-contrast'?: 'more' | 'less' | 'no-preference'
    'forced-colors'?: 'active' | 'none'
    'prefers-reduced-motion'?: 'reduce' | 'no-preference'
    'prefers-reduced-transparency'?: 'reduce' | 'no-preference'
    'prefers-color-scheme'?: 'light' | 'dark'
  }
  inline?: Record<string, string>
}

/** The cascaded custom properties (and `color-scheme`) of <html> in one context. */
export interface ResolvedTokens {
  /** Every property that has a cascaded value, var() not yet substituted. */
  readonly names: string[]
  /** The fully substituted value; throws when the property has no value or a var() cannot be resolved. */
  value(name: string): string
  has(name: string): boolean
  color(name: string): Rgba
  number(name: string): number
}

export interface ParsedTokens {
  rules: readonly StyleRule[]
  /** Every `@layer` name in first-seen order, dotted (`tokens.theme`). */
  layers: readonly string[]
  /** The first top-level `@layer a, b, c;` statement, as written. */
  layerStatement: string | null
  resolve(ctx: TokenContext): ResolvedTokens
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

/** Parses tokens.css (strict, see the module comment). */
export function parseTokens(source: string): ParsedTokens {
  const css = stripComments(source)
  const rules: StyleRule[] = []
  const layers: string[] = []
  let layerStatement: string | null = null
  let pos = 0
  let order = 0

  const addLayer = (path: string[]): void => {
    const name = path.join('.')
    if (!layers.includes(name)) layers.push(name)
  }
  /** Reads up to the next top-level `{`, `;` or `}`; returns the prelude and the delimiter. */
  const readPrelude = (): { text: string; delim: string } => {
    let text = ''
    let quote = ''
    let depth = 0
    while (pos < css.length) {
      const ch = css[pos++] ?? ''
      if (quote) {
        if (ch === quote) quote = ''
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '(') depth++
      else if (ch === ')') depth--
      else if (depth === 0 && (ch === '{' || ch === ';' || ch === '}'))
        return { text: text.trim(), delim: ch }
      text += ch
    }
    return { text: text.trim(), delim: '' }
  }
  const readDeclarations = (selectorText: string): Declaration[] => {
    const decls: Declaration[] = []
    for (;;) {
      const { text, delim } = readPrelude()
      if (delim === '{')
        throw new Error(`nested rule inside "${selectorText}" is not supported by the harness`)
      if (text !== '') {
        const colon = text.indexOf(':')
        if (colon < 0) throw new Error(`bad declaration "${text}" in "${selectorText}"`)
        const prop = text.slice(0, colon).trim()
        const value = text
          .slice(colon + 1)
          .trim()
          .replace(/\s+/g, ' ')
        if (/!important$/i.test(value)) throw new Error(`!important in tokens (${prop}) is not supported`)
        decls.push({ prop, value })
      }
      if (delim === '}' || delim === '') return decls
    }
  }
  const parseBlock = (layer: string[], media: string[], topLevel: boolean): void => {
    for (;;) {
      const { text, delim } = readPrelude()
      if (delim === '}' || delim === '') {
        if (text !== '') throw new Error(`stray text "${text}"`)
        if (delim === '' && !topLevel) throw new Error('unexpected end of file (unclosed block)')
        return
      }
      if (delim === ';') {
        const m = /^@layer\s+(.+)$/s.exec(text)
        if (!m || m[1] === undefined) throw new Error(`unsupported statement "${text}"`)
        if (topLevel && layer.length === 0 && layerStatement === null)
          layerStatement = text.replace(/\s+/g, ' ')
        for (const name of m[1].split(',')) addLayer([...layer, ...name.trim().split('.')])
        continue
      }
      if (text.startsWith('@layer')) {
        const name = text.slice('@layer'.length).trim()
        if (!name) throw new Error('anonymous @layer blocks are not supported')
        const path = [...layer, ...name.split('.')]
        addLayer(path)
        parseBlock(path, media, false)
      } else if (text.startsWith('@media')) {
        parseBlock(layer, [...media, text.slice('@media'.length).trim()], false)
      } else if (text.startsWith('@')) {
        throw new Error(`unsupported at-rule "${text}"`)
      } else {
        const selectors = splitTop(text, ',')
        for (const sel of selectors) specificity(sel) // validates
        rules.push({ selectors, media, layer, declarations: readDeclarations(text), order: order++ })
      }
    }
  }
  parseBlock([], [], true)

  return {
    rules,
    layers,
    layerStatement,
    resolve: (ctx) => resolveRoot(rules, layers, ctx),
  }
}

// ───────────────────────────── selectors and media ─────────────────────────────

type Specificity = [number, number, number]

const addSpec = (a: Specificity, b: Specificity): Specificity => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const cmpSpec = (a: Specificity, b: Specificity): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** Splits a compound selector into simple selectors; throws on combinators and unsupported syntax. */
function simpleSelectors(sel: string): string[] {
  const out: string[] = []
  let i = 0
  const s = sel.trim()
  while (i < s.length) {
    const rest = s.slice(i)
    const simple = /^\[[^\]]+\]/.exec(rest) ?? /^:root\b/.exec(rest) ?? /^html\b/.exec(rest)
    if (/^:(not|is|where)\(/.test(rest)) {
      let depth = 0
      let j = i
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++
        else if (s[j] === ')' && --depth === 0) break
      }
      out.push(s.slice(i, j + 1))
      i = j + 1
    } else if (simple) {
      out.push(simple[0])
      i += simple[0].length
    } else {
      throw new Error(`selector "${sel}" is not a root-element compound selector the harness supports`)
    }
  }
  return out
}

function specificity(sel: string): Specificity {
  return simpleSelectors(sel).reduce<Specificity>(
    (acc, simple) => {
      if (simple === 'html') return addSpec(acc, [0, 0, 1])
      if (simple === ':root' || simple.startsWith('[')) return addSpec(acc, [0, 1, 0])
      const m = /^:(not|is|where)\(([\s\S]*)\)$/.exec(simple)
      if (!m || m[2] === undefined) throw new Error(`bad simple selector "${simple}"`)
      if (m[1] === 'where') {
        for (const inner of splitTop(m[2], ',')) specificity(inner)
        return acc
      }
      const max = splitTop(m[2], ',')
        .map(specificity)
        .reduce<Specificity>((best, s) => (cmpSpec(s, best) > 0 ? s : best), [0, 0, 0])
      return addSpec(acc, max)
    },
    [0, 0, 0],
  )
}

function matchesRoot(sel: string, attrs: Record<string, string>): boolean {
  return simpleSelectors(sel).every((simple) => {
    if (simple === ':root' || simple === 'html') return true
    if (simple.startsWith('[')) {
      const m = /^\[\s*([\w-]+)\s*(?:=\s*(?:'([^']*)'|"([^"]*)"|([\w-]+)))?\s*\]$/.exec(simple)
      if (!m || m[1] === undefined) throw new Error(`unsupported attribute selector "${simple}"`)
      const actual = attrs[m[1]]
      const expected = m[2] ?? m[3] ?? m[4]
      return expected === undefined ? actual !== undefined : actual === expected
    }
    const m = /^:(not|is|where)\(([\s\S]*)\)$/.exec(simple)
    if (!m || m[2] === undefined) throw new Error(`bad simple selector "${simple}"`)
    const any = splitTop(m[2], ',').some((inner) => matchesRoot(inner, attrs))
    return m[1] === 'not' ? !any : any
  })
}

function matchesMedia(query: string, media: NonNullable<TokenContext['media']>): boolean {
  return query.split(/\s+and\s+/).every((part) => {
    const m = /^\(\s*([\w-]+)\s*:\s*([\w-]+)\s*\)$/.exec(part.trim())
    if (!m || m[1] === undefined || m[2] === undefined) throw new Error(`unsupported media query "${query}"`)
    const defaults: Record<string, string> = {
      'prefers-contrast': 'no-preference',
      'forced-colors': 'none',
      'prefers-reduced-motion': 'no-preference',
      'prefers-reduced-transparency': 'no-preference',
      'prefers-color-scheme': 'light',
    }
    if (!(m[1] in defaults)) throw new Error(`unsupported media feature "${m[1]}"`)
    return ((media as Record<string, string | undefined>)[m[1]] ?? defaults[m[1]]) === m[2]
  })
}

// ───────────────────────────── cascade and substitution ─────────────────────────────

/**
 * Sort key of a layer path: siblings rank by declaration order, and a layer's own rules beat its sub-layers
 * (unlayered rules beat every layer). Compared lexicographically.
 */
function layerKey(path: readonly string[], layers: readonly string[]): number[] {
  const key: number[] = []
  for (let depth = 1; depth <= path.length; depth++) {
    const prefix = path.slice(0, depth - 1).join('.')
    const siblings = layers.filter((l) => {
      const parts = l.split('.')
      return parts.length === depth && parts.slice(0, -1).join('.') === prefix
    })
    key.push(siblings.indexOf(path.slice(0, depth).join('.')))
  }
  key.push(Number.POSITIVE_INFINITY)
  return key
}

function cmpKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? Number.NEGATIVE_INFINITY
    const y = b[i] ?? Number.NEGATIVE_INFINITY
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function resolveRoot(
  rules: readonly StyleRule[],
  layers: readonly string[],
  ctx: TokenContext,
): ResolvedTokens {
  const attrs = ctx.attrs ?? {}
  const media = ctx.media ?? {}
  interface Winner {
    value: string
    layer: number[]
    spec: Specificity
    order: number
  }
  const cascaded = new Map<string, Winner>()
  for (const rule of rules) {
    if (!rule.media.every((q) => matchesMedia(q, media))) continue
    const matching = rule.selectors.filter((s) => matchesRoot(s, attrs))
    if (matching.length === 0) continue
    const spec = matching.map(specificity).reduce((a, b) => (cmpSpec(a, b) >= 0 ? a : b))
    const layer = layerKey(rule.layer, layers)
    for (const d of rule.declarations) {
      const prev = cascaded.get(d.prop)
      const wins =
        !prev ||
        cmpKeys(layer, prev.layer) > 0 ||
        (cmpKeys(layer, prev.layer) === 0 &&
          (cmpSpec(spec, prev.spec) > 0 || (cmpSpec(spec, prev.spec) === 0 && rule.order >= prev.order)))
      if (wins) cascaded.set(d.prop, { value: d.value, layer, spec, order: rule.order })
    }
  }
  const raw = new Map<string, string>([...cascaded].map(([k, v]) => [k, v.value]))
  for (const [k, v] of Object.entries(ctx.inline ?? {})) raw.set(k, v)

  const memo = new Map<string, string>()
  const substitute = (name: string, stack: string[]): string => {
    const cached = memo.get(name)
    if (cached !== undefined) return cached
    if (stack.includes(name)) throw new Error(`var() cycle: ${[...stack, name].join(' → ')}`)
    const value = raw.get(name)
    if (value === undefined) throw new Error(`${name} has no value in this context`)
    const out = expand(value, [...stack, name])
    memo.set(name, out)
    return out
  }
  const expand = (value: string, stack: string[]): string => {
    let out = ''
    let i = 0
    while (i < value.length) {
      const start = value.indexOf('var(', i)
      if (start < 0) {
        out += value.slice(i)
        break
      }
      out += value.slice(i, start)
      let depth = 0
      let j = start + 3
      for (; j < value.length; j++) {
        if (value[j] === '(') depth++
        else if (value[j] === ')' && --depth === 0) break
      }
      const inner = value.slice(start + 4, j)
      const comma = splitTop(inner, ',')
      const ref = comma[0]?.trim() ?? ''
      const fallback = inner.includes(',') ? inner.slice(inner.indexOf(',') + 1).trim() : undefined
      out += raw.has(ref) ? substitute(ref, stack) : fallback !== undefined ? expand(fallback, stack) : ''
      if (!raw.has(ref) && fallback === undefined)
        throw new Error(`var(${ref}) is undefined and has no fallback`)
      i = j + 1
    }
    return out
  }

  return {
    names: [...raw.keys()],
    has: (name) => raw.has(name),
    value: (name) => substitute(name, []),
    color: (name) => parseColor(substitute(name, [])),
    number: (name) => {
      const q = evalNumber(substitute(name, []))
      return q.percent ? q.value / 100 : q.value
    },
  }
}
