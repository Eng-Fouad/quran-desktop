/**
 * The Markdown subset of note bodies (`note.body`).
 *
 * **Rendering.** `parseMarkdown` builds a small tree; `renderMarkdown` serialises it to HTML in which every character
 * of the source is escaped and the only tags are the subset's own, all inside the sanitiser's allowlist
 * (`src/lib/text/html.ts`). The HTML is shown only through `SafeHtml` (DOMPurify runs a second, independent pass), so a
 * note body can never inject markup, attributes or URLs. Ayah references become `<a data-ref="2:255">`, which
 * `SafeHtml` turns into reference buttons (`onref`).
 *
 * **The subset** (CommonMark-shaped, with the forgiving rules people expect from a notes field):
 * - Paragraphs are separated by blank lines; a single line break inside one is kept (`<br>`).
 * - Headings `#`, `##`, `###` (deeper levels read as `###`) render as `h2`, `h3`, `h4`.
 * - Bullet lists (`-`, `*`, `+`), numbered lists (`1.` or `1)`, Arabic-Indic digits too), task items (`- [ ]`,
 *   `- [x]`, shown as ☐ / ☑), nested by indenting under the item (two spaces are enough).
 * - Quotes (`>`), which may hold any other block.
 * - `**strong**`, `__strong__`, `*emphasis*`, `_emphasis_` (never inside a word for `_`) and `==highlight==`.
 * - Ayah references: `2:255`, `2:255-257` (or with Arabic-Indic digits, `٢:٢٥٥`) link to the ayah when the surah has
 *   that ayah; `[a label](2:255)` links a label.
 * - Web links `[label](https://…)` and `<https://…>` are kept as text ("label (https://…)"): a note never navigates
 *   the webview. `NoteBody` makes https addresses clickable (they open in the system browser).
 * - `\` escapes punctuation; everything else, HTML included, is literal text.
 *
 * Nesting is capped at {@link MAX_DEPTH} blocks and the inline pass is linear in practice (CommonMark's delimiter
 * algorithm with the openers-bottom bound), so the 100,000-character body limit renders in milliseconds.
 *
 * **Editing.** `toggleInline`, `toggleLines` and `continueList` are the note editor's formatting commands, as pure
 * text edits (one replaced range plus the selection after it), so the editor can apply them with the native undo stack.
 */

// --- tree ------------------------------------------------------------------------------------------------------------

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'break' }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'mark'; children: Inline[] }
  /** An ayah reference; `ref` is `s:a` or `s:a-b` in ASCII digits (the `data-ref` form). */
  | { type: 'ref'; ref: string; children: Inline[] }
  /** A web link, rendered as text ("label (url)"). */
  | { type: 'link'; url: string; children: Inline[] }

export interface ListItem {
  /** A task item's box (`- [ ]` / `- [x]`), or `null`. */
  task: 'open' | 'done' | null
  children: Block[]
}

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | { type: 'quote'; children: Block[] }
  | {
      type: 'list'
      ordered: boolean
      /** The first item's number (numbered lists). */
      start: number
      /** No blank lines between or inside the items: items render their text without paragraphs. */
      tight: boolean
      items: ListItem[]
    }

export interface MarkdownOptions {
  /** Link ayah references (default `true`). */
  refs?: boolean
}

/** The deepest nesting of quotes and lists; deeper markers read as text. */
export const MAX_DEPTH = 8

/** Every tag `renderMarkdown` emits (a subset of `ALLOWED_TAGS`; checked by the tests). */
export const MARKDOWN_TAGS = [
  'p',
  'br',
  'h2',
  'h3',
  'h4',
  'ul',
  'ol',
  'li',
  'blockquote',
  'strong',
  'em',
  'mark',
  'a',
] as const

/** Ayahs per surah (Hafs, 6,236 in all): a reference links only when its surah has the ayahs. */
const AYAH_COUNTS = [
  7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128, 111, 110, 98, 135, 112, 78, 118,
  64, 77, 227, 93, 88, 69, 60, 34, 30, 73, 54, 45, 83, 182, 88, 75, 85, 54, 53, 89, 59, 37, 35, 38, 29, 18,
  45, 60, 49, 62, 55, 78, 96, 29, 22, 24, 13, 14, 11, 11, 18, 12, 12, 30, 52, 52, 44, 28, 28, 20, 56, 40, 31,
  50, 40, 46, 42, 29, 19, 36, 25, 22, 17, 19, 26, 30, 20, 15, 21, 11, 8, 8, 19, 5, 8, 8, 11, 11, 8, 3, 9, 5,
  4, 7, 3, 6, 3, 5, 4, 5, 6,
] as const

/** How many ayahs surah `n` has (0 for anything that is not a surah number). */
export function ayahCount(surah: number): number {
  return Number.isInteger(surah) ? (AYAH_COUNTS[surah - 1] ?? 0) : 0
}

// --- characters ------------------------------------------------------------------------------------------------------

/** ASCII, Arabic-Indic (U+0660–0669) and Extended Arabic-Indic (U+06F0–06F9) digits, as a character-class body. */
const DIGIT = '0-9٠-٩۰-۹'
const WHITESPACE = /\s/u
const PUNCTUATION = /[\p{P}\p{S}]/u
const WORD_CHAR = /[\p{L}\p{N}]/u
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/

