/**
 * `settings` store (§7.3, §9.1, §9.6): the typed `Settings`, its optimistic round trip through `settings_set`, the
 * resolved theme values and the document-level effects. Owner: WP0E → WP7c. Layer L0 (imports `app` only).
 *
 * - Fields are read and written by their generated camelCase names (§0.2): `settings.value.followAlong`,
 *   `settings.update({ inkBrightnessPct: 80 })`. `update` merges top-level keys, so nested objects (`sidebar`,
 *   `sidePane`, `copy`, `gap`) are passed whole: `update({ sidebar: { ...settings.value.sidebar, open: false } })`.
 * - `value` is immutable (`$state.raw`; frozen in development): an in-place mutation would never persist.
 * - Writes are serialised and coalesced: one `settings_set` is in flight at a time, and every patch made meanwhile
 *   rides on the next one with the whole current value. The validated result is adopted once nothing newer is queued.
 *   A failed write reverts to the last confirmed value, cancels the writes queued behind it and reports the error
 *   (a toast once `ui` is initialised); the returned promise then resolves `false` (it never rejects).
 * - The §7.3 "reset to defaults" is `resetToDefaults()`, because `reset()` is the §7.9 store contract.
 */
import { defaultSettings } from '$lib/contracts/settings'
import type { ResolvedTheme, Store } from '$lib/contracts/stores'
import { api, call, events, isIpcError } from '$lib/ipc'
import type { Bootstrap, ChromeAppearance, Settings } from '$lib/ipc/bindings'
import { app, listenEvent } from './app.svelte'

const QUERY_DARK = '(prefers-color-scheme: dark)'
const QUERY_REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
const QUERY_REDUCED_TRANSPARENCY = '(prefers-reduced-transparency: reduce)'

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** A private, plain (non-proxy) copy; frozen in development so accidental mutation throws at the culprit. */
function own(settings: Settings): Settings {
  const copy = $state.snapshot(settings) as Settings
  return import.meta.env.DEV ? deepFreeze(copy) : copy
}

function sameSettings(a: Settings, b: Settings): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Fields `settings_reset` keeps (WP2b, `RESET_PRESERVED_KEYS` in user.db): the UI language and what the app has already
 * shown or asked. Resetting them would switch the language under the user, rerun onboarding and replay every hint.
 */
export const RESET_PRESERVED = ['uiLanguage', 'onboardingDone', 'hintsSeen', 'closeToTrayAsked'] as const

/** The defaults with the `RESET_PRESERVED` fields of `current`: what `settings_reset` stores. */
export function resetValue(current: Settings): Settings {
  const kept: Pick<Settings, (typeof RESET_PRESERVED)[number]> = {
    uiLanguage: current.uiLanguage,
    onboardingDone: current.onboardingDone,
    hintsSeen: [...current.hintsSeen],
    closeToTrayAsked: current.closeToTrayAsked,
  }
  return { ...defaultSettings(), ...kept }
}

class SettingsStore implements Store {
  value = $state.raw<Settings>(own(defaultSettings()))
  /** The OS preferences behind `theme: system`, `motion: system` and the translucent chrome (live). */
  systemDark = $state(false)
  systemReducedMotion = $state(false)
  systemReducedTransparency = $state(false)

  readonly resolvedTheme: ResolvedTheme = $derived.by(() => {
    const { theme, lightVariant, darkVariant } = this.value
    if (theme === 'system') return this.systemDark ? darkVariant : lightVariant
    return theme
  })
  /** High contrast follows the OS light/dark preference (`data-hc`, §9.1). */
  readonly highContrastDark = $derived(this.resolvedTheme === 'high_contrast' && this.systemDark)
  readonly isDark = $derived(
    this.resolvedTheme === 'night' || this.resolvedTheme === 'black' || this.highContrastDark,
  )
  readonly dir: 'ltr' | 'rtl' = $derived(this.value.uiLanguage === 'ar' ? 'rtl' : 'ltr')
  readonly reducedMotion = $derived(
    this.value.motion === 'reduce' || (this.value.motion === 'system' && this.systemReducedMotion),
  )
  /** §11.2: UI numbers use Arabic-Indic digits. */
  readonly arabicDigits = $derived(
    this.value.digits === 'arabic_indic' || (this.value.digits === 'auto' && this.value.uiLanguage === 'ar'),
  )
  /**
   * The window cannot show a backdrop material (`window_set_chrome` answered `unsupported`: Windows 10, Linux, a
   * browser): the chrome stays opaque for the rest of the session.
   */
  chromeUnsupported = $state(false)
  /** Rust confirmed the translucent backdrop (`window_set_chrome` with `auto` succeeded) and it is still wanted. */
  chromeActive = $state(false)

