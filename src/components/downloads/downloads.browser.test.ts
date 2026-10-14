/**
 * The Downloads manager in a real browser against the IPC mock: rows and their actions, the narrow row (its
 * actions under the title), the surah grid (clicks, keyboard, the basmala rule, its menu), filters, the stop
 * confirmation, Work offline and the Arabic UI. The rail flyout and the manager in the shell: `flyout.browser.test.ts`.
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
import { initStores, packs, resetStores, settings, ui } from '$lib/stores'
import DownloadsView from './DownloadsView.svelte'
import { downloadsView } from './view.svelte'

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)]
const row = (id: string) => $(`li.pack[data-pack-id="${id}"]`)
const cell = (n: number) => $<HTMLButtonElement>(`li.pack[data-pack-id="audio.qdc.7"] [data-surah="${n}"]`)

async function settle(ms = 60): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms))
  flushSync()
}

/** Polls until `done()` holds (the mock downloads in real time, here at 50 MB/s). */
async function until(done: () => boolean, timeoutMs = 5_000): Promise<void> {
  const end = performance.now() + timeoutMs
  while (!done()) {
    if (performance.now() > end) throw new Error('timed out')
    await settle(30)
  }
}

async function mount(
  options: { query?: string; settings?: Partial<Settings>; before?: () => void; wait?: boolean } = {},
): Promise<void> {
  await page.viewport(1400, 900)
  history.replaceState(null, '', `/${options.query ?? ''}`)
  localStorage.clear()
  await initIpc()
  packsMock.reset()
  packsMock.setRate(50_000)
  state.resetAll()
  state.loadAll()
  state.settings.set({ ...defaultSettings(), ...options.settings })
  options.before?.()
  await initStores(await call(api.appBootstrap()))
  render(DownloadsView)
  if (options.wait !== false) await until(() => row('tr.en.saheeh') !== null)
  await settle(100)
}

