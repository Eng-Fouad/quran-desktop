import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, SETTING_LIMITS } from '$lib/contracts/settings'
import { events, type Settings } from '../../bindings'
import { installMockRuntime } from '../index'
import { state } from '../state'
import { mockOnline, resetSettings, settingsHandlers, validateSettings } from './settings'

beforeEach(async () => {
  localStorage.clear()
  await installMockRuntime()
  state.resetAll()
  state.loadAll()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('settings mock handlers', () => {
  it('validates like Settings::validated()', () => {
    const s = validateSettings({
      ...defaultSettings(),
      uiScalePct: 205,
      inkBrightnessPct: 10,
      speedPct: 123,
      translations: ['a', 'a', ' ', 'b', 'c', 'd', 'e', 'f'],
      wbwPackId: '  ',
      sidebar: { ...defaultSettings().sidebar, widthPx: 9999 },
    })
    expect(s.uiScalePct).toBe(SETTING_LIMITS.uiScalePct.max)
    expect(s.inkBrightnessPct).toBe(SETTING_LIMITS.inkBrightnessPct.min)
    expect(s.speedPct).toBe(125)
    expect(s.translations).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(s.wbwPackId).toBeNull()
    expect(s.sidebar.widthPx).toBe(SETTING_LIMITS.sidebarWidthPx.max)
  })

  it('stores the validated value and emits settings-changed', async () => {
    const seen: unknown[] = []
    const stop = await events.settingsChanged.listen((e) => seen.push(e.payload))
    const r = await settingsHandlers.settingsSet({ ...defaultSettings(), zoomPct: 1000 })
    stop()
    expect(r.status).toBe('ok')
    expect(state.settings.value.zoomPct).toBe(SETTING_LIMITS.zoomPct.max)
    expect(seen).toEqual([state.settings.value])
  })

  it('emits network-changed when network use is switched', async () => {
    const seen: boolean[] = []
    const stop = await events.networkChanged.listen((e) => seen.push(e.payload.online))
    await settingsHandlers.settingsSet({ ...defaultSettings(), networkAllowed: false })
    await settingsHandlers.settingsSet({ ...defaultSettings(), networkAllowed: false, accent: 'rose' })
    await settingsHandlers.settingsSet({ ...defaultSettings(), networkAllowed: true })
    stop()
    expect(seen).toEqual([false, true])
    expect(mockOnline({ ...defaultSettings(), networkAllowed: false })).toBe(false)
  })

  it('resets to the defaults but keeps what user.db keeps', async () => {
    const kept: Pick<Settings, 'uiLanguage' | 'onboardingDone' | 'hintsSeen' | 'closeToTrayAsked'> = {
      uiLanguage: 'ar',
      onboardingDone: true,
      hintsSeen: ['page_turn'],
      closeToTrayAsked: true,
    }
    state.settings.set({ ...defaultSettings(), ...kept, theme: 'black', zoomPct: 150 })
    const r = await settingsHandlers.settingsReset()
    expect(r).toEqual({ status: 'ok', data: { ...defaultSettings(), ...kept } })
    expect(resetSettings(state.settings.value)).toEqual(state.settings.value)
  })
})
