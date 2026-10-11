/**
 * The Settings view (§9.7) in a real browser against the IPC mock: every `settingsMeta` row is rendered, and changes made
 * with the controls (switches, cards, segmented controls, selects, sliders, steppers, the translation list, the copy
 * settings, Clear cache and Reset) round-trip through `settings_set` into the mock's stored settings and come back after
 * a fresh bootstrap. Also the search, the section navigation and the Arabic UI.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import { defaultSettings } from '$lib/contracts/settings'
import { api, call, initIpc } from '$lib/ipc'
import type { PackInfo, Settings } from '$lib/ipc/bindings'
import { packsMock } from '$lib/ipc/mock/handlers/packs'
import { state } from '$lib/ipc/mock/state'
import { fonts, i18n, initStores, packs, resetStores, settings, ui } from '$lib/stores'
import { ROW_IDS, SETTINGS_SECTIONS } from './meta'
import SettingsView from './SettingsView.svelte'
import { settingsView } from './view.svelte'

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)]
const row = (id: string) => $(`[data-row="${id}"]`)
/** A button of a row by its text (a segmented option also holds a hidden copy of its label, reserving its bold width). */
const button = (id: string, text: string) =>
  $$<HTMLButtonElement>(`[data-row="${id}"] button`).find((b) => {
    const t = (b.textContent ?? '').replace(/\s+/gu, '')
    const want = text.replace(/\s+/gu, '')
    return t === want || t === want.repeat(2)
  }) as HTMLElement

async function settle(ms = 40): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms))
  flushSync()
}

async function until(done: () => boolean, timeoutMs = 4_000): Promise<void> {
  const end = performance.now() + timeoutMs
  while (!done()) {
    if (performance.now() > end) throw new Error('timed out')
    await settle(20)
  }
}

/** The settings the mock has stored (what `settings_get` and the next bootstrap return). */
const stored = (): Settings => state.settings.value

async function mount(options: { query?: string; settings?: Partial<Settings> } = {}): Promise<void> {
  await page.viewport(1400, 900)
  history.replaceState(null, '', `/${options.query ?? ''}`)
  localStorage.clear()
  await initIpc()
  packsMock.reset()
  state.resetAll()
  state.loadAll()
  state.settings.set({ ...defaultSettings(), ...options.settings })
  settingsView.reset()
  await initStores(await call(api.appBootstrap()))
  render(SettingsView)
  await settle(60)
}

/** Opens a section with its navigation button. */
async function open(section: string): Promise<void> {
  await userEvent.click(page.elementLocator($(`nav button[data-section="${section}"]`) as HTMLElement))
  await settle()
}

/** Waits until every pending settings write has reached the mock. */
async function saved(check: (s: Settings) => boolean): Promise<void> {
  await until(() => check(stored()))
}

