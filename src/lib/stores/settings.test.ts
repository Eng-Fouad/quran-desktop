import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '$lib/contracts/settings'
import { api, call, events, initIpc } from '$lib/ipc'
import type { Bootstrap, Platform, Settings } from '$lib/ipc/bindings'
import { mockCommands } from '$lib/ipc/mock'
import { err, ok } from '$lib/ipc/mock/result'
import { state } from '$lib/ipc/mock/state'
import { app } from './app.svelte'
import { i18n } from './i18n.svelte'
import { RESET_PRESERVED, resetValue, settings } from './settings.svelte'
import { ui } from './ui.svelte'

/** The OS preferences `matchMedia` reports, and a way to flip one live. */
const media = new Map<string, { matches: boolean; listeners: Set<(e: MediaQueryListEvent) => void> }>()

function stubMatchMedia(prefs: Record<string, boolean>): void {
  media.clear()
  vi.stubGlobal('matchMedia', (query: string) => {
    let entry = media.get(query)
    if (!entry) media.set(query, (entry = { matches: prefs[query] ?? false, listeners: new Set() }))
    const e = entry
    return {
      get matches() {
        return e.matches
      },
      media: query,
      addEventListener: (_: string, fn: (ev: MediaQueryListEvent) => void) => e.listeners.add(fn),
      removeEventListener: (_: string, fn: (ev: MediaQueryListEvent) => void) => e.listeners.delete(fn),
    }
  })
}

function flipMedia(query: string, matches: boolean): void {
  const entry = media.get(query)
  if (!entry) throw new Error(`no listener for ${query}`)
  entry.matches = matches
  for (const fn of entry.listeners) fn({ matches } as MediaQueryListEvent)
}

const DARK = '(prefers-color-scheme: dark)'

/**
 * Boots on an explicit platform. The browser mock reads the platform from the user agent, and jsdom's names the host OS
 * (`(darwin)` and `(win32)` read as Windows, `(linux)` as Linux, where the app never asks for a backdrop).
 */
async function boot(stored?: Partial<Settings>, platform: Platform = 'windows'): Promise<Bootstrap> {
  localStorage.clear()
  await initIpc()
  state.resetAll()
  state.loadAll()
  if (stored) state.settings.set({ ...defaultSettings(), ...stored })
  const fetched = await call(api.appBootstrap())
  const b = { ...fetched, app: { ...fetched.app, platform } }
  app.init(b)
  settings.init(b)
  return b
}

const html = () => document.documentElement

beforeEach(() => {
  stubMatchMedia({})
})