/** Digits of any supported script as a number (`'٢٥٥'` → 255). */
export function digitsValue(digits: string): number {
  let n = 0
  for (const ch of digits) {
    const cp = ch.codePointAt(0) ?? 0
    const d =
      cp >= 0x30 && cp <= 0x39
        ? cp - 0x30
        : cp >= 0x660 && cp <= 0x669
          ? cp - 0x660
          : cp >= 0x6f0 && cp <= 0x6f9
            ? cp - 0x6f0
            : -1
    if (d < 0) return Number.NaN
    n = n * 10 + d
  }
  return n
}

/** `n` written in the digit script of `sample` (the next number of a list typed with Arabic-Indic digits). */
function digitsLike(n: number, sample: string): string {
  const cp = sample.codePointAt(0) ?? 0x30
  const zero = cp >= 0x660 && cp <= 0x669 ? 0x660 : cp >= 0x6f0 && cp <= 0x6f9 ? 0x6f0 : 0x30
  return String(n).replace(/[0-9]/g, (d) => String.fromCodePoint(zero + d.charCodeAt(0) - 0x30))
}

/** The full character before index `i` (a surrogate pair counts as one), or `''` at the start. */
function charBefore(text: string, i: number): string {
  if (i <= 0) return ''
  const low = text.charCodeAt(i - 1)
  if (i >= 2 && low >= 0xdc00 && low <= 0xdfff) {
    const high = text.charCodeAt(i - 2)
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(i - 2, i)
  }
  return text.charAt(i - 1)
}

/** The full character at index `i`, or `''` at the end. */
function charAt(text: string, i: number): string {
  const cp = text.codePointAt(i)
  return cp === undefined ? '' : String.fromCodePoint(cp)
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Escapes text for HTML element content and attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c)
}

// --- references --------------------------------------------------------------------------------------------------------

/** A reference in running text: `2:255`, `2:255-257` (`-` or `–`), any digit script; not part of a longer number. */
const BARE_REF = new RegExp(
  `(?<![\\p{L}\\p{N}:./])([${DIGIT}]{1,3}):([${DIGIT}]{1,3})(?:[-–]([${DIGIT}]{1,3}))?(?![\\p{L}\\p{N}]|[:./-][${DIGIT}])`,
  'gu',
)
/** A link target that is a reference. */
const REF_TARGET = new RegExp(`^([${DIGIT}]{1,3}):([${DIGIT}]{1,3})(?:[-–]([${DIGIT}]{1,3}))?$`, 'u')
/** A web address (link target or autolink). */
const WEB_URL = /^https?:\/\/[^\s<>]+$/iu

/** The `data-ref` of a reference whose surah has the ayahs, else `null`. */
function refOf(s: string, a: string, b: string | undefined): string | null {
  const surah = digitsValue(s)
  const from = digitsValue(a)
  const to = b === undefined ? from : digitsValue(b)
  const count = ayahCount(surah)
  if (count === 0 || !(from >= 1) || !(to >= from) || to > count) return null
  return to === from ? `${surah}:${from}` : `${surah}:${from}-${to}`
}

// --- inline ----------------------------------------------------------------------------------------------------------

interface SBase {
  prev: SNode | null
  next: SNode | null
}
interface SText extends SBase {
  kind: 'text'
  text: string
}
interface SInline extends SBase {
  kind: 'inline'
  node: Inline
}
interface SDelim extends SBase {
  kind: 'delim'
  char: '*' | '_' | '='
  count: number
  orig: number
  canOpen: boolean
  canClose: boolean
  /** Neighbours on the delimiter stack. */
  below: SDelim | null
  above: SDelim | null
}
type SNode = SText | SInline | SDelim

interface InlineContext {
  /** Recognise `[label](target)` and `<https://…>` (off inside a link label). */
  links: boolean
  /** Link bare references (off inside a link label, or by option). */
  refs: boolean
}

/** A doubly linked token sequence with the delimiter stack threaded through it. */
class Sequence {
  head: SNode | null = null
  tail: SNode | null = null
  top: SDelim | null = null
  #text = ''

  pushText(text: string): void {
    this.#text += text
  }

  push(node: SInline | SDelim): void {
    this.#flush()
    this.#append(node)
    if (node.kind === 'delim') {
      node.below = this.top
      if (this.top) this.top.above = node
      this.top = node
    }
  }

  end(): void {
    this.#flush()
  }

  #flush(): void {
    if (this.#text === '') return
    const node: SText = { kind: 'text', text: this.#text, prev: null, next: null }
    this.#text = ''
    this.#append(node)
  }

  #append(node: SNode): void {
    node.prev = this.tail
    if (this.tail) this.tail.next = node
    else this.head = node
    this.tail = node
  }

  /** The bottom of the delimiter stack. */
  bottom(): SDelim | null {
    let d = this.top
    while (d?.below) d = d.below
    return d
  }

  /** Takes a delimiter off the stack (it stays in the sequence as literal text). */
  unstack(d: SDelim): void {
    if (d.below) d.below.above = d.above
    if (d.above) d.above.below = d.below
    if (this.top === d) this.top = d.below
    d.below = null
    d.above = null
  }

