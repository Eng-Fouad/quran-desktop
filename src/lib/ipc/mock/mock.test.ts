import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Channel } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { commands, events, type AudioTick, type Settings } from '../bindings'
import { installMockRuntime, mockCommands } from './index'
import { err, handle, MockError, ok, send, unsupported } from './result'
import { listenerCounts } from './runtime'
import { defaultSettings, mergeDefaults, Slice, state, STORAGE_PREFIX } from './state'
import { validateSettings } from './handlers/settings'

const unwrap = async <T>(
  p: Promise<{ status: 'ok'; data: T } | { status: 'error'; error: unknown }>,
): Promise<T> => {
  const r = await p
  if (r.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(r.error)}`)
  return r.data
}

// These tests pin the command contract (shapes, validation, state, events), never the stub details of a handler, so
// each handler can implement its commands without touching this file.
beforeEach(async () => {
  localStorage.clear()
  await installMockRuntime()
  state.resetAll()
  state.loadAll()
})

describe('mockCommands', () => {
  it('implements exactly the generated command set', () => {
    expect(Object.keys(mockCommands).sort()).toEqual(Object.keys(commands).sort())
    expect(Object.keys(mockCommands)).toHaveLength(92)
  })

  it('answers asynchronously with the result shape', async () => {
    let settled = false
    const p = mockCommands.windowReady().then((r) => {
      settled = true
      return r
    })
    expect(settled).toBe(false)
    await expect(p).resolves.toEqual({ status: 'ok', data: null })
  })

  it('assembles a Bootstrap from the slices and the synthetic index', async () => {
    const b = await unwrap(mockCommands.appBootstrap())
    expect(b.app).toMatchObject({
      name: 'Quran',
      identifier: 'com.quran.labs.desktop',
      fontTransport: 'url',
    })
    expect(b.index.surahs).toHaveLength(114)
    expect(b.settings).toEqual(defaultSettings())
    expect(b.firstRun).toBe(true)
    expect(b.audio.status).toBe('idle')
    expect(b.reciters.some((r) => r.id === 7)).toBe(true)
    expect(b.packs.length).toBeGreaterThan(30)
    expect(b.decor.installed).toBe(false)
    b.settings.uiLanguage = 'ar'
    expect(state.settings.value.uiLanguage).toBe('en')
  })

  it('serves synthetic pages and validates the page list', async () => {
    const data = await unwrap(mockCommands.mushafGetPages('qcf_v2', [261, 262]))
    expect(data.map((p) => [p.page, p.style, p.layout])).toEqual([
      [261, 'qcf_v2', 'v2'],
      [262, 'qcf_v2', 'v2'],
    ])
    await expect(mockCommands.mushafGetPages('hafs', [0])).resolves.toMatchObject({
      status: 'error',
      error: { kind: 'invalid_argument' },
    })
    await expect(mockCommands.mushafGetPages('hafs', [1, 2, 3, 4, 5, 6, 7, 8, 9])).resolves.toMatchObject({
      status: 'error',
      error: { kind: 'invalid_argument' },
    })
  })

  it('answers hafs fonts as ready without IO', async () => {
    const [hafs] = await unwrap(mockCommands.mushafEnsurePageFonts('hafs', [1], 'interactive'))
    expect(hafs).toEqual({
      style: 'hafs',
      page: 1,
      availability: 'ready',
      family: 'qd-hafs',
      url: null,
      rel: null,
      bytes: 0,
    })
  })

  it('returns ayahs, timings and empty user marks', async () => {
    const ayahs = await unwrap(mockCommands.quranGetAyahs('v1', 1, 7))
    expect(ayahs.map((a) => a.ayah)).toEqual([1, 2, 3, 4, 5, 6, 7])
    const timings = await unwrap(mockCommands.audioGetTimings(7, 112))
    expect(timings.ayahs).toHaveLength(4)
    const marks = await unwrap(mockCommands.userMarks('v2', 1, 7, [1]))
    expect(marks).toEqual({
      bookmarks: [],
      pageBookmarks: [],
      highlights: [],
      notes: [],
      readingAyahId: null,
    })
  })

  it('keeps the audio and packs channels it is given', async () => {
    const ticks: AudioTick[] = []
    const channel = new Channel<AudioTick>((t) => ticks.push(t))
    const snapshot = await unwrap(mockCommands.audioSubscribe(channel))
    expect(snapshot.status).toBe('idle')
    send(channel, { ...({} as AudioTick), seq: 1 })
    expect(ticks).toHaveLength(1)
    await expect(unwrap(mockCommands.packsSubscribe(new Channel()))).resolves.toEqual([])
  })

  it('records positions and search history', async () => {
    await unwrap(
      mockCommands.positionSet({
        context: 'mushaf',
        layout: 'v2',
        page: 262,
        ayahId: 1802,
        scrollPx: null,
        updatedAt: 0,
      }),
    )
    const b = await unwrap(mockCommands.appBootstrap())
    expect(b.positions).toMatchObject([{ context: 'mushaf', page: 262, ayahId: 1802 }])
    expect(b.positions[0]?.updatedAt).toBeGreaterThan(0)
    await unwrap(mockCommands.searchHistoryAdd('الرحمن', { type: 'quran' }))
    await unwrap(mockCommands.searchHistoryAdd('الرحمن', { type: 'quran' }))
    const history = await unwrap(mockCommands.searchHistoryList(10))
    expect(history).toMatchObject([{ query: 'الرحمن', useCount: 2 }])
  })
})

describe('settings round trip', () => {
  it('validates, persists and emits settings-changed', async () => {
    const seen: Settings[] = []
    const unlisten = await events.settingsChanged.listen((e) => seen.push(e.payload))
    const next = { ...defaultSettings(), uiScalePct: 155, speedPct: 123, translations: ['a', 'a', ' ', 'b'] }
    const saved = await unwrap(mockCommands.settingsSet(next))
    expect(saved).toMatchObject({ uiScalePct: 160, speedPct: 125, translations: ['a', 'b'] })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.uiScalePct).toBe(160)
    expect(JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}settings`) ?? '{}')).toMatchObject({
      uiScalePct: 160,
    })
    await unlisten()
    await unwrap(mockCommands.settingsReset())
    expect(seen).toHaveLength(1)
    expect(state.settings.value).toEqual(defaultSettings())
  })

  it('mirrors Settings::validated()', () => {
    const s = validateSettings({
      ...defaultSettings(),
      uiScalePct: 75,
      inkBrightnessPct: 101,
      zoomPct: 304,
      speedPct: 52,
      volumePct: 300,
      ayahRepeat: 120,
      gap: { type: 'fixed', data: { ms: 40_000 } },
      streamCacheCapMib: 10,
      wbwPackId: '  ',
      hintsSeen: ['page_turn', 'page_turn'],
    })
    expect(s).toMatchObject({
      uiScalePct: 80,
      inkBrightnessPct: 100,
      zoomPct: 300,
      speedPct: 50,
      volumePct: 100,
      ayahRepeat: 99,
      gap: { type: 'fixed', data: { ms: 30_000 } },
      streamCacheCapMib: 256,
      wbwPackId: null,
      hintsSeen: ['page_turn'],
    })
    expect(validateSettings(s)).toEqual(s)
  })
})

