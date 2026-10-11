/**
 * The `window.__QD_TEST__` contract (§12.6), as types only. Owner: WP13a. Kept apart from `qdtest.ts` (which imports the
 * stores) so the Node-side harness (`tests/e2e/lib/types.d.ts`) can type scenarios against the same shapes without
 * pulling in the app.
 */
import type { OverlayKind, OverlayProps } from '$lib/contracts/overlays'
import type { Dock, ResolvedTheme } from '$lib/contracts/stores'
import type {
  AppView,
  commands,
  MushafLayout,
  MushafStyle,
  NavTarget,
  PlaybackStatus,
  PlayRequest,
  Settings,
} from '$lib/ipc/bindings'

/** The typed command object (`$lib/ipc` `Api`). */
export type QdApi = typeof commands

/** The data type a command resolves to (`settingsGet` → `Settings`). */
export type CommandData<K extends keyof QdApi> =
  Awaited<ReturnType<QdApi[K]>> extends { status: 'ok'; data: infer T } | { status: 'error' } ? T : never

/** §8.18 metrics, collected since install or the last `resetMetrics()`. */
export interface QdTestMetrics {
  /** Cumulative layout shift: the sum of `layout-shift` values not caused by recent input (budget: 0). */
  cls: number
  /** Long tasks (> 50 ms) on the main thread (budget during navigation: none). */
  longTasks: number
  /** Durations of the `performance.measure('qd:page')` entries, ms (budget: p95 < 16 ms). */
  pageRenderMs: number[]
  /** Average frame rate while audio plays, i.e. while the word highlight glides (budget: ≥ 58); 0 without playback. */
  glideFps: number
  /** The longest frame while audio played, ms (budget: none > 32 ms); 0 without playback. */
  glideMaxFrameMs: number
  /** `securitypolicyviolation` events (§6.4; budget: none). */
  cspViolations: number
  /** The time the metrics cover, ms. */
  windowMs: number
  /** Pages in the PageCache now (budget: ≤ 48, §8.18). */
  pageCacheSize: number
  /** QCF page FontFaces in `document.fonts` now, by style (`v1`, `v2`, `v4`; budget: ≤ 24 each, §8.18). */
  qcfFontFaces: Record<string, number>
}

/** What `waitIdle()` is still waiting for. Idle means every list is empty and every flag is false. */
export interface QdTestBusy {
  /** Commands in flight, by `api` name (`mushafGetPages`). */
  ipc: string[]
  /** `document.fonts` is loading a face. */
  fontsLoading: boolean
  /** Running finite animations and transitions (infinite ones, such as spinners, never count). */
  animations: string[]
  /** A page turn or flip is in progress (`reader.turning`/`flipping`, `html[data-turn]`). */
  turning: boolean
  /** The shaping warm-up still has pages queued (warmup.ts: what makes the next turn cheap). */
  shaping: boolean
  /** The reader's neighbour prefetch (page data or fonts) is scheduled for an idle moment and has not started. */
  prefetch: boolean
}

/** A JSON snapshot of the app state that scenarios assert on. */
export interface QdTestState {
  version: number
  url: string
  ready: boolean
  fatal: string | null
  testMode: boolean
  online: boolean
  view: AppView
  overlays: OverlayKind[]
  layerOpen: boolean
  zen: boolean
  sidebarOpen: boolean
  sidePaneOpen: boolean
  readingMode: Settings['readingMode']
  page: number
  visiblePages: number[]
  spread: boolean
  dock: Dock
  qfs: number
  style: MushafStyle
  layout: MushafLayout
  cursorAyahId: number | null
  selection: { fromAyahId: number; toAyahId: number; anchorAyahId: number } | null
  locale: Settings['uiLanguage']
  dir: 'ltr' | 'rtl'
  resolvedTheme: ResolvedTheme
  settings: Settings
  player: {
    status: PlaybackStatus | null
    isPlaying: boolean
    currentAyahId: number | null
    positionMs: number
  }
  ipcPending: string[]
}

export interface WaitIdleOptions {
  /** Reject after this long (default 10 s). */
  timeoutMs?: number
  /** Frames the app must stay idle, with no new command started, before `waitIdle` resolves (default 2). */
  settleFrames?: number
}

/** `window.__QD_TEST__`. Every argument and result is a JSON value, so the hooks work through CDP. */
export interface QdTest {
  readonly version: number
  /**
   * Shows a navigation target and waits until it is on screen: `page`/`ayah`/`surah` open the reader at that page (a
   * jump, without the page-turn animation) and, in Mushaf mode, reject unless that page is visible; `view` switches the
   * view; `search` goes through `ui.navigate` like a deep link.
   */
  goto(target: NavTarget): Promise<void>
  /** `settings.update(patch)`; rejects when the store reverted the change. Resolves when the app is idle. */
  setSettings(patch: Partial<Settings>): Promise<void>
  /** `audio_play(request)`. Run the app with `QD_AUDIO_SINK=null` or `wav:` (the QA drivers default to `null`). */
  play(request: PlayRequest): Promise<void>
  /** `audio_seek` to a file position in ms. */
  seek(ms: number): Promise<void>
  /** `audio_pause`. */
  pause(): Promise<void>
  /** Opens an overlay; without `props`, a QA default (the action target for note-editor, the page for self-test). */
  openOverlay<K extends OverlayKind>(kind: K, props?: OverlayProps[K]): void
  /** Closes every overlay and the context menu. */
  closeOverlays(): void
  /** Resolves once no command is in flight, no font loads, no finite animation runs and no page turns. */
  waitIdle(options?: WaitIdleOptions): Promise<void>
  /** What `waitIdle` would wait for right now. */
  busy(): QdTestBusy
  metrics(): QdTestMetrics
  /** Starts a new metrics window (e.g. before a scripted navigation). */
  resetMetrics(): void
  /**
   * Switches the glide's frame sampler off (`false`) and on again (the default). While audio plays it requests a frame
   * on every vsync, which the app itself does not: measure playback CPU with it off.
   */
  sampleFrames(on: boolean): void
  state(): QdTestState
  /** Calls any typed command through `call()` and returns its data; rejects with `"<kind>: <detail>"`. */
  ipc<K extends keyof QdApi>(command: K, ...args: Parameters<QdApi[K]>): Promise<CommandData<K>>
}
