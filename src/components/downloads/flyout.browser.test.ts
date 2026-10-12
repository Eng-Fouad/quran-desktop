/**
 * The rail's Downloads flyout and the manager's polish (§9.7; owner request 2026-10-11) in a real browser with the real
 * shell: the arrowless flyout beside the rail button (bottom edges aligned, mirrored in Arabic), its button semantics,
 * light dismiss and focus; the idle state's "Get content" links that open the manager on a tab; running, paused,
 * failed and waiting downloads with their actions, "Recently finished", "Update all" and `Mod+Shift+D` inside it; the
 * rail's ring and marks; the small-window fallback (760 × 600 at 150 % and 200 %); the manager without the sidebar
 * (a rail tab, `Mod+1…7`, `Mod+B`, `Mod+F` return to the reader), focus in and out, and the dock kept off the rows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '../../app.css'
import { packsMock } from '$lib/ipc/mock/handlers/packs'
import { app, packs, settings, ui } from '$lib/stores'
import { bootApp, resetApp, settle, type BootOptions } from '$components/shell/testing/boot'

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const $$ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document) => [
  ...root.querySelectorAll<T>(selector),
]
/** `Mod` (§7.7): ⌘ when the browser runs on macOS (the mock reports the browser's platform), Ctrl elsewhere. */
const mod = () => (app.isMac ? 'Meta' : 'Control')
const railButton = () => $('.rail button[data-view="downloads"]') as HTMLElement
const flyout = () => $('[data-qd-flyout="downloads"]')
/** The flyout's floating panel (the popover box around the content). */
const panel = () => flyout()?.closest<HTMLElement>('.popover') ?? null
const row = (id: string) => $(`[data-qd-flyout="downloads"] [data-pack-id="${id}"]`)
const RECITER = 'audio.qdc.7'
/** Whether `el` lies inside the window. */
function inView(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1
}

async function boot(options: BootOptions & { query?: string } = {}): Promise<void> {
  history.replaceState(null, '', `/${options.query ?? ''}`)
  packsMock.reset()
  await bootApp(options)
  packsMock.setRate(50_000)
}

/** Polls until `done()` holds (the mock downloads in real time). */
async function until(done: () => boolean, timeoutMs = 8_000): Promise<void> {
  const end = performance.now() + timeoutMs
  while (!done()) {
    if (performance.now() > end) throw new Error('timed out')
    await settle(30)
  }
}

async function openFlyout(): Promise<void> {
  await userEvent.click(railButton())
  await until(() => flyout() !== null)
  await settle(200)
}

afterEach(async () => {
  // The mouse is shared by the tests: parked on the title bar, it leaves no rail tooltip open in the next app, where
  // that tooltip, not the view, would take the first Escape.
  await userEvent.hover(document.querySelector('.titlebar, header') ?? document.body)
  await settle(250)
  resetApp()
  packsMock.reset()
  history.replaceState(null, '', '/')
  vi.restoreAllMocks()
  await page.viewport(1280, 800)
})

