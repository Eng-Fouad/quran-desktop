/**
 * The frontend IPC wrapper (§5.16; WP0C, frozen). Stores reach Rust only through `api`, `events`, `call` and `fontBytes`
 * from here; ESLint forbids importing `invoke` or `./bindings` values anywhere else.
 *
 * `__MOCK_IPC__` is a compile-time constant (D29): `true` under `vite --mode mock` and vitest, `false` in every Tauri
 * build, so the mock branches below are dead code there and Rollup drops `./mock`, the synthetic generator and every
 * fixture chunk from `dist/` (`pnpm check:dist` verifies it).
 */
import { invoke } from '@tauri-apps/api/core'
import { commands, events, type AppError } from './bindings'

export type { AppError }
export type Api = typeof commands
export type AppErrorKind = AppError['kind']

/** The typed commands: the generated tauri-specta object, replaced by the mock in browser mode (live binding). */
export let api: Api = commands
export { events }

/** Every `AppError` kind (§5.2). */
export const APP_ERROR_KINDS = [
  'not_found',
  'invalid_argument',
  'database',
  'io',
  'network',
  'offline',
  'integrity',
  'cancelled',
  'conflict',
  'audio',
  'unsupported',
  'internal',
] as const satisfies readonly AppErrorKind[]

/** A failed command. `kind` selects the localised message (`errors.<kind>`); `detail` is the raw developer message. */
export class IpcError extends Error {
  override readonly name = 'IpcError'

  constructor(
    readonly kind: AppErrorKind,
    readonly detail: string,
  ) {
    super(`${kind}: ${detail}`)
  }

  /** The error as the `AppError` DTO shape. */
  toAppError(): AppError {
    return { kind: this.kind, message: this.detail }
  }
}

export function isIpcError(e: unknown): e is IpcError {
  return e instanceof IpcError
}

const KNOWN_KINDS: ReadonlySet<string> = new Set(APP_ERROR_KINDS)

/**
 * Normalises whatever a command rejected with into an `AppError`. Tauri rejects argument-deserialisation and
 * unmanaged-state failures with a plain string (§5.2), which becomes `internal`; so does any malformed value.
 */
export function toAppError(raw: unknown): AppError {
  if (raw instanceof IpcError) return raw.toAppError()
  if (typeof raw === 'string') return { kind: 'internal', message: raw }
  if (typeof raw === 'object' && raw !== null) {
    const { kind, message } = raw as { kind?: unknown; message?: unknown }
    if (typeof kind === 'string' && KNOWN_KINDS.has(kind)) {
      return { kind: kind as AppErrorKind, message: typeof message === 'string' ? message : '' }
    }
    if (raw instanceof Error) return { kind: 'internal', message: raw.message }
  }
  return { kind: 'internal', message: safeString(raw) }
}

/** Any thrown value as an `IpcError` (stores catch, then `ui.toastError(err)`). */
export function toIpcError(raw: unknown): IpcError {
  if (raw instanceof IpcError) return raw
  const e = toAppError(raw)
  return new IpcError(e.kind, e.message)
}

function safeString(value: unknown): string {
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

/**
 * Selects the IPC implementation. Must be awaited once, before the first command (`main.ts`). In browser mode it
 * installs the mock runtime (windows, events, plugin fallbacks) and swaps `api` for the typed mock commands. Outside
 * Tauri without the mock (a `vite preview` of a production build) it throws, and the app shows its fatal screen.
 */
export async function initIpc(): Promise<void> {
  if (__MOCK_IPC__) {
    const mock = await import('./mock')
    await mock.installMockRuntime()
    api = mock.mockCommands
  } else if (!('__TAURI_INTERNALS__' in window)) {
    throw new IpcError('unsupported', 'Run Quran in Tauri (pnpm app:dev)')
  }
}

/** The result shape of a generated command, with the string rejections Tauri really produces (§5.2). */
export type Res<T> = { status: 'ok'; data: T } | { status: 'error'; error: AppError | string }

/**
 * Unwraps a tauri-specta result and throws `IpcError` on failure. Every store uses it: `await call(api.x(...))`.
 * A rejected promise (the generated wrapper rethrows `Error`s, e.g. when there is no IPC at all) becomes `internal`.
 */
export async function call<T>(p: Promise<Res<T>>): Promise<T> {
  let r: Res<T>
  try {
    r = await p
  } catch (e) {
    throw toIpcError(e)
  }
  if (r.status === 'ok') return r.data
  throw toIpcError(r.error)
}

/** The font routes `font_bytes` accepts (§6.2): the same allow-list as the `quran://` protocol, without the leading `/`. */
const FONT_REL =
  /^(?:mushaf\/v[124]\/p([1-9][0-9]{0,2})\.woff2|decor\/(?:qcf-surah-header\.woff2|quran-common\.ttf|sura-names\.woff2|noto-nastaliq-urdu\.woff2))$/

/** Whether `rel` names a font route (`mushaf/v2/p262.woff2`, `decor/quran-common.ttf`, …). */
export function isFontRel(rel: string): boolean {
  const m = FONT_REL.exec(rel)
  if (!m) return false
  return m[1] === undefined || Number(m[1]) <= 604
}

/**
 * A raw IPC response as an `ArrayBuffer`. Tauri answers a raw (`tauri::ipc::Response`) command with an `ArrayBuffer`
 * over its custom-protocol IPC, but when that protocol is blocked it falls back to `postMessage`, which serialises the
 * bytes as a JSON array of numbers (tauri 2.12 `ipc/protocol.rs`; always the case on that macOS path, WP6a).
 */
export function toArrayBuffer(raw: unknown): ArrayBuffer {
  if (raw instanceof ArrayBuffer) return raw
  if (ArrayBuffer.isView(raw)) {
    const bytes = new Uint8Array(raw.byteLength)
    bytes.set(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
    return bytes.buffer
  }
  if (Array.isArray(raw) && raw.every((b) => Number.isInteger(b) && b >= 0 && b <= 255))
    return Uint8Array.from(raw as number[]).buffer
  throw new IpcError(
    'internal',
    `font_bytes answered ${Array.isArray(raw) ? 'an array of non-bytes' : typeof raw}, not bytes`,
  )
}

/**
 * The one hand-written command wrapper (§5.13): the raw bytes of a pack font, for `fontTransport = bytes`
 * (`new FontFace(family, buffer)`, D30). The browser mock reads the same file from the dev-packs server.
 */
export async function fontBytes(rel: string): Promise<ArrayBuffer> {
  if (!isFontRel(rel)) throw new IpcError('invalid_argument', `not a font route: ${rel}`)
  if (__MOCK_IPC__) {
    const res = await fetch(`/__packs/${rel}`)
    if (!res.ok)
      throw new IpcError(res.status === 404 ? 'not_found' : 'io', `GET /__packs/${rel}: ${res.status}`)
    return await res.arrayBuffer()
  }
  let raw: unknown
  try {
    raw = await invoke<unknown>('font_bytes', { rel })
  } catch (e) {
    throw toIpcError(e)
  }
  return toArrayBuffer(raw)
}

/** A pack URL from `AppInfo.protocolBase` and a relative path. Rust returns full URLs in DTOs; this is for diagnostics. */
export function packUrl(base: string, rel: string): string {
  return base + rel
}
