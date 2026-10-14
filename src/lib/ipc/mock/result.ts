/**
 * Result helpers for mock handlers. Every handler returns the tauri-specta result shape built with `ok()`/`err()` and
 * resolves asynchronously, like real IPC.
 */
import type { Channel } from '@tauri-apps/api/core'
import type { AppError, commands } from '../bindings'

/** The typed command surface the mock implements (`mockCommands satisfies Api`). */
export type Api = typeof commands
/** A handler module implements exactly the commands it owns: `Handlers<'mushafGetPages' | …>`. */
export type Handlers<K extends keyof Api> = Pick<Api, K>

export type Result<T> = { status: 'ok'; data: T } | { status: 'error'; error: AppError }
export type ErrorKind = AppError['kind']

export function ok<T>(data: T): Result<T> {
  return { status: 'ok', data }
}

export function err<T = never>(kind: ErrorKind, message: string): Result<T> {
  return { status: 'error', error: { kind, message } }
}

/** Thrown inside `handle()` bodies to return a typed error (`throw new MockError('not_found', '…')`). */
export class MockError extends Error {
  override readonly name = 'MockError'

  constructor(
    readonly kind: ErrorKind,
    message: string,
  ) {
    super(message)
  }
}

/** Resolves on the next microtask: handlers never answer synchronously. */
export function tick(): Promise<void> {
  return Promise.resolve()
}

/** Resolves after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A random delay in `[minMs, maxMs]`: page loads take 2–8 ms to surface race conditions. */
export function jitter(minMs = 2, maxMs = 8): Promise<void> {
  return delay(minMs + Math.random() * (maxMs - minMs))
}

/**
 * Wraps a handler body: waits a microtask, runs `fn`, and turns its value into `ok()`, a thrown `MockError` into
 * `err()`, and any other exception into an `internal` error (logged, since it is a bug in the mock).
 */
export function handle<A extends unknown[], T>(
  fn: (...args: A) => T | Promise<T>,
): (...args: A) => Promise<Result<T>> {
  return async (...args: A) => {
    await tick()
    try {
      return ok(await fn(...args))
    } catch (e) {
      if (e instanceof MockError) return err(e.kind, e.message)
      console.error('[mock IPC] handler failed', e)
      return err('internal', e instanceof Error ? e.message : String(e))
    }
  }
}

/**
 * An `unsupported` answer, after a microtask. Stubs pass a fixed reason string, so a grep for it finds every stub still
 * left in a handler file.
 */
export function unsupported<T = never>(command: string, reason: string): Promise<Result<T>> {
  return tick().then(() => err<T>('unsupported', `${reason}: ${command} (browser mock)`))
}

/** Pushes one payload into a channel a handler kept. A throwing consumer must not break the mock's loop. */
export function send<T>(channel: Channel<T> | null | undefined, payload: T): void {
  if (!channel) return
  try {
    channel.onmessage(payload)
  } catch (e) {
    console.error('[mock IPC] channel consumer threw', e)
  }
}

/** Validation helpers mirroring the commands' `InvalidArgument` checks. */
export function assertRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new MockError('invalid_argument', `${name} ${value} is outside ${min}..=${max}`)
  }
}

export function assertAyahRange(from: number, to: number, maxLen: number): void {
  assertRange('fromAyahId', from, 1, 6236)
  assertRange('toAyahId', to, 1, 6236)
  if (from > to) throw new MockError('invalid_argument', `fromAyahId ${from} > toAyahId ${to}`)
  if (to - from + 1 > maxLen) throw new MockError('invalid_argument', `range longer than ${maxLen} ayahs`)
}

/** Current time in Unix seconds (the DTOs' `*_at` unit). */
export function nowSecs(): number {
  return Math.floor(Date.now() / 1000)
}
