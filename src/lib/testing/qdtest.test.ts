import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, call, initIpc } from '$lib/ipc'
import type { Bootstrap } from '$lib/ipc/bindings'
import { mockCommands } from '$lib/ipc/mock'
import { err, ok } from '$lib/ipc/mock/result'
import { state as mockState } from '$lib/ipc/mock/state'
import { flushSync } from 'svelte'
import { app, i18n, pages, player, quran, reader, settings, ui } from '$lib/stores'
import { installQdTest, QD_TEST_VERSION, uninstallQdTest, type QdTest } from './qdtest'

vi.mock('svelte-sonner', () => {
  const toast = Object.assign(() => 0, {
    error: () => 0,
    warning: () => 0,
    success: () => 0,
    dismiss: () => {},
  })
  return { toast }
})

type Fn = (...args: unknown[]) => unknown
/** The live `api` object (`initIpc()` swaps it for the mock, so it is read at call time). */
const apiRecord = (): Record<string, Fn> => api as unknown as Record<string, Fn>

async function boot(testMode: boolean): Promise<Bootstrap> {
  localStorage.clear()
  await initIpc()
  mockState.resetAll()
  mockState.loadAll()
  const fetched = await call(api.appBootstrap())
  const b: Bootstrap = { ...fetched, app: { ...fetched.app, testMode } }
  app.init(b)
  settings.init(b)
  i18n.init(b)
  quran.init(b)
  ui.init(b)
  player.init(b)
  reader.init(b)
  return b
}

function hooks(): QdTest {
  const h = window.__QD_TEST__
  if (!h) throw new Error('window.__QD_TEST__ is not installed')
  return h
}

