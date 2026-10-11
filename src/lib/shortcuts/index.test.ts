import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chordAvailable,
  formatChord,
  installShortcutListeners,
  isEditableTarget,
  isGuardedChord,
  isInertKeyEvent,
  matchesChord,
  matchQuality,
  parseChord,
  tryParseChord,
  widgetGuardBlocks,
} from './index'

type KeyInit = KeyboardEventInit & { altGraph?: boolean }

/** A keydown event; `altGraph` sets the AltGraph modifier state (AltGr on Windows/Linux layouts). */
function key({ altGraph, ...init }: KeyInit): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
    ...(altGraph ? { modifierAltGraph: true } : {}),
  } as KeyboardEventInit)
}

const WIN = false
const MAC = true
const q = (chord: string, init: KeyInit, isMac = WIN) => matchQuality(parseChord(chord), key(init), isMac)

afterEach(() => {
  document.body.replaceChildren()
})

describe('parseChord', () => {
  it('parses the §7.7 notation', () => {
    expect(parseChord('Mod+k')).toEqual({
      mod: true,
      ctrl: false,
      alt: false,
      shift: false,
      key: 'k',
      kind: 'letter',
    })
    expect(parseChord('Mod+Shift+d')).toMatchObject({ mod: true, shift: true, key: 'd', kind: 'letter' })
    expect(parseChord('Mod+Ctrl+f')).toMatchObject({ mod: true, ctrl: true, key: 'f' })
    expect(parseChord('Alt+ArrowRight')).toMatchObject({ alt: true, key: 'ArrowRight', kind: 'named' })
    expect(parseChord('?')).toMatchObject({ key: '?', kind: 'punct', shift: false })
    expect(parseChord('Mod+Shift+=')).toMatchObject({ mod: true, shift: true, key: '=', kind: 'punct' })
    expect(parseChord('Digit1')).toMatchObject({ key: 'Digit1', kind: 'digit' })
    expect(parseChord('Mod+Shift+Digit0')).toMatchObject({ key: 'Digit0', kind: 'digit', shift: true })
    expect(parseChord('F11')).toMatchObject({ key: 'F11', kind: 'named' })
    expect(parseChord('Shift+F10')).toMatchObject({ key: 'F10', shift: true })
  })

  it('normalises aliases: code names, bare digits, Esc and a literal plus', () => {
    expect(parseChord('Mod+Comma')).toMatchObject({ mod: true, key: ',', kind: 'punct' })
    expect(parseChord('Period')).toMatchObject({ key: '.', kind: 'punct' })
    expect(parseChord('3')).toMatchObject({ key: 'Digit3', kind: 'digit' })
    expect(parseChord('Esc')).toMatchObject({ key: 'Escape', kind: 'named' })
    expect(parseChord('Mod++')).toMatchObject({ mod: true, key: '+', kind: 'punct' })
    expect(parseChord('+')).toMatchObject({ key: '+', kind: 'punct' })
  })

  it('rejects definition bugs', () => {
    expect(() => parseChord('K')).toThrow(/lower-case/)
    expect(() => parseChord('Hyper+k')).toThrow(/modifier/)
    expect(() => parseChord('Mod+Foo')).toThrow(/unknown key/)
    expect(() => parseChord('')).toThrow(/no key/)
    expect(() => parseChord('Mod+')).toThrow(/no key/)
    expect(tryParseChord('Mod+Foo')).toBeNull()
  })

  it('marks Mod+Ctrl chords as macOS-only', () => {
    expect(chordAvailable(parseChord('Mod+Ctrl+f'), MAC)).toBe(true)
    expect(chordAvailable(parseChord('Mod+Ctrl+f'), WIN)).toBe(false)
    expect(chordAvailable(parseChord('F11'), WIN)).toBe(true)
  })
})