  /** Takes a node out of the sequence. */
  unlink(n: SNode): void {
    if (n.prev) n.prev.next = n.next
    else this.head = n.next
    if (n.next) n.next.prev = n.prev
    else this.tail = n.prev
  }
}

/** For each `[`, the index of its matching `]` (escapes skipped), else -1: one pass, so links never rescan. */
function matchBrackets(text: string): Int32Array {
  const close = new Int32Array(text.length).fill(-1)
  const open: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i)
    if (c === '\\') i += 1
    else if (c === '[') open.push(i)
    else if (c === ']') {
      const at = open.pop()
      if (at !== undefined) close[at] = i
    }
  }
  return close
}

/** `<https://…>` at the scan position (sticky). */
const AUTOLINK = /<(https?:\/\/[^\s<>]{1,2048})>/iuy
/** The longest link target scanned. */
const TARGET_MAX = 2048

/** Parses the inline content of a block (`\n` is a line break). */
function parseInline(text: string, ctx: InlineContext): Inline[] {
  const seq = new Sequence()
  const closeOf = ctx.links && text.includes('](') ? matchBrackets(text) : null
  let i = 0
  while (i < text.length) {
    const c = text.charAt(i)
    if (c === '\\') {
      const next = text.charAt(i + 1)
      if (next === '\n') {
        i += 1
        continue
      }
      if (ASCII_PUNCTUATION.test(next)) {
        seq.pushText(next)
        i += 2
        continue
      }
      seq.pushText(c)
      i += 1
      continue
    }
    if (c === '\n') {
      seq.push({ kind: 'inline', node: { type: 'break' }, prev: null, next: null })
      i += 1
      continue
    }
    if (c === '[' && closeOf) {
      const link = parseLink(text, i, closeOf[i] ?? -1, ctx)
      if (link) {
        for (const node of link.nodes) seq.push({ kind: 'inline', node, prev: null, next: null })
        i = link.end
        continue
      }
    }
    if (c === '<' && ctx.links) {
      AUTOLINK.lastIndex = i
      const auto = AUTOLINK.exec(text)
      const url = auto?.[1]
      if (auto && url !== undefined) {
        seq.push({
          kind: 'inline',
          node: { type: 'link', url, children: [{ type: 'text', text: url }] },
          prev: null,
          next: null,
        })
        i += auto[0].length
        continue
      }
    }
    if (c === '*' || c === '_' || c === '=') {
      let j = i
      while (text.charAt(j) === c) j += 1
      const count = j - i
      if (c === '=' && count < 2) {
        seq.pushText(c)
        i = j
        continue
      }
      const before = charBefore(text, i)
      const after = charAt(text, j)
      const wsBefore = before === '' || WHITESPACE.test(before)
      const wsAfter = after === '' || WHITESPACE.test(after)
      const pBefore = before !== '' && PUNCTUATION.test(before)
      const pAfter = after !== '' && PUNCTUATION.test(after)
      const left = !wsAfter && (!pAfter || wsBefore || pBefore)
      const right = !wsBefore && (!pBefore || wsAfter || pAfter)
      const canOpen = c === '_' ? left && (!right || pBefore) : left
      const canClose = c === '_' ? right && (!left || pAfter) : right
      seq.push({
        kind: 'delim',
        char: c,
        count,
        orig: count,
        canOpen,
        canClose,
        below: null,
        above: null,
        prev: null,
        next: null,
      })
      i = j
      continue
    }
    seq.pushText(c)
    i += 1
  }
  seq.end()
  processEmphasis(seq, ctx)
  return toInlines(seq.head, null, ctx)
}

/**
 * `[label](target)` at `i`: a reference (just its label when references are off) or a web link; `null` when the target
 * is neither (the bracket is literal text then).
 */
function parseLink(
  text: string,
  i: number,
  j: number,
  ctx: InlineContext,
): { nodes: Inline[]; end: number } | null {
  if (j < 0 || text.charAt(j + 1) !== '(') return null
  const labelText = text.slice(i + 1, j)
  let k = j + 2
  let parens = 1
  const limit = Math.min(text.length, k + TARGET_MAX)
  for (; k < limit; k++) {
    const c = text.charAt(k)
    if (c === '\\') {
      k += 1
      continue
    }
    if (c === '\n') return null
    if (c === '(') parens += 1
    else if (c === ')') {
      parens -= 1
      if (parens === 0) break
    }
  }
  if (parens !== 0) return null
  const target = text.slice(j + 2, k).trim()
  const label = parseInline(labelText, { links: false, refs: false })
  const ref = REF_TARGET.exec(target)
  if (ref) {
    const value = refOf(ref[1] ?? '', ref[2] ?? '', ref[3])
    if (value === null) return null
    const children: Inline[] = label.length > 0 ? label : [{ type: 'text', text: target }]
    return { nodes: ctx.refs ? [{ type: 'ref', ref: value, children }] : children, end: k + 1 }
  }
  if (WEB_URL.test(target)) {
    return { nodes: [{ type: 'link', url: target, children: label }], end: k + 1 }
  }
  return null
}