/** A promise with its resolver, for commands that stay in flight until the test releases them. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

afterEach(() => {
  uninstallQdTest()
  vi.restoreAllMocks()
  reader.reset()
  player.reset()
  ui.reset()
  quran.reset()
  i18n.reset()
  settings.reset()
  app.reset()
})

describe('installQdTest', () => {
  it('does nothing outside test mode', async () => {
    await boot(false)
    const before = { ...apiRecord() }
    expect(installQdTest()).toBe(false)
    expect(window.__QD_TEST__).toBeUndefined()
    expect({ ...apiRecord() }).toEqual(before)
  })

  it('installs frozen hooks once and announces them', async () => {
    await boot(true)
    const ready = vi.fn()
    window.addEventListener('qd:test-ready', ready)
    expect(installQdTest()).toBe(true)
    expect(installQdTest()).toBe(true)
    window.removeEventListener('qd:test-ready', ready)
    expect(ready).toHaveBeenCalledTimes(1)
    expect(hooks().version).toBe(QD_TEST_VERSION)
    expect(Object.isFrozen(hooks())).toBe(true)
  })

  it('restores the original api functions on uninstall', async () => {
    await boot(true)
    const original = apiRecord().settingsGet
    installQdTest()
    expect(apiRecord().settingsGet).not.toBe(original)
    uninstallQdTest()
    expect(apiRecord().settingsGet).toBe(original)
    expect(window.__QD_TEST__).toBeUndefined()
  })
})

describe('IPC tracking and waitIdle', () => {
  beforeEach(async () => {
    await boot(true)
  })

  it('lists commands in flight and waits for them', async () => {
    const gate = deferred<void>()
    const original = mockCommands.windowReady
    mockCommands.windowReady = async () => {
      await gate.promise
      return { status: 'ok', data: null }
    }
    try {
      installQdTest()
      const pending = call(api.windowReady())
      expect(hooks().busy().ipc).toEqual(['windowReady'])
      expect(hooks().state().ipcPending).toEqual(['windowReady'])
      let idle = false
      const waiting = hooks()
        .waitIdle({ timeoutMs: 5000 })
        .then(() => (idle = true))
      await new Promise((r) => setTimeout(r, 150))
      expect(idle).toBe(false)
      gate.resolve()
      await pending
      await waiting
      expect(idle).toBe(true)
      expect(hooks().busy().ipc).toEqual([])
    } finally {
      mockCommands.windowReady = original
    }
  })

  it('passes results and errors through unchanged', async () => {
    installQdTest()
    const s = await call(api.settingsGet())
    expect(s.uiLanguage).toBe(settings.value.uiLanguage)
    vi.spyOn(mockCommands, 'settingsGet').mockResolvedValueOnce(err('database', 'disk full'))
    await expect(call(api.settingsGet())).rejects.toMatchObject({ kind: 'database', detail: 'disk full' })
    expect(hooks().busy().ipc).toEqual([])
  })

  it('times out with a description of what is still busy', async () => {
    const original = mockCommands.windowReady
    mockCommands.windowReady = () => new Promise(() => {})
    try {
      installQdTest()
      void api.windowReady()
      await expect(hooks().waitIdle({ timeoutMs: 120 })).rejects.toThrow(
        /still busy after 120 ms \(commands in flight: windowReady\)/,
      )
    } finally {
      mockCommands.windowReady = original
    }
  })
})

describe('navigation', () => {
  beforeEach(async () => {
    await boot(true)
    installQdTest()
  })

  it('jumps to a page and verifies that it is visible', async () => {
    const goToPage = vi.spyOn(reader, 'goToPage').mockImplementation((p) => {
      reader.page = p
    })
    ui.setView('settings')
    await hooks().goto({ type: 'page', data: { page: 262 } })
    expect(goToPage).toHaveBeenCalledWith(262, { push: true, transition: false })
    expect(ui.view).toBe('reader')
    expect(reader.visiblePages).toContain(262)
  })

  it('rejects when the reader does not show the target', async () => {
    vi.spyOn(reader, 'goToAyah').mockImplementation(() => {})
    reader.page = 1
    const target = quran.ayahId(2, 255)
    const page = quran.pageOfAyah(reader.layout, target)
    expect(reader.visiblePages).not.toContain(page)
    await expect(hooks().goto({ type: 'ayah', data: { ayahId: target } })).rejects.toThrow(
      `goto(ayah ${target}): expected page ${page} on screen`,
    )
  })

  it('validates targets before navigating', async () => {
    const goToPage = vi.spyOn(reader, 'goToPage')
    await expect(hooks().goto({ type: 'page', data: { page: 605 } })).rejects.toThrow(RangeError)
    await expect(hooks().goto({ type: 'surah', data: { surah: 0 } })).rejects.toThrow(RangeError)
    await expect(hooks().goto({ type: 'ayah', data: { ayahId: 1.5 } })).rejects.toThrow(RangeError)
    expect(goToPage).not.toHaveBeenCalled()
  })

  it('opens a surah at its first page', async () => {
    vi.spyOn(reader, 'goToSurah').mockImplementation((n) => {
      reader.page = quran.pageOfAyah(reader.layout, quran.surahRange(n).from)
    })
    await hooks().goto({ type: 'surah', data: { surah: 18 } })
    expect(reader.visiblePages).toContain(quran.pageOfAyah(reader.layout, quran.surahRange(18).from))
  })

  it('switches views', async () => {
    await hooks().goto({ type: 'view', data: { view: 'about' } })
    expect(ui.view).toBe('about')
    expect(hooks().state().view).toBe('about')
  })

  it('routes search targets through ui.navigate', async () => {
    const navigate = vi.spyOn(ui, 'navigate')
    await hooks().goto({ type: 'search', data: { query: 'الرحمن' } })
    expect(navigate).toHaveBeenCalledWith({ type: 'search', data: { query: 'الرحمن' } })
  })
})

describe('settings, audio, overlays, state', () => {
  beforeEach(async () => {
    await boot(true)
    installQdTest()
  })

  it('applies settings and rejects a reverted change', async () => {
    await hooks().setSettings({ theme: 'sepia', inkBrightnessPct: 80 })
    expect(settings.value.theme).toBe('sepia')
    expect(hooks().state().settings.inkBrightnessPct).toBe(80)
    vi.spyOn(settings, 'update').mockResolvedValueOnce(false)
    await expect(hooks().setSettings({ theme: 'night' })).rejects.toThrow(
      'the settings store reverted the change',
    )
  })

  it('sends the audio commands with their DTOs', async () => {
    const seek = vi.spyOn(apiRecord(), 'audioSeek').mockResolvedValue(ok(null))
    const pause = vi.spyOn(apiRecord(), 'audioPause').mockResolvedValue(ok(null))
    const play = vi.spyOn(apiRecord(), 'audioPlay').mockResolvedValue(ok(player.snapshot))
    const request = {
      reciterId: 7,
      from: { surah: 1, ayah: 2 },
      to: null,
      stopAt: null,
      layout: 'v2',
      ayahRepeat: 1,
      rangeRepeat: 1,
      gap: { type: 'none' },
      startPaused: true,
    } as const
    await hooks().play(request)
    await hooks().seek(1500)
    await hooks().pause()
    expect(play).toHaveBeenCalledWith(request)
    expect(seek).toHaveBeenCalledWith({ type: 'file_ms', data: { ms: 1500 } })
    expect(pause).toHaveBeenCalledWith()
    await expect(hooks().seek(-1)).rejects.toThrow(RangeError)
  })

  it('opens overlays with QA defaults and closes them all', () => {
    // The note editor's default target is the reader's action target: the cursor while it is on screen.
    reader.page = 1
    reader.cursorAyahId = 5
    expect(reader.visiblePages).toContain(1)
    hooks().openOverlay('confirm')
    hooks().openOverlay('note-editor')
    hooks().openOverlay('goto', { initial: '2:255' })
    expect(ui.overlays.map((o) => o.kind)).toEqual(['confirm', 'note-editor', 'goto'])
    expect(ui.overlays[0]?.props).toEqual({
      title: i18n.t('common.appName'),
      body: i18n.t('common.details'),
      confirmLabel: i18n.t('common.ok'),
    })
    expect(ui.overlays[1]?.props).toEqual({ fromAyahId: 5, toAyahId: 5 })
    expect(ui.overlays[2]?.props).toEqual({ initial: '2:255' })
    expect(hooks().state().overlays).toEqual(['confirm', 'note-editor', 'goto'])
    hooks().closeOverlays()
    expect(ui.overlays).toEqual([])
    expect(() => hooks().openOverlay('nope' as 'goto')).toThrow('unknown overlay kind')
  })

  it('reports a JSON snapshot of the app', () => {
    const s = hooks().state()
    expect(JSON.parse(JSON.stringify(s))).toEqual(s)
    expect(s).toMatchObject({
      version: QD_TEST_VERSION,
      testMode: true,
      view: 'reader',
      page: reader.page,
      style: settings.value.mushafStyle,
      locale: settings.value.uiLanguage,
      settings: { theme: settings.value.theme },
      player: { isPlaying: false },
      ipcPending: [],
    })
  })

  it('calls any command through ipc()', async () => {
    const s = await hooks().ipc('settingsGet')
    expect(s.theme).toBe(settings.value.theme)
    vi.spyOn(mockCommands, 'settingsGet').mockResolvedValueOnce(err('io', 'locked'))
    await expect(hooks().ipc('settingsGet')).rejects.toThrow('io: locked')
    await expect(hooks().ipc('noSuchCommand' as 'settingsGet')).rejects.toThrow('unknown command')
  })

  it('requests frames for the glide only while audio plays', () => {
    uninstallQdTest()
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')
    /** The sampler's own requests (its callback is `sampleGlide`; the player store animates with its own). */
    const sampled = () =>
      raf.mock.calls.flatMap(([cb], i) =>
        cb.name === 'sampleGlide' ? [raf.mock.results[i]?.value as number] : [],
      )
    installQdTest()
    flushSync()
    expect(raf).not.toHaveBeenCalled()
    const idle = player.snapshot
    expect(idle).not.toBeNull()
    if (!idle) return
    player.snapshot = { ...idle, status: 'playing' }
    flushSync()
    expect(sampled()).toHaveLength(1)
    player.snapshot = { ...idle, status: 'paused' }
    flushSync()
    expect(cancel).toHaveBeenCalledWith(sampled()[0])
    expect(sampled()).toHaveLength(1)
    // Switched off, playing requests nothing; switched on again while playing, it samples at once.
    hooks().sampleFrames(false)
    player.snapshot = { ...idle, status: 'playing' }
    flushSync()
    expect(sampled()).toHaveLength(1)
    hooks().sampleFrames(true)
    expect(sampled()).toHaveLength(2)
    hooks().sampleFrames(false)
    expect(cancel).toHaveBeenCalledWith(sampled()[1])
    expect(() => hooks().sampleFrames('no' as unknown as boolean)).toThrow('must be a boolean')
    player.snapshot = { ...idle, status: 'paused' }
    flushSync()
    hooks().sampleFrames(true) // not playing: nothing to sample
    expect(sampled()).toHaveLength(2)
    // Uninstalling stops watching: playing again requests nothing for the sampler.
    uninstallQdTest()
    player.snapshot = { ...idle, status: 'playing' }
    flushSync()
    expect(sampled()).toHaveLength(2)
  })

  it('reports the memory budgets’ counts: PageCache pages and QCF FontFaces per style', () => {
    // jsdom has no FontFaceSet: a stand-in with the families the app's registry adds (quoted, as Chromium reports).
    const families = ['"qcf-v2-p1"', 'qcf-v2-p2', '"qcf-v4-p50"', '"qd-hafs"', 'qcf-v2-decor']
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: new Set(families.map((family) => ({ family }))),
    })
    try {
      const m = hooks().metrics()
      expect(m.pageCacheSize).toBe(pages.size)
      expect(m.qcfFontFaces).toEqual({ v2: 2, v4: 1 })
    } finally {
      Reflect.deleteProperty(document, 'fonts')
    }
  })

  it('counts CSP violations in the metrics window', () => {
    const m0 = hooks().metrics()
    expect(m0).toMatchObject({ cls: 0, longTasks: 0, pageRenderMs: [], glideFps: 0, glideMaxFrameMs: 0 })
    expect(m0.cspViolations).toBe(0)
    document.dispatchEvent(new Event('securitypolicyviolation'))
    document.dispatchEvent(new Event('securitypolicyviolation'))
    expect(hooks().metrics().cspViolations).toBe(2)
    hooks().resetMetrics()
    expect(hooks().metrics().cspViolations).toBe(0)
  })
})