describe('matchQuality (D11 hybrid matching)', () => {
  it('matches letters on e.key for Latin layouts, Shift compared', () => {
    expect(q('k', { key: 'k', code: 'KeyK' })).toBe(2)
    expect(q('Shift+b', { key: 'B', code: 'KeyB', shiftKey: true })).toBe(2)
    expect(q('b', { key: 'B', code: 'KeyB', shiftKey: true })).toBe(0)
    expect(q('Shift+b', { key: 'b', code: 'KeyB' })).toBe(0)
    // Caps Lock: upper-case key without Shift is still the plain letter.
    expect(q('b', { key: 'B', code: 'KeyB' })).toBe(2)
  })

  it('follows the character on Dvorak (the key that types k, wherever it is)', () => {
    expect(q('k', { key: 'k', code: 'KeyV' })).toBe(2)
    expect(q('k', { key: 't', code: 'KeyK' })).toBe(0)
  })

  it('falls back to e.code on an Arabic layout (ن on KeyK is k)', () => {
    expect(q('k', { key: 'ن', code: 'KeyK' })).toBe(2)
    expect(q('j', { key: 'ت', code: 'KeyJ' })).toBe(2)
    expect(q('Mod+k', { key: 'ن', code: 'KeyK', ctrlKey: true })).toBe(2)
    expect(q('[', { key: 'ج', code: 'BracketLeft' })).toBe(1)
    expect(q('?', { key: '؟', code: 'Slash', shiftKey: true })).toBe(1)
    expect(q('?', { key: 'ظ', code: 'Slash' })).toBe(0)
    // A dead key is not a character either.
    expect(q('[', { key: 'Dead', code: 'BracketLeft' })).toBe(1)
  })

  it('handles AZERTY: ? is Shift+comma (KeyM), q is KeyA, m is Semicolon, digits need no Shift', () => {
    expect(q('?', { key: '?', code: 'KeyM', shiftKey: true })).toBe(1)
    expect(q('m', { key: '?', code: 'KeyM', shiftKey: true })).toBe(0)
    expect(q('m', { key: 'm', code: 'Semicolon' })).toBe(2)
    expect(q('q', { key: 'q', code: 'KeyA' })).toBe(2)
    expect(q(',', { key: ',', code: 'KeyM' })).toBe(1)
    expect(q('Digit1', { key: '&', code: 'Digit1' })).toBe(2)
    expect(q('Digit1', { key: '1', code: 'Digit1', shiftKey: true })).toBe(0)
  })

  it('matches punctuation by character with Shift implied', () => {
    expect(q('?', { key: '?', code: 'Slash', shiftKey: true })).toBe(1)
    expect(q('>', { key: '>', code: 'Period', shiftKey: true })).toBe(1)
    expect(q('.', { key: '>', code: 'Period', shiftKey: true })).toBe(0)
    expect(q('}', { key: '}', code: 'BracketRight', shiftKey: true })).toBe(1)
    expect(q(']', { key: '}', code: 'BracketRight', shiftKey: true })).toBe(0)
    expect(q('Mod+,', { key: ',', code: 'Comma', ctrlKey: true })).toBe(1)
    expect(q('Mod+,', { key: ',', code: 'Comma' })).toBe(0)
  })

  it('treats explicit-Shift punctuation as the physical US key (exact)', () => {
    expect(q('Mod+Shift+=', { key: '+', code: 'Equal', ctrlKey: true, shiftKey: true })).toBe(2)
    // German: Equal is the ´ key; the chord still means Shift + that physical key.
    expect(q('Mod+Shift+=', { key: '`', code: 'Equal', ctrlKey: true, shiftKey: true })).toBe(2)
    expect(q('Mod+Shift+=', { key: '=', code: 'Equal', ctrlKey: true })).toBe(0)
    expect(q('Mod+=', { key: '=', code: 'Equal', ctrlKey: true })).toBe(1)
    expect(q('Mod+=', { key: '+', code: 'Equal', ctrlKey: true, shiftKey: true })).toBe(0)
    expect(q('Mod+Shift+.', { key: '>', code: 'Period', ctrlKey: true, shiftKey: true })).toBe(2)
  })

  it('ranks an exact chord above a character match for the same keystroke', () => {
    // German Ctrl+Shift+0 types "=": the explicit Mod+Shift+Digit0 wins over Mod+=.
    const e = { key: '=', code: 'Digit0', ctrlKey: true, shiftKey: true }
    expect(q('Mod+Shift+Digit0', e)).toBe(2)
    expect(q('Mod+=', e)).toBe(1)
  })

  it('treats AltGr (Windows/Linux) and Option (macOS) as character modifiers for punctuation only', () => {
    const altGr8 = { key: '[', code: 'Digit8', ctrlKey: true, altKey: true, altGraph: true }
    expect(q('[', altGr8)).toBe(1)
    expect(q('Mod+[', altGr8)).toBe(0)
    expect(q('[', { key: '[', code: 'Digit5', altKey: true }, MAC)).toBe(1)
    // AltGr+a types ą (Polish): never the letter a.
    expect(q('a', { key: 'ą', code: 'KeyA', ctrlKey: true, altKey: true, altGraph: true })).toBe(0)
    // Option+b types ∫ on macOS: not b.
    expect(q('b', { key: '∫', code: 'KeyB', altKey: true }, MAC)).toBe(0)
  })

  it('maps Mod to Ctrl on Windows/Linux and to ⌘ on macOS', () => {
    expect(q('Mod+k', { key: 'k', code: 'KeyK', ctrlKey: true })).toBe(2)
    expect(q('Mod+k', { key: 'k', code: 'KeyK', metaKey: true })).toBe(0)
    expect(q('Mod+k', { key: 'k', code: 'KeyK', metaKey: true }, MAC)).toBe(2)
    expect(q('Mod+k', { key: 'k', code: 'KeyK', ctrlKey: true }, MAC)).toBe(0)
    expect(q('Mod+Ctrl+f', { key: 'f', code: 'KeyF', metaKey: true, ctrlKey: true }, MAC)).toBe(2)
    expect(q('k', { key: 'k', code: 'KeyK', ctrlKey: true })).toBe(0)
    expect(q('k', { key: 'k', code: 'KeyK', altKey: true })).toBe(0)
  })

  it('matches digits on e.code, and numpad digits only while they type the digit', () => {
    expect(q('Digit3', { key: '3', code: 'Digit3' })).toBe(2)
    expect(q('Digit3', { key: '3', code: 'Numpad3' })).toBe(2)
    expect(q('Digit1', { key: 'End', code: 'Numpad1' })).toBe(0)
    expect(q('End', { key: 'End', code: 'Numpad1' })).toBe(2)
    expect(q('Mod+Digit0', { key: '0', code: 'Digit0', ctrlKey: true })).toBe(2)
    expect(q('Mod+Digit0', { key: ')', code: 'Digit0', ctrlKey: true, shiftKey: true })).toBe(0)
  })

  it('matches named keys by key or code, Shift compared', () => {
    expect(q('Space', { key: ' ', code: 'Space' })).toBe(2)
    expect(q('Space', { key: ' ', code: 'Space', shiftKey: true })).toBe(0)
    expect(q('ArrowLeft', { key: 'ArrowLeft', code: 'ArrowLeft' })).toBe(2)
    expect(q('Shift+ArrowLeft', { key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: true })).toBe(2)
    expect(q('ArrowLeft', { key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: true })).toBe(0)
    expect(q('Alt+ArrowLeft', { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true })).toBe(2)
    expect(q('Shift+F3', { key: 'F3', code: 'F3', shiftKey: true })).toBe(2)
    expect(q('Escape', { key: 'Escape', code: 'Escape' })).toBe(2)
    expect(q('Enter', { key: 'Enter', code: 'NumpadEnter' })).toBe(2)
    expect(q('ContextMenu', { key: 'ContextMenu', code: 'ContextMenu' })).toBe(2)
  })

  it('ignores IME composition and lone modifiers', () => {
    expect(isInertKeyEvent(key({ key: 'k', code: 'KeyK', isComposing: true }))).toBe(true)
    expect(isInertKeyEvent(key({ key: 'Process', code: 'KeyK' }))).toBe(true)
    expect(isInertKeyEvent(key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))).toBe(true)
    expect(q('k', { key: 'k', code: 'KeyK', isComposing: true })).toBe(0)
    expect(matchesChord(parseChord('k'), key({ key: 'k', code: 'KeyK' }), WIN)).toBe(true)
  })
})

