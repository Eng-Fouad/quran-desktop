/**
 * The webview's HTML sanitiser. Only `TranslationText.html`, `Footnote.html`, `TafsirEntry.html` and
 * `SearchHit.snippet` are ever rendered as HTML, and only through `SafeHtml.svelte`, which calls `renderSafeHtml`.
 *
 * Rust already sanitises with ammonia; this is the second, independent pass with the same policy:
 * - tags: `p br b strong i em span sup sub h2 h3 h4 ul ol li a blockquote`, plus `mark` for search snippets;
 *   anything else is unwrapped (its text kept) or, for `script`, `style` and the like, removed with its content;
 * - classes: `span.h .s .green .arabic .qpc-hafs .brown`, `sup.fn`, `i.s`; every other class token is dropped;
 * - attributes: `class`, `sup[data-fn]` and `a[data-ref]` only (`href`, `style`, event handlers and every other `data-*`
 *   are dropped). References arrive as `<a data-ref="s:a[-b]">` without `href`, so no URL scheme is involved.
 * After sanitising, `a[data-ref]` becomes `<button type="button" class="ref" data-ref>` (any other `a` is unwrapped) and
 * `sup.fn[data-fn]` gets `role="button" tabindex="0"`; `SafeHtml` delegates their activation to `onref`/`onfootnote`.
 */
import DOMPurify, { type Config, type DOMPurify as Purifier, type UponSanitizeAttributeHook } from 'dompurify'

export const ALLOWED_TAGS = [
  'p',
  'br',
  'b',
  'strong',
  'i',
  'em',
  'span',
  'sup',
  'sub',
  'h2',
  'h3',
  'h4',
  'ul',
  'ol',
  'li',
  'a',
  'blockquote',
  'mark',
] as const

/** Allowed class tokens per tag. */
export const ALLOWED_CLASSES: Readonly<Record<string, readonly string[]>> = {
  span: ['h', 's', 'green', 'arabic', 'qpc-hafs', 'brown'],
  sup: ['fn'],
  i: ['s'],
}

/** `data-ref` values: `s:a` or `s:a-b` (surah 1..3 digits, ayah 1..3 digits). */
export const REF_PATTERN = /^\d{1,3}:\d{1,3}(?:-\d{1,3})?$/
/** `data-fn` values: `s:a:n`; the marker `n` keeps the source's digits (e.g. Bengali). */
export const FOOTNOTE_PATTERN = /^\d{1,3}:\d{1,3}:\p{Nd}{1,4}$/u

const CONFIG: Config = {
  ALLOWED_TAGS: [...ALLOWED_TAGS],
  ALLOWED_ATTR: ['class', 'data-fn', 'data-ref'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  FORBID_ATTR: ['href', 'style'],
  KEEP_CONTENT: true,
}

const restrictAttributes: UponSanitizeAttributeHook = (node, data) => {
  const tag = node.nodeName.toLowerCase()
  switch (data.attrName) {
    case 'class': {
      const allowed = ALLOWED_CLASSES[tag] ?? []
      const kept = data.attrValue.split(/\s+/).filter((token) => allowed.includes(token))
      if (kept.length === 0) data.keepAttr = false
      else data.attrValue = [...new Set(kept)].join(' ')
      break
    }
    case 'data-ref':
      if (tag !== 'a' || !REF_PATTERN.test(data.attrValue.trim())) data.keepAttr = false
      else data.attrValue = data.attrValue.trim()
      break
    case 'data-fn':
      if (tag !== 'sup' || !FOOTNOTE_PATTERN.test(data.attrValue.trim())) data.keepAttr = false
      else data.attrValue = data.attrValue.trim()
      break
  }
}

let purifier: Purifier | null = null

/** A private DOMPurify instance, so these hooks never affect another user of the library. */
function instance(): Purifier {
  if (!purifier) {
    purifier = DOMPurify(window)
    purifier.addHook('uponSanitizeAttribute', restrictAttributes)
  }
  return purifier
}

/** Sanitises an HTML string with the policy above. References stay `a[data-ref]` (see `renderSafeHtml`). */
export function sanitize(html: string): string {
  return instance().sanitize(html, CONFIG)
}

/** Replaces an element by its children. */
function unwrap(el: Element): void {
  el.replaceWith(...Array.from(el.childNodes))
}

/** Sanitises, then turns references into buttons and footnote markers into keyboard-reachable buttons. */
export function renderSafeFragment(html: string): DocumentFragment {
  const fragment = instance().sanitize(html, { ...CONFIG, RETURN_DOM_FRAGMENT: true })
  for (const a of Array.from(fragment.querySelectorAll('a'))) {
    const ref = a.getAttribute('data-ref')
    if (ref === null) {
      unwrap(a)
      continue
    }
    const button = a.ownerDocument.createElement('button')
    button.type = 'button'
    button.className = 'ref'
    button.setAttribute('data-ref', ref)
    button.append(...Array.from(a.childNodes))
    a.replaceWith(button)
  }
  for (const sup of Array.from(fragment.querySelectorAll('sup.fn[data-fn]'))) {
    sup.setAttribute('role', 'button')
    sup.setAttribute('tabindex', '0')
  }
  return fragment
}

/** `renderSafeFragment` serialised: what `SafeHtml.svelte` renders. */
export function renderSafeHtml(html: string): string {
  if (html === '') return ''
  const host = document.createElement('div')
  host.append(renderSafeFragment(html))
  return host.innerHTML
}

/** A parsed `data-ref`: surah and an inclusive ayah range. */
export interface ParsedRef {
  surah: number
  fromAyah: number
  toAyah: number
}

/** Parses `"2:255"` or `"2:255-257"`; `null` for anything else (including `to < from`). */
export function parseRef(ref: string): ParsedRef | null {
  if (!REF_PATTERN.test(ref)) return null
  const [s, range = ''] = ref.split(':')
  const [from, to] = range.split('-')
  const surah = Number(s)
  const fromAyah = Number(from)
  const toAyah = to === undefined ? fromAyah : Number(to)
  if (surah < 1 || surah > 114 || fromAyah < 1 || toAyah < fromAyah) return null
  return { surah, fromAyah, toAyah }
}