afterEach(() => {
  resetStores()
  downloadsView.reset()
  packsMock.reset()
  history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

describe('downloads view', () => {
  it('shows the storage card, the sections and the current reciter’s surah grid', async () => {
    await mount({ query: '?mockPacks=demo' })
    expect($('h1')?.textContent).toBe('Downloads')
    // The heading takes focus when the manager opens.
    expect(document.activeElement).toBe($('h1'))
    expect($('[data-qd-usage] .total')?.textContent).toMatch(/used/)
    expect($$('section[data-section]').map((s) => s.dataset.section)).toEqual([
      'mushaf',
      'recitation',
      'translation',
      'tafsir',
      'wbw',
    ])
    expect(row('tr.en.saheeh')?.dataset.state).toBe('installed')
    expect(row('tr.en.hilali_khan')?.querySelector('[data-action="update"]')).not.toBeNull()
    expect($('[data-banner="updates"]')?.textContent).toContain('1 update available')
    expect($$('li.pack[data-pack-id="audio.qdc.7"] .cell')).toHaveLength(114)
    expect(cell(18)?.dataset.state).toBe('pinned')
    expect(cell(2)?.dataset.state).toBe('cached')
    expect(row('audio.qdc.7')?.querySelector('.sub')?.textContent).toMatch(
      /^10 of 114 surahs · .+ · 5 cached$/,
    )
  })

  it('moves a row’s badge and actions under its title below 560 px of row (container query)', async () => {
    await mount()
    const box = (sel: string) =>
      (row('tr.en.saheeh')?.querySelector(sel) as HTMLElement).getBoundingClientRect()
    expect(box('.end').top).toBeLessThan(box('.body').bottom)
    await page.viewport(560, 900)
    await settle(200)
    expect(row('tr.en.saheeh')?.getBoundingClientRect().width).toBeLessThan(560)
    expect(box('.end').top).toBeGreaterThanOrEqual(box('.body').bottom - 1)
    expect(Math.abs(box('.end').left - box('.body').left)).toBeLessThanOrEqual(1)
  })

  it('downloads a pack from its row', async () => {
    await mount()
    await userEvent.click(row('tr.fr.rashid')?.querySelector('[data-action="download"]') as HTMLElement)
    await until(() => row('tr.fr.rashid')?.dataset.state === 'installed')
    expect(row('tr.fr.rashid')?.querySelector('.sub')?.textContent).toContain('French')
    expect(row('tr.fr.rashid')?.querySelector('[data-action="remove"]')).not.toBeNull()
  })

  it('asks before stopping a download that already received data', async () => {
    await mount()
    packsMock.setRate(200)
    const confirm = vi.spyOn(ui, 'confirm').mockResolvedValue(true)
    await userEvent.click(row('mushaf.v1')?.querySelector('[data-action="download"]') as HTMLElement)
    await until(() => row('mushaf.v1')?.dataset.job === 'downloading')
    await settle(400)
    expect(row('mushaf.v1')?.querySelector('[role="progressbar"]')).not.toBeNull()
    expect(row('mushaf.v1')?.querySelector('.stats')?.textContent).toMatch(/ of .+ MB/)
    await userEvent.click(row('mushaf.v1')?.querySelector('[data-action="stop"]') as HTMLElement)
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Stop downloading Madani Mushaf (1405 AH print)?' }),
    )
    await until(() => row('mushaf.v1')?.dataset.job === undefined)
  })
})

describe('surah grid', () => {
  it('downloads a surah with surah 1, which then stays while another surah is downloaded', async () => {
    await mount()
    await userEvent.click(cell(112) as HTMLElement)
    await until(() => cell(112)?.dataset.state === 'pinned' && cell(1)?.dataset.state === 'pinned')
    expect(cell(1)?.getAttribute('aria-disabled')).toBe('true')
    expect(cell(1)?.getAttribute('aria-label')).toContain('basmala')
    cell(1)?.click() // aria-disabled: Playwright would refuse the click
    await settle(200)
    expect(cell(1)?.dataset.state).toBe('pinned')

    await userEvent.click(cell(112) as HTMLElement)
    await until(() => cell(112)?.dataset.state === 'none')
    expect(cell(1)?.getAttribute('aria-disabled')).toBeNull()
  })

  it('moves with the arrow keys (mirrored in Arabic) and keeps one tab stop', async () => {
    await mount()
    await userEvent.hover($('h1') as HTMLElement) // the pointer off the grid: the status line follows focus
    const tabStops = () => $$('li.pack[data-pack-id="audio.qdc.7"] .cell').filter((c) => c.tabIndex === 0)
    expect(tabStops()).toHaveLength(1)
    cell(1)?.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(cell(2))
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(cell(21))
    await userEvent.keyboard('{End}')
    expect(document.activeElement).toBe(cell(114))
    expect(tabStops()).toEqual([cell(114)])
    expect($('li.pack[data-pack-id="audio.qdc.7"] .status')?.textContent).toMatch(
      /^114\. An-Nas · Not downloaded · about /,
    )

    settings.update({ uiLanguage: 'ar' })
    await settle()
    cell(5)?.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(cell(4))
  })

  it('offers Download, Remove and Play surah in its menu', async () => {
    await mount({ query: '?mockPacks=demo' })
    await userEvent.click(cell(36) as HTMLElement, { button: 'right' })
    await settle(150)
    const labels = $$('[role="menuitem"]').map((m) => m.textContent?.trim())
    expect(labels).toEqual(['Remove', 'Play surah'])
    await userEvent.click($$('[role="menuitem"]')[0] as HTMLElement)
    await until(() => cell(36)?.dataset.state === 'none')
  })
})

describe('filters and connectivity', () => {
  it('filters by kind, language and search, with an empty state that clears them', async () => {
    await mount()
    packs.filter = 'translation'
    await settle()
    expect($$('section[data-section]').map((s) => s.dataset.section)).toEqual(['translation'])
    packs.filter = 'all'
    packs.query = 'urdu'
    await settle()
    const ids = $$('li.pack').map((li) => li.dataset.packId)
    expect(ids).toEqual(expect.arrayContaining(['decor.nastaliq', 'tr.ur.junagarhi', 'wbw.ur']))
    expect(ids.every((id) => id === 'decor.nastaliq' || id?.includes('.ur'))).toBe(true)
    packs.query = 'zzzz'
    await settle()
    expect($('.empty')?.textContent).toContain('No pack matches “zzzz”')
    await userEvent.click(
      $$('.empty button').find((b) => b.textContent?.includes('Clear filters')) as HTMLElement,
    )
    expect(packs.query).toBe('')
  })

  it('disables downloads while working offline, and offers to allow network use', async () => {
    await mount({ settings: { networkAllowed: false } })
    expect($('[data-banner="network-off"]')).not.toBeNull()
    expect(row('tr.fr.rashid')?.querySelector<HTMLButtonElement>('[data-action="download"]')?.disabled).toBe(
      true,
    )
    await userEvent.click($('[data-banner="network-off"] button') as HTMLElement)
    await until(() => settings.value.networkAllowed)
    await settle()
    expect($('[data-banner="network-off"]')).toBeNull()
    expect(row('tr.fr.rashid')?.querySelector<HTMLButtonElement>('[data-action="download"]')?.disabled).toBe(
      false,
    )
  })

  it('shows why the catalogue could not load, and retries', async () => {
    let fail = true
    const list = api.packsList
    await mount({
      wait: false,
      before: () => {
        vi.spyOn(api, 'packsList').mockImplementation(() =>
          fail
            ? Promise.resolve({
                status: 'error',
                error: { kind: 'unsupported', message: 'packs_list is unavailable (test)' },
              })
            : list(),
        )
      },
    })
    expect($('.empty')?.textContent).toContain('Couldn’t load the packs')
    expect($('.empty')?.textContent).toContain("This isn't available in this version.")
    fail = false
    await userEvent.click($$('.empty button').find((b) => b.textContent?.includes('Retry')) as HTMLElement)
    await until(() => row('tr.en.saheeh') !== null)
  })

  it('mirrors in the Arabic UI with Arabic digits and names', async () => {
    await mount({ settings: { uiLanguage: 'ar' } })
    expect($('h1')?.textContent).toBe('التنزيلات')
    expect(cell(18)?.textContent?.trim()).toBe('١٨')
    expect(row('tr.en.saheeh')?.querySelector('.name')?.textContent).toBe('صحيح إنترناشونال')
    expect(row('tr.en.saheeh')?.querySelector('.sub')?.textContent).toContain('الإنجليزية')
  })
})