  /**
   * §9.6: translucent chrome (Mica / macOS sidebar material) is wanted with `chromeEffect = auto`, the paper or night
   * theme, outside Linux, without reduced transparency, and while the window has not reported it unsupported.
   * `html[data-chrome="vibrant"]` (which makes the root transparent) follows only once Rust confirmed the effect
   * (`chromeActive`), so the chrome never composites over a backdrop that does not exist.
   */
  readonly vibrantChrome = $derived(
    !app.isLinux &&
      !this.chromeUnsupported &&
      this.value.chromeEffect === 'auto' &&
      (this.resolvedTheme === 'paper' || this.resolvedTheme === 'night') &&
      !this.systemReducedTransparency,
  )
  /** What `window_set_chrome` receives: the effect the frontend actually draws over (`off` when the chrome is opaque). */
  readonly chrome: ChromeAppearance = $derived({
    dark: this.isDark,
    effect: this.vibrantChrome ? this.value.chromeEffect : 'off',
  })

  /** The last value Rust confirmed (bootstrap, a successful write, or `SettingsChanged` while idle). */
  #confirmed: Settings = own(defaultSettings())
  #tail: Promise<unknown> = Promise.resolve()
  /** The queued (not yet started) `settings_set` that new patches join. */
  #queuedSend: Promise<boolean> | null = null
  /** Writes enqueued and not finished. */
  #pending = 0
  /** Bumped by a failed write: the writes queued behind it are skipped. */
  #generation = 0
  /** Bumped by `reset()`: writes still in flight from before it are ignored. */
  #epoch = 0
  #chromeSent: string | null = null
  /** Sequence of `window_set_chrome` calls: only the newest answer is applied. */
  #chromeSeq = 0
  #disposers: (() => void)[] = []
  #reportError: (e: unknown) => void = (e) => console.error('[qd] settings could not be saved', e)

  init(b: Bootstrap): void {
    this.#dispose()
    this.value = own(b.settings)
    this.#confirmed = this.value
    this.#watchMedia(QUERY_DARK, (m) => (this.systemDark = m))
    this.#watchMedia(QUERY_REDUCED_MOTION, (m) => (this.systemReducedMotion = m))
    this.#watchMedia(QUERY_REDUCED_TRANSPARENCY, (m) => (this.systemReducedTransparency = m))
    this.#disposers.push(listenEvent(events.settingsChanged, (next) => this.#external(next)))
    this.applyEffects()
  }

  /**
   * Optimistic update (§7.3): applies the patch at once, persists the whole value through `settings_set` and adopts the
   * validated result. Resolves `true` once saved, `false` when the write failed (already reverted and reported).
   */
  update(patch: Partial<Settings>): Promise<boolean> {
    this.#setLocal({ ...this.value, ...patch })
    if (this.#queuedSend !== null) return this.#queuedSend
    const send: Promise<boolean> = this.#enqueue(() => {
      // From here on, new patches queue the next write (this one sends the value as it is now).
      if (this.#queuedSend === send) this.#queuedSend = null
      return call(api.settingsSet(this.value))
    })
    this.#queuedSend = send
    return send
  }

  /**
   * Settings › Reset (`settings_reset`). Optimistic like `update`; later patches apply on top of the defaults. Like
   * the Rust reset (WP2b), it keeps the UI language and what the app has already shown or asked
   * (`RESET_PRESERVED`), so the UI never flips language or replays onboarding while the reply is on its way.
   */
  resetToDefaults(): Promise<boolean> {
    this.#setLocal(resetValue(this.value))
    this.#queuedSend = null
    return this.#enqueue(() => call(api.settingsReset()))
  }

  /** Where failed writes are reported; `ui` routes them to an error toast (it cannot be imported here: L0 order). */
  setErrorReporter(report: ((e: unknown) => void) | null): void {
    this.#reportError = report ?? ((e) => console.error('[qd] settings could not be saved', e))
  }

  /**
   * Writes the document-level effects (§7.3, §9.1, §9.6): `data-theme`, `data-hc`, `data-accent`, `data-motion`,
   * `data-chrome`, `lang`, `dir`, `--ink-alpha`, and sends `window_set_chrome` whenever the resolved appearance changed
   * (the frontend is the single chrome owner). UI scale is webview zoom applied by Rust (D27); the browser mock
   * approximates it with CSS zoom (§12.6).
   */
  applyEffects(): void {
    const html = document.documentElement
    const s = this.value
    html.dataset.theme = this.resolvedTheme
    if (this.resolvedTheme === 'high_contrast') html.dataset.hc = this.highContrastDark ? 'dark' : 'light'
    else delete html.dataset.hc
    html.dataset.accent = s.accent
    html.dataset.motion = this.reducedMotion ? 'reduce' : 'full'
    html.lang = s.uiLanguage
    html.dir = this.dir
    html.style.setProperty('--ink-alpha', String(s.inkBrightnessPct / 100))
    if (__MOCK_IPC__) {
      // The mock's UI scale (§12.6). Viewport units inside a zoomed root are zoomed too, so `--qd-mock-zoom` lets the
      // shell keep a `100vh` layout inside the window.
      html.style.zoom = s.uiScalePct === 100 ? '' : `${s.uiScalePct}%`
      if (s.uiScalePct === 100) html.style.removeProperty('--qd-mock-zoom')
      else html.style.setProperty('--qd-mock-zoom', String(s.uiScalePct / 100))
    }
    this.#applyChrome()
  }

