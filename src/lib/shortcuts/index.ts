/**
 * Shortcut runtime (§7.7, D11): chord parsing, hybrid key matching, the editable and widget guards, key labels and the
 * window listeners. Everything here is pure (no store imports), so the `shortcuts` store can use it without an import
 * cycle and tests can drive it with synthetic events. The rules that need app state (layers, scopes, `when`, precedence,
 * the Escape hand-off) live in `$lib/stores/shortcuts.svelte`. Owner: WP0E → WP7c.
 *
 * Chord notation (§7.7): `[Mod+][Ctrl+][Alt+][Shift+]<key>`, `Mod` = Ctrl on Windows/Linux and ⌘ on macOS, `Ctrl+` the
 * physical Control key (a chord with both `Mod+` and `Ctrl+` exists only on macOS: `Mod+Ctrl+f`). `<key>` is one of:
 * - a lower-case US letter `a`–`z` (Shift is written explicitly: `Shift+b`);
 * - a US punctuation character (`?`, `>`, `[`, `,`), or its `KeyboardEvent.code` name (`Comma`, `Period`, …);
 *   a literal plus is written as the trailing `+` of `Mod++`;
 * - `Digit0`–`Digit9` (a bare `0`–`9` means the same);
 * - a named key: arrows, `PageUp`/`PageDown`, `Home`/`End`, `Space`, `Enter`, `Escape`, `Tab`, `Backspace`, `Delete`,
 *   `Insert`, `ContextMenu`, `F1`–`F24`.
 */
export type { ShortcutDef, ShortcutGroup, ShortcutScope } from '$lib/contracts/shortcuts'
export { SHORTCUT_GROUPS } from '$lib/contracts/shortcuts'

/** How a chord's key is matched (D11). */
export type KeyKind = 'named' | 'digit' | 'letter' | 'punct'

/** A parsed chord: `Mod+Shift+d` → `{ mod: true, shift: true, key: 'd', kind: 'letter' }`. */
export interface Chord {
  mod: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** Normalised key: a US letter (`k`), a US punctuation character (`?`), `Digit0`–`Digit9` or a named key. */
  key: string
  kind: KeyKind
}

/**
 * How well an event matched a chord. `2` (exact): every modifier compared, including Shift. `1` (by character):
 * punctuation matched by the character it types, Shift implied (`?` is "the key that types ?"). `0`: no match.
 * When several definitions match one event the exact match wins (§7.7 precedence in the store).
 */
export type MatchQuality = 0 | 1 | 2

const FUNCTION_KEYS = Array.from({ length: 24 }, (_, i) => `F${i + 1}`)

/** Keys matched by name on `e.key` / `e.code`. */
export const NAMED_KEYS: ReadonlySet<string> = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'Space',
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'Insert',
  'ContextMenu',
  ...FUNCTION_KEYS,
])

/**
 * The US layout: punctuation character → [`KeyboardEvent.code`, Shift]. Used for the `code` fallback on non-Latin
 * layouts (D11: `'['` ↔ `BracketLeft`, `'?'` ↔ `Shift+Slash`, `'>'` ↔ `Shift+Period`) and for explicit-Shift chords.
 */
export const US_PUNCTUATION: Readonly<Record<string, readonly [code: string, shift: boolean]>> = {
  '`': ['Backquote', false],
  '~': ['Backquote', true],
  '!': ['Digit1', true],
  '@': ['Digit2', true],
  '#': ['Digit3', true],
  $: ['Digit4', true],
  '%': ['Digit5', true],
  '^': ['Digit6', true],
  '&': ['Digit7', true],
  '*': ['Digit8', true],
  '(': ['Digit9', true],
  ')': ['Digit0', true],
  '-': ['Minus', false],
  _: ['Minus', true],
  '=': ['Equal', false],
  '+': ['Equal', true],
  '[': ['BracketLeft', false],
  '{': ['BracketLeft', true],
  ']': ['BracketRight', false],
  '}': ['BracketRight', true],
  '\\': ['Backslash', false],
  '|': ['Backslash', true],
  ';': ['Semicolon', false],
  ':': ['Semicolon', true],
  "'": ['Quote', false],
  '"': ['Quote', true],
  ',': ['Comma', false],
  '<': ['Comma', true],
  '.': ['Period', false],
  '>': ['Period', true],
  '/': ['Slash', false],
  '?': ['Slash', true],
}

/** `code` names accepted in place of the unshifted US character (`Mod+Comma` in §7.7 is `Mod+,`). */
const CODE_ALIASES: Readonly<Record<string, string>> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
}