describe('focus guards', () => {
  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Record<string, string> = {},
    parent: Element = document.body,
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag)
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
    parent.append(node)
    return node
  }

  it('detects editable targets (rule 2)', () => {
    expect(isEditableTarget(el('input'))).toBe(true)
    expect(isEditableTarget(el('input', { type: 'search' }))).toBe(true)
    expect(isEditableTarget(el('input', { type: 'checkbox' }))).toBe(false)
    expect(isEditableTarget(el('input', { type: 'range' }))).toBe(false)
    expect(isEditableTarget(el('textarea'))).toBe(true)
    expect(isEditableTarget(el('select'))).toBe(true)
    const editor = el('div', { contenteditable: 'true' })
    expect(isEditableTarget(el('span', {}, editor))).toBe(true)
    expect(isEditableTarget(el('div', { contenteditable: 'false' }))).toBe(false)
    expect(isEditableTarget(el('button'))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget(window)).toBe(false)
  })

  it('guards widgets and their contents (rule 3)', () => {
    expect(widgetGuardBlocks(el('button'))).toBe(true)
    expect(widgetGuardBlocks(el('span', {}, el('button')))).toBe(true)
    expect(widgetGuardBlocks(el('a', { href: '#x' }))).toBe(true)
    expect(widgetGuardBlocks(el('a'))).toBe(false)
    expect(widgetGuardBlocks(el('div', { role: 'slider', tabindex: '0' }))).toBe(true)
    expect(widgetGuardBlocks(el('div', { role: 'menuitem' }))).toBe(true)
    expect(widgetGuardBlocks(el('div', { 'data-qd-keys': 'own' }))).toBe(true)
    expect(widgetGuardBlocks(el('div', { tabindex: '0' }))).toBe(false)
  })

  it('lets shortcuts run on body, main.canvas and the Mushaf roving items', () => {
    expect(widgetGuardBlocks(document.body)).toBe(false)
    expect(widgetGuardBlocks(document.documentElement)).toBe(false)
    expect(widgetGuardBlocks(el('main', { class: 'canvas', role: 'grid' }))).toBe(false)
    const list = el('ul', { class: 'mp-a11y', role: 'listbox' })
    const item = el('li', { role: 'option', tabindex: '0' }, list)
    expect(widgetGuardBlocks(item)).toBe(false)
    // A widget inside a roving item still owns its keys.
    expect(widgetGuardBlocks(el('button', {}, item))).toBe(true)
    expect(widgetGuardBlocks(null)).toBe(false)
  })

  it('applies the guard to plain and Shift-only chords except Escape and function keys', () => {
    for (const chord of ['k', 'Shift+b', 'Digit1', '?', 'Space', 'Enter', 'ArrowLeft', 'Home', 'ContextMenu'])
      expect(isGuardedChord(parseChord(chord)), chord).toBe(true)
    expect(isGuardedChord(parseChord('Shift+F10'))).toBe(true)
    for (const chord of ['Mod+k', 'Alt+ArrowLeft', 'Mod+Shift+d', 'Escape', 'F3', 'Shift+F3', 'F6', 'F11'])
      expect(isGuardedChord(parseChord(chord)), chord).toBe(false)
  })
})

