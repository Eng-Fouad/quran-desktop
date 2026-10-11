import { afterEach, describe, expect, it } from 'vitest'
import { defaultSettings } from '$lib/contracts/settings'
import { api, call, initIpc } from '$lib/ipc'
import type { Settings } from '$lib/ipc/bindings'
import { state } from '$lib/ipc/mock/state'
import { app } from './app.svelte'
import { i18n, LRI, PDI, RLI } from './i18n.svelte'
import { settings } from './settings.svelte'

async function boot(stored?: Partial<Settings>): Promise<void> {
  localStorage.clear()
  await initIpc()
  state.resetAll()
  state.loadAll()
  if (stored) state.settings.set({ ...defaultSettings(), ...stored })
  const b = await call(api.appBootstrap())
  app.init(b)
  settings.init(b)
  i18n.init(b)
}

const ltr = (s: string) => `${LRI}${s}${PDI}`
const rtl = (s: string) => `${RLI}${s}${PDI}`

afterEach(() => {
  i18n.reset()
  settings.reset()
  app.reset()
})

describe('i18n store: messages', () => {
  it('follows the UI language live, with direction', async () => {
    await boot()
    expect(i18n.locale).toBe('en')
    expect(i18n.dir).toBe('ltr')
    expect(i18n.t('common.cancel')).toBe('Cancel')
    await settings.update({ uiLanguage: 'ar' })
    expect(i18n.locale).toBe('ar')
    expect(i18n.dir).toBe('rtl')
    expect(i18n.t('common.cancel')).toBe('إلغاء')
    expect(i18n.t('shortcuts.app.palette')).toBe('لوحة الأوامر')
  })

  it('formats numeric parameters with the UI digits', async () => {
    await boot()
    expect(i18n.t('common.pageNumber', { page: 262 })).toBe('Page 262')
    await settings.update({ uiLanguage: 'ar' })
    expect(i18n.t('common.pageNumber', { page: 262 })).toBe('الصفحة ٢٦٢')
    // A pre-formatted string is left alone.
    expect(i18n.t('common.pageNumber', { page: '٢٦١–٢٦٢' })).toBe('الصفحة ٢٦١–٢٦٢')
    await settings.update({ digits: 'latin' })
    expect(i18n.t('common.pageNumber', { page: 262 })).toBe('الصفحة 262')
  })

  it('pluralises with the language rules and localised counts', async () => {
    await boot()
    expect(i18n.tp('common.ayahCount', 1)).toBe('1 ayah')
    expect(i18n.tp('common.ayahCount', 1234)).toBe('1,234 ayahs')
    await settings.update({ uiLanguage: 'ar' })
    expect(i18n.tp('common.ayahCount', 0)).toBe('لا آيات')
    expect(i18n.tp('common.ayahCount', 2)).toBe('آيتان')
    expect(i18n.tp('common.ayahCount', 7)).toBe('٧ آيات')
    expect(i18n.tp('common.ayahCount', 11)).toBe('١١ آية')
  })
})

