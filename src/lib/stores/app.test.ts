import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, call, events, initIpc, IpcError } from '$lib/ipc'
import type { Bootstrap } from '$lib/ipc/bindings'
import { mockCommands } from '$lib/ipc/mock'
import { state } from '$lib/ipc/mock/state'
import { app, hasIpc, listenEvent, QUIT_FLUSH_MS } from './app.svelte'

async function bootstrap(): Promise<Bootstrap> {
  localStorage.clear()
  await initIpc()
  state.resetAll()
  state.loadAll()
  return call(api.appBootstrap())
}

const frames = (n: number) =>
  new Promise<void>((resolve) => {
    const step = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1)))
    step(n)
  })

afterEach(() => {
  app.reset()
  vi.restoreAllMocks()
})

describe('app store', () => {
  it('starts with neutral values before bootstrap', () => {
    expect(app.ready).toBe(false)
    expect(app.info.name).toBe('Quran')
    expect(app.online).toBe(true)
    expect(app.fatal).toBeNull()
    expect(app.notices).toEqual([])
  })

  it('takes the bootstrap data and derives the platform', async () => {
    const b = await bootstrap()
    app.init({ ...b, firstRun: true, online: false, app: { ...b.app, platform: 'macos', testMode: true } })
    expect(app.firstRun).toBe(true)
    expect(app.online).toBe(false)
    expect(app.platform).toBe('macos')
    expect([app.isMac, app.isWindows, app.isLinux]).toEqual([true, false, false])
    expect(app.testMode).toBe(true)
    expect(app.protocolBase).toBe('/__packs/')
    // Platform styles (no translucency on Linux, the title bar per OS) key off html[data-platform].
    expect(document.documentElement.dataset.platform).toBe('macos')
    app.reset()
    expect(document.documentElement.dataset.platform).toBeUndefined()
  })

  it('picks the §9.8 fatal screen from the failure', () => {
    expect(app.fatalReason).toBeNull()
    app.failBootstrap(new IpcError('not_found', 'core.db missing — run pnpm core:qdc'))
    expect(app.fatalReason).toBe('core_missing')
    app.failBootstrap(new IpcError('not_found', 'surah 115'))
    expect(app.fatalReason).toBe('error')
    // With a backend (the mock here), `unsupported` is a wave-0 stub or a real refusal, not the browser preview.
    app.failBootstrap(new IpcError('unsupported', 'not implemented: app_bootstrap'))
    expect(app.fatalReason).toBe('error')
    expect(hasIpc()).toBe(true)
  })

  it('reveals the data folder through system_reveal_data_dir', async () => {
    await initIpc()
    const reveal = vi.spyOn(mockCommands, 'systemRevealDataDir')
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await app.revealDataDir()
    expect(reveal).toHaveBeenCalledTimes(1)
    reveal.mockResolvedValueOnce({ status: 'error', error: { kind: 'io', message: 'no file manager' } })
    await expect(app.revealDataDir()).rejects.toMatchObject({ kind: 'io' })
  })

  it('follows NetworkChanged and stops after reset', async () => {
    app.init(await bootstrap())
    await events.networkChanged.emit({ online: false })
    expect(app.online).toBe(false)
    await events.networkChanged.emit({ online: true })
    expect(app.online).toBe(true)
    app.reset()
    await events.networkChanged.emit({ online: false })
    expect(app.online).toBe(true)
  })

  it('shows the fatal screen for a failed bootstrap, whatever was thrown', () => {
    app.failBootstrap(new IpcError('not_found', 'core.db missing — run pnpm core:qdc'))
    expect(app.fatal).toBe('core.db missing — run pnpm core:qdc')
    expect(app.fatalKind).toBe('not_found')
    app.failBootstrap('argument error')
    expect(app.fatalKind).toBe('internal')
    app.failBootstrap(new Error('boom'))
    expect(app.fatal).toBe('boom')
  })

  it('asks Rust to show the window once, after the first frames', async () => {
    await initIpc()
    const ready = vi.spyOn(mockCommands, 'windowReady')
    app.markReady()
    app.markReady()
    expect(app.ready).toBe(true)
    expect(ready).not.toHaveBeenCalled()
    await frames(3)
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('asks to be shown without waiting for frames while the window is hidden (WKWebView runs none)', async () => {
    await initIpc()
    const ready = vi.spyOn(mockCommands, 'windowReady')
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    app.markReady()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ready).toHaveBeenCalledTimes(1)
    expect(raf).not.toHaveBeenCalled()
  })

  it('dismisses a startup notice', async () => {
    const b = await bootstrap()
    app.init({
      ...b,
      notices: [{ type: 'user_db_recovered', data: { quarantinedFile: 'user.db.corrupt' } }],
    })
    const [notice] = app.notices
    if (!notice) throw new Error('expected a notice')
    app.dismissNotice(notice)
    expect(app.notices).toEqual([])
  })

  it('quits through app_quit and logs a failure instead of throwing', async () => {
    await initIpc()
    const quit = vi.spyOn(mockCommands, 'appQuit').mockResolvedValueOnce({
      status: 'error',
      error: { kind: 'internal', message: 'no' },
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(app.quit()).resolves.toBeUndefined()
    expect(quit).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalled()
  })

  it('answers quit-requested once ready: the pending writes land first, then app_quit', async () => {
    await initIpc()
    const order: string[] = []
    vi.spyOn(mockCommands, 'appQuit').mockImplementation(() => {
      order.push('app_quit')
      return Promise.resolve({ status: 'ok', data: null })
    })
    let land!: () => void
    const write = new Promise<void>((resolve) => (land = resolve))
    app.beforeQuit(() => {
      order.push('sync hook')
    })
    app.beforeQuit(() => write.then(() => order.push('write landed')))
    const removed = app.beforeQuit(() => order.push('unregistered hook'))
    removed()

    // Not listening before markReady (Rust exits at once until window_ready).
    await events.quitRequested.emit()
    expect(order).toEqual([])

    app.markReady()
    await Promise.resolve()
    await events.quitRequested.emit()
    await events.quitRequested.emit() // a second request joins the first
    expect(order).toEqual(['sync hook'])
    land()
    await vi.waitFor(() => expect(order).toEqual(['sync hook', 'write landed', 'app_quit']))
  })

  it('quits without a write that never lands after QUIT_FLUSH_MS, and logs a failed one', async () => {
    await initIpc()
    vi.useFakeTimers()
    try {
      const quit = vi.spyOn(mockCommands, 'appQuit').mockResolvedValue({ status: 'ok', data: null })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      app.beforeQuit(() => new Promise(() => {}))
      app.beforeQuit(() => {
        throw new Error('disk full')
      })
      const done = app.quit()
      await vi.advanceTimersByTimeAsync(QUIT_FLUSH_MS - 1)
      expect(quit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await done
      expect(quit).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${QUIT_FLUSH_MS} ms`))

      // Without a hung write, a failed one is logged and the quit goes on at once.
      app.reset()
      app.beforeQuit(() => Promise.reject(new Error('disk full')))
      await app.quit()
      expect(quit).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalledWith('[qd] a pending write failed before quitting', expect.any(Error))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('listenEvent', () => {
  it('detaches a listener even when unsubscribed before listen() resolved', async () => {
    await initIpc()
    const seen: boolean[] = []
    const stop = listenEvent(events.networkChanged, (p) => seen.push(p.online))
    stop()
    await events.networkChanged.emit({ online: false })
    expect(seen).toEqual([])
  })

  it('logs instead of throwing when the event bus is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stop = listenEvent({ listen: () => Promise.reject(new Error('no IPC')) }, () => {})
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).toHaveBeenCalled()
    stop()
  })
})
