/**
 * Types for e2e scenario authors (§12.6; WP13a). A scenario is `tests/e2e/scenarios/<id>.mjs`:
 *
 *   // @ts-check
 *   /** @type {import('../lib/types').ScenarioMeta} *\/
 *   export const meta = { window: [1600, 1000], ui: 'ar', theme: 'night', mode: 'web' }
 *   /** @param {import('../lib/types').ScenarioContext} ctx *\/
 *   export default async function (ctx) {
 *     await ctx.qd.goto({ type: 'page', data: { page: 262 } })
 *     await ctx.shot()                       // artifacts/shots/<web|app>/<id>.png
 *     await ctx.shot('dock', { selector: '.dock' })   // <id>-dock.png
 *   }
 */
import type { Page, PageScreenshotOptions } from 'playwright-core'
import type { OverlayKind, OverlayProps } from '../../../src/lib/contracts/overlays'
import type { NavTarget, PlayRequest, Settings } from '../../../src/lib/ipc/bindings'
import type {
  CommandData,
  QdApi,
  QdTestBusy,
  QdTestMetrics,
  QdTestState,
  WaitIdleOptions,
} from '../../../src/lib/testing/types'

export type {
  CommandData,
  QdApi,
  QdTest,
  QdTestBusy,
  QdTestMetrics,
  QdTestState,
  WaitIdleOptions,
} from '../../../src/lib/testing/types'

/** Which runner executes a scenario: `web-shot.mjs` (browser mock) or `app-driver.mjs` (real app over CDP). */
export type RunMode = 'web' | 'app'

/** `export const meta` of a scenario module. Unknown keys are rejected. */
export interface ScenarioMeta {
  /** Viewport in CSS px (default [1600, 1000]). The app driver emulates it over CDP. */
  window?: [number, number]
  /** UI language, applied with `setSettings({ uiLanguage })` before the scenario runs. */
  ui?: Settings['uiLanguage']
  /** App theme, applied with `setSettings({ theme })`. */
  theme?: Settings['theme']
  /** Where the scenario runs (default `web`). `both` runs in the browser mock and in the real app. */
  mode?: 'web' | 'app' | 'both'
  /** Any other settings to apply before the scenario (merged with `ui`/`theme`). */
  settings?: Partial<Settings>
  /** `prefers-color-scheme` (default `light`, so `theme: 'system'` resolves to the light variant). */
  colorScheme?: 'light' | 'dark'
  /** `prefers-reduced-motion: reduce`. */
  reducedMotion?: boolean
  /** Device pixel ratio of the browser-mock viewport (default 1). */
  dpr?: number
  /** Scenario budget in ms (default 120000, or the runner's `--scenario-timeout`). */
  timeout?: number
  /** Console errors this scenario expects (regex sources or RegExps); everything else fails the run. */
  allowConsole?: Array<string | RegExp>
  /** The scenario expects the fatal screen (otherwise a fatal boot fails it, or marks it pending on a wave-0 stub). */
  expectFatal?: boolean
  /** Extra environment for the app process (app mode), e.g. `{ QD_AUDIO_SINK: 'wav:artifacts/ic2.wav' }`. */
  env?: Record<string, string>
  description?: string
}

/** `meta` after validation, with defaults filled in. */
export interface ResolvedMeta {
  window: [number, number]
  ui: Settings['uiLanguage'] | null
  theme: Settings['theme'] | null
  mode: 'web' | 'app' | 'both'
  settings: Record<string, unknown> | null
  colorScheme: 'light' | 'dark'
  reducedMotion: boolean
  dpr: number
  timeout: number | null
  allowConsole: RegExp[]
  expectFatal: boolean
  env: Record<string, string>
  description: string | null
}

/** How the app came up. */
export interface BootInfo {
  /** The fatal screen, when bootstrap failed: its `data-qd-fatal` kind (if marked) and text. */
  fatal: { kind: string | null; text: string } | null
  /** Who installed `window.__QD_TEST__`: the app itself, the harness (browser mock fallback), or nobody. */
  hook: 'app' | 'harness' | null
}

export interface ShotOptions extends Omit<PageScreenshotOptions, 'path'> {
  /** Screenshot one element instead of the viewport. */
  selector?: string
  /** Wait for `__QD_TEST__.waitIdle()` first (default true when the hook is installed). */
  idle?: boolean
  /** Accept a single-colour image (by default a blank screenshot fails the scenario). */
  allowBlank?: boolean
}

/** `ctx.qd`: `window.__QD_TEST__` called through `page.evaluate`. Every method fails clearly when the hook is missing. */
export interface QdClient {
  /** Whether `window.__QD_TEST__` exists on the current page. */
  available(): Promise<boolean>
  goto(target: NavTarget): Promise<void>
  setSettings(patch: Partial<Settings>): Promise<void>
  play(request: PlayRequest): Promise<void>
  seek(ms: number): Promise<void>
  pause(): Promise<void>
  openOverlay<K extends OverlayKind>(kind: K, props?: OverlayProps[K]): Promise<void>
  closeOverlays(): Promise<void>
  waitIdle(options?: WaitIdleOptions): Promise<void>
  busy(): Promise<QdTestBusy>
  metrics(): Promise<QdTestMetrics>
  resetMetrics(): Promise<void>
  sampleFrames(on: boolean): Promise<void>
  state(): Promise<QdTestState>
  ipc<K extends keyof QdApi>(command: K, ...args: Parameters<QdApi[K]>): Promise<CommandData<K>>
}

export interface ScenarioContext {
  /** The scenario id (file name without `.mjs`). */
  readonly id: string
  readonly mode: RunMode
  readonly meta: ResolvedMeta
  /** The app page. Replaced by `relaunch()`, so always read it through `ctx`. */
  readonly page: Page
  readonly qd: QdClient
  /** How the app came up (after `relaunch()`, the latest boot). */
  readonly boot: BootInfo
  /** Screenshot directory (`artifacts/shots/<mode>`). */
  readonly outDir: string
  /** `QD_DATA_DIR` of the app (app mode), else null. */
  readonly dataDir: string | null
  /**
   * The app process (app mode): its PID, and `Date.now()` just before it was spawned (cold-start measurements, WP13b's
   * metrics). Replaced by `relaunch()`. Null in the browser mock.
   */
  readonly process: { pid: number; launchedAt: number } | null
  /**
   * Writes `<id>.png` (no name), or `<id>-<name>.png` (a name not already starting with the id), into `outDir` and returns
   * the path. Waits for the app to be idle first. A scenario that takes no shot gets `<id>.png` at the end.
   */
  shot(name?: string, options?: ShotOptions): Promise<string>
  wait(ms: number): Promise<void>
  log(...args: unknown[]): void
  /**
   * Restarts the app with the same data (web: reloads the page, keeping the mock's storage) and waits for it to boot.
   * The harness quits through `app_quit`; with `close`, the user closes the window instead (what the title bar's ×
   * sends) and the app quits by itself: the page saves what it holds first (`quit-requested`). App mode fails the
   * scenario when the closed window does not end the app.
   */
  relaunch(options?: { close?: boolean }): Promise<void>
  /** Ends the scenario as `pending`: a feature it needs is still a stub. */
  pending(reason: string): never
  /** Accepts console errors matching `pattern` for the rest of this scenario. */
  allowConsole(pattern: string | RegExp): void
}

export type ScenarioFn = (ctx: ScenarioContext) => Promise<void> | void
