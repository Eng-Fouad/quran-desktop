/**
 * `app` store: bootstrap data, platform, connectivity, startup notices and the fatal screen.
 * Layer L0 and the base of the store graph: it imports no other store.
 */
import type { Store } from '$lib/contracts/stores'
import { api, call, events, toAppError, type AppErrorKind } from '$lib/ipc'
import type { AppInfo, Bootstrap, StartupNotice } from '$lib/ipc/bindings'

/** What `info` holds before bootstrap (and after a failed one). */
const UNKNOWN_APP: AppInfo = {
  name: 'Quran',
  version: '',
  identifier: 'com.quran.labs.desktop',
  platform: 'windows',
  arch: '',
  osVersion: '',
  osLocale: null,
  webviewVersion: 'unknown',
  dataDir: '',
  logDir: '',
  protocolBase: '',
  fontTransport: 'url',
  debug: false,
  testMode: false,
  core: { schemaVersion: 0, normalizerVersion: 0, source: 'unavailable', builtAt: '' },
}

/** The fatal screens: core.db missing (debug), no backend (browser preview), anything else. */
export type FatalReason = 'core_missing' | 'no_backend' | 'error'

/**
 * How long a quit waits for the `beforeQuit` work (the stores' pending writes) before it quits anyway. Rust's own
 * fallback (`window::QUIT_GRACE`, 1.5 s) is longer, and the window is hidden meanwhile.
 */
export const QUIT_FLUSH_MS = 800

/** Work that must reach Rust before the app exits; what it returns is awaited (`AppStore.beforeQuit`). */
export type QuitHook = () => unknown

/** Whether commands can reach a backend: the Tauri webview, or the browser mock. */
export function hasIpc(): boolean {
  return __MOCK_IPC__ || (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window)
}

/** The part of a generated tauri-specta event (`events.x`) that `listenEvent` uses. */
export interface TypedEvent<T> {
  listen(handler: (event: { payload: T }) => void): Promise<() => void>
}

/**
 * Subscribes to a backend event and returns a synchronous unsubscribe. `listen` resolves asynchronously, so an
 * unsubscribe that runs first still detaches the listener once it exists; a failed `listen` (no IPC) is logged, never
 * thrown. Stores call this in `init` and the returned function in `reset`.
 */
export function listenEvent<T>(event: TypedEvent<T>, handler: (payload: T) => void): () => void {
  let active = true
  let unlisten: (() => void) | null = null
  event
    .listen((e) => {
      if (active) handler(e.payload)
    })
    .then(
      (fn) => {
        if (active) unlisten = fn
        else fn()
      },
      (err: unknown) => console.warn('[qd] could not listen to a backend event', err),
    )
  return () => {
    active = false
    unlisten?.()
    unlisten = null
  }
}

class AppStore implements Store {
  /** `markReady()` ran: the first frame is painted and Rust was asked to show the window. */
  ready = $state(false)
  info = $state.raw<AppInfo>(UNKNOWN_APP)
  /** Network reachability as Rust sees it (`NetworkChanged`: reachability or `networkAllowed`). */
  online = $state(true)
  firstRun = $state(false)
  /** The bootstrap failure shown by `FatalScreen` (the developer message; `fatalKind` selects the copy). */
  fatal = $state<string | null>(null)
  fatalKind = $state<AppErrorKind | null>(null)
  notices = $state.raw<StartupNotice[]>([])

  readonly platform = $derived(this.info.platform)
  readonly isWindows = $derived(this.platform === 'windows')
  readonly isMac = $derived(this.platform === 'macos')
  readonly isLinux = $derived(this.platform === 'linux')
  readonly protocolBase = $derived(this.info.protocolBase)
  readonly testMode = $derived(this.info.testMode)
  /**
   * Which fatal screen to show: the debug build without core.db (`app_bootstrap` → `NotFound("core.db missing …")`),
   * a browser preview of a production build (no IPC at all), or any other bootstrap failure.
   */
  readonly fatalReason: FatalReason | null = $derived.by(() => {
    if (this.fatal === null) return null
    if (this.fatalKind === 'not_found' && /core\.db/i.test(this.fatal)) return 'core_missing'
    if (this.fatalKind === 'unsupported' && !hasIpc()) return 'no_backend'
    return 'error'
  })

  #unlisten: (() => void) | null = null
  #unlistenQuit: (() => void) | null = null
  #quitHooks = new Set<QuitHook>()
  #quitting: Promise<void> | null = null

