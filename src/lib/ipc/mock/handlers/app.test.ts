import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockRuntime } from '../index'
import { state } from '../state'
import { appHandlers, CORE_MISSING_MESSAGE } from './app'

function setSearch(search: string): void {
  window.history.replaceState(null, '', `/${search}`)
}

beforeEach(async () => {
  localStorage.clear()
  setSearch('')
  await installMockRuntime()
  state.resetAll()
  state.loadAll()
})

afterEach(() => {
  setSearch('')
  vi.restoreAllMocks()
})

describe('app mock handlers', () => {
  it('assembles the bootstrap from the state slices', async () => {
    const r = await appHandlers.appBootstrap()
    if (r.status !== 'ok') throw new Error('bootstrap failed')
    expect(r.data.app.name).toBe('Quran')
    expect(r.data.app.protocolBase).toBe('/__packs/')
    expect(r.data.settings).toEqual(state.settings.value)
    expect(r.data.settings).not.toBe(state.settings.value)
    expect(r.data.index.surahs).toHaveLength(114)
    expect(r.data.notices).toEqual([])
    expect(r.data.app.testMode).toBe(false)
  })

  it('simulates startup notices, test mode and bootstrap failures from the URL', async () => {
    setSearch('?qdtest&mockNotice=user_db_recovered&mockNotice=content_db_recovered')
    let r = await appHandlers.appBootstrap()
    if (r.status !== 'ok') throw new Error('bootstrap failed')
    expect(r.data.app.testMode).toBe(true)
    expect(r.data.notices.map((n) => n.type)).toEqual(['user_db_recovered', 'content_db_recovered'])

    setSearch('?mockFatal=core')
    r = await appHandlers.appBootstrap()
    expect(r).toEqual({ status: 'error', error: { kind: 'not_found', message: CORE_MISSING_MESSAGE } })
    setSearch('?mockFatal=database')
    r = await appHandlers.appBootstrap()
    expect(r.status === 'error' && r.error.kind).toBe('database')
    setSearch('?mockFatal=nonsense')
    r = await appHandlers.appBootstrap()
    expect(r.status === 'error' && r.error.kind).toBe('internal')
  })

  it('answers window_set_chrome like a window without a backdrop, unless ?mockMica', async () => {
    expect(await appHandlers.windowSetChrome({ dark: false, effect: 'off' })).toEqual({
      status: 'ok',
      data: null,
    })
    const auto = await appHandlers.windowSetChrome({ dark: true, effect: 'auto' })
    expect(auto.status === 'error' && auto.error.kind).toBe('unsupported')
    setSearch('?mockMica')
    expect(await appHandlers.windowSetChrome({ dark: true, effect: 'auto' })).toEqual({
      status: 'ok',
      data: null,
    })
  })

  it('opens only https and mailto links', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    expect((await appHandlers.systemOpenExternal('https://tanzil.net')).status).toBe('ok')
    expect((await appHandlers.systemOpenExternal('mailto:x@example.com')).status).toBe('ok')
    const bad = await appHandlers.systemOpenExternal('file:///etc/passwd')
    expect(bad.status === 'error' && bad.error.kind).toBe('invalid_argument')
    expect((await appHandlers.systemRevealDataDir()).status).toBe('ok')
  })
})