describe('runtime', () => {
  it('delivers events and really removes unlistened handlers', async () => {
    const warn = vi.spyOn(console, 'warn')
    const got: unknown[] = []
    const off = await listen<{ n: number }>('qd-test', (e) => got.push(e.payload))
    await emit('qd-test', { n: 1 })
    await off()
    await emit('qd-test', { n: 2 })
    expect(got).toEqual([{ n: 1 }])
    expect(listenerCounts()['qd-test']).toBe(0)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('answers plugin fallbacks and rejects unknown commands by name', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    await expect(invoke('plugin:window|minimize')).resolves.toBeNull()
    await expect(invoke('plugin:window|is_fullscreen')).resolves.toBe(false)
    await expect(invoke('plugin:dialog|save')).resolves.toBe('C:/mock/backup.qdb')
    await expect(invoke('plugin:dialog|open')).resolves.toBeNull()
    await expect(invoke('app_bootstrap')).rejects.toThrow('app_bootstrap')
  })

  it('closing the window asks the page to quit, as Rust does (quit-requested)', async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const got: unknown[] = []
    const off = await events.quitRequested.listen((e) => got.push(e.payload))
    await getCurrentWindow().close()
    off()
    expect(got).toEqual([null])
  })
})

describe('result helpers', () => {
  it('wraps values, MockErrors and bugs', async () => {
    expect(ok(1)).toEqual({ status: 'ok', data: 1 })
    expect(err('offline', 'x')).toEqual({ status: 'error', error: { kind: 'offline', message: 'x' } })
    await expect(handle(() => 2)()).resolves.toEqual({ status: 'ok', data: 2 })
    await expect(
      handle(() => {
        throw new MockError('not_found', 'gone')
      })(),
    ).resolves.toEqual({ status: 'error', error: { kind: 'not_found', message: 'gone' } })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      handle(() => {
        throw new TypeError('bug')
      })(),
    ).resolves.toEqual({ status: 'error', error: { kind: 'internal', message: 'bug' } })
    error.mockRestore()
    await expect(unsupported('x', 'not ready')).resolves.toMatchObject({
      error: { kind: 'unsupported', message: 'not ready: x (browser mock)' },
    })
  })
})

describe('state', () => {
  it('matches the Rust Settings::default() snapshot', () => {
    // vitest runs from the repository root.
    const file = resolve(process.cwd(), 'crates/quran-types/tests/data/settings_default.json')
    expect(defaultSettings()).toEqual(JSON.parse(readFileSync(file, 'utf8')))
  })

  it('merges stored values over defaults and rejects the wrong kind', () => {
    const initial = { a: 1, nested: { b: 2, c: 3 }, list: [1] }
    expect(mergeDefaults(initial, { nested: { b: 9 }, list: [4, 5] })).toEqual({
      a: 1,
      nested: { b: 9, c: 3 },
      list: [4, 5],
    })
    expect(mergeDefaults(initial, [1, 2])).toBeNull()
    expect(mergeDefaults([1], { a: 1 })).toBeNull()
  })

  it('mirrors a slice to localStorage and survives corrupt storage', () => {
    const slice = new Slice('search', () => ({ history: [] as string[] }))
    slice.update((s) => s.history.push('x'))
    expect(localStorage.getItem(`${STORAGE_PREFIX}search`)).toBe('{"history":["x"]}')
    localStorage.setItem(`${STORAGE_PREFIX}search`, '{not json')
    slice.load()
    expect(slice.value).toEqual({ history: [] })
    expect(slice.fromStorage).toBe(false)
    localStorage.setItem(`${STORAGE_PREFIX}search`, '{"history":["y"]}')
    slice.load()
    expect(slice.fromStorage).toBe(true)
    expect(slice.value).toEqual({ history: ['y'] })
    slice.reset()
    expect(localStorage.getItem(`${STORAGE_PREFIX}search`)).toBeNull()
  })
})