afterEach(() => {
  ui.reset()
  settings.reset()
  app.reset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('settings store: init and effects', () => {
  it('takes the bootstrap value and writes the document effects', async () => {
    await boot()
    expect(settings.value).toEqual(defaultSettings())
    expect(settings.resolvedTheme).toBe('paper')
    expect(html().dataset.theme).toBe('paper')
    expect(html().dataset.accent).toBe('teal')
    expect(html().dataset.motion).toBe('full')
    expect(html().dataset.hc).toBeUndefined()
    expect(html().lang).toBe('en')
    expect(html().dir).toBe('ltr')
    expect(html().style.getPropertyValue('--ink-alpha')).toBe('0.88')
  })

  it('resolves `system` through the OS preference, live', async () => {
    stubMatchMedia({ [DARK]: true })
    await boot({ darkVariant: 'black' })
    expect(settings.resolvedTheme).toBe('black')
    expect(settings.isDark).toBe(true)
    expect(html().dataset.theme).toBe('black')
    flipMedia(DARK, false)
    expect(settings.resolvedTheme).toBe('paper')
    expect(html().dataset.theme).toBe('paper')
  })

  it('gives high contrast the OS light/dark (data-hc)', async () => {
    stubMatchMedia({ [DARK]: true })
    await boot({ theme: 'high_contrast' })
    expect(html().dataset.theme).toBe('high_contrast')
    expect(html().dataset.hc).toBe('dark')
    expect(settings.isDark).toBe(true)
    flipMedia(DARK, false)
    expect(html().dataset.hc).toBe('light')
  })

  it('follows motion, digits and the UI language', async () => {
    stubMatchMedia({ '(prefers-reduced-motion: reduce)': true })
    await boot({ uiLanguage: 'ar' })
    expect(settings.reducedMotion).toBe(true)
    expect(html().dataset.motion).toBe('reduce')
    expect(settings.dir).toBe('rtl')
    expect(html().dir).toBe('rtl')
    expect(html().lang).toBe('ar')
    expect(settings.arabicDigits).toBe(true)
    await settings.update({ digits: 'latin' })
    expect(settings.arabicDigits).toBe(false)
    await settings.update({ motion: 'full' })
    expect(html().dataset.motion).toBe('full')
  })

  it('sends window_set_chrome only when the drawn appearance changes', async () => {
    // A window that has the backdrop (Windows 11): every request succeeds.
    const chrome = vi.spyOn(mockCommands, 'windowSetChrome').mockImplementation(async () => ok(null))
    await boot()
    expect(chrome).toHaveBeenLastCalledWith({ dark: false, effect: 'auto' })
    // Translucent only once Rust confirmed the backdrop.
    expect(html().dataset.chrome).toBeUndefined()
    await vi.waitFor(() => expect(html().dataset.chrome).toBe('vibrant'))
    expect(settings.chromeActive).toBe(true)
    await settings.update({ accent: 'rose' })
    expect(chrome).toHaveBeenCalledTimes(1)
    // Sepia is opaque chrome: `data-chrome` goes at once, then the window effect goes off.
    const sepia = settings.update({ theme: 'sepia' })
    expect(html().dataset.chrome).toBeUndefined()
    await sepia
    expect(chrome).toHaveBeenLastCalledWith({ dark: false, effect: 'off' })
    await settings.update({ theme: 'night' })
    expect(chrome).toHaveBeenLastCalledWith({ dark: true, effect: 'auto' })
    await vi.waitFor(() => expect(html().dataset.chrome).toBe('vibrant'))
    await settings.update({ chromeEffect: 'off' })
    expect(chrome).toHaveBeenLastCalledWith({ dark: true, effect: 'off' })
    expect(html().dataset.chrome).toBeUndefined()
    expect(chrome).toHaveBeenCalledTimes(4)
  })

  it('keeps the chrome opaque for the session when the window has no backdrop', async () => {
    // The browser mock answers like Windows 10: `unsupported` for a translucent effect.
    const chrome = vi.spyOn(mockCommands, 'windowSetChrome')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await boot()
    await vi.waitFor(() => expect(settings.chromeUnsupported).toBe(true))
    expect(settings.vibrantChrome).toBe(false)
    expect(html().dataset.chrome).toBeUndefined()
    // Rust still learns the appearance, once, with the effect off; nothing is logged for an expected answer.
    await vi.waitFor(() => expect(chrome).toHaveBeenLastCalledWith({ dark: false, effect: 'off' }))
    expect(chrome).toHaveBeenCalledTimes(2)
    await settings.update({ theme: 'night' })
    expect(chrome).toHaveBeenLastCalledWith({ dark: true, effect: 'off' })
    expect(warn).not.toHaveBeenCalled()
    // Another failure is logged and retried on the next change.
    chrome.mockImplementationOnce(async () => err('internal', 'no window'))
    await settings.update({ theme: 'paper' })
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    await settings.update({ theme: 'paper', accent: 'blue' })
    await settings.update({ theme: 'sepia' })
    expect(chrome).toHaveBeenLastCalledWith({ dark: false, effect: 'off' })
  })

  it('never uses translucent chrome on Linux or with reduced transparency', async () => {
    // Not even with a window that would take the backdrop: Rust is only ever asked for opaque chrome.
    const chrome = vi.spyOn(mockCommands, 'windowSetChrome').mockImplementation(async () => ok(null))
    const b = await boot(undefined, 'linux')
    expect(settings.vibrantChrome).toBe(false)
    await settings.update({ theme: 'night' })
    expect(chrome.mock.calls).toEqual([[{ dark: false, effect: 'off' }], [{ dark: true, effect: 'off' }]])
    expect(html().dataset.chrome).toBeUndefined()
    app.init({ ...b, app: { ...b.app, platform: 'windows' } })
    stubMatchMedia({ '(prefers-reduced-transparency: reduce)': true })
    settings.init(b)
    expect(settings.vibrantChrome).toBe(false)
    expect(chrome).toHaveBeenLastCalledWith({ dark: false, effect: 'off' })
  })

  it('freezes the value in development, so a mutation cannot silently skip persistence', async () => {
    await boot()
    expect(() => {
      ;(settings.value as { uiScalePct: number }).uiScalePct = 150
    }).toThrow(TypeError)
    expect(() => settings.value.translations.push('x')).toThrow(TypeError)
  })
})

describe('settings store: update round trip', () => {
  it('applies a patch at once and persists the validated value', async () => {
    await boot()
    const p = settings.update({ uiScalePct: 205, theme: 'night' })
    expect(settings.value.uiScalePct).toBe(205)
    expect(html().dataset.theme).toBe('night')
    await expect(p).resolves.toBe(true)
    expect(settings.value.uiScalePct).toBe(200)
    expect(state.settings.value.uiScalePct).toBe(200)
    expect(state.settings.value.theme).toBe('night')
  })

  it('coalesces patches into one write per round trip, in order', async () => {
    await boot()
    const set = vi.spyOn(mockCommands, 'settingsSet')
    const a = settings.update({ accent: 'blue' })
    const b = settings.update({ zoomPct: 150 })
    const c = settings.update({ sidebar: { ...settings.value.sidebar, open: false } })
    expect(a).toBe(b)
    expect(b).toBe(c)
    await a
    expect(set).toHaveBeenCalledTimes(1)
    expect(set.mock.calls[0]?.[0]).toMatchObject({ accent: 'blue', zoomPct: 150, sidebar: { open: false } })

    // A patch made while a write is in flight rides on the next write and is not undone by the first answer.
    const first = settings.update({ accent: 'amber' })
    await Promise.resolve()
    const second = settings.update({ accent: 'indigo' })
    expect(second).not.toBe(first)
    await first
    expect(settings.value.accent).toBe('indigo')
    await second
    expect(set).toHaveBeenCalledTimes(3)
    expect(settings.value.accent).toBe('indigo')
    expect(state.settings.value.accent).toBe('indigo')
  })

  it('reverts and reports a failed write, skipping the writes queued behind it', async () => {
    await boot()
    const reported: unknown[] = []
    settings.setErrorReporter((e) => reported.push(e))
    vi.spyOn(mockCommands, 'settingsSet').mockImplementationOnce(async () =>
      err('database', 'disk I/O error'),
    )
    const failing = settings.update({ accent: 'rose' })
    await Promise.resolve()
    const queued = settings.update({ zoomPct: 120 })
    await expect(failing).resolves.toBe(false)
    await expect(queued).resolves.toBe(false)
    expect(settings.value.accent).toBe('teal')
    expect(settings.value.zoomPct).toBe(100)
    expect(html().dataset.accent).toBe('teal')
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject({ kind: 'database' })
    // The store recovers: the next write goes through.
    await expect(settings.update({ zoomPct: 130 })).resolves.toBe(true)
    expect(state.settings.value.zoomPct).toBe(130)
  })

  it('reports failures as a localised error toast once ui is initialised', async () => {
    const b = await boot()
    i18n.init(b)
    ui.init(b)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(mockCommands, 'settingsSet').mockImplementationOnce(async () => err('io', 'denied'))
    await settings.update({ zoomPct: 140 })
    expect(ui.toasts.at(-1)).toMatchObject({ message: i18n.t('errors.io'), tone: 'danger' })
  })

  it('resets to the defaults optimistically; later patches apply on top', async () => {
    await boot({ theme: 'night', zoomPct: 180 })
    expect(settings.value.theme).toBe('night')
    const reset = settings.resetToDefaults()
    const after = settings.update({ accent: 'emerald' })
    expect(settings.value.theme).toBe('system')
    await reset
    await after
    expect(settings.value).toEqual({ ...defaultSettings(), accent: 'emerald' })
    expect(state.settings.value).toEqual({ ...defaultSettings(), accent: 'emerald' })
  })

  it('keeps the UI language and what was already shown or asked across a reset, like user.db', async () => {
    const kept: Pick<Settings, 'uiLanguage' | 'onboardingDone' | 'hintsSeen' | 'closeToTrayAsked'> = {
      uiLanguage: 'ar',
      onboardingDone: true,
      hintsSeen: ['page_turn'],
      closeToTrayAsked: true,
    }
    await boot({ ...kept, theme: 'night', accent: 'rose' })
    const reset = settings.resetToDefaults()
    // Optimistically too: the UI never flips to English or reopens onboarding while the reply is on its way.
    expect(settings.value).toEqual({ ...defaultSettings(), ...kept })
    expect(html().lang).toBe('ar')
    await reset
    expect(settings.value).toEqual({ ...defaultSettings(), ...kept })
    expect(state.settings.value).toEqual({ ...defaultSettings(), ...kept })
    expect(resetValue(settings.value)).toEqual(settings.value)
    expect(RESET_PRESERVED).toEqual(['uiLanguage', 'onboardingDone', 'hintsSeen', 'closeToTrayAsked'])
  })

  it('adopts SettingsChanged from elsewhere while idle', async () => {
    await boot()
    await events.settingsChanged.emit({ ...defaultSettings(), theme: 'sepia', uiLanguage: 'ar' })
    expect(settings.value.theme).toBe('sepia')
    expect(html().dataset.theme).toBe('sepia')
    expect(html().dir).toBe('rtl')
  })

  it('ignores SettingsChanged while its own write is pending', async () => {
    await boot()
    const p = settings.update({ accent: 'amber' })
    await events.settingsChanged.emit({ ...defaultSettings(), accent: 'blue' })
    expect(settings.value.accent).toBe('amber')
    await p
    expect(settings.value.accent).toBe('amber')
  })

  it('reset() returns to the defaults, stops listening and clears the document', async () => {
    await boot({ theme: 'night' })
    settings.reset()
    expect(settings.value).toEqual(defaultSettings())
    expect(html().dataset.theme).toBeUndefined()
    await events.settingsChanged.emit({ ...defaultSettings(), theme: 'black' })
    expect(settings.value.theme).toBe('system')
  })
})
