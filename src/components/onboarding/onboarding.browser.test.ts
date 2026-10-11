/**
 * The onboarding (§9.7) in a real browser against the IPC mock: the five steps, the live language and theme switch,
 * the Mushaf step (the 1421 AH print and the ornate surah headers preselected, its live preview and what that preview
 * fetches), the exact starter set of §2.5.4 (and its total) for each choice, Work offline disabling every download,
 * "Download now" and "Start reading", and how the dialog ends: Finish only on a first run, Skip or Escape on a re-run.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import { defaultSettings } from '$lib/contracts/settings'
import { api, call, initIpc } from '$lib/ipc'
import type { Settings } from '$lib/ipc/bindings'
import { packsMock } from '$lib/ipc/mock/handlers/packs'
import { state } from '$lib/ipc/mock/state'
import { app, fonts, initStores, packs, player, quran, resetStores, settings, ui } from '$lib/stores'
import { flow, STEPS } from './flow.svelte'
import OnboardingDialog from './OnboardingDialog.svelte'

const DIALOG = '[role="dialog"].qd-onboarding'
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)]
const action = (name: string) => $<HTMLButtonElement>(`${DIALOG} [data-action="${name}"]`)
const heading = () => $(`${DIALOG} [data-step-heading]`)?.textContent?.trim()
const rows = () => $$(`${DIALOG} [data-pack]`).map((r) => `${r.dataset.pack}:${r.dataset.fetch}`)
const totalKib = () => Number($(`${DIALOG} [data-total-kib]`)?.dataset.totalKib ?? NaN)

async function settle(ms = 60): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms))
  flushSync()
}

async function until(done: () => boolean, timeoutMs = 5_000): Promise<void> {
  const end = performance.now() + timeoutMs
  while (!done()) {
    if (performance.now() > end) throw new Error('timed out')
    await settle(30)
  }
}

/**
 * Opens the dialog over a fresh mock. `firstRun` (default true) is the first-run tour, which must be finished; false is
 * a tour reopened from Settings › System. `ensureDecor` is stubbed (the preview's ornaments request), so the totals do
 * not depend on whether `data/dev-packs` is served.
 */
async function mount(options: { settings?: Partial<Settings>; firstRun?: boolean } = {}): Promise<void> {
  await page.viewport(1400, 900)
  history.replaceState(null, '', '/')
  localStorage.clear()
  await initIpc()
  packsMock.reset()
  packsMock.setRate(50_000)
  state.resetAll()
  state.loadAll()
  state.settings.set({ ...defaultSettings(), ...options.settings })
  await initStores(await call(api.appBootstrap()))
  await until(() => packs.list.length > 0)
  app.firstRun = options.firstRun ?? true
  vi.spyOn(fonts, 'ensureDecor').mockResolvedValue(undefined)
  flow.reset()
  ui.open('onboarding', {})
  render(OnboardingDialog)
  await until(() => $(DIALOG) !== null)
  await settle(100)
}

async function next(): Promise<void> {
  await userEvent.click(action('next') as HTMLElement)
  await settle(80)
}

async function back(): Promise<void> {
  await userEvent.click(action('back') as HTMLElement)
  await settle(80)
}

/** Moves to the starter-set step (from step 1). */
async function toSummary(): Promise<void> {
  await next()
  await next()
  await next()
  await until(() => flow.stepId === 'summary')
}

/** The live preview of the Mushaf step. */
const preview = () => $(`${DIALOG} [data-ob-preview]`)
const checked = (option: string) => $<HTMLInputElement>(`${DIALOG} [data-option="${option}"]`)?.checked