afterEach(() => {
  resetStores()
  settingsView.reset()
  packsMock.reset()
  history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

describe('settings view', () => {
  it('lists the ten sections and opens on Appearance with its preview', async () => {
    await mount()
    expect($$('nav button[data-section]').map((b) => b.dataset.section)).toEqual([...SETTINGS_SECTIONS])
    expect($('nav button[aria-current="page"]')?.dataset.section).toBe('appearance')
    expect($('h1')?.textContent).toBe('Settings')
    expect($('section[data-section] h2')?.textContent).toBe('Appearance')
    expect($('[data-preview]')).not.toBeNull()
  })

  it('renders a row for every settingsMeta field and action, each exactly once', async () => {
    await mount()
    const seen: string[] = []
    for (const section of SETTINGS_SECTIONS) {
      await open(section)
      seen.push(...$$('[data-row]').map((r) => r.dataset.row ?? ''))
    }
    expect([...seen].sort()).toEqual([...ROW_IDS].sort())
  })

  it('round-trips switches, cards, segmented controls and selects through settings_set', async () => {
    await mount()
    // A theme card (radio group): Night.
    await userEvent.click(
      page.elementLocator($('[data-row="theme"] [role="radio"][data-value="night"]') as HTMLElement),
    )
    await saved((s) => s.theme === 'night')
    expect(document.documentElement.dataset.theme).toBe('night')
    expect($('[data-row="theme"] [aria-checked="true"]')?.dataset.value).toBe('night')

    // An accent swatch: arrow keys move and choose (APG radio group).
    const teal = $('[data-row="accent"] [role="radio"][data-value="teal"]') as HTMLElement
    teal.focus()
    await userEvent.keyboard('{ArrowRight}')
    await saved((s) => s.accent === 'emerald')
    expect(document.activeElement?.getAttribute('data-value')).toBe('emerald')

    // A segmented control: motion → Reduced.
    await userEvent.click(page.elementLocator(button('motion', 'Reduced')))
    await saved((s) => s.motion === 'reduce')

    // Mushaf: a switch by its label, a style card and a select.
    await open('mushaf')
    await userEvent.click(page.elementLocator($('[data-row="showPageFrame"] label') as HTMLElement))
    await saved((s) => !s.showPageFrame)
    expect($('[data-row="showPageFrame"] [role="switch"]')?.getAttribute('aria-checked')).toBe('false')
    await userEvent.click(
      page.elementLocator($('[data-row="mushafStyle"] [data-value="qcf_v4"]') as HTMLElement),
    )
    await saved((s) => s.mushafStyle === 'qcf_v4')

    await open('audio')
    const stopAt = $('[data-row="stopAt"] [role="combobox"]') as HTMLElement
    await userEvent.click(page.elementLocator(stopAt))
    await settle(80)
    await userEvent.click(page.getByRole('option', { name: 'End of the juz' }))
    await saved((s) => s.stopAt === 'end_of_juz')

    // A fresh bootstrap reads back what was stored.
    const before = stored()
    resetStores()
    await initStores(await call(api.appBootstrap()))
    expect(settings.value.theme).toBe('night')
    expect(settings.value.accent).toBe('emerald')
    expect(settings.value.showPageFrame).toBe(false)
    expect(settings.value.mushafStyle).toBe('qcf_v4')
    expect(settings.value.stopAt).toBe('end_of_juz')
    expect(settings.value).toEqual(before)
  })

  it('round-trips sliders, steppers, nested fields and the pause between repeats', async () => {
    await mount({ settings: { theme: 'night' } })
    // Ink brightness (live): one step with the arrow key, Shift for ten.
    const ink = $('[data-row="inkBrightnessPct"] [role="slider"]') as HTMLElement
    ink.focus()
    await userEvent.keyboard('{ArrowRight}')
    await saved((s) => s.inkBrightnessPct === 89)
    await userEvent.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    await saved((s) => s.inkBrightnessPct === 79)
    expect(document.documentElement.style.getPropertyValue('--ink-alpha')).toBe('0.79')
    // Its reset button returns to the default.
    await userEvent.click(
      page.elementLocator($('[data-row="inkBrightnessPct"] .reset button') as HTMLElement),
    )
    await saved((s) => s.inkBrightnessPct === 88)

    // A nested field: the sidebar width (saved with its parent object whole).
    const width = $('[data-row="sidebar.widthPx"] [role="slider"]') as HTMLElement
    width.focus()
    await userEvent.keyboard('{ArrowRight}')
    await saved((s) => s.sidebar.widthPx === 310)
    expect(stored().sidebar.tab).toBe('index')

    await open('audio')
    const repeat = $('[data-row="ayahRepeat"] [role="spinbutton"]') as HTMLElement
    repeat.focus()
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    await saved((s) => s.ayahRepeat === 3)
    await userEvent.keyboard('{Home}')
    await saved((s) => s.ayahRepeat === 0)
    expect(repeat.textContent?.trim()).toBe('∞')
    expect(repeat.getAttribute('aria-valuetext')).toBe('Until you stop')
    await userEvent.keyboard('12')
    await saved((s) => s.ayahRepeat === 12)

    // The pause: Fixed, then one step up (0.5 s).
    await userEvent.click(page.elementLocator(button('gap', 'Fixed')))
    await saved((s) => s.gap.type === 'fixed')
    expect(stored().gap).toEqual({ type: 'fixed', data: { ms: 1000 } })
    const pause = $('[data-row="gap"] [role="spinbutton"]') as HTMLElement
    pause.focus()
    await userEvent.keyboard('{ArrowUp}')
    await saved((s) => s.gap.type === 'fixed' && s.gap.data.ms === 1500)
    expect(pause.textContent?.trim()).toBe('1.5 s')

    // The study pane follows: a nested select.
    await open('translations')
    await userEvent.click(
      page.elementLocator($('[data-row="sidePane.follow"] [role="combobox"]') as HTMLElement),
    )
    await settle(80)
    await userEvent.click(page.getByRole('option', { name: 'Only the pinned ayah' }))
    await saved((s) => s.sidePane.follow === 'pinned')
    expect(stored().sidePane.widthPx).toBe(400)
  })

  it('orders the shown translations and previews the copy format', async () => {
    await mount({ query: '?mockPacks=demo' })
    await until(() => packs.list.some((p) => p.id === 'tr.en.saheeh' && p.state.type === 'installed'))
    await open('translations')
    await until(() => $('[data-row="translations"] li[data-pack-id="tr.en.saheeh"]') !== null)
    const switchOf = (id: string) =>
      $(`[data-row="translations"] li[data-pack-id="${id}"] [role="switch"]`) as HTMLElement
    const installed = $$('[data-row="translations"] li[data-pack-id]').map((li) => li.dataset.packId ?? '')
    expect(installed.length).toBeGreaterThanOrEqual(2)
    const [first, second] = installed as [string, string]
    await userEvent.click(page.elementLocator(switchOf(first)))
    await saved((s) => s.translations.join() === first)
    await userEvent.click(page.elementLocator(switchOf(second)))
    await saved((s) => s.translations.join() === `${first},${second}`)
    // Move the second up, from the keyboard: the order is stored, and focus stays on the moved row's buttons.
    const arrow = (id: string, dir: 'up' | 'down') =>
      $(`[data-row="translations"] li[data-pack-id="${id}"] button[data-move="${dir}"]`) as HTMLButtonElement
    const name = (id: string) => packs.title(packs.pack(id) as PackInfo)
    expect(arrow(second, 'up').getAttribute('aria-label')).toBe(`Move ${name(second)} up`)
    expect(arrow(second, 'down').getAttribute('aria-label')).toBe(`Move ${name(second)} down`)
    arrow(second, 'up').focus()
    await userEvent.keyboard('{Enter}')
    await saved((s) => s.translations.join() === `${second},${first}`)
    expect(
      $$('[data-row="translations"] li[data-pack-id]')
        .slice(0, 2)
        .map((li) => li.dataset.packId),
    ).toEqual([second, first])
    // At the top "Move up" is disabled: focus went to the same row's "Move down", which moves it back.
    await until(() => document.activeElement === arrow(second, 'down'))
    await userEvent.keyboard('{Enter}')
    await saved((s) => s.translations.join() === `${first},${second}`)
    await until(() => document.activeElement === arrow(second, 'up'))

    // The copy preview follows the copy settings.
    await until(() => ($('[data-copy-preview]')?.textContent ?? '').includes('112:1'))
    await userEvent.click(page.elementLocator($('[data-row="copy.includeReference"] label') as HTMLElement))
    await saved((s) => !s.copy.includeReference)
    await until(() => !($('[data-copy-preview]')?.textContent ?? '').includes('112:1'))
    expect(row('copy.referenceStyle')?.classList.contains('disabled')).toBe(true)
  })

  it('clears the cache after confirming, and resets every setting after confirming', async () => {
    await mount({ settings: { theme: 'sepia', speedPct: 150, uiLanguage: 'en', onboardingDone: true } })
    const clear = vi.spyOn(packs, 'clearCache')
    await open('storage')
    await userEvent.click(page.elementLocator($('[data-action="clear-cache"]') as HTMLElement))
    await until(() => ui.isTop('confirm'))
    expect(ui.topOverlay?.kind).toBe('confirm')
    ui.resolveConfirm(true)
    await until(() => clear.mock.calls.length === 1)

    await open('system')
    await userEvent.click(page.elementLocator($('[data-action="reset-all"]') as HTMLElement))
    await until(() => ui.isTop('confirm'))
    ui.resolveConfirm(true)
    await saved((s) => s.theme === 'system' && s.speedPct === 100)
    // Reset keeps the language and what the app has already shown (WP2b).
    expect(stored().onboardingDone).toBe(true)
  })

  it('saves the interface size when a key or drag ends, and applies it (CSS zoom in the mock)', async () => {
    await mount()
    const scale = $('[data-row="uiScalePct"] [role="slider"]') as HTMLElement
    scale.focus()
    await userEvent.keyboard('{ArrowRight}')
    await saved((s) => s.uiScalePct === 110)
    expect(document.documentElement.style.zoom).toBe('110%')
    expect($('[data-row="uiScalePct"] output')?.textContent?.trim()).toBe('110%')
    // The reset button returns to 100 % and is hidden again.
    await userEvent.click(page.elementLocator($('[data-row="uiScalePct"] .reset button') as HTMLElement))
    await saved((s) => s.uiScalePct === 100)
    expect(document.documentElement.style.zoom).toBe('')
    expect($('[data-row="uiScalePct"] .reset')?.classList.contains('shown')).toBe(false)
  })

  it('points the preview’s “Choose a translation” at the translations list', async () => {
    await mount()
    const choose = $$<HTMLButtonElement>('[data-preview] button').find((b) =>
      b.textContent?.includes('Choose a translation'),
    )
    expect(choose).toBeDefined()
    await userEvent.click(page.elementLocator(choose as HTMLElement))
    await settle(80)
    expect($('nav button[aria-current="page"]')?.dataset.section).toBe('translations')
    await until(() => row('translations')?.classList.contains('flash') === true)
  })

  it('turns the ornate surah headers off and on, saying what turning them on downloads', async () => {
    // Hafs: nothing asks for the ornaments by itself, so the mock's decor stays as the bootstrap left it.
    await mount()
    const ensure = vi.spyOn(api, 'decorEnsure')
    await open('mushaf')
    const switchOf = () => $('[data-row="ornateHeaders"] [role="switch"]')
    const note = () => $('[data-row="ornateHeaders"] .note')
    expect($('[data-row="ornateHeaders"] label')?.textContent?.trim()).toBe('Ornate surah headers')
    expect($('[data-row="ornateHeaders"] .description')?.textContent).toContain('surah names in lists')
    expect(switchOf()?.getAttribute('aria-checked')).toBe('true')
    expect(fonts.decor.installed).toBe(false)
    const size = i18n.bytes(packs.pack('decor')?.sizeKib ?? NaN)
    // Not on this computer: where to get them.
    expect(note()?.textContent).toBe(`Not downloaded yet (${size}). Get them from Downloads.`)
    expect(ensure).not.toHaveBeenCalled()
    await userEvent.click(page.elementLocator($('[data-row="ornateHeaders"] label') as HTMLElement))
    await saved((s) => !s.ornateHeaders)
    expect(switchOf()?.getAttribute('aria-checked')).toBe('false')
    // Off: what turning them on downloads, in the muted note colour (never the faint one).
    expect(note()?.textContent).toBe(`Downloads ${size} when turned on.`)
    const probe = document.createElement('span')
    probe.style.color = 'var(--text-muted)'
    document.body.append(probe)
    expect(getComputedStyle(note() as HTMLElement).color).toBe(getComputedStyle(probe).color)
    probe.remove()
    // Turned on again: the ornaments are asked for (an explicit choice), even with Hafs.
    await userEvent.click(page.elementLocator($('[data-row="ornateHeaders"] label') as HTMLElement))
    await saved((s) => s.ornateHeaders)
    await until(() => ensure.mock.calls.length === 1)
  })

  it('a declined confirmation changes nothing', async () => {
    await mount({ settings: { speedPct: 150 } })
    await open('system')
    await userEvent.click(page.elementLocator($('[data-action="reset-all"]') as HTMLElement))
    await until(() => ui.isTop('confirm'))
    ui.resolveConfirm(false)
    await settle(100)
    expect(stored().speedPct).toBe(150)
  })

  it('searches every section, with counts in the navigation, and opens a result’s section', async () => {
    await mount()
    const field = $('[data-settings-search]') as HTMLInputElement
    await userEvent.click(page.elementLocator(field))
    await userEvent.keyboard('glare')
    await settle(60)
    const visible = $$('[data-row]:not([hidden])').map((r) => r.dataset.row)
    expect(visible).toEqual(['inkBrightnessPct'])
    expect($('nav button[data-section="appearance"] .count')?.textContent).toBe('1')
    expect($('.content [role="status"]')?.textContent).toContain('1 setting matches')
    // Its control works in the results.
    const ink = $('[data-row="inkBrightnessPct"] [role="slider"]') as HTMLElement
    ink.focus()
    await userEvent.keyboard('{ArrowLeft}')
    await saved((s) => s.inkBrightnessPct === 87)

    // No match: the empty state offers to clear the search.
    await userEvent.fill(page.elementLocator(field), 'zzzz')
    await settle(60)
    expect($$('[data-row]:not([hidden])')).toHaveLength(0)
    expect(document.body.textContent).toContain('No settings match “zzzz”')

    // A section button leaves the search.
    await userEvent.fill(page.elementLocator(field), 'tray')
    await settle(60)
    await open('system')
    expect(settingsView.query).toBe('')
    expect($('section[data-section] h2')?.textContent).toBe('System')
  })

  for (const [lang, names] of [
    ['en', ['Automatic', 'Western Arabic numbers', 'Eastern Arabic numbers']],
    ['ar', ['تلقائي', 'الأرقام العربية الغربية', 'الأرقام العربية الشرقية']],
  ] as const) {
    it(`names the digit systems in full in the Numbers select, nothing clipped (${lang})`, async () => {
      await mount({ settings: { uiLanguage: lang } })
      await open('language')
      const row = $('[data-row="digits"]') as HTMLElement
      const trigger = row.querySelector<HTMLElement>('[role="combobox"]')
      if (!trigger) throw new Error('the Numbers row is not a select')
      expect(row.querySelector('.segmented')).toBeNull()
      const whole = (el: Element | null | undefined) => {
        if (!(el instanceof HTMLElement)) throw new Error('no text')
        expect(el.scrollWidth, el.textContent ?? '').toBeLessThanOrEqual(el.clientWidth)
      }
      await userEvent.click(page.elementLocator(trigger))
      await settle(80)
      const options = $$('[role="option"]')
      expect(options.map((o) => o.querySelector('.label')?.textContent)).toEqual([...names])
      for (const o of options) whole(o.querySelector('.label'))
      await userEvent.click(page.getByRole('option', { name: names[2] }))
      await saved((s) => s.digits === 'arabic_indic')
      expect(trigger.querySelector('.value')?.textContent).toBe(names[2])
      // From the default window down to the 760 px minimum, the select shows the longer name whole and leaves the
      // row's title and description a readable column.
      for (const [w, h] of [
        [1400, 900],
        [900, 700],
        [760, 600],
      ] as const) {
        await page.viewport(w, h)
        await settle(60)
        whole(trigger.querySelector('.value'))
        expect(row.querySelector('.text')?.getBoundingClientRect().width, `${w} px`).toBeGreaterThan(200)
      }
    })
  }

  for (const uiLanguage of ['en', 'ar'] as const) {
    it(`folds the navigation into one row under 880 px that the wheel scrolls sideways (${uiLanguage})`, async () => {
      await mount({ settings: { uiLanguage } })
      await page.viewport(640, 700)
      await settle(120)
      const strip = $('ul.sections') as HTMLElement
      const buttons = $$('ul.sections button[data-section]')
      expect(new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size).toBe(1)
      expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth)
      const wheel = (deltaY: number) => {
        const e = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })
        strip.dispatchEvent(e)
        return e
      }
      // Down moves towards the end of the row: right in English, left in Arabic (scrollLeft below 0).
      expect(wheel(120).defaultPrevented).toBe(true)
      await settle(0)
      expect(uiLanguage === 'ar' ? strip.scrollLeft < 0 : strip.scrollLeft > 0).toBe(true)
      // At the end the wheel goes on to the page.
      strip.scrollTo({ left: uiLanguage === 'ar' ? -strip.scrollWidth : strip.scrollWidth })
      await settle(0)
      expect(wheel(120).defaultPrevented).toBe(false)
      expect(wheel(-120).defaultPrevented).toBe(true)
      // The arrow keys follow the reading direction.
      buttons[0]?.focus()
      await userEvent.keyboard(uiLanguage === 'ar' ? '{ArrowLeft}' : '{ArrowRight}')
      expect(document.activeElement).toBe(buttons[1])
    })
  }

  it('mirrors in the Arabic UI and keeps every label translated', async () => {
    await mount({ settings: { uiLanguage: 'ar' } })
    expect(document.documentElement.dir).toBe('rtl')
    expect($('h1')?.textContent).toBe('الإعدادات')
    expect($('section[data-section] h2')?.textContent).toBe('المظهر')
    const nav = $('nav.nav') as HTMLElement
    const column = $('.content') as HTMLElement
    // The navigation is on the right of the column in RTL.
    expect(nav.getBoundingClientRect().left).toBeGreaterThan(column.getBoundingClientRect().left)
    // Arrow keys in a radio group follow the visual order: ← is "next" in RTL.
    const system = $('[data-row="theme"] [data-value="system"]') as HTMLElement
    system.focus()
    await userEvent.keyboard('{ArrowLeft}')
    await saved((s) => s.theme === 'paper')
  })
})