  /**
   * The §9.6 chrome hand-off. Going opaque drops `data-chrome` at once (opaque chrome over a fading backdrop is fine);
   * going translucent waits for Rust to confirm the backdrop. An `unsupported` answer makes the chrome opaque for the
   * session and tells Rust once more with `effect: off` (it still learns the light/dark appearance); any other failure
   * is logged and retried on the next appearance change.
   */
  #applyChrome(): void {
    const chrome = this.chrome
    if (chrome.effect === 'off') this.chromeActive = false
    this.#writeChromeAttr()
    const key = `${chrome.dark}:${chrome.effect}`
    if (key === this.#chromeSent) return
    this.#chromeSent = key
    const seq = ++this.#chromeSeq
    const epoch = this.#epoch
    call(api.windowSetChrome(chrome)).then(
      () => {
        if (seq !== this.#chromeSeq || epoch !== this.#epoch) return
        this.chromeActive = chrome.effect === 'auto'
        this.#writeChromeAttr()
      },
      (e: unknown) => {
        if (seq !== this.#chromeSeq || epoch !== this.#epoch) return
        this.chromeActive = false
        this.#writeChromeAttr()
        if (chrome.effect !== 'off' && isIpcError(e) && e.kind === 'unsupported') {
          this.chromeUnsupported = true
          this.#applyChrome()
        } else {
          this.#chromeSent = null
          console.warn('[qd] window_set_chrome failed', e)
        }
      },
    )
  }

  #writeChromeAttr(): void {
    const html = document.documentElement
    if (this.vibrantChrome && this.chromeActive) html.dataset.chrome = 'vibrant'
    else delete html.dataset.chrome
  }

  reset(): void {
    this.#dispose()
    this.#epoch++
    this.#queuedSend = null
    this.#pending = 0
    this.#tail = Promise.resolve()
    this.value = own(defaultSettings())
    this.#confirmed = this.value
    this.systemDark = false
    this.systemReducedMotion = false
    this.systemReducedTransparency = false
    this.chromeUnsupported = false
    this.chromeActive = false
    this.#chromeSent = null
    this.#chromeSeq++
    this.setErrorReporter(null)
    const html = document.documentElement
    for (const attr of ['theme', 'hc', 'accent', 'motion', 'chrome']) delete html.dataset[attr]
    html.style.removeProperty('--ink-alpha')
    html.style.zoom = ''
  }

  #setLocal(next: Settings): void {
    this.value = own(next)
    this.applyEffects()
  }

  /**
   * Serialises a write (see the file comment). `#epoch` changes on `reset()` (a stale write then touches nothing);
   * `#generation` changes when a write fails (the writes queued behind it are skipped: their patches were reverted).
   */
  #enqueue(write: () => Promise<Settings>): Promise<boolean> {
    const epoch = this.#epoch
    const generation = this.#generation
    this.#pending++
    const run = async (): Promise<boolean> => {
      if (epoch !== this.#epoch) return false
      if (generation !== this.#generation) {
        this.#pending--
        return false
      }
      try {
        const saved = own(await write())
        if (epoch !== this.#epoch) return false
        this.#pending--
        this.#confirmed = saved
        // Adopt the validated value only when no newer patch waits to be written.
        if (this.#pending === 0 && !sameSettings(saved, this.value)) this.value = saved
        this.applyEffects()
        return true
      } catch (e) {
        if (epoch !== this.#epoch) return false
        this.#pending--
        this.#generation++
        this.#queuedSend = null
        this.value = this.#confirmed
        this.applyEffects()
        this.#reportError(e)
        return false
      }
    }
    const result = this.#tail.then(run)
    this.#tail = result
    return result
  }

  /** `SettingsChanged` (§5.14): adopt changes made elsewhere (tray, another window) while no write of ours is pending. */
  #external(next: Settings): void {
    if (this.#pending > 0) return
    const value = own(next)
    this.#confirmed = value
    if (!sameSettings(value, this.value)) {
      this.value = value
      this.applyEffects()
    }
  }

  #watchMedia(query: string, apply: (matches: boolean) => void): void {
    if (typeof matchMedia !== 'function') return
    const list = matchMedia(query)
    apply(list.matches)
    const onChange = (e: MediaQueryListEvent) => {
      apply(e.matches)
      this.applyEffects()
    }
    list.addEventListener('change', onChange)
    this.#disposers.push(() => list.removeEventListener('change', onChange))
  }

  #dispose(): void {
    for (const dispose of this.#disposers.splice(0)) dispose()
  }
}

export const settings = new SettingsStore()