describe('formatChord', () => {
  const win = { isMac: false }
  const mac = { isMac: true }

  it('prints Windows/Linux chords with Ctrl, Alt, Shift', () => {
    expect(formatChord(parseChord('Mod+k'), win)).toBe('Ctrl+K')
    expect(formatChord(parseChord('Mod+Shift+d'), win)).toBe('Ctrl+Shift+D')
    expect(formatChord(parseChord('Alt+ArrowRight'), win)).toBe('Alt+→')
    expect(formatChord(parseChord('Mod+,'), win)).toBe('Ctrl+,')
    expect(formatChord(parseChord('Mod+Digit1'), win)).toBe('Ctrl+1')
    expect(formatChord(parseChord('?'), win)).toBe('?')
    expect(formatChord(parseChord('F11'), win)).toBe('F11')
  })

  it('prints macOS chords with symbols in Apple order', () => {
    expect(formatChord(parseChord('Mod+k'), mac)).toBe('⌘K')
    expect(formatChord(parseChord('Mod+Shift+d'), mac)).toBe('⇧⌘D')
    expect(formatChord(parseChord('Mod+Ctrl+f'), mac)).toBe('⌃⌘F')
    expect(formatChord(parseChord('Alt+ArrowLeft'), mac)).toBe('⌥←')
  })

  it('spells named keys through the dictionary and labels physical keys from the layout map', () => {
    const keyLabel = (k: string) => `<${k}>`
    expect(formatChord(parseChord('Space'), { ...win, keyLabel })).toBe('<space>')
    expect(formatChord(parseChord('PageDown'), win)).toBe('Page Down')
    expect(formatChord(parseChord('Escape'), win)).toBe('Esc')
    const german = new Map([['Equal', '´']])
    expect(formatChord(parseChord('Mod+Shift+='), { ...win, layoutMap: german })).toBe('Ctrl+Shift+´')
    expect(formatChord(parseChord('Mod+Shift+='), win)).toBe('Ctrl+Shift+=')
    // Character chords print the character whatever the layout.
    expect(formatChord(parseChord('['), { ...win, layoutMap: new Map([['BracketLeft', 'ج']]) })).toBe('[')
  })
})

describe('installShortcutListeners', () => {
  it('runs the capture listener before element handlers and the bubble listener after them', () => {
    const order: string[] = []
    const button = document.createElement('button')
    document.body.append(button)
    button.addEventListener('keydown', () => order.push('element'))
    const uninstall = installShortcutListeners({
      capture: () => order.push('capture'),
      bubble: () => order.push('bubble'),
    })
    button.dispatchEvent(key({ key: 'k', code: 'KeyK' }))
    expect(order).toEqual(['capture', 'element', 'bubble'])
    uninstall()
    order.length = 0
    button.dispatchEvent(key({ key: 'k', code: 'KeyK' }))
    expect(order).toEqual(['element'])
  })

  it('passes the keyboard event itself', () => {
    const capture = vi.fn()
    const uninstall = installShortcutListeners({ capture, bubble: () => {} })
    const e = key({ key: 'x', code: 'KeyX' })
    document.body.dispatchEvent(e)
    expect(capture).toHaveBeenCalledWith(e)
    uninstall()
  })
})