  init(b: Bootstrap): void {
    this.#unlisten?.()
    this.info = b.app
    this.online = b.online
    this.firstRun = b.firstRun
    this.notices = b.notices
    this.fatal = null
    this.fatalKind = null
    // Platform-specific styles key off this (no translucency on Linux; the title bar per OS).
    document.documentElement.dataset.platform = b.app.platform
    this.#unlisten = listenEvent(events.networkChanged, ({ online }) => {
      this.online = online
    })
  }

  /** Bootstrap failed: show the fatal screen. `main.ts` still mounts the app and calls `markReady()`. */
  failBootstrap(e: unknown): void {
    const err = toAppError(e)
    this.fatal = err.message
    this.fatalKind = err.kind
  }

  /**
   * After the first paint (double rAF), tells Rust to show the window (`window_ready`). Idempotent. Before that
   * it subscribes to `quit-requested`, also on the fatal screen: `window_ready` tells Rust a page now answers a quit.
   */
  markReady(): void {
    if (this.ready) return
    this.ready = true
    // Without IPC (a browser preview of a production build) there is no window to show and nothing to quit.
    if (hasIpc()) this.#unlistenQuit = listenEvent(events.quitRequested, () => void this.quit())
    const ready = (): void => {
      if (!hasIpc()) return
      call(api.windowReady()).catch((e: unknown) => console.error('[qd] window_ready failed', e))
    }
    // A hidden document gets no animation frames: WKWebView (macOS) reports its hidden window as hidden, so the double
    // rAF would wait for Rust's show fallback (3 s). Lay out now and ask to be shown; WebKit paints as the window appears.
    if (document.visibilityState === 'hidden') {
      void document.documentElement.offsetHeight
      setTimeout(ready, 0)
      return
    }
    requestAnimationFrame(() => requestAnimationFrame(ready))
  }

  /**
   * Registers work that must reach Rust before the app exits: a write still waiting for its debounce (the reading and
   * recitation positions, the history dwell, a note draft) and the writes on their way. `quit()` runs every hook and
   * waits for what each returns. Returns the unregister (stores call this in `init` and the result in `reset`).
   */
  beforeQuit(hook: QuitHook): () => void {
    this.#quitHooks.add(hook)
    return () => {
      this.#quitHooks.delete(hook)
    }
  }

  /**
   * Quits the app: saves what the stores still hold (`beforeQuit`, at most `QUIT_FLUSH_MS`), then `app_quit` (stops
   * audio, closes the databases, exits). Rust asks for it when the user quits (`quit-requested`: the window's ×, the
   * tray's Quit, a close from the taskbar), with the window already hidden; the fatal screen's Quit calls it directly.
   * A call while one runs joins it. A failure is logged, never thrown.
   */
  quit(): Promise<void> {
    if (!hasIpc()) return Promise.resolve()
    this.#quitting ??= this.#quit().finally(() => {
      this.#quitting = null
    })
    return this.#quitting
  }

  async #quit(): Promise<void> {
    const pending = [...this.#quitHooks].map(async (hook) => hook())
    let timer: ReturnType<typeof setTimeout> | undefined
    const cap = new Promise<'cap'>((resolve) => (timer = setTimeout(() => resolve('cap'), QUIT_FLUSH_MS)))
    const settled = await Promise.race([Promise.allSettled(pending), cap])
    clearTimeout(timer)
    if (settled === 'cap')
      console.warn(`[qd] quitting without waiting longer than ${QUIT_FLUSH_MS} ms for pending writes`)
    else
      for (const r of settled)
        if (r.status === 'rejected') console.warn('[qd] a pending write failed before quitting', r.reason)
    try {
      await call(api.appQuit())
    } catch (e) {
      console.error('[qd] app_quit failed', e)
    }
  }

  /** Reveals the data folder in the file manager (user.db, the kept copy of a recovered library, `backups/`). */
  async revealDataDir(): Promise<void> {
    await call(api.systemRevealDataDir())
  }

  /** Removes a startup notice the user dismissed (the startup banner); there is at most one notice per type. */
  dismissNotice(notice: StartupNotice): void {
    this.notices = this.notices.filter((n) => n.type !== notice.type)
  }

  reset(): void {
    this.#unlisten?.()
    this.#unlisten = null
    this.#unlistenQuit?.()
    this.#unlistenQuit = null
    this.#quitHooks.clear()
    this.#quitting = null
    this.ready = false
    this.info = UNKNOWN_APP
    this.online = true
    this.firstRun = false
    this.fatal = null
    this.fatalKind = null
    this.notices = []
    delete document.documentElement.dataset.platform
  }
}

export const app = new AppStore()
