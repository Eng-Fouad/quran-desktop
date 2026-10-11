import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  APP_ERROR_KINDS,
  call,
  fontBytes,
  initIpc,
  IpcError,
  isFontRel,
  isIpcError,
  packUrl,
  toAppError,
  toArrayBuffer,
  toIpcError,
  type AppError,
  type Res,
} from './index'

const ok = <T>(data: T): Promise<Res<T>> => Promise.resolve({ status: 'ok', data })
const fail = (error: AppError | string): Promise<Res<never>> => Promise.resolve({ status: 'error', error })

describe('call()', () => {
  it('unwraps an ok result', async () => {
    await expect(call(ok({ page: 262 }))).resolves.toEqual({ page: 262 })
  })

  it('throws an IpcError with kind and detail for an AppError object', async () => {
    const e = await call(fail({ kind: 'offline', message: 'no network' })).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(IpcError)
    expect(isIpcError(e)).toBe(true)
    expect(e).toMatchObject({ kind: 'offline', detail: 'no network', message: 'offline: no network' })
  })

  it('normalises a plain string rejection (Tauri argument/state errors) to internal', async () => {
    const e = await call(fail('invalid args `page` for command `mushaf_get_pages`')).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(IpcError)
    expect(e).toMatchObject({
      kind: 'internal',
      detail: 'invalid args `page` for command `mushaf_get_pages`',
    })
  })

  it('turns a rejected promise (no IPC at all) into an internal IpcError', async () => {
    const e = await call(Promise.reject(new TypeError('window.__TAURI_INTERNALS__ is undefined'))).catch(
      (x: unknown) => x,
    )
    expect(e).toMatchObject({ kind: 'internal', detail: 'window.__TAURI_INTERNALS__ is undefined' })
  })

  it('treats a malformed error object as internal and keeps it readable', async () => {
    const e = await call(fail({ kind: 'nope', message: 'x' } as unknown as AppError)).catch((x: unknown) => x)
    expect(e).toMatchObject({ kind: 'internal' })
    expect((e as IpcError).detail).toContain('nope')
  })
})

describe('error helpers', () => {
  it('lists every AppError kind once', () => {
    expect(new Set(APP_ERROR_KINDS).size).toBe(12)
  })

  it('round-trips IpcError and AppError', () => {
    const e = new IpcError('conflict', 'busy')
    expect(e.name).toBe('IpcError')
    expect(e.toAppError()).toEqual({ kind: 'conflict', message: 'busy' })
    expect(toIpcError(e)).toBe(e)
    expect(toAppError(e)).toEqual({ kind: 'conflict', message: 'busy' })
    expect(toAppError(new Error('boom'))).toEqual({ kind: 'internal', message: 'boom' })
    expect(toAppError(42)).toEqual({ kind: 'internal', message: '42' })
    expect(toAppError({ kind: 'audio' })).toEqual({ kind: 'audio', message: '' })
  })
})

describe('font routes', () => {
  it('accepts exactly the §6.2 font routes', () => {
    for (const rel of [
      'mushaf/v2/p1.woff2',
      'mushaf/v1/p604.woff2',
      'mushaf/v4/p262.woff2',
      'decor/qcf-surah-header.woff2',
      'decor/quran-common.ttf',
      'decor/sura-names.woff2',
      'decor/noto-nastaliq-urdu.woff2',
    ]) {
      expect(isFontRel(rel), rel).toBe(true)
    }
    for (const rel of [
      'mushaf/v2/p0.woff2',
      'mushaf/v2/p605.woff2',
      'mushaf/v3/p1.woff2',
      'mushaf/v2/p01.woff2',
      '/mushaf/v2/p1.woff2',
      'mushaf/v2/../p1.woff2',
      'audio/7/001.mp3',
      'decor/other.ttf',
    ]) {
      expect(isFontRel(rel), rel).toBe(false)
    }
  })

  it('reads font bytes from the dev-packs route in the mock and rejects other paths', async () => {
    const bytes = new Uint8Array([0x77, 0x4f, 0x46, 0x32]).buffer
    const fetch = vi.fn(async () => new Response(bytes, { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await expect(fontBytes('mushaf/v2/p262.woff2')).resolves.toBeInstanceOf(ArrayBuffer)
    expect(fetch).toHaveBeenCalledWith('/__packs/mushaf/v2/p262.woff2')
    fetch.mockResolvedValueOnce(new Response(null, { status: 404 }))
    await expect(fontBytes('mushaf/v2/p1.woff2')).rejects.toMatchObject({ kind: 'not_found' })
    await expect(fontBytes('../secret')).rejects.toMatchObject({ kind: 'invalid_argument' })
  })

  it('accepts the raw font bytes in every shape Tauri delivers them', () => {
    const bytes = [0x77, 0x4f, 0x46, 0x32]
    const buffer = new Uint8Array(bytes).buffer
    expect(toArrayBuffer(buffer)).toBe(buffer)
    // The postMessage fallback serialises a raw response as a JSON array of numbers (WP6a).
    expect([...new Uint8Array(toArrayBuffer(bytes))]).toEqual(bytes)
    expect([...new Uint8Array(toArrayBuffer(new Uint8Array([0, 1, 2, 3, 4]).subarray(1, 3)))]).toEqual([1, 2])
    expect(() => toArrayBuffer([256])).toThrow(IpcError)
    expect(() => toArrayBuffer('wOF2')).toThrow(IpcError)
  })

  it('joins pack URLs onto the protocol base', () => {
    expect(packUrl('http://quran.localhost/', 'mushaf/v2/p1.woff2')).toBe(
      'http://quran.localhost/mushaf/v2/p1.woff2',
    )
  })
})

describe('initIpc()', () => {
  afterEach(() => vi.unstubAllGlobals())

  // Imports the whole browser mock with its fixtures: seconds on a machine busy with the other unit files.
  it(
    'installs the mock (compile-time __MOCK_IPC__ in vitest) and swaps api for the typed mock commands',
    { timeout: 30_000 },
    async () => {
      const generated = api
      await initIpc()
      const { api: live } = await import('./index')
      expect(live).not.toBe(generated)
      expect(Object.keys(live).sort()).toEqual(Object.keys(generated).sort())
      const bootstrap = await call(live.appBootstrap())
      expect(bootstrap.index.surahs).toHaveLength(114)
    },
  )
})
