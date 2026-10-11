/**
 * Audio shortcuts (§10.1; WP9a): every chord parses and matches its key on US and Arabic layouts, the definitions are
 * global and in the audio group, registration is reference-counted, and Space's idle target follows the selection, else
 * the first ayah of the visible page (Mushaf mode) or the verse at the top of the view (translation mode).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, call, initIpc } from '$lib/ipc'
import { state } from '$lib/ipc/mock/state'
import { app } from '$lib/stores/app.svelte'
import { quran } from '$lib/stores/quran.svelte'
import { reader } from '$lib/stores/reader.svelte'
import { settings } from '$lib/stores/settings.svelte'
import { shortcuts } from '$lib/stores/shortcuts.svelte'
import { translations } from '$lib/stores/translations.svelte'
import { ui } from '$lib/stores/ui.svelte'
import { audioShortcut, audioShortcuts, idleTarget, registerAudioShortcuts } from './audio'
import { matchesChord, parseChord } from './index'

function key(init: KeyboardEventInit & { key: string; code: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', init)
}

const US: Record<string, KeyboardEvent> = {
  'audio.playPause': key({ key: ' ', code: 'Space' }),
  'audio.nextAyah': key({ key: '.', code: 'Period' }),
  'audio.prevAyah': key({ key: ',', code: 'Comma' }),
  'audio.seekForward': key({ key: '>', code: 'Period', shiftKey: true }),
  'audio.seekBack': key({ key: '<', code: 'Comma', shiftKey: true }),
  'audio.repeat': key({ key: 'r', code: 'KeyR' }),
  'audio.abLoop': key({ key: 'l', code: 'KeyL' }),
  'audio.faster': key({ key: ']', code: 'BracketRight' }),
  'audio.slower': key({ key: '[', code: 'BracketLeft' }),
  'audio.muchFaster': key({ key: '}', code: 'BracketRight', shiftKey: true }),
  'audio.muchSlower': key({ key: '{', code: 'BracketLeft', shiftKey: true }),
  'audio.normalSpeed': key({ key: '\\', code: 'Backslash' }),
  'audio.mute': key({ key: 'm', code: 'KeyM' }),
  'audio.stop': key({ key: '>', code: 'Period', shiftKey: true, ctrlKey: true }),
}

beforeEach(async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  localStorage.clear()
  await initIpc()
  state.resetAll()
  state.loadAll()
  const b = await call(api.appBootstrap())
  app.init(b)
  settings.init(b)
  quran.init(b)
  ui.init(b)
  shortcuts.init(b)
  reader.init(b)
})

afterEach(() => {
  translations.topAyahId = null
  reader.reset()
  shortcuts.reset()
  ui.reset()
  quran.reset()
  settings.reset()
  app.reset()
  vi.unstubAllGlobals()
})

describe('audio shortcut definitions (§10.1)', () => {
  it('covers the fourteen audio rows, all global and in the audio group', () => {
    expect(audioShortcuts.map((d) => d.id).sort()).toEqual(Object.keys(US).sort())
    for (const d of audioShortcuts) {
      expect(d.group).toBe('audio')
      expect(d.scope).toBe('global')
      expect(d.labelKey.startsWith('shortcuts.audio.')).toBe(true)
    }
  })

  it('every chord matches its US key, and the letters match by code on an Arabic layout', () => {
    for (const [id, e] of Object.entries(US)) {
      const def = audioShortcut(id)
      expect(def, id).toBeDefined()
      expect(
        def?.keys.some((k) => matchesChord(parseChord(k), e, false)),
        id,
      ).toBe(true)
    }
    // Arabic layout: the key labelled ر/ق types an Arabic letter; R and L still work through `code`.
    const arR = key({ key: 'ق', code: 'KeyR' })
    expect(matchesChord(parseChord('r'), arR, false)).toBe(true)
    const arL = key({ key: 'م', code: 'KeyL' })
    expect(matchesChord(parseChord('l'), arL, false)).toBe(true)
    // Stop is Mod+Shift+. — never the plain `>` of seek.
    expect(matchesChord(parseChord('Mod+Shift+.'), US['audio.seekForward'] as KeyboardEvent, false)).toBe(
      false,
    )
  })

  it('registers once while any dock holds them (reference-counted)', () => {
    const before = shortcuts.defs.length
    const a = registerAudioShortcuts()
    const b = registerAudioShortcuts()
    expect(shortcuts.defs.length).toBe(before + audioShortcuts.length)
    a()
    a()
    expect(shortcuts.defs.length).toBe(before + audioShortcuts.length)
    b()
    expect(shortcuts.defs.length).toBe(before)
  })
})

describe('idleTarget (Space with nothing loaded, §10.1)', () => {
  it('is the first ayah of the first visible page without a selection', () => {
    reader.goToPage(3)
    const first = quran.pageRange(reader.layout, reader.visiblePages[0] ?? 3).from
    expect(idleTarget()).toEqual({ from: first })
  })

  it('in translation mode is the verse at the top of the view, not the Mushaf page above it', async () => {
    // 2:255 at the top of the translation view: its Mushaf page starts at 2:253, above it and off screen.
    const kursi = quran.ayahId(2, 255)
    reader.goToAyah(kursi)
    // The jump is asynchronous (it waits for the page's data).
    await vi.waitFor(() => expect(reader.visiblePages).toContain(quran.pageOfAyah(reader.layout, kursi)))
    expect(reader.cursorAyahId).toBe(kursi)
    const pageStart = quran.pageRange(reader.layout, reader.visiblePages[0] ?? reader.page).from
    expect(pageStart).toBeLessThan(kursi)
    await settings.update({ readingMode: 'translation' })
    // Before the view reports its top verse (laying out, or no translation installed yet): where it opens, the cursor.
    expect(reader.cursorAyahId).toBe(kursi)
    expect(idleTarget()).toEqual({ from: kursi })
    // Then the verse at the top of the view, wherever the reader scrolled.
    translations.topAyahId = kursi + 3
    expect(idleTarget()).toEqual({ from: kursi + 3 })
    translations.topAyahId = kursi
    // Back in the Mushaf the visible page's first ayah plays again.
    await settings.update({ readingMode: 'mushaf' })
    expect(idleTarget()).toEqual({ from: pageStart })
  })

  it('is the selection: one ayah, or the range it spans', () => {
    reader.selection = { fromAyahId: 255, toAyahId: 255, anchorAyahId: 255 }
    expect(idleTarget()).toEqual({ from: 255 })
    reader.selection = { fromAyahId: 257, toAyahId: 255, anchorAyahId: 257 }
    expect(idleTarget()).toEqual({ from: 255, to: 257 })
  })
})