describe('i18n store: numbers and references (§11.2, §11.3)', () => {
  it('formats UI numbers per the digits setting, Mushaf numbers always Eastern Arabic', async () => {
    await boot()
    expect(i18n.num(1234)).toBe('1,234')
    expect(i18n.mushafNum(262)).toBe('٢٦٢')
    expect(i18n.mushafNum(1000)).toBe('١٠٠٠')
    await settings.update({ digits: 'arabic_indic' })
    expect(i18n.num(1234)).toBe('١٬٢٣٤')
    expect(i18n.mushafNum(262)).toBe('٢٦٢')
  })

  it('isolates references: LRI…PDI for Western Arabic numbers, RLI…PDI for Eastern Arabic', async () => {
    await boot()
    expect(i18n.ref(2, 255)).toBe(ltr('2:255'))
    expect(i18n.ref(2, 255, 257)).toBe(ltr('2:255–257'))
    expect(i18n.ref(2, 255, 255)).toBe(ltr('2:255'))
    expect(i18n.ref(2, 286, 2, 3)).toBe(ltr('2:286–3:2'))
    expect(i18n.ref(114, 1000)).toBe(ltr('114:1000'))
    await settings.update({ uiLanguage: 'ar' })
    expect(i18n.ref(2, 255)).toBe(rtl('٢:٢٥٥'))
    expect(i18n.ref(2, 255, 257)).toBe(rtl('٢:٢٥٥–٢٥٧'))
    await settings.update({ digits: 'latin' })
    expect(i18n.ref(2, 255)).toBe(ltr('2:255'))
  })

  it('writes fractions in UI digits: ¼ ½ ¾ with Western Arabic numbers, n/d with Eastern Arabic', async () => {
    await boot()
    expect([i18n.fraction(1, 4), i18n.fraction(1, 2), i18n.fraction(3, 4)]).toEqual(['¼', '½', '¾'])
    expect(i18n.fraction(2, 3)).toBe('2/3')
    await settings.update({ uiLanguage: 'ar' })
    // Numerator first, no isolates or marks: the solidus joins the two digits into one left-to-right number.
    expect([i18n.fraction(1, 4), i18n.fraction(1, 2), i18n.fraction(3, 4)]).toEqual(['١/٤', '١/٢', '٣/٤'])
    expect(i18n.t('memo.panel.presets.gapHalf', { half: i18n.fraction(1, 2) })).toBe('×١/٢')
    await settings.update({ digits: 'latin' })
    expect(i18n.fraction(1, 2)).toBe('½')
    await settings.update({ uiLanguage: 'en', digits: 'arabic_indic' })
    expect(i18n.fraction(3, 4)).toBe('٣/٤')
  })

  it('formats sizes from KiB', async () => {
    await boot()
    expect(i18n.bytes(512)).toBe('512 kB')
    expect(i18n.bytes(1536)).toBe('1.5 MB')
    expect(i18n.bytes(20 * 1024)).toBe('20 MB')
    expect(i18n.bytes(1.5 * 1024 * 1024)).toBe('1.5 GB')
    expect(i18n.bytes(-5)).toBe('0 kB')
    expect(i18n.bytes(Number.NaN)).toBe('0 kB')
    await settings.update({ uiLanguage: 'ar' })
    expect(i18n.bytes(1536)).toMatch(/^١٫٥\s/u)
  })

  it('spells every Arabic size step in one style, abbreviated alike (ك.ب / م.ب / غ.ب / ت.ب)', async () => {
    await boot()
    await settings.update({ uiLanguage: 'ar' })
    const steps = [507, 15 * 1024, 2.5 * 1024 ** 2, 3 * 1024 ** 3].map((kib) => i18n.bytes(kib))
    // CLDR's short forms mix the word «كيلوبايت» with «م.ب» and «غ.ب»: never the word beside abbreviations.
    for (const s of steps) {
      expect(s).not.toMatch(/بايت/u)
      expect(s).toMatch(/^[٠-٩٫]+\s.\.ب$/u)
    }
    expect(new Set(steps.map((s) => s.replace(/^[٠-٩٫]+\s/u, ''))).size).toBe(4)
    // English keeps the short forms with a space.
    await settings.update({ uiLanguage: 'en' })
    expect([507, 15 * 1024, 2.5 * 1024 ** 2].map((kib) => i18n.bytes(kib))).toEqual([
      '507 kB',
      '15 MB',
      '2.5 GB',
    ])
  })

  it('spells other units out in Arabic, where the short forms read as broken words («ملي ث»)', async () => {
    await boot()
    expect(i18n.unitDisplay).toBe('short')
    await settings.update({ uiLanguage: 'ar' })
    expect(i18n.unitDisplay).toBe('long')
    const ms = new Intl.NumberFormat(i18n.intlLocale, {
      style: 'unit',
      unit: 'millisecond',
      unitDisplay: i18n.unitDisplay,
    }).format(243)
    expect(ms).toMatch(/ثانية$/u)
  })

  it('formats durations as m:ss and h:mm:ss', async () => {
    await boot()
    expect(i18n.duration(0)).toBe('0:00')
    expect(i18n.duration(65_400)).toBe('1:05')
    expect(i18n.duration(3_725_000)).toBe('1:02:05')
    expect(i18n.duration(-1)).toBe('0:00')
    await settings.update({ uiLanguage: 'ar' })
    expect(i18n.duration(65_000)).toBe('١:٠٥')
  })

  it('formats relative times and dates', async () => {
    await boot()
    const now = Date.UTC(2026, 9, 10, 12)
    const ago = (secs: number) => i18n.relTime(now / 1000 - secs, now)
    expect(ago(10)).toBe('now')
    expect(ago(5 * 60)).toBe('5 minutes ago')
    expect(ago(3 * 3600)).toBe('3 hours ago')
    expect(ago(86_400)).toBe('yesterday')
    expect(ago(9 * 86_400)).toBe('9 days ago')
    expect(ago(90 * 86_400)).toBe('3 months ago')
    expect(ago(800 * 86_400)).toBe('2 years ago')
    expect(i18n.relTime(now / 1000 + 2 * 3600, now)).toBe('in 2 hours')
    expect(i18n.date(now / 1000)).toBe('Oct 10, 2026')
    await settings.update({ uiLanguage: 'ar' })
    expect(ago(3 * 86_400)).toBe('قبل ٣ أيام')
  })
})
