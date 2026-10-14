/**
 * The mock IPC runtime: fake windows, `convertFileSrc`, the event bus behind the generated
 * `events.x.listen/emit`, and answers for the few plugin calls the UI makes outside the typed commands. Typed commands
 * never reach this layer: `api` is replaced by `mockCommands`, so an unknown command here is a bug and throws.
 *
 * Events are handled here instead of with `mockIPC(…, { shouldMockEvents: true })`: in @tauri-apps/api 2.12.2 the
 * built-in mock removes listeners by `args.id` while `unlisten` sends `eventId`, so unlistened handlers stayed
 * registered and every later emit logged "Couldn't find callback id".
 */
import type { InvokeArgs } from '@tauri-apps/api/core'
import { clearMocks, mockConvertFileSrc, mockIPC, mockWindows } from '@tauri-apps/api/mocks'

type Args = Record<string, unknown>

interface TauriInternals {
  runCallback?: (id: number, data: unknown) => void
}

/** `tauri-plugin-log` levels (`LogLevel` in @tauri-apps/plugin-log). */
const LOG_LEVELS: Record<number, 'debug' | 'info' | 'warn' | 'error'> = {
  1: 'debug',
  2: 'debug',
  3: 'info',
  4: 'warn',
  5: 'error',
}

/** Event name → handler callback ids registered through `plugin:event|listen`. */
const listeners = new Map<string, Set<number>>()

function internals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__ ?? {}
}

function asArgs(payload: InvokeArgs | undefined): Args {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Args) : {}
}

function listen(args: Args): number {
  const event = String(args.event)
  const handler = Number(args.handler)
  let set = listeners.get(event)
  if (!set) listeners.set(event, (set = new Set()))
  set.add(handler)
  return handler // the event id the frontend later passes to unlisten
}

function unlisten(args: Args): null {
  listeners.get(String(args.event))?.delete(Number(args.eventId))
  return null
}

function emit(args: Args): null {
  const event = String(args.event)
  const run = internals().runCallback
  for (const id of [...(listeners.get(event) ?? [])]) run?.(id, { event, id, payload: args.payload })
  return null
}

function log(args: Args): null {
  const level = LOG_LEVELS[Number(args.level)] ?? 'info'
  console[level](`[app log] ${String(args.message ?? '')}`)
  return null
}

/** The fallback for every invoke that is not a typed command. */
function fallback(cmd: string, payload?: InvokeArgs): unknown {
  const args = asArgs(payload)
  switch (cmd) {
    case 'plugin:event|listen':
      return listen(args)
    case 'plugin:event|unlisten':
      return unlisten(args)
    case 'plugin:event|emit':
    case 'plugin:event|emit_to':
      return emit(args)
    case 'plugin:log|log':
      return log(args)
    case 'plugin:dialog|save':
      return 'C:/mock/backup.qdb'
    case 'plugin:dialog|open':
      return null
    case 'plugin:window|close':
      // As Rust closes the main window with no recitation to keep in the tray (`window::quit`): the page is asked to
      // save what it holds and quit (`app_quit`, which the mock only logs).
      return emit({ event: 'quit-requested', payload: null })
  }
  if (cmd.startsWith('plugin:window|') || cmd.startsWith('plugin:webview|')) {
    // minimize, toggle_maximize, start_dragging, set_fullscreen, …: no-ops. `is_*` queries answer false.
    return cmd.includes('|is_') ? false : null
  }
  throw new Error(`[mock IPC] unhandled command "${cmd}": add it to a handler in src/lib/ipc/mock/handlers/`)
}

/** Installs the runtime. Idempotent: a second call resets the event bus and re-registers everything. */
export function installRuntime(): void {
  clearMocks()
  listeners.clear()
  mockWindows('main')
  mockConvertFileSrc('windows')
  mockIPC(fallback, { shouldMockEvents: false })
}

/** Removes the runtime (tests). */
export function uninstallRuntime(): void {
  listeners.clear()
  clearMocks()
}

/** Number of live listeners per event (tests and the debug handle). */
export function listenerCounts(): Record<string, number> {
  return Object.fromEntries([...listeners].map(([event, set]) => [event, set.size]))
}