/** `e.key` values of the modifier keys themselves: pressing one alone never matches a chord. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'Shift',
  'Control',
  'Alt',
  'AltGraph',
  'Meta',
  'OS',
  'Hyper',
  'Super',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Fn',
  'FnLock',
])

/** Parses the §7.7 chord notation. Throws on an unknown modifier or key (a definition bug). */
export function parseChord(chord: string): Chord {
  const text = chord.trim()
  let keyPart: string
  let modParts: string[]
  if (text === '+') {
    keyPart = '+'
    modParts = []
  } else if (text.endsWith('++')) {
    keyPart = '+'
    modParts = text.slice(0, -2).split('+')
  } else {
    modParts = text.split('+')
    keyPart = modParts.pop() ?? ''
  }

  const parsed: Chord = { mod: false, ctrl: false, alt: false, shift: false, key: '', kind: 'named' }
  for (const raw of modParts) {
    switch (raw.trim().toLowerCase()) {
      case 'mod':
        parsed.mod = true
        break
      case 'ctrl':
      case 'control':
        parsed.ctrl = true
        break
      case 'alt':
      case 'option':
        parsed.alt = true
        break
      case 'shift':
        parsed.shift = true
        break
      default:
        throw new Error(`invalid modifier "${raw}" in chord "${chord}"`)
    }
  }

  const key = keyPart.trim()
  if (key === '') throw new Error(`invalid chord "${chord}": no key`)
  if (key === 'Esc') return { ...parsed, key: 'Escape', kind: 'named' }
  if (NAMED_KEYS.has(key)) return { ...parsed, key, kind: 'named' }
  if (/^Digit[0-9]$/.test(key)) return { ...parsed, key, kind: 'digit' }
  if (/^[0-9]$/.test(key)) return { ...parsed, key: `Digit${key}`, kind: 'digit' }
  if (/^[a-z]$/.test(key)) return { ...parsed, key, kind: 'letter' }
  if (/^[A-Z]$/.test(key)) {
    throw new Error(`invalid chord "${chord}": letters are lower-case, write Shift+ explicitly`)
  }
  const alias = CODE_ALIASES[key]
  if (alias !== undefined) return { ...parsed, key: alias, kind: 'punct' }
  if (key in US_PUNCTUATION) return { ...parsed, key, kind: 'punct' }
  throw new Error(`invalid chord "${chord}": unknown key "${key}"`)
}

/** Parses a chord, or returns `null` (and never throws) for an invalid one. */
export function tryParseChord(chord: string): Chord | null {
  try {
    return parseChord(chord)
  } catch {
    return null
  }
}

/** Whether a chord can be typed on this platform: `Mod+Ctrl+…` exists only on macOS (elsewhere Mod is Ctrl). */
export function chordAvailable(chord: Chord, isMac: boolean): boolean {
  return isMac || !(chord.mod && chord.ctrl)
}

/** A single printable ASCII character (what a Latin layout reports in `e.key`). */
function isAsciiChar(key: string): boolean {
  if (key.length !== 1) return false
  const c = key.charCodeAt(0)
  return c > 0x20 && c < 0x7f
}

interface ModifierRule {
  /** Compare Shift (`true`/`false`), or ignore it (`null`: punctuation by character). */
  shift: boolean | null
  /**
   * The key was matched by the character it typed: AltGr (Ctrl+Alt on Windows/Linux layouts such as German `[` =
   * AltGr+8) and macOS Option are then character modifiers, not chord modifiers.
   */
  byCharacter: boolean
}

function modifiersMatch(chord: Chord, e: KeyboardEvent, isMac: boolean, rule: ModifierRule): boolean {
  let ctrl = e.ctrlKey
  let alt = e.altKey
  const meta = e.metaKey
  if (rule.byCharacter && !chord.mod && !chord.ctrl && !chord.alt) {
    if (isMac) alt = false
    else if (e.getModifierState('AltGraph') || (ctrl && alt)) {
      ctrl = false
      alt = false
    }
  }
  const wantCtrl = isMac ? chord.ctrl : chord.mod || chord.ctrl
  const wantMeta = isMac && chord.mod
  if (ctrl !== wantCtrl || meta !== wantMeta || alt !== chord.alt) return false
  return rule.shift === null || e.shiftKey === rule.shift
}