/** CommonMark's "process emphasis" over the delimiter stack, with `==` pairs for highlights. */
function processEmphasis(seq: Sequence, ctx: InlineContext): void {
  /** Lowest opener worth trying, per closer kind (keeps unmatched runs from making this quadratic). */
  const openersBottom = new Map<string, SDelim | null>()
  let closer = seq.bottom()
  while (closer) {
    if (!closer.canClose) {
      closer = closer.above
      continue
    }
    const key = `${closer.char}${closer.canOpen ? 1 : 0}${closer.orig % 3}`
    const floor = openersBottom.has(key) ? openersBottom.get(key) : undefined
    let opener = closer.below
    let found: SDelim | null = null
    while (opener && opener !== floor) {
      if (opener.canOpen && opener.char === closer.char) {
        const both = opener.canClose || closer.canOpen
        const ruleOf3 =
          closer.char !== '=' &&
          both &&
          (opener.orig + closer.orig) % 3 === 0 &&
          !(opener.orig % 3 === 0 && closer.orig % 3 === 0)
        const markOk = closer.char !== '=' || (opener.count >= 2 && closer.count >= 2)
        if (!ruleOf3 && markOk) {
          found = opener
          break
        }
      }
      opener = opener.below
    }
    if (!found) {
      openersBottom.set(key, closer.below)
      const next: SDelim | null = closer.above
      if (!closer.canOpen) seq.unstack(closer)
      closer = next
      continue
    }
    const use = closer.char === '=' ? 2 : found.count >= 2 && closer.count >= 2 ? 2 : 1
    const type = closer.char === '=' ? 'mark' : use === 2 ? 'strong' : 'em'
    const children = toInlines(found.next, closer, ctx)
    const wrapped: SInline = { kind: 'inline', node: { type, children }, prev: found, next: closer }
    found.next = wrapped
    closer.prev = wrapped
    // Delimiters between the pair are text now.
    found.above = closer
    closer.below = found
    found.count -= use
    closer.count -= use
    if (found.count === 0) {
      seq.unstack(found)
      seq.unlink(found)
    }
    if (closer.count === 0) {
      const next: SDelim | null = closer.above
      seq.unstack(closer)
      seq.unlink(closer)
      closer = next
    }
  }
}

/** The nodes from `from` up to (not including) `to` as inline nodes: delimiters left over become text. */
function toInlines(from: SNode | null, to: SNode | null, ctx: InlineContext): Inline[] {
  const out: Inline[] = []
  const text = (t: string) => {
    if (t === '') return
    const last = out.at(-1)
    if (last?.type === 'text') last.text += t
    else out.push({ type: 'text', text: t })
  }
  for (let n = from; n && n !== to; n = n.next) {
    if (n.kind === 'text') text(n.text)
    else if (n.kind === 'delim') text(n.char.repeat(n.count))
    else out.push(n.node)
  }
  return ctx.refs ? linkRefs(out) : out
}

/** Splits text nodes at bare references. */
function linkRefs(nodes: Inline[]): Inline[] {
  const out: Inline[] = []
  for (const node of nodes) {
    if (node.type !== 'text') {
      out.push(node)
      continue
    }
    let last = 0
    for (const m of node.text.matchAll(BARE_REF)) {
      const ref = refOf(m[1] ?? '', m[2] ?? '', m[3])
      if (ref === null) continue
      const at = m.index
      if (at > last) out.push({ type: 'text', text: node.text.slice(last, at) })
      out.push({ type: 'ref', ref, children: [{ type: 'text', text: m[0] }] })
      last = at + m[0].length
    }
    if (last === 0) out.push(node)
    else if (last < node.text.length) out.push({ type: 'text', text: node.text.slice(last) })
  }
  return out
}

// --- blocks ----------------------------------------------------------------------------------------------------------

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/u
const QUOTE = /^ {0,3}> ?(.*)$/u
const BULLET = /^( {0,3})([-*+])(?:( +)(.*))?$/u
const ORDERED = new RegExp(`^( {0,3})([${DIGIT}]{1,9})([.)])(?:( +)(.*))?$`, 'u')
const TASK = /^\[([ xX])\](?: +(.*))?$/u

interface Marker {
  indent: number
  ordered: boolean
  /** `-`, `*`, `+` for bullets; `.` or `)` for numbered items. */
  char: string
  number: number
  content: string
  /** Where the item's content starts (continuation lines indented this far belong to it). */
  contentIndent: number
}

const isBlank = (line: string) => line.trim() === ''
const indentOf = (line: string) => line.length - line.trimStart().length

/** Leading tabs as spaces (tab stops of 4), so indentation compares in one unit. */
function expandTabs(line: string): string {
  if (!line.includes('\t')) return line
  let out = ''
  let i = 0
  for (; i < line.length; i++) {
    const c = line.charAt(i)
    if (c === ' ') out += ' '
    else if (c === '\t') out += ' '.repeat(4 - (out.length % 4))
    else break
  }
  return out + line.slice(i)
}

