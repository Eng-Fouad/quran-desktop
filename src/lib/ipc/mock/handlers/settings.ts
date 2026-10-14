/**
 * Mock handlers: settings. Mirrors the real commands (`commands/settings.rs`):
 * - `settings_set` validates like `Settings::validated()`, stores the result and answers it;
 * - `settings_reset` restores the defaults but keeps the fields user.db keeps (`RESET_PRESERVED`: UI language,
 *   onboarding, hints, the close-to-tray question);
 * - every successful write emits `settings-changed` with the stored value, and a change of `networkAllowed` emits
 *   `network-changed` like the pack manager's network gate.
 */
import type { GapSetting, Settings } from '../../bindings'
import { events } from '../../bindings'
import { type Handlers, handle } from '../result'
import { defaultSettings, SETTING_LIMITS } from '$lib/contracts/settings'
import { state } from '../state'

/** quran-types `limits::Bounds`: clamp, then round to the nearest `min + k·step` (ties up), never past `max`. */
function bound(v: number, { min, max, step }: { min: number; max: number; step: number }): number {
  const clamped = Math.min(max, Math.max(min, Number.isFinite(v) ? Math.trunc(v) : min))
  if (step <= 1) return clamped
  const rounded = min + Math.floor((clamped - min + Math.floor(step / 2)) / step) * step
  return Math.min(max, rounded)
}

function dedupe(items: readonly string[], max: number): string[] {
  const out: string[] = []
  for (const item of items) {
    if (out.length >= max) break
    if (item.trim() !== '' && !out.includes(item)) out.push(item)
  }
  return out
}

const nonEmpty = (id: string | null): string | null => (id !== null && id.trim() !== '' ? id : null)

function clampGap(gap: GapSetting): GapSetting {
  switch (gap.type) {
    case 'fixed':
      return { type: 'fixed', data: { ms: bound(gap.data.ms, SETTING_LIMITS.gapFixedMs) } }
    case 'multiplier':
      return { type: 'multiplier', data: { pct: bound(gap.data.pct, SETTING_LIMITS.gapMultiplierPct) } }
    default:
      return { type: 'none' }
  }
}

/** The TypeScript twin of `Settings::validated()`. */
export function validateSettings(input: Settings): Settings {
  const s = structuredClone(input)
  const L = SETTING_LIMITS
  s.uiScalePct = bound(s.uiScalePct, L.uiScalePct)
  s.inkBrightnessPct = bound(s.inkBrightnessPct, L.inkBrightnessPct)
  s.zoomPct = bound(s.zoomPct, L.zoomPct)
  s.translationFontPct = bound(s.translationFontPct, L.translationFontPct)
  s.sidePane.widthPx = bound(s.sidePane.widthPx, L.sidePaneWidthPx)
  s.sidebar.widthPx = bound(s.sidebar.widthPx, L.sidebarWidthPx)
  s.speedPct = bound(s.speedPct, L.speedPct)
  s.volumePct = bound(s.volumePct, L.volumePct)
  s.ayahRepeat = bound(s.ayahRepeat, L.repeat)
  s.rangeRepeat = bound(s.rangeRepeat, L.repeat)
  s.gap = clampGap(s.gap)
  s.streamCacheCapMib = bound(s.streamCacheCapMib, L.streamCacheCapMib)
  s.translations = dedupe(s.translations, L.maxTranslations)
  s.hintsSeen = dedupe(s.hintsSeen, Number.POSITIVE_INFINITY)
  s.wbwPackId = nonEmpty(s.wbwPackId)
  s.tafsirPackId = nonEmpty(s.tafsirPackId)
  s.copy.translationPackId = nonEmpty(s.copy.translationPackId)
  return s
}

/** `settings_reset` keeps these (`RESET_PRESERVED_KEYS`; the store's optimistic copy does the same). */
export function resetSettings(current: Settings): Settings {
  return {
    ...defaultSettings(),
    uiLanguage: current.uiLanguage,
    onboardingDone: current.onboardingDone,
    hintsSeen: [...current.hintsSeen],
    closeToTrayAsked: current.closeToTrayAsked,
  }
}

/** What `NetworkChanged.online` reports in the mock: network allowed and the browser online. */
export function mockOnline(settings: Settings): boolean {
  return settings.networkAllowed && (typeof navigator === 'undefined' || navigator.onLine)
}

async function commit(next: Settings): Promise<Settings> {
  const before = mockOnline(state.settings.value)
  const saved = state.settings.set(validateSettings(next))
  await events.settingsChanged.emit(structuredClone(saved))
  const online = mockOnline(saved)
  if (online !== before) await events.networkChanged.emit({ online })
  return structuredClone(saved)
}

export const settingsHandlers: Handlers<'settingsGet' | 'settingsSet' | 'settingsReset'> = {
  settingsGet: handle(() => structuredClone(state.settings.value)),
  settingsSet: handle((next: Settings) => commit(next)),
  settingsReset: handle(() => commit(resetSettings(state.settings.value))),
}