/** Whether the event is part of an IME composition or a lone modifier press (never a shortcut). */
export function isInertKeyEvent(e: KeyboardEvent): boolean {
  // keyCode 229 is the IME "Process" key some engines send outside `isComposing`.
  return e.isComposing || e.keyCode === 229 || e.key === 'Process' || MODIFIER_KEYS.has(e.key)
}

/**
 * D11 hybrid matching. Letters and punctuation match `e.key` when it is a printable ASCII character, and fall back to
 * `e.code` (+ Shift through the US table) on non-Latin layouts; digits always match `e.code` (`DigitN`, or `NumpadN`
 * while it types the digit); named keys match `e.key`/`e.code`. Punctuation written with an explicit `Shift+`
 * (`Mod+Shift+=`) means Shift plus the physical US key, so it matches `e.code` on every layout.
 */
export function matchQuality(chord: Chord, e: KeyboardEvent, isMac: boolean): MatchQuality {
  if (isInertKeyEvent(e)) return 0
  const exact = (keyMatches: boolean): MatchQuality =>
    keyMatches && modifiersMatch(chord, e, isMac, { shift: chord.shift, byCharacter: false }) ? 2 : 0

  switch (chord.kind) {
    case 'named':
      return exact(e.key === chord.key || e.code === chord.key || (chord.key === 'Space' && e.key === ' '))
    case 'digit': {
      const digit = chord.key.slice(-1)
      return exact(e.code === chord.key || (e.code === `Numpad${digit}` && e.key === digit))
    }
    case 'letter':
      return exact(
        isAsciiChar(e.key) ? e.key.toLowerCase() === chord.key : e.code === `Key${chord.key.toUpperCase()}`,
      )
    case 'punct': {
      const us = US_PUNCTUATION[chord.key]
      if (us === undefined) return 0
      const [code, usShift] = us
      if (chord.shift) return exact(e.code === code)
      if (isAsciiChar(e.key)) {
        return e.key === chord.key && modifiersMatch(chord, e, isMac, { shift: null, byCharacter: true })
          ? 1
          : 0
      }
      return e.code === code && modifiersMatch(chord, e, isMac, { shift: usShift, byCharacter: false })
        ? 1
        : 0
    }
  }
}

/** Whether a keyboard event matches a chord (D11 hybrid matching). */
export function matchesChord(chord: Chord, e: KeyboardEvent, isMac: boolean): boolean {
  return matchQuality(chord, e, isMac) > 0
}

// ---------------------------------------------------------------------------------------------------------------------
// Focus guards (§7.7 rules 2 and 3)

/** `<input>` types that take typed text (a checkbox, radio, range or button input is not "editable" for rule 2). */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
])

/** §7.7 rule 2: the target takes typed text (`input`, `textarea`, `select`, `[contenteditable]`). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type)
  if (target instanceof HTMLElement && target.isContentEditable) return true
  // `contenteditable` inherits; the nearest attribute decides (jsdom does not implement isContentEditable).
  const host = target.closest('[contenteditable]')
  return host !== null && host.getAttribute('contenteditable') !== 'false'
}

/** §7.7 rule 3: elements that own plain keys (Space, Enter, arrows, typeahead letters) while focused. */
export const WIDGET_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  'summary',
  '[contenteditable]',
  ...[
    'button',
    'link',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'tab',
    'slider',
    'spinbutton',
    'switch',
    'checkbox',
    'radio',
    'combobox',
    'listbox',
    'menu',
    'grid',
    'gridcell',
    'tree',
    'treeitem',
    'toolbar',
  ].map((role) => `[role=${role}]`),
  '[data-qd-keys=own]',
].join(', ')

/** The Mushaf's roving ayah items (§8.15): the reading surface, where reader shortcuts always run. */
export const ROVING_ITEM_SELECTOR = '.mp-a11y li'

/**
 * §7.7 rule 3 (widget guard): whether a plain or Shift-only shortcut must leave this key to the focused widget.
 * Exceptions, where shortcuts do run: `body`, `main.canvas` itself and the Mushaf roving items (also when they sit in a
 * list/grid container; a widget nested inside a roving item still owns its keys).
 */
export function widgetGuardBlocks(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const doc = target.ownerDocument
  if (target === doc.body || target === doc.documentElement || target.matches('main.canvas')) return false
  const widget = target.closest(WIDGET_SELECTOR)
  if (widget === null) return false
  const roving = target.closest(ROVING_ITEM_SELECTOR)
  return !(roving !== null && (widget === roving || widget.contains(roving)))
}