function listMarker(line: string): Marker | null {
  const b = BULLET.exec(line)
  if (b) {
    const indent = (b[1] ?? '').length
    const spaces = (b[3] ?? '').length
    return {
      indent,
      ordered: false,
      char: b[2] ?? '-',
      number: 0,
      content: b[4] ?? '',
      contentIndent: indent + 1 + Math.min(Math.max(spaces, 1), 4),
    }
  }
  const o = ORDERED.exec(line)
  if (o) {
    const indent = (o[1] ?? '').length
    const digits = o[2] ?? '1'
    const spaces = (o[4] ?? '').length
    return {
      indent,
      ordered: true,
      char: o[3] ?? '.',
      number: digitsValue(digits),
      content: o[5] ?? '',
      contentIndent: indent + digits.length + 1 + Math.min(Math.max(spaces, 1), 4),
    }
  }
  return null
}

/** A line that ends a paragraph: a heading, a quote, a bullet, or a numbered item starting at 1. */
function interruptsParagraph(line: string): boolean {
  if (HEADING.test(line) || QUOTE.test(line)) return true
  const m = listMarker(line)
  return m !== null && m.content.trim() !== '' && (!m.ordered || m.number === 1)
}

/** A heading's text without its optional closing `#` sequence (`## Title ##` → `Title`). */
function withoutClosingHashes(content: string): string {
  const text = content.trim()
  let end = text.length
  while (end > 0 && text.charAt(end - 1) === '#') end -= 1
  if (end === text.length) return text
  const before = text.charAt(end - 1)
  return end === 0 || before === ' ' || before === '\t' ? text.slice(0, end).trimEnd() : text
}

function parseBlocks(lines: readonly string[], depth: number, ctx: InlineContext): Block[] {
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (isBlank(line)) {
      i += 1
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      const hashes = (heading[1] ?? '#').length
      const content = withoutClosingHashes(heading[2] ?? '')
      if (content !== '') {
        const level = hashes === 1 ? 1 : hashes === 2 ? 2 : 3
        blocks.push({ type: 'heading', level, children: parseInline(content, ctx) })
      }
      i += 1
      continue
    }
    if (depth < MAX_DEPTH && QUOTE.test(line)) {
      const inner: string[] = []
      while (i < lines.length) {
        const l = lines[i] ?? ''
        const q = QUOTE.exec(l)
        if (q) inner.push(q[1] ?? '')
        else if (!isBlank(l) && inner.length > 0 && !isBlank(inner.at(-1) ?? '') && !interruptsParagraph(l))
          inner.push(l) // lazy continuation of the quoted paragraph
        else break
        i += 1
      }
      blocks.push({ type: 'quote', children: parseBlocks(inner, depth + 1, ctx) })
      continue
    }
    const marker = depth < MAX_DEPTH ? listMarker(line) : null
    if (marker) {
      const [list, next] = parseList(lines, i, marker, depth, ctx)
      blocks.push(list)
      i = next
      continue
    }
    const para: string[] = [line.trim()]
    i += 1
    while (i < lines.length) {
      const l = lines[i] ?? ''
      if (isBlank(l) || interruptsParagraph(l)) break
      para.push(l.trim())
      i += 1
    }
    blocks.push({ type: 'paragraph', children: parseInline(para.join('\n'), ctx) })
  }
  return blocks
}

function parseList(
  lines: readonly string[],
  start: number,
  first: Marker,
  depth: number,
  ctx: InlineContext,
): [Block, number] {
  const items: ListItem[] = []
  let tight = true
  let i = start
  let gapBefore = false
  while (i < lines.length) {
    const m = listMarker(lines[i] ?? '')
    if (!m || m.ordered !== first.ordered || m.char !== first.char) break
    if (gapBefore) tight = false
    // Nested content may be indented less than CommonMark asks (two spaces under "1. "), as people type it.
    const threshold = Math.min(m.contentIndent, m.indent + 2)
    let content = m.content
    let task: ListItem['task'] = null
    const t = TASK.exec(content)
    if (t) {
      task = t[1] === ' ' ? 'open' : 'done'
      content = t[2] ?? ''
    }
    const body: string[] = [content]
    i += 1
    while (i < lines.length) {
      const l = lines[i] ?? ''
      if (isBlank(l)) {
        body.push('')
        i += 1
        continue
      }
      const ind = indentOf(l)
      if (ind >= threshold) {
        body.push(l.slice(Math.min(ind, m.contentIndent)))
        i += 1
        continue
      }
      const previous = body.at(-1) ?? ''
      if (!isBlank(previous) && !HEADING.test(l) && !QUOTE.test(l) && listMarker(l) === null) {
        body.push(l.trim()) // lazy continuation of the item's paragraph
        i += 1
        continue
      }
      break
    }
    gapBefore = false
    while (body.length > 1 && isBlank(body.at(-1) ?? '')) {
      body.pop()
      gapBefore = true
    }
    if (body.some((l, n) => n > 0 && isBlank(l))) tight = false
    items.push({ task, children: parseBlocks(body, depth + 1, ctx) })
  }
  return [{ type: 'list', ordered: first.ordered, start: first.number, tight, items }, i]
}

/** Parses a note body into blocks. */
export function parseMarkdown(source: string, options: MarkdownOptions = {}): Block[] {
  if (source.trim() === '') return []
  const lines = source.replace(/\r\n?/gu, '\n').split('\n').map(expandTabs)
  return parseBlocks(lines, 0, { links: true, refs: options.refs !== false })
}