describe('Downloads flyout (owner request 2026-10-11)', () => {
  it('opens arrowless beside the rail button, bottom edges aligned, and closes back on the button', async () => {
    await boot()
    const button = railButton()
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.hasAttribute('aria-pressed')).toBe(false)
    expect(button.hasAttribute('aria-current')).toBe(false)
    expect(button.getAttribute('aria-label')).toBe('Downloads')
    // Its tooltip names it without a key: Mod+Shift+D opens the manager, and the flyout's footer says so.
    await userEvent.hover(button)
    await expect.poll(() => $('.tooltip')?.textContent?.trim(), { timeout: 3_000 }).toBe('Downloads')
    expect($('.tooltip .kbd')).toBeNull()

    await openFlyout()
    expect($('.tooltip')).toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.hasAttribute('data-active')).toBe(false)
    expect(ui.view).toBe('reader')
    expect(ui.layerOpen).toBe(true)
    const box = (panel() as HTMLElement).getBoundingClientRect()
    const b = button.getBoundingClientRect()
    // Beside the 52 px rail on its inline end, 10 px off the button; 380 px wide; no arrow.
    expect(box.left).toBeGreaterThanOrEqual(52)
    expect(box.left).toBeLessThanOrEqual(b.right + 12)
    expect(Math.round(box.width)).toBe(380)
    expect(Math.abs(box.bottom - b.bottom)).toBeLessThanOrEqual(1)
    expect(panel()?.querySelector('.arrow')).toBeNull()
    expect(panel()?.getAttribute('role')).toBe('dialog')
    expect(panel()?.getAttribute('aria-label')).toBe('Downloads')
    // Portalled to the body: a `header` or `footer` there would be a second banner or a contentinfo landmark.
    expect(panel()?.querySelector('header, footer')).toBeNull()
    // Focus starts on its heading; the idle state offers content and the manager with its key.
    expect(document.activeElement?.textContent).toBe('Downloads')
    expect(flyout()?.querySelector('.nothing')?.textContent).toBe('Nothing downloading')
    expect($$('[data-qd-flyout] .chip').map((c) => c.textContent?.trim())).toEqual([
      'Mushaf',
      'Recitations',
      'Translations',
      'Tafsir',
      'Word by word',
    ])
    await expect.poll(() => flyout()?.querySelector('.total')?.textContent?.trim()).toMatch(/used$/)
    expect(flyout()?.querySelector('[data-qd-usage-strip] [role="img"]')).not.toBeNull()
    const manage = flyout()?.querySelector('[data-action="manage"]') as HTMLElement
    // macOS prints the modifiers in Apple's order, ⌃⌥⇧⌘ (`formatChord`).
    expect(manage.textContent?.replace(/\s+/g, '')).toBe(
      app.isMac ? 'Managedownloads⇧⌘D' : 'ManagedownloadsCtrl+Shift+D',
    )

    await userEvent.keyboard('{Escape}')
    await settle(250)
    expect(flyout()).toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(button)
    expect(ui.layerOpen).toBe(false)

    // A click outside closes it too.
    await openFlyout()
    await userEvent.click($('main#qd-main') as HTMLElement, { position: { x: 600, y: 300 } })
    await settle(250)
    expect(flyout()).toBeNull()
  })

  it('opens the manager on a tab from "Get content", its heading focused and the sidebar hidden', async () => {
    await boot()
    packs.query = 'zzzz'
    await openFlyout()
    await userEvent.click($('[data-qd-flyout] .chip[data-tab="translation"]') as HTMLElement)
    await settle(300)
    expect(ui.view).toBe('downloads')
    expect(flyout()).toBeNull()
    expect(packs.filter).toBe('translation')
    expect(packs.query).toBe('')
    await expect.poll(() => document.activeElement?.getAttribute('data-qd-focus')).toBe('downloads')
    expect($$('section[data-section]').map((s) => s.dataset.section)).toEqual(['translation'])

    const button = railButton()
    expect(button.getAttribute('aria-current')).toBe('page')
    expect(button.hasAttribute('data-active')).toBe(true)
    // Here it returns to the reader: a plain button, announcing no popup.
    expect(button.hasAttribute('aria-haspopup')).toBe(false)
    expect(button.hasAttribute('aria-expanded')).toBe(false)
    // The sidebar is hidden (its preference kept), and no rail tab shows as open.
    expect(ui.sidebarOpen).toBe(false)
    expect(settings.value.sidebar.open).toBe(true)
    expect($('aside .sidebar, #qd-pane-sidebar')).toBeNull()
    expect($$('.rail [data-tab][data-active]')).toEqual([])

    // A rail tab returns to the reader with that tab open; focus stays on it.
    const bookmarks = $('.rail button[data-tab="bookmarks"]') as HTMLElement
    await userEvent.click(bookmarks)
    await settle(300)
    expect(ui.view).toBe('reader')
    expect(ui.sidebarOpen).toBe(true)
    expect(settings.value.sidebar.tab).toBe('bookmarks')
    expect(document.activeElement).toBe(bookmarks)
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('leaves the manager for the reading cursor (Escape, the rail button); Mod+1, Mod+B, Mod+F reach the reader', async () => {
    await boot()
    const cursor = () => document.activeElement?.matches('.mp-a11y li') === true
    await until(() => $('.mp-a11y li[tabindex="0"]') !== null)

    await userEvent.keyboard(`{${mod()}>}{Shift>}D{/Shift}{/${mod()}}`)
    await settle(200)
    expect(ui.view).toBe('downloads')
    await expect.poll(() => document.activeElement?.getAttribute('data-qd-focus')).toBe('downloads')
    await userEvent.keyboard('{Escape}')
    expect(ui.view).toBe('reader')
    await expect.poll(cursor).toBe(true)

    await userEvent.keyboard(`{${mod()}>}{Shift>}D{/Shift}{/${mod()}}`)
    await settle(200)
    await userEvent.click(railButton())
    expect(ui.view).toBe('reader')
    expect(flyout()).toBeNull()
    await expect.poll(cursor).toBe(true)

    await userEvent.keyboard(`{${mod()}>}{Shift>}D{/Shift}{/${mod()}}`)
    await settle(200)
    await userEvent.keyboard(`{${mod()}>}1{/${mod()}}`)
    await settle(200)
    expect(ui.view).toBe('reader')
    expect(ui.sidebarOpen).toBe(true)
    expect(settings.value.sidebar.tab).toBe('index')

    await userEvent.keyboard(`{${mod()}>}{Shift>}D{/Shift}{/${mod()}}`)
    await settle(200)
    await userEvent.keyboard(`{${mod()}>}b{/${mod()}}`)
    await settle(200)
    expect(ui.view).toBe('reader')
    expect(ui.sidebarOpen).toBe(true)

    await userEvent.keyboard(`{${mod()}>}{Shift>}D{/Shift}{/${mod()}}`)
    await settle(200)
    await userEvent.keyboard(`{${mod()}>}f{/${mod()}}`)
    await expect.poll(() => document.activeElement?.matches('[data-qd-focus="search"]')).toBe(true)
    expect(ui.view).toBe('reader')
    expect(settings.value.sidebar.tab).toBe('search')
  })

  it('shows running, paused, failed and waiting downloads, recently finished, and the rail’s ring and marks', async () => {
    await boot({ query: '?mockPacks=demo' })
    await until(() => packs.updatable.length > 0)
    // Something finished first.
    await packs.install('tr.fr.rashid')
    await until(() => packs.recent.length > 0)
    // Then a slow download, a failure and a request that waits for a connection.
    packsMock.setRate(150)
    await packs.install('mushaf.v1')
    await until(() => packs.jobOf('mushaf.v1')?.phase === 'downloading')
    const button = railButton()
    await expect
      .poll(() => button.querySelector('[data-badge="progress"] [role="progressbar"]'))
      .not.toBeNull()
    expect(button.getAttribute('aria-label')).toBe('Downloads · 1 download in progress')
    packsMock.failNext('tr.es.garcia', 'integrity', 0)
    await packs.install('tr.es.garcia')
    await until(() => packs.jobOf('tr.es.garcia')?.phase === 'failed')
    await expect.poll(() => button.querySelector('[data-badge="failed"]')).not.toBeNull()
    expect(button.getAttribute('aria-label')).toBe('Downloads · 1 download in progress · 1 failed')

    await openFlyout()
    expect(flyout()?.querySelector('[data-qd-updates]')?.textContent).toContain('1 update available')
    expect(flyout()?.querySelector('[data-action="update-all"]')).not.toBeNull()
    const running = row('mushaf.v1') as HTMLElement
    expect(running.dataset.job).toBe('downloading')
    expect(running.querySelector('[role="progressbar"]')).not.toBeNull()
    await expect.poll(() => running.querySelector('.stats')?.textContent).toMatch(/^[\d.]+ of [\d.]+ MB$/)
    expect($$('[data-action]', running).map((a) => a.dataset.action)).toEqual(['pause', 'stop'])
    const failed = row('tr.es.garcia') as HTMLElement
    expect(failed.querySelector('.error')?.textContent).toContain('damaged')
    expect($$('[data-action]', failed).map((a) => a.dataset.action)).toEqual(['retry', 'stop'])
    const done = $('[data-qd-flyout] .recent [data-pack-id="tr.fr.rashid"]') as HTMLElement
    expect(done.querySelector('.line')?.textContent).toMatch(/^Downloaded · [\d.]+ kB$/)
    // Running first, then failed.
    expect($$('[data-qd-flyout] ul[aria-label] > li').map((li) => li.dataset.packId)).toEqual([
      'mushaf.v1',
      'tr.es.garcia',
    ])

    await userEvent.click(running.querySelector('[data-action="pause"]') as HTMLElement)
    await until(() => row('mushaf.v1')?.dataset.job === 'paused')
    expect(row('mushaf.v1')?.querySelector('.stats')?.textContent).toMatch(/^Paused · /)
    expect($$('[data-action]', row('mushaf.v1') as HTMLElement).map((a) => a.dataset.action)).toEqual([
      'resume',
      'stop',
    ])
    await expect.poll(() => button.querySelector('[data-badge="progress"]')).toBeNull()

    // A request made offline waits for a connection: listed with Cancel, counted on the rail.
    settings.update({ networkAllowed: false })
    await settle(100)
    await packs.installWhenOnline(RECITER, { type: 'items', data: { items: [18] } })
    await until(() => row(RECITER) !== null)
    expect(row(RECITER)?.dataset.job).toBe('waiting')
    expect(row(RECITER)?.textContent).toContain('Waits for a connection')
    expect($$('[data-action]', row(RECITER) as HTMLElement).map((a) => a.dataset.action)).toEqual(['cancel'])
    expect(flyout()?.querySelector('[data-note="network-off"]')).not.toBeNull()
    expect(button.querySelector('[data-badge="waiting"]')?.textContent).toBe('1')
    expect(button.getAttribute('aria-label')).toContain('1 waiting for a connection')

    // Mod+Shift+D inside the flyout opens the manager (the layer pauses the global key).
    await userEvent.keyboard(`{${mod()}>}{Shift>}D{/Shift}{/${mod()}}`)
    await settle(300)
    expect(ui.view).toBe('downloads')
    expect(flyout()).toBeNull()
    await expect.poll(() => document.activeElement?.getAttribute('data-qd-focus')).toBe('downloads')
  })

  // The app's UI scale is webview zoom (D27): 760 × 600 at 150 % lays out as a 507 × 400 CSS px window, at 200 % as
  // 380 × 300. The browser mock's CSS zoom would move floating-ui's coordinates, so these run at those CSS sizes.
  it('fits the 760 × 600 window at 150 % (507 × 400), mirrored in Arabic', async () => {
    await boot({ size: [507, 400] })
    expect(ui.windowSize).toEqual({ w: 507, h: 400 })
    for (const uiLanguage of ['en', 'ar'] as const) {
      settings.update({ uiLanguage })
      await settle(200)
      expect(inView(railButton())).toBe(true)
      expect(inView($('.rail button[data-view="settings"]') as HTMLElement)).toBe(true)
      await openFlyout()
      const box = (panel() as HTMLElement).getBoundingClientRect()
      const rail = ($('nav.rail') as HTMLElement).getBoundingClientRect()
      if (uiLanguage === 'ar') expect(box.right).toBeLessThanOrEqual(rail.left + 1)
      else expect(box.left).toBeGreaterThanOrEqual(rail.right - 1)
      expect(Math.abs(box.bottom - railButton().getBoundingClientRect().bottom)).toBeLessThanOrEqual(1)
      expect(inView(panel() as HTMLElement)).toBe(true)
      expect(inView(flyout()?.querySelector('[data-action="manage"]') as HTMLElement)).toBe(true)
      expect(inView(flyout()?.querySelector('.chip[data-tab="wbw"]') as HTMLElement)).toBe(true)
      expect(flyout()?.querySelector('h2')?.textContent).toBe(uiLanguage === 'ar' ? 'التنزيلات' : 'Downloads')
      await userEvent.keyboard('{Escape}')
      await settle(200)
    }
  })

  it('opens the manager at once in the 760 × 600 window at 200 % (380 × 300), in English and Arabic', async () => {
    await boot({ size: [380, 300] })
    for (const uiLanguage of ['en', 'ar'] as const) {
      settings.update({ uiLanguage })
      await settle(200)
      expect(inView(railButton())).toBe(true)
      // It opens no flyout here: a plain button.
      expect(railButton().hasAttribute('aria-haspopup')).toBe(false)
      expect(railButton().hasAttribute('aria-expanded')).toBe(false)
      await userEvent.click(railButton())
      await settle(300)
      expect(flyout()).toBeNull()
      expect(ui.view).toBe('downloads')
      expect(railButton().getAttribute('aria-current')).toBe('page')
      await userEvent.keyboard('{Escape}')
      await settle(200)
      expect(ui.view).toBe('reader')
    }
  })

  for (const [w, h] of [
    [507, 400],
    [380, 300],
  ] as const) {
    it(`keeps every rail button 40 px tall at ${w} × ${h} (760 × 600 at ${w === 507 ? 150 : 200} %): the tabs scroll`, async () => {
      await boot({ size: [w, h] })
      const tabs = $('.rail .tabs') as HTMLElement
      const items = $$('.rail button.item')
      expect(items).toHaveLength(9)
      expect(items.map((b) => Math.round(b.getBoundingClientRect().height))).toEqual(Array(9).fill(40))
      if (h === 300) expect(tabs.scrollHeight).toBeGreaterThan(tabs.clientHeight)
      expect(inView(railButton())).toBe(true)
      expect(inView($('.rail button[data-view="settings"]') as HTMLElement)).toBe(true)
      // The last tab scrolls into reach.
      const memorize = $('.rail button[data-tab="memorize"]') as HTMLElement
      memorize.focus()
      await settle()
      const t = tabs.getBoundingClientRect()
      const m = memorize.getBoundingClientRect()
      expect(m.top >= t.top - 1 && m.bottom <= t.bottom + 1).toBe(true)
    })
  }

  it('keeps the player dock off the manager’s last rows', async () => {
    await boot({ size: [1280, 800] })
    await userEvent.keyboard(`{${mod()}>}{Shift>}D{/Shift}{/${mod()}}`)
    await until(() => $$('li.pack').length > 10)
    await settle(200)
    const viewport = $('[data-qd-view="downloads"] [data-scroll-area-viewport]') as HTMLElement
    viewport.scrollTop = viewport.scrollHeight
    await settle(200)
    const last = $$('li.pack').at(-1) as HTMLElement
    const dock = $('.dock-region > *') as HTMLElement
    expect(last.getBoundingClientRect().bottom).toBeLessThanOrEqual(dock.getBoundingClientRect().top)
  })
})