/**
 * Whether the widget guard applies to a chord: chords without Mod, Ctrl or Alt (plain or Shift-only), except Escape and
 * the function keys, which no widget uses (F3, F6, F11 work from anywhere). `Shift+F10` stays guarded: like the
 * ContextMenu key, it opens the focused widget's own context menu.
 */
export function isGuardedChord(chord: Chord): boolean {
  if (chord.mod || chord.ctrl || chord.alt) return false
  if (chord.kind !== 'named') return true
  if (chord.key === 'Escape') return false
  if (/^F\d{1,2}$/.test(chord.key)) return chord.key === 'F10' && chord.shift
  return true
}

// ---------------------------------------------------------------------------------------------------------------------
// Labels (§7.7 `format`)

/** Named keys whose label comes from the `shortcuts.keys.*` dictionary. */
export type LabelledKey =
  'space' | 'enter' | 'escape' | 'home' | 'end' | 'pageUp' | 'pageDown' | 'contextMenu'

const LABELLED: Readonly<Record<string, LabelledKey>> = {
  Space: 'space',
  Enter: 'enter',
  Escape: 'escape',
  Home: 'home',
  End: 'end',
  PageUp: 'pageUp',
  PageDown: 'pageDown',
  ContextMenu: 'contextMenu',
}

const ENGLISH_LABELS: Readonly<Record<LabelledKey, string>> = {
  space: 'Space',
  enter: 'Enter',
  escape: 'Esc',
  home: 'Home',
  end: 'End',
  pageUp: 'Page Up',
  pageDown: 'Page Down',
  contextMenu: 'Menu',
}

const ARROWS: Readonly<Record<string, string>> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
}

export interface FormatOptions {
  isMac: boolean
  /** `navigator.keyboard.getLayoutMap()`: `code` → the character printed on that key in the user's layout. */
  layoutMap?: ReadonlyMap<string, string> | null
  /** Localised names of the spelled-out keys (`shortcuts.keys.*`); English otherwise. */
  keyLabel?: (key: LabelledKey) => string
}

/** The label of a chord's key alone. */
export function keyLabel(chord: Chord, options: FormatOptions): string {
  switch (chord.kind) {
    case 'named': {
      const arrow = ARROWS[chord.key]
      if (arrow !== undefined) return arrow
      const labelled = LABELLED[chord.key]
      if (labelled === undefined) return chord.key
      return options.keyLabel?.(labelled) ?? ENGLISH_LABELS[labelled]
    }
    case 'digit':
      return chord.key.slice(-1)
    case 'letter':
      return chord.key.toUpperCase()
    case 'punct': {
      // Explicit-Shift punctuation is a physical key: print what the user's layout shows on it (German `´` for Equal).
      if (!chord.shift) return chord.key
      const code = US_PUNCTUATION[chord.key]?.[0]
      const shown = code === undefined ? undefined : options.layoutMap?.get(code)
      return shown !== undefined && shown.trim() !== '' ? shown.toUpperCase() : chord.key
    }
  }
}

/**
 * A chord as the user reads it: `Ctrl+Shift+D` on Windows/Linux, `⇧⌘D` on macOS (modifiers in Apple's order ⌃⌥⇧⌘).
 * Render it inside `<Kbd>` (`<bdi dir="ltr">`, §11.3).
 */
export function formatChord(chord: Chord, options: FormatOptions): string {
  const key = keyLabel(chord, options)
  if (options.isMac) {
    return `${chord.ctrl ? '⌃' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${chord.mod ? '⌘' : ''}${key}`
  }
  const parts: string[] = []
  if (chord.mod || chord.ctrl) parts.push('Ctrl')
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

// ---------------------------------------------------------------------------------------------------------------------
// Listeners (§7.7)

export interface ShortcutListeners {
  /** Window capture phase: runs before any element handler (`capture: true` definitions). */
  capture: (e: KeyboardEvent) => void
  /** Window bubble phase: runs after every element handler (everything else). */
  bubble: (e: KeyboardEvent) => void
}

/** Installs the two `keydown` listeners on `target` (the window); returns the uninstaller. */
export function installShortcutListeners(listeners: ShortcutListeners, target: Window = window): () => void {
  const capture = (e: KeyboardEvent) => listeners.capture(e)
  const bubble = (e: KeyboardEvent) => listeners.bubble(e)
  target.addEventListener('keydown', capture, { capture: true })
  target.addEventListener('keydown', bubble)
  return () => {
    target.removeEventListener('keydown', capture, { capture: true })
    target.removeEventListener('keydown', bubble)
  }
}