// --- HTML --------------------------------------------------------------------------------------------------------------

/** The text of inline nodes (references keep their label; web links read "label (url)"). */
function inlineText(nodes: readonly Inline[]): string {
  let out = ''
  for (const n of nodes) {
    if (n.type === 'text') out += n.text
    else if (n.type === 'break') out += '\n'
    else if (n.type === 'link') out += linkText(n.url, inlineText(n.children))
    else out += inlineText(n.children)
  }
  return out
}

function linkText(url: string, label: string): string {
  return label.trim() === '' || label === url ? url : `${label} (${url})`
}

function inlineHtml(nodes: readonly Inline[]): string {
  let out = ''
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        out += escapeHtml(n.text)
        break
      case 'break':
        out += '<br>'
        break
      case 'strong':
      case 'em':
      case 'mark':
        out += `<${n.type}>${inlineHtml(n.children)}</${n.type}>`
        break
      case 'ref':
        out += `<a data-ref="${escapeHtml(n.ref)}">${inlineHtml(n.children)}</a>`
        break
      case 'link': {
        const label = inlineText(n.children)
        out +=
          label.trim() === '' || label === n.url
            ? escapeHtml(n.url)
            : `${inlineHtml(n.children)} (${escapeHtml(n.url)})`
        break
      }
    }
  }
  return out
}

/** No-break space: a task box stays with the item's first word. */
const NBSP = String.fromCharCode(0xa0)
const TASK_BOX = { open: `☐${NBSP}`, done: `☑${NBSP}` } as const

/**
 * Blocks as HTML. `tight` renders paragraphs without `<p>` (items of a tight list); `lead` (a task box) goes at the start
 * of the first paragraph, or before the first block when that is not a paragraph.
 */
function blockHtml(blocks: readonly Block[], tight = false, lead = ''): string {
  let out = ''
  let pending = lead
  for (const b of blocks) {
    if (pending !== '' && b.type !== 'paragraph') out += escapeHtml(pending)
    const prefix = b.type === 'paragraph' ? escapeHtml(pending) : ''
    pending = ''
    switch (b.type) {
      case 'paragraph':
        out += tight ? prefix + inlineHtml(b.children) : `<p>${prefix}${inlineHtml(b.children)}</p>`
        break
      case 'heading': {
        const tag = b.level === 1 ? 'h2' : b.level === 2 ? 'h3' : 'h4'
        out += `<${tag}>${inlineHtml(b.children)}</${tag}>`
        break
      }
      case 'quote':
        out += `<blockquote>${blockHtml(b.children)}</blockquote>`
        break
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul'
        out += `<${tag}>`
        for (const item of b.items) {
          const box = item.task === null ? '' : TASK_BOX[item.task]
          out += `<li>${blockHtml(item.children, b.tight, box)}${item.children.length === 0 ? escapeHtml(box) : ''}</li>`
        }
        out += `</${tag}>`
        break
      }
    }
  }
  return out
}

/** The HTML of a note body: escaped text in the subset's tags only (render it through `SafeHtml`). */
export function renderMarkdown(source: string, options: MarkdownOptions = {}): string {
  return blockHtml(parseMarkdown(source, options))
}

/** The HTML of blocks already parsed with `parseMarkdown`. */
export function renderBlocks(blocks: readonly Block[]): string {
  return blockHtml(blocks)
}

/** A note body as plain text: markup removed, one line per block or list item. */
export function markdownToText(source: string): string {
  const lines: string[] = []
  const walk = (blocks: readonly Block[]) => {
    for (const b of blocks) {
      if (b.type === 'list') {
        for (const item of b.items) {
          const start = lines.length
          walk(item.children)
          if (item.task !== null && lines.length > start) lines[start] = TASK_BOX[item.task] + lines[start]
        }
      } else if (b.type === 'quote') walk(b.children)
      else lines.push(...inlineText(b.children).split('\n'))
    }
  }
  walk(parseMarkdown(source, { refs: false }))
  return lines
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join('\n')
}

/** The ordered lists of a body in document order with their first numbers (`NoteBody` restores `<ol start>`). */
export function orderedListStarts(blocks: readonly Block[]): number[] {
  const out: number[] = []
  const walk = (bs: readonly Block[]) => {
    for (const b of bs) {
      if (b.type === 'list') {
        if (b.ordered) out.push(b.start)
        for (const item of b.items) walk(item.children)
      } else if (b.type === 'quote') walk(b.children)
    }
  }
  walk(blocks)
  return out
}

// --- editing ------------------------------------------------------------------------------------------------------------

/** One replaced range and the selection after the change (offsets in the new text). */
export interface TextEdit {
  from: number
  to: number
  insert: string
  selectionStart: number
  selectionEnd: number
}

/** Applies an edit to a string (tests, and the editor's fallback when the native edit path is unavailable). */
export function applyEdit(text: string, edit: TextEdit): string {
  return text.slice(0, edit.from) + edit.insert + text.slice(edit.to)
}

export type InlineMark = 'strong' | 'em' | 'mark'

const MARKS: Record<InlineMark, string> = { strong: '**', em: '*', mark: '==' }

