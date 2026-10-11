/**
 * Browser-test helpers for the shell (WP7c): boot every store from the mock bootstrap and mount the real `App`, the way
 * `main.ts` does, at a given viewport; and wait for transitions. Never imported by the app.
 */
import { flushSync } from 'svelte'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import App from '../../../App.svelte'
import { defaultSettings } from '$lib/contracts/settings'
import { api, call, initIpc } from '$lib/ipc'
import type { Bootstrap, Settings } from '$lib/ipc/bindings'
import { shapeWarmer } from '$lib/mushaf/warmup'
import { app, initStores, resetStores } from '$lib/stores'

/** The part of `window.__QD_MOCK__` (installed by the mock runtime, D29) these helpers use. */
interface MockHandle {
  state: { resetAll(): void; loadAll(): void; settings: { set(value: Settings): Settings } }
}

function mockState(): MockHandle['state'] {
  const handle = (window as unknown as { __QD_MOCK__?: MockHandle }).__QD_MOCK__
  if (!handle) throw new Error('the IPC mock is not installed (initIpc() in a mock build)')
  return handle.state
}

export interface BootOptions {
  /** Viewport in CSS px (default 1600 × 1000, the scenario size). */
  size?: [number, number]
  /** Stored settings before bootstrap. */
  settings?: Partial<Settings>
  /** Edits the bootstrap before the stores see it (notices, platform, …). */
  edit?: (b: Bootstrap) => Bootstrap
  /**
   * Boot as the first run, which opens the welcome flow (default false: the tests start on the reader, as after the
   * onboarding; the browser mock would otherwise report a first run, since nothing was stored yet).
   */
  firstRun?: boolean
}

/** Boots the stores like `main.ts` and mounts `App`. Returns the bootstrap used. */
export async function bootApp(options: BootOptions = {}): Promise<Bootstrap> {
  const [w, h] = options.size ?? [1600, 1000]
  await page.viewport(w, h)
  localStorage.clear()
  await initIpc()
  const state = mockState()
  state.resetAll()
  state.loadAll()
  state.settings.set({ ...defaultSettings(), ...options.settings })
  const raw = { ...(await call(api.appBootstrap())), firstRun: options.firstRun ?? false }
  const b = options.edit ? options.edit(raw) : raw
  await initStores(b)
  await render(App)
  app.markReady()
  flushSync()
  await settle()
  return b
}

/** Unmounting is automatic (vitest-browser-svelte); this returns every store and the document to a clean state. */
export function resetApp(): void {
  resetStores()
  shapeWarmer.reset()
  document.documentElement.removeAttribute('style')
}

/** Two animation frames plus `ms`: effects, measurements and short transitions have settled. */
export async function settle(ms = 60): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms))
}

/** The rendered width of an element (px), or 0. */
export function widthOf(selector: string): number {
  return document.querySelector(selector)?.getBoundingClientRect().width ?? 0
}
