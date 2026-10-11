/**
 * The browser IPC mock (§5.17, D9; WP0C, frozen). Loaded only by `initIpc()` behind the compile-time `__MOCK_IPC__`
 * (D29), so none of it reaches a production `dist/`.
 *
 * `mockCommands` replaces the generated `commands` object: `satisfies Api` makes the compiler fail when a command is
 * missing or its signature drifts after `bindings.ts` is regenerated. Each handler module belongs to the package named in
 * it (§5.17 table) and fixes itself after a contract change.
 */
import { appHandlers } from './handlers/app'
import { audioHandlers } from './handlers/audio'
import { contentHandlers } from './handlers/content'
import { fontsHandlers } from './handlers/fonts'
import { memoHandlers } from './handlers/memo'
import { mushafHandlers } from './handlers/mushaf'
import { packsHandlers } from './handlers/packs'
import { searchHandlers } from './handlers/search'
import { settingsHandlers } from './handlers/settings'
import { userHandlers } from './handlers/user'
import { fixtures } from './fixtures'
import type { Api } from './result'
import { installRuntime, listenerCounts } from './runtime'
import { state } from './state'

export const mockCommands = {
  ...appHandlers,
  ...settingsHandlers,
  ...mushafHandlers,
  ...fontsHandlers,
  ...contentHandlers,
  ...searchHandlers,
  ...audioHandlers,
  ...memoHandlers,
  ...packsHandlers,
  ...userHandlers,
} satisfies Api

/** A debugging handle for the console and QA scenarios (`window.__QD_MOCK__`), mock builds only. */
export interface MockDebugHandle {
  state: typeof state
  fixtures: typeof fixtures
  listeners: typeof listenerCounts
  /** Clears every state slice and reloads the page. */
  reset(): void
}

let installing: Promise<void> | null = null

/**
 * Installs the mock runtime once: fake windows and events, fixtures preloaded (index and catalogue), and the state slices
 * restored from `localStorage` (or cleared first when the URL has `?mockReset`).
 */
export function installMockRuntime(): Promise<void> {
  installing ??= (async () => {
    installRuntime()
    await fixtures.preload()
    if (new URLSearchParams(location.search).has('mockReset')) state.resetAll()
    state.loadAll()
    const handle: MockDebugHandle = {
      state,
      fixtures,
      listeners: listenerCounts,
      reset() {
        state.resetAll()
        location.reload()
      },
    }
    ;(window as unknown as { __QD_MOCK__?: MockDebugHandle }).__QD_MOCK__ = handle
    console.info(
      `[mock IPC] browser mock ready: ${fixtures.available ? 'fixtures' : 'synthetic data'} (src/lib/ipc/mock)`,
    )
  })()
  return installing
}

export { fixtures, state }