function runLength(text: string, at: number, step: 1 | -1, ch: string): number {
  let n = 0
  let i = step === 1 ? at : at - 1
  while (i >= 0 && i < text.length && text.charAt(i) === ch) {
    n += 1
    i += step
  }
  return n
}

/** Whether a run pair of `inner` markers around a span carries the mark (`***x***` is strong and emphasis). */
function carries(mark: InlineMark, before: number, after: number): boolean {
  const run = Math.min(before, after)
  if (mark === 'em') return run % 2 === 1
  return run >= 2
}

/** A run of one delimiter character, and whether it can open (text follows) or close (text precedes) a span. */
interface DelimiterRun {
  start: number
  end: number
  open: boolean
  close: boolean
}

function delimiterRuns(text: string, from: number, to: number, ch: string): DelimiterRun[] {
  const runs: DelimiterRun[] = []
  let i = from
  while (i < to) {
    if (text.charAt(i) !== ch) {
      i += 1
      continue
    }
    let j = i
    while (j < to && text.charAt(j) === ch) j += 1
    const before = i > from ? text.charAt(i - 1) : ''
    const after = j < to ? text.charAt(j) : ''
    runs.push({
      start: i,
      end: j,
      open: after !== '' && !WHITESPACE.test(after),
      close: before !== '' && !WHITESPACE.test(before),
    })
    i = j
  }
  return runs
}

/**
 * The span of `mark` the caret sits in on its line (`open.end ≤ at ≤ close.start`), or `null`. Delimiter runs pair from
 * the start of the line as the renderer reads them: a run that carries the mark and can open opens a span, the next one
 * that carries it and can close closes it. A bullet's `* ` never opens (whitespace follows it).
 */
function enclosingSpan(
  text: string,
  at: number,
  mark: InlineMark,
): { open: DelimiterRun; close: DelimiterRun } | null {
  const ch = MARKS[mark].charAt(0)
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  const nl = text.indexOf('\n', at)
  const lineEnd = nl === -1 ? text.length : nl
  let open: DelimiterRun | null = null
  for (const run of delimiterRuns(text, lineStart, lineEnd, ch)) {
    const len = run.end - run.start
    if (!carries(mark, len, len)) continue
    if (open !== null && run.close) {
      if (run.start >= at) return open.end <= at ? { open, close: run } : null
      open = null
    } else if (open === null && run.open) {
      if (run.end > at) return null
      open = run
    }
  }
  return null
}

/**
 * Toggles bold, italic or highlight on the selection (`Mod+B`, `Mod+I` and the toolbar). With no selection: at the end
 * of a span of that mark the caret steps out past its closing marker (Mod+B, type, Mod+B, as in a word processor),
 * inside one the span is removed, else the word at the caret is wrapped, or an empty pair is inserted with the caret
 * inside. Surrounding whitespace stays outside.
 */
export function toggleInline(text: string, start: number, end: number, mark: InlineMark): TextEdit {
  const m = MARKS[mark]
  const ch = m.charAt(0)
  let a = Math.min(start, end)
  let b = Math.max(start, end)
  while (a < b && WHITESPACE.test(text.charAt(a))) a += 1
  while (b > a && WHITESPACE.test(text.charAt(b - 1))) b -= 1
  if (a === b) {
    // Caret between an empty pair: remove it.
    const emptyPair =
      text.slice(a - m.length, a) === m &&
      text.slice(a, a + m.length) === m &&
      carries(mark, runLength(text, a, -1, ch), runLength(text, a, 1, ch))
    if (emptyPair) {
      const at = a - m.length
      return { from: at, to: a + m.length, insert: '', selectionStart: at, selectionEnd: at }
    }
    const span = enclosingSpan(text, a, mark)
    if (span !== null) {
      // At the span's end: step out past its closing marker; the text is unchanged.
      if (a === span.close.start) {
        return { from: a, to: a, insert: '', selectionStart: span.close.end, selectionEnd: span.close.end }
      }
      // Inside it: remove the markers next to the content, the caret staying on its character.
      const from = span.open.end - m.length
      const at = a - m.length
      return {
        from,
        to: span.close.start + m.length,
        insert: text.slice(span.open.end, span.close.start),
        selectionStart: at,
        selectionEnd: at,
      }
    }
    // The word around the caret, keeping the caret on its character.
    let ws = a
    let we = a
    while (ws > 0 && WORD_CHAR.test(charBefore(text, ws))) ws -= charBefore(text, ws).length
    while (we < text.length && WORD_CHAR.test(charAt(text, we))) we += charAt(text, we).length
    if (ws === we) {
      const at = a + m.length
      return { from: a, to: a, insert: m + m, selectionStart: at, selectionEnd: at }
    }
    const edit = toggleInline(text, ws, we, mark)
    const at = edit.selectionStart + (a - ws)
    return { ...edit, selectionStart: at, selectionEnd: at }
  }
  const inner = text.slice(a, b)
  // The selection includes the markers: unwrap inside.
  const wrappedInside =
    inner.length >= 2 * m.length + 1 &&
    inner.startsWith(m) &&
    inner.endsWith(m) &&
    carries(mark, runLength(inner, 0, 1, ch), runLength(inner, inner.length, -1, ch))
  if (wrappedInside) {
    const stripped = inner.slice(m.length, inner.length - m.length)
    return { from: a, to: b, insert: stripped, selectionStart: a, selectionEnd: a + stripped.length }
  }
  // Markers just outside the selection: unwrap.
  if (carries(mark, runLength(text, a, -1, ch), runLength(text, b, 1, ch))) {
    return {
      from: a - m.length,
      to: b + m.length,
      insert: inner,
      selectionStart: a - m.length,
      selectionEnd: b - m.length,
    }
  }
  return { from: a, to: b, insert: m + inner + m, selectionStart: a + m.length, selectionEnd: b + m.length }
}