afterEach(() => {
  flow.reset()
  resetStores()
  packsMock.reset()
  history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

describe('onboarding dialog', () => {
  it('opens on the welcome step over the page: 720 × 540, faint backdrop, Match system selected', async () => {
    await mount()
    const dialog = $(DIALOG) as HTMLElement
    const box = dialog.getBoundingClientRect()
    expect(Math.round(box.width)).toBe(720)
    expect(Math.round(box.height)).toBe(540)
    expect(getComputedStyle($('.backdrop') as HTMLElement).backgroundColor).toBe('rgba(0, 0, 0, 0.18)')
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    // No second banner (or a contentinfo) landmark inside the dialog (HTML-AAM: header/footer outside sections).
    expect(dialog.querySelectorAll('header, footer')).toHaveLength(0)
    expect(heading()).toBe('Welcome to Quran for Desktop')
    expect($(`${DIALOG} .step-label`)?.textContent?.trim()).toBe('Step 1 of 5')
    // A first run must be finished: no Skip.
    expect(action('skip')).toBeNull()
    expect($$(`${DIALOG} [data-theme-choice]`).map((c) => c.dataset.themeChoice)).toEqual([
      'system',
      'paper',
      'sepia',
      'night',
      'black',
    ])
    expect($(`${DIALOG} [data-theme-choice="system"]`)?.getAttribute('aria-checked')).toBe('true')
    // The title takes focus, so the step is read first.
    expect(document.activeElement?.hasAttribute('data-step-heading')).toBe(true)
    expect(action('back')).toBeNull()
  })

  for (const lang of ['en', 'ar'] as const) {
    it(`fits every step in the 720 × 540 dialog without scrolling (${lang})`, async () => {
      await mount({ settings: { uiLanguage: lang } })
      document.documentElement.lang = lang
      document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'
      await document.fonts.ready
      const overflow: string[] = []
      for (let step = 0; step < STEPS.length; step++) {
        flow.go(step)
        await settle(400)
        const body = $(`${DIALOG} > .body`) as HTMLElement
        if (body.scrollHeight > body.clientHeight) {
          overflow.push(`${flow.stepId}: ${body.scrollHeight} > ${body.clientHeight}`)
        }
      }
      expect(overflow).toEqual([])
      // Step 1's theme cards end inside the body, above the footer's divider.
      flow.go(0)
      await settle(400)
      const bodyBox = ($(`${DIALOG} > .body`) as HTMLElement).getBoundingClientRect()
      for (const card of $$(`${DIALOG} [data-theme-choice]`)) {
        expect(card.getBoundingClientRect().bottom).toBeLessThanOrEqual(bodyBox.bottom)
      }
    })
  }

  it('renders page 1 in each theme on its card', async () => {
    await mount()
    await until(() => $$(`${DIALOG} [data-theme-choice] section.mp[data-page="1"]`).length === 6)
    const paper = (theme: string) =>
      $$(`${DIALOG} [data-theme-choice="${theme}"] .mp-paper`).map((p) => getComputedStyle(p).backgroundColor)
    expect(paper('paper')).toEqual(['rgb(253, 248, 236)'])
    expect(paper('sepia')).toEqual(['rgb(246, 234, 210)'])
    expect(paper('night')).toEqual(['rgb(26, 28, 31)'])
    expect(paper('black')).toEqual(['rgb(0, 0, 0)'])
    // Match system: the light and the dark variant.
    expect(paper('system')).toEqual(['rgb(253, 248, 236)', 'rgb(26, 28, 31)'])
    // Thumbnails are decorative and inert.
    for (const mp of $$(`${DIALOG} [data-theme-choice] section.mp`)) {
      expect(mp.getAttribute('aria-hidden')).toBe('true')
      expect(mp.hasAttribute('inert')).toBe(true)
    }
  })

  it('switches the language live and mirrors the dialog', async () => {
    await mount()
    const arabic = $$(`${DIALOG} button`).find((b) =>
      b.textContent?.trim().startsWith('العربية'),
    ) as HTMLElement
    await userEvent.click(arabic)
    await until(() => settings.value.uiLanguage === 'ar')
    await settle(80)
    expect(heading()).toBe('مرحبًا بك في «قرآن لسطح المكتب»')
    expect(getComputedStyle($(DIALOG) as HTMLElement).direction).toBe('rtl')
    expect(document.documentElement.dir).toBe('rtl')
  })

  it('applies a theme card at once; arrow keys move the choice', async () => {
    await mount()
    await userEvent.click($(`${DIALOG} [data-theme-choice="sepia"]`) as HTMLElement)
    await until(() => settings.value.theme === 'sepia')
    expect(document.documentElement.dataset.theme).toBe('sepia')
    ;($(`${DIALOG} [data-theme-choice="sepia"]`) as HTMLElement).focus()
    await userEvent.keyboard('{ArrowRight}')
    await until(() => settings.value.theme === 'night')
    expect(document.activeElement?.getAttribute('data-theme-choice')).toBe('night')
    await userEvent.keyboard('{Home}')
    await until(() => settings.value.theme === 'system')
  })
})

describe('the Mushaf step (owner 2026-10-11)', () => {
  afterEach(() => {
    fonts.status.delete('qd-surah-header')
    fonts.status.delete('qd-quran-common')
    fonts.v4Supported = null
  })

  it('preselects the Madani 1421 AH print with ornate surah headers, for every style', async () => {
    await mount()
    await next()
    expect(heading()).toBe('Choose your Mushaf')
    expect($(`${DIALOG} .step-label`)?.textContent?.trim()).toBe('Step 2 of 5')
    expect($(`${DIALOG} [data-style-choice="qcf_v2"]`)?.getAttribute('aria-checked')).toBe('true')
    expect(checked('ornaments')).toBe(true)
    expect(checked('all-pages')).toBe(false)
    // Every card offers the ornaments; only a QCF card offers every page.
    await userEvent.click($(`${DIALOG} [data-style-choice="hafs"]`) as HTMLElement)
    expect(checked('ornaments')).toBe(true)
    expect($(`${DIALOG} [data-option="all-pages"]`)).toBeNull()
    await userEvent.click($(`${DIALOG} [data-style-choice="qcf_v4"]`) as HTMLElement)
    expect(checked('ornaments')).toBe(true)
    expect(checked('all-pages')).toBe(false)
  })

  it('previews the chosen style and headers live, without touching the settings', async () => {
    await mount()
    await next()
    await until(() => preview()?.querySelector('section.mp[data-page="1"][data-style="qcf_v2"]') != null)
    expect(preview()?.querySelector('[data-preview]')?.getAttribute('aria-label')).toBe(
      'Preview of the first page',
    )
    expect(preview()?.textContent).toContain('Madani print, 1421 AH · Ornate headers')
    await userEvent.click($(`${DIALOG} [data-style-choice="hafs"]`) as HTMLElement)
    await until(() => preview()?.querySelector('section.mp[data-style="hafs"]') != null)
    expect(preview()?.dataset.style).toBe('hafs')
    // The header calligraphy once its face is loaded; unticking draws the plain cartouche at once, re-ticking brings
    // it back.
    const header = () => preview()?.querySelector<HTMLElement>('.sh-line')
    expect(header()?.hasAttribute('data-decor')).toBe(false)
    fonts.status.set('qd-surah-header', 'ready')
    await until(() => header()?.hasAttribute('data-decor') === true)
    await userEvent.click($(`${DIALOG} [data-option="ornaments"]`) as HTMLElement)
    await settle(30)
    expect(preview()?.dataset.ornaments).toBe('off')
    expect(header()?.hasAttribute('data-decor')).toBe(false)
    expect(header()?.querySelector('.sc')).not.toBeNull()
    expect(preview()?.textContent).toContain('Hafs · Plain headers')
    await userEvent.click($(`${DIALOG} [data-option="ornaments"]`) as HTMLElement)
    await settle(30)
    expect(header()?.hasAttribute('data-decor')).toBe(true)
    // Nothing is saved before the starter set is decided.
    expect(settings.value.mushafStyle).toBe('hafs')
    expect(settings.value.ornateHeaders).toBe(true)
  })

  it('fetches the ornaments and the page for the preview once, online and ticked', async () => {
    await mount()
    const pageFonts = vi.spyOn(api, 'mushafEnsurePageFonts')
    expect(fonts.ensureDecor).not.toHaveBeenCalled()
    await next()
    await until(() => vi.mocked(fonts.ensureDecor).mock.calls.length === 1)
    // The chosen print's page 1, on the interactive lane, as the reader would.
    await until(() => pageFonts.mock.calls.some(([style, pages]) => style === 'qcf_v2' && pages.includes(1)))
    await next()
    await back()
    await settle(80)
    expect(fonts.ensureDecor).toHaveBeenCalledTimes(1)
  })

  it('fetches no ornaments while they are unticked', async () => {
    await mount()
    flow.setOrnaments(false)
    await next()
    await settle(200)
    expect(fonts.ensureDecor).not.toHaveBeenCalled()
    expect(preview()?.dataset.ornaments).toBe('off')
  })

  it('fetches nothing for the preview with network use off: it shows Hafs', async () => {
    await mount({ settings: { networkAllowed: false } })
    const pageFonts = vi.spyOn(api, 'mushafEnsurePageFonts')
    const decor = vi.spyOn(api, 'decorEnsure')
    const install = vi.spyOn(packs, 'install')
    await next()
    await until(() => preview()?.querySelector('section.mp[data-page="1"][data-style="hafs"]') != null)
    await settle(200)
    expect(flow.style).toBe('qcf_v2')
    expect(preview()?.dataset.style).toBe('hafs')
    expect(fonts.ensureDecor).not.toHaveBeenCalled()
    expect(decor).not.toHaveBeenCalled()
    expect(pageFonts).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
    expect(preview()?.querySelector('[role="status"]')?.textContent).toBe(
      'The ornaments show once they download.',
    )
  })

  it('a re-run starts from the settings: the style as it is', async () => {
    await mount({ firstRun: false, settings: { mushafStyle: 'qcf_v4' } })
    expect(action('skip')).not.toBeNull()
    await next()
    expect($(`${DIALOG} [data-style-choice="qcf_v4"]`)?.getAttribute('aria-checked')).toBe('true')
    expect(checked('ornaments')).toBe(true)
  })

  it('a re-run starts from the settings: Hafs stays Hafs, the ornate headers stay off', async () => {
    await mount({ firstRun: false, settings: { ornateHeaders: false } })
    await next()
    expect($(`${DIALOG} [data-style-choice="hafs"]`)?.getAttribute('aria-checked')).toBe('true')
    expect(checked('ornaments')).toBe(false)
    expect(preview()?.dataset.ornaments).toBe('off')
  })

  it('locks the Tajweed card where this web view cannot draw it (§8.6)', async () => {
    await mount({ firstRun: false, settings: { mushafStyle: 'qcf_v4' } })
    expect(flow.effectiveStyle).toBe('qcf_v4')
    fonts.v4Supported = false
    await next()
    // A Tajweed choice falls back to the 1421 AH print, as the reader would switch it.
    expect(flow.effectiveStyle).toBe('qcf_v2')
    const v4 = $(`${DIALOG} [data-style-choice="qcf_v4"]`) as HTMLElement
    expect(v4.getAttribute('aria-disabled')).toBe('true')
    expect(v4.getAttribute('aria-checked')).toBe('false')
    expect(v4.textContent).toContain('Not supported on this system')
    v4.click()
    flow.setStyle('qcf_v4')
    await settle(30)
    expect(flow.effectiveStyle).toBe('qcf_v2')
  })
})

describe('starter set (§2.5.4)', () => {
  it('English, the 1421 AH print: ornaments and Saheeh now, pages and WBW on demand, timings on first play; 832 kB', async () => {
    await mount()
    await toSummary()
    expect(rows()).toEqual([
      'decor:now',
      'tr.en.saheeh:now',
      'mushaf.v2:on_demand',
      'wbw.en:on_demand',
      'audio.qdc.7:timings_on_first_play',
    ])
    // WP5a pins 851,422 B (332,556 + 518,866), i.e. 325 + 507 KiB rounded up per pack.
    expect(totalKib()).toBe(832)
    expect($(`${DIALOG} .total-size`)?.textContent?.trim()).toBe('832 kB')
    expect(flow.starterSet.nowKib).toBe(832)
  })

  it('English, Hafs: the same set without the page fonts; 832 kB', async () => {
    await mount()
    await next()
    await userEvent.click($(`${DIALOG} [data-style-choice="hafs"]`) as HTMLElement)
    await next()
    await next()
    expect(rows()).toEqual([
      'decor:now',
      'tr.en.saheeh:now',
      'wbw.en:on_demand',
      'audio.qdc.7:timings_on_first_play',
    ])
    expect(totalKib()).toBe(832)
  })

  it('QCF V2: the page fonts on demand, or all of them now with the checkbox', async () => {
    await mount()
    await next()
    expect($(`${DIALOG} [data-style-choice="qcf_v2"]`)?.getAttribute('aria-checked')).toBe('true')
    expect(checked('all-pages')).toBe(false)
    await next()
    await next()
    expect(rows()).toEqual([
      'decor:now',
      'tr.en.saheeh:now',
      'mushaf.v2:on_demand',
      'wbw.en:on_demand',
      'audio.qdc.7:timings_on_first_play',
    ])
    expect(totalKib()).toBe(832)

    await back()
    await back()
    await userEvent.click($(`${DIALOG} [data-option="all-pages"]`) as HTMLElement)
    await next()
    await next()
    expect(rows()).toContain('mushaf.v2:now')
    expect(totalKib()).toBe(832 + (packs.pack('mushaf.v2')?.sizeKib ?? NaN))
  })

  it('Hafs without the ornate headers leaves the ornaments out', async () => {
    await mount()
    await next()
    await userEvent.click($(`${DIALOG} [data-style-choice="hafs"]`) as HTMLElement)
    expect(checked('ornaments')).toBe(true)
    await userEvent.click($(`${DIALOG} [data-option="ornaments"]`) as HTMLElement)
    await next()
    await next()
    expect(rows()).toEqual(['tr.en.saheeh:now', 'wbw.en:on_demand', 'audio.qdc.7:timings_on_first_play'])
    expect(totalKib()).toBe(507)
  })

  it('the 1421 AH print without the ornate headers: no ornaments in the set, and both choices applied', async () => {
    await mount()
    await next()
    await userEvent.click($(`${DIALOG} [data-option="ornaments"]`) as HTMLElement)
    expect(flow.ornaments).toBe(false)
    await next()
    await next()
    expect(rows()).toEqual([
      'tr.en.saheeh:now',
      'mushaf.v2:on_demand',
      'wbw.en:on_demand',
      'audio.qdc.7:timings_on_first_play',
    ])
    expect(totalKib()).toBe(507)
    await userEvent.click(action('start-reading') as HTMLElement)
    await until(() => flow.stepId === 'keys')
    await until(() => settings.value.mushafStyle === 'qcf_v2' && settings.value.ornateHeaders === false)
  })

  it('Arabic UI: Al-Muyassar instead of a translation and no word by word; 1,119 kB', async () => {
    await mount({ settings: { uiLanguage: 'ar' } })
    await toSummary()
    expect(rows()).toEqual([
      'decor:now',
      'tafsir.ar.muyassar:now',
      'mushaf.v2:on_demand',
      'audio.qdc.7:timings_on_first_play',
    ])
    // WP5a pins 1,144,830 B (332,556 + 812,274): 325 + 794 KiB.
    expect(totalKib()).toBe(1119)
    expect($(`${DIALOG} .total-size`)?.textContent?.trim()).toBe('١٬١١٩ ك.ب')
  })

  it('follows the chosen translation and reciter; "No translation" drops it', async () => {
    await mount()
    await next()
    await next()
    expect(flow.stepId).toBe('reading')
    flow.translation = 'tr.fr.rashid'
    flow.setReciter(2)
    await next()
    expect(rows()).toEqual([
      'decor:now',
      'tr.fr.rashid:now',
      'mushaf.v2:on_demand',
      'wbw.en:on_demand',
      'audio.qdc.2:timings_on_first_play',
    ])
    await userEvent.click(action('back') as HTMLElement)
    flow.translation = null
    await next()
    expect(rows()).toEqual([
      'decor:now',
      'mushaf.v2:on_demand',
      'wbw.en:on_demand',
      'audio.qdc.2:timings_on_first_play',
    ])
  })
})

describe('work offline', () => {
  it('disables every download and keeps the style on Hafs', async () => {
    await mount()
    await toSummary()
    expect(action('download-now')?.disabled).toBe(false)

    await userEvent.click($(`${DIALOG} [role="switch"]`) as HTMLElement)
    await until(() => settings.value.networkAllowed === false)
    await settle(80)
    expect(action('download-now')?.disabled).toBe(true)
    expect(action('start-reading')?.disabled).toBe(false)
    // The style falls back to Hafs: no page-font row, and the download rows are disabled.
    expect(rows()).not.toContain('mushaf.v2:on_demand')
    expect($$(`${DIALOG} [data-pack].disabled`).map((r) => r.dataset.pack)).toEqual(['decor', 'tr.en.saheeh'])

    // The reciter preview needs the network too.
    await back()
    expect($<HTMLButtonElement>(`${DIALOG} [data-action="preview"]`)?.disabled).toBe(true)
    await back()
    expect($(`${DIALOG} [data-style-choice="qcf_v2"]`)?.getAttribute('aria-disabled')).toBe('true')
    expect($(`${DIALOG} [data-style-choice="qcf_v4"]`)?.getAttribute('aria-disabled')).toBe('true')
    expect($(`${DIALOG} [data-style-choice="hafs"]`)?.getAttribute('aria-checked')).toBe('true')
    expect($(`${DIALOG} .style.locked`)?.textContent).toContain(
      "Needs download — available when you're online",
    )
    // A locked card ignores a click (it is aria-disabled, so this clicks it through the DOM).
    ;($(`${DIALOG} [data-style-choice="qcf_v4"]`) as HTMLElement).click()
    await settle(30)
    expect(flow.style).toBe('qcf_v2')
    expect(flow.effectiveStyle).toBe('hafs')
    // The preview shows Hafs; without the network it fetches nothing (see 'fetches nothing for the preview offline').
    await until(() => preview()?.querySelector('section.mp[data-style="hafs"]') != null)

    // "Start reading" applies Hafs and downloads nothing.
    const install = vi.spyOn(packs, 'install')
    await next()
    await next()
    await userEvent.click(action('start-reading') as HTMLElement)
    await until(() => flow.stepId === 'keys')
    expect(install).not.toHaveBeenCalled()
    expect(settings.value.mushafStyle).toBe('hafs')
    expect(packs.activeJobs).toHaveLength(0)
  })

  it('the choice comes back once network use is allowed again', async () => {
    await mount()
    await next()
    expect(flow.effectiveStyle).toBe('qcf_v2')
    await settings.update({ networkAllowed: false })
    await settle(80)
    expect(flow.effectiveStyle).toBe('hafs')
    await settings.update({ networkAllowed: true })
    await settle(80)
    expect(flow.effectiveStyle).toBe('qcf_v2')
  })
})

describe('starting', () => {
  it('"Download now" installs the starter set, applies the choices and follows the download', async () => {
    await mount()
    await toSummary()
    await userEvent.click(action('download-now') as HTMLElement)
    await until(() => flow.stepId === 'keys')
    expect(flow.started).toEqual(['decor', 'tr.en.saheeh'])
    expect(settings.value.mushafStyle).toBe('qcf_v2')
    expect(settings.value.ornateHeaders).toBe(true)
    await until(() => $(`${DIALOG} [data-starter="done"]`) !== null, 10_000)
    expect(packs.pack('decor')?.state.type).toBe('installed')
    expect(packs.pack('tr.en.saheeh')?.state.type).toBe('installed')
    // Never audio, never the on-demand packs.
    expect(packs.pack('audio.qdc.7')?.state.type).toBe('not_installed')
    expect(packs.pack('mushaf.v2')?.state.type).toBe('not_installed')
    // The packs store puts a downloaded translation to use (WP12a deviation 4).
    await until(() => settings.value.translations.includes('tr.en.saheeh'))
    // Word by word downloads as you read: it is in use from the start (§2.5.4 item 4).
    expect(settings.value.wbwPackId).toBe('wbw.en')
    expect(heading()).toBe('Three keys to remember')
  })

  it('"Start reading" applies the style and reciter without downloading', async () => {
    await mount()
    await next()
    await userEvent.click($(`${DIALOG} [data-style-choice="qcf_v4"]`) as HTMLElement)
    flow.setReciter(4)
    await next()
    await next()
    const install = vi.spyOn(packs, 'install')
    await userEvent.click(action('start-reading') as HTMLElement)
    await until(() => flow.stepId === 'keys')
    expect(install).not.toHaveBeenCalled()
    await until(() => settings.value.mushafStyle === 'qcf_v4' && settings.value.reciterId === 4)
    expect($(`${DIALOG} [data-starter]`)).toBeNull()
    // The set's on-demand word-by-word pack is in use, so word meanings show while reading.
    await until(() => settings.value.wbwPackId === 'wbw.en')
  })

  it('keeps a word-by-word pack the user already chose', async () => {
    await mount()
    const chosen = packs.list.find((p) => p.kind === 'wbw' && p.id !== 'wbw.en')?.id ?? ''
    expect(chosen).not.toBe('')
    await settings.update({ wbwPackId: chosen })
    await toSummary()
    await userEvent.click(action('start-reading') as HTMLElement)
    await until(() => flow.stepId === 'keys')
    await settle(80)
    expect(settings.value.wbwPackId).toBe(chosen)
  })

  it('puts no word-by-word pack to use in Arabic, where the set has none', async () => {
    await mount({ settings: { uiLanguage: 'ar' } })
    await toSummary()
    await userEvent.click(action('start-reading') as HTMLElement)
    await until(() => flow.stepId === 'keys')
    await settle(80)
    expect(settings.value.wbwPackId).toBeNull()
  })

  it('teaches Ctrl+K, Space and ? with keycaps', async () => {
    await mount()
    flow.go(STEPS.indexOf('keys'))
    await settle(80)
    const caps = $$(`${DIALOG} [data-key]`).map((k) =>
      [...k.querySelectorAll('.cap')].map((c) => c.textContent?.trim()).join('+'),
    )
    expect(caps[0]).toMatch(/^(Ctrl\+K|⌘\+K)$/) // the caps, joined with + here
    expect(caps[1]).toBe('Space')
    expect(caps[2]).toBe('?')
  })
})

describe('reciter preview', () => {
  it('plays Al-Fatihah 1:1 with the chosen reciter, and stops', async () => {
    await mount()
    await next()
    await next()
    flow.setReciter(3)
    await settle(30)
    const snapshot = await call(api.audioGetSnapshot())
    const play = vi.spyOn(api, 'audioPlay').mockResolvedValue({ status: 'ok', data: snapshot })
    const stop = vi.spyOn(api, 'audioStop').mockResolvedValue({ status: 'ok', data: null })
    const button = () => $<HTMLButtonElement>(`${DIALOG} [data-action="preview"]`) as HTMLButtonElement
    expect(button().getAttribute('aria-pressed')).toBe('false')
    await userEvent.click(button())
    await until(() => play.mock.calls.length === 1)
    expect(play.mock.calls[0]?.[0]).toMatchObject({
      reciterId: 3,
      from: { surah: 1, ayah: 1 },
      to: { surah: 1, ayah: 1 },
      startPaused: false,
      record: false,
    })
    await settle(30)
    expect(button().getAttribute('aria-pressed')).toBe('true')
    expect(button().textContent?.trim()).toBe('Stop')
    await userEvent.click(button())
    await until(() => stop.mock.calls.length === 1)
    expect(flow.previewing).toBeNull()
    // Choosing the starter set never applied the reciter it previewed.
    expect(settings.value.reciterId).toBe(7)
  })

  it('leaves no resume point: Space afterwards recites the page being read, not Al-Fatihah 1:2', async () => {
    await mount()
    await next()
    await next()
    expect(player.resumeCandidate).toBeNull()
    await userEvent.click($(`${DIALOG} [data-action="preview"]`) as HTMLElement)
    await until(() => player.status === 'playing' && player.currentAyahId === 1, 5_000)
    // Heard to its natural end.
    await until(() => player.status === 'idle' && flow.previewing === null, 30_000)
    await settle(1_200)
    expect(player.resumeCandidate).toBeNull()
    expect(player.audioPosition).toBeNull()
    const play = vi.spyOn(api, 'audioPlay')
    await player.toggle({ from: 2_000 })
    expect(play.mock.calls[0]?.[0].from).toEqual(quran.ayahRef(2_000))
    await player.stop()
  })
})

describe('ending', () => {
  it('Escape in an open listbox closes the listbox, not the dialog', async () => {
    await mount({ firstRun: false })
    await next()
    await next()
    await userEvent.click($(`${DIALOG} .ob-translation`) as HTMLElement)
    await until(() => document.querySelector('.qd-listbox') !== null)
    await userEvent.keyboard('{Escape}')
    await until(() => document.querySelector('.qd-listbox') === null)
    await settle(80)
    expect(ui.isOpen('onboarding')).toBe(true)
    expect(settings.value.onboardingDone).toBe(false)
  })

  it('Finish sets onboardingDone, closes, and ends the first run', async () => {
    await mount()
    flow.go(STEPS.indexOf('keys'))
    await settle(80)
    await userEvent.click(action('finish') as HTMLElement)
    await until(() => settings.value.onboardingDone)
    expect(ui.isOpen('onboarding')).toBe(false)
    expect(app.firstRun).toBe(false)
  })

  it('a first run offers no way out but Finish: no Skip on any step, and complete() waits for the last', async () => {
    await mount()
    expect(flow.mandatory).toBe(true)
    for (let step = 0; step < STEPS.length - 1; step++) {
      flow.go(step)
      await settle(80)
      expect(action('skip'), STEPS[step]).toBeNull()
      flow.complete()
      await settle(30)
      expect(ui.isOpen('onboarding')).toBe(true)
      expect(settings.value.onboardingDone).toBe(false)
    }
    // Back stays.
    expect(action('back')).not.toBeNull()
  })

  it('a first run ignores Escape and a click on the backdrop, on every step', async () => {
    await mount()
    for (let step = 0; step < STEPS.length; step++) {
      flow.go(step)
      await settle(120)
      await userEvent.click($('.backdrop') as HTMLElement, { position: { x: 8, y: 8 } })
      await settle(30)
      // Focus on the step's title, then on nothing at all.
      $(`${DIALOG} [data-step-heading]`)?.focus()
      await userEvent.keyboard('{Escape}')
      await settle(30)
      ;(document.activeElement as HTMLElement | null)?.blur()
      await userEvent.keyboard('{Escape}')
      await settle(60)
      expect(ui.isOpen('onboarding'), STEPS[step]).toBe(true)
      expect(flow.step).toBe(step)
      expect(settings.value.onboardingDone).toBe(false)
    }
  })

  it('a re-run (Settings › System) can be skipped from any step; Skip keeps the settings', async () => {
    await mount({ firstRun: false })
    expect(flow.mandatory).toBe(false)
    await next()
    await userEvent.click(action('skip') as HTMLElement)
    await until(() => settings.value.onboardingDone)
    expect(ui.isOpen('onboarding')).toBe(false)
    // Skip keeps the settings: the reading choices were never applied.
    expect(settings.value.mushafStyle).toBe('hafs')
  })

  it('on a re-run, Escape skips; a click on the backdrop does nothing', async () => {
    await mount({ firstRun: false })
    await userEvent.click($('.backdrop') as HTMLElement, { position: { x: 8, y: 8 } })
    await settle(80)
    expect(ui.isOpen('onboarding')).toBe(true)
    expect(settings.value.onboardingDone).toBe(false)
    await userEvent.keyboard('{Escape}')
    await until(() => settings.value.onboardingDone)
    expect(ui.isOpen('onboarding')).toBe(false)
  })

  it('keeps its step while another overlay is on top', async () => {
    await mount()
    await next()
    ui.open('palette', {})
    await settle(80)
    expect(flow.stepId).toBe('mushaf')
    expect(settings.value.onboardingDone).toBe(false)
  })
})