export type LineFormat = 'bullet' | 'ordered' | 'quote' | 'heading'

const LINE_PREFIX: Record<LineFormat, RegExp> = {
  bullet: /^(\s*)[-*+] +(?:\[[ xX]\] +)?/u,
  ordered: new RegExp(`^(\\s*)[${DIGIT}]{1,9}[.)] +`, 'u'),
  quote: /^(\s*)> ?/u,
  heading: /^(\s*)#{1,6} +/u,
}

/** Any list marker at the start of a line (switching bullet ↔ numbered replaces it). */
const ANY_LIST_PREFIX = new RegExp(`^(\\s*)(?:[-*+]|[${DIGIT}]{1,9}[.)]) +`, 'u')

/**
 * Toggles a line format on every line the selection touches: adds it to each non-blank line (numbering a numbered list
 * 1, 2, 3, …), or removes it when every non-blank line already has it.
 */
export function toggleLines(text: string, start: number, end: number, format: LineFormat): TextEdit {
  const a = Math.min(start, end)
  let b = Math.max(start, end)
  if (b > a && text.charAt(b - 1) === '\n') b -= 1
  const lineStart = text.lastIndexOf('\n', a - 1) + 1
  const nl = text.indexOf('\n', b)
  const lineEnd = nl === -1 ? text.length : nl
  const lines = text.slice(lineStart, lineEnd).split('\n')
  const prefix = LINE_PREFIX[format]
  const content = lines.filter((l) => !isBlank(l))
  const remove = content.length > 0 && content.every((l) => prefix.test(l))
  let n = 0
  const out = lines.map((l) => {
    if (remove) return l.replace(prefix, '$1')
    if (isBlank(l) && lines.length > 1) return l
    n += 1
    const bare =
      format === 'bullet' || format === 'ordered'
        ? l.replace(ANY_LIST_PREFIX, '$1')
        : format === 'heading'
          ? l.replace(LINE_PREFIX.heading, '$1')
          : l
    const lead = /^\s*/u.exec(bare)?.[0] ?? ''
    const mark =
      format === 'bullet' ? '- ' : format === 'ordered' ? `${n}. ` : format === 'quote' ? '> ' : '## '
    return lead + mark + bare.slice(lead.length)
  })
  const insert = out.join('\n')
  if (a === b) {
    // Keep the caret on the same character of its line.
    const before = lines[0] ?? ''
    const after = out[0] ?? ''
    const col = Math.max(0, a - lineStart + after.length - before.length)
    const at = lineStart + Math.min(col, after.length)
    return { from: lineStart, to: lineEnd, insert, selectionStart: at, selectionEnd: at }
  }
  return {
    from: lineStart,
    to: lineEnd,
    insert,
    selectionStart: lineStart,
    selectionEnd: lineStart + insert.length,
  }
}

const CONTINUE_LIST = new RegExp(`^(\\s*)(?:([-*+])|([${DIGIT}]{1,9})([.)]))( +)(\\[[ xX]\\] +)?`, 'u')
const CONTINUE_QUOTE = /^(\s*> ?)/u

/**
 * Enter inside a list item or a quote: continues it on the next line ("- ", "3. ", "> ", a new open task box), or, on
 * an item that is still empty, ends the list by removing the marker. `null` when Enter should just insert a line break.
 */
export function continueList(text: string, caret: number): TextEdit | null {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1
  const nl = text.indexOf('\n', caret)
  const lineEnd = nl === -1 ? text.length : nl
  const line = text.slice(lineStart, lineEnd)
  const list = CONTINUE_LIST.exec(line)
  const quote = list ? null : CONTINUE_QUOTE.exec(line)
  const prefix = list?.[0] ?? quote?.[0]
  if (prefix === undefined || caret - lineStart < prefix.length) return null
  if (line.slice(prefix.length).trim() === '') {
    return { from: lineStart, to: lineEnd, insert: '', selectionStart: lineStart, selectionEnd: lineStart }
  }
  let next: string
  if (list) {
    const lead = list[1] ?? ''
    const spaces = list[5] ?? ' '
    const task = list[6] === undefined ? '' : '[ ] '
    if (list[2] !== undefined) next = `${lead}${list[2]}${spaces}${task}`
    else {
      const digits = list[3] ?? '1'
      next = `${lead}${digitsLike(digitsValue(digits) + 1, digits)}${list[4] ?? '.'}${spaces}${task}`
    }
  } else {
    next = prefix
  }
  const insert = `\n${next}`
  const at = caret + insert.length
  return { from: caret, to: caret, insert, selectionStart: at, selectionEnd: at }
}
