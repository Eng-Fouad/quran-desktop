/**
 * About and attribution (§9.7) in a real browser against the IPC mock: the header and Copy diagnostics, the groups
 * with installed packs and their versions, links opened outside the webview, the bundled Hafs licence, the app's own
 * licence (the repository's LICENSE) and the credit for its name and icon (LEAD.md item 16), and the collapsible
 * open-source licences loaded from thirdparty.json.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import { SOURCE_URL } from '$lib/about/attributions'
import { defaultSettings } from '$lib/contracts/settings'
import { api, call, initIpc } from '$lib/ipc'
import type { Settings } from '$lib/ipc/bindings'
import { packsMock } from '$lib/ipc/mock/handlers/packs'
import { state } from '$lib/ipc/mock/state'
import { app, initStores, packs, resetStores } from '$lib/stores'
import AboutView from './AboutView.svelte'
import { loadThirdParty } from './thirdparty'

const VIEW = '[data-qd-view="about"]'
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(`${VIEW} ${sel}`)
const $$ = <T extends Element = HTMLElement>(sel: string) => [
  ...document.querySelectorAll<T>(`${VIEW} ${sel}`),
]
const entries = (group: string) => $$(`[data-group="${group}"] [data-entry]`).map((e) => e.dataset.entry)

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

async function mount(options: { query?: string; settings?: Partial<Settings> } = {}): Promise<void> {
  await page.viewport(1400, 900)
  history.replaceState(null, '', `/${options.query ?? ''}`)
  localStorage.clear()
  await initIpc()
  packsMock.reset()
  state.resetAll()
  state.loadAll()
  state.settings.set({ ...defaultSettings(), ...options.settings })
  await initStores(await call(api.appBootstrap()))
  render(AboutView)
  await until(() => $('h1') !== null && packs.list.length > 0)
  await settle(80)
}

afterEach(() => {
  resetStores()
  packsMock.reset()
  history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

describe('about view', () => {
  it('shows the app icon, full name, version and the core.db build line', async () => {
    await mount()
    const icon = $<HTMLImageElement>('.hero img')
    expect(icon?.getBoundingClientRect().width).toBe(64)
    // Decorative: the name is right next to it (assets/brand/README.md).
    expect(icon?.alt).toBe('')
    expect($('h1')?.textContent?.trim()).toBe('Quran for Desktop')
    expect(app.info.name).toBe('Quran')
    expect($('.version-number')?.textContent?.trim()).toBe(`Version ${app.info.version}`)
    const core = app.info.core
    expect($('[data-build-line]')?.textContent?.trim()).toBe(
      `core.db: ${core.source} · ${core.builtAt.slice(0, 10) || '—'} · schema ${core.schemaVersion}`,
    )
  })

  it('copies the diagnostics as JSON', async () => {
    await mount()
    const write = vi.fn((_text: string) => Promise.resolve())
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(write)
    await userEvent.click($('[data-action="copy-diagnostics"]') as HTMLElement)
    await until(() => write.mock.calls.length === 1)
    const json = JSON.parse(write.mock.calls[0]?.[0] ?? '{}') as { app: typeof app.info; session: object }
    expect(json.app).toEqual(JSON.parse(JSON.stringify(app.info)))
    expect(json.session).toMatchObject({ uiLanguage: 'en', networkAllowed: true })
    await settle(30)
    expect($('[data-action="copy-diagnostics"]')?.textContent?.trim()).toBe('Copied')
  })

  it('lists the groups in order, with each installed pack and its version', async () => {
    await mount({ query: '?mockPacks=demo' })
    await until(() => entries('translations').length > 0)
    expect($$('[data-group]').map((g) => g.dataset.group)).toEqual([
      'app',
      'text',
      'fonts',
      'translations',
      'tafsir',
      'recitations',
    ])
    expect(entries('app')).toEqual(['app', 'app-icon'])
    // The source core.db was built from: QUL (release), the Quran.com API (qdc fixtures), never both.
    const source = app.info.core.source
    const builtFrom = source === 'qul' ? ['qul'] : source === 'qdc' ? ['qdc-dev'] : []
    expect(entries('text')).toEqual([...builtFrom, 'kfgqpc', 'tanzil'])
    expect(entries('fonts')).toEqual(['kfgqpc-hafs', 'qcf', 'decor', 'ui-fonts'])
    expect(entries('translations')).toContain('tr.en.saheeh')
    expect(entries('tafsir')).toContain('tafsir.ar.muyassar')
    expect(entries('recitations')).toEqual(['quranicaudio', 'qf-timings'])
    expect($('[data-entry="tr.en.saheeh"] .pack-line')?.textContent).toMatch(/^English · Version \d/)
    expect($('[data-entry="qcf"] .credit')?.textContent?.trim()).toBe(
      'Quran fonts provided by Quran Foundation',
    )
  })

  it('says where installed translations will appear when there are none', async () => {
    await mount()
    expect($('[data-group="translations"] .empty')?.textContent).toContain(
      'Translations you download are credited',
    )
  })

  it('opens links outside the webview', async () => {
    await mount()
    const open = vi.spyOn(api, 'systemOpenExternal')
    const link = $<HTMLAnchorElement>('[data-entry="tanzil"] a.site') as HTMLAnchorElement
    expect(link.href).toBe('https://tanzil.net/')
    await userEvent.click(link)
    await until(() => open.mock.calls.length === 1)
    expect(open).toHaveBeenCalledWith('https://tanzil.net')
    expect(location.pathname).toBe('/')
  })

  it('shows the bundled KFGQPC Hafs licence as plain text', async () => {
    await mount()
    const toggle = $('[data-entry="kfgqpc-hafs"] .notice-toggle') as HTMLElement
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(toggle)
    await until(() => $('[data-entry="kfgqpc-hafs"] pre.notice-text') !== null)
    const text = $('[data-entry="kfgqpc-hafs"] pre.notice-text')?.textContent ?? ''
    expect(text).toContain('King Fahd Glorious Quran Printing Complex')
    expect(text).toContain('ELECTRONIC END-USER LICENSE AGREEMENT')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('credits the app’s own licence with its full text, and its name and icon to Quran.com', async () => {
    await mount()
    expect($('[data-group="app"] .group-title')?.textContent?.trim()).toBe('This app')
    expect($('[data-entry="app"] .name')?.textContent?.trim()).toBe('Quran for Desktop')
    expect($('[data-entry="app"] .credit')?.textContent).toContain('© Quran for Desktop contributors')
    expect($('[data-entry="app"] .licence')?.textContent).toContain('GPL-3.0-or-later')
    expect($<HTMLAnchorElement>('[data-entry="app"] .licence a')?.href).toBe(
      'https://www.gnu.org/licenses/gpl-3.0.html',
    )
    expect($('[data-entry="app"] a.site')).toBeNull()
    // GPL-3.0 §6: the Corresponding Source is one click away, outside the webview.
    const source = $<HTMLAnchorElement>('[data-entry="app"] a.source') as HTMLAnchorElement
    expect(source.textContent?.trim()).toBe('Source code')
    expect(source.href).toBe(SOURCE_URL)
    const open = vi.spyOn(api, 'systemOpenExternal')
    await userEvent.click(source)
    await until(() => open.mock.calls.length === 1)
    expect(open).toHaveBeenCalledWith(SOURCE_URL)
    const toggle = $('[data-entry="app"] .notice-toggle') as HTMLElement
    await userEvent.click(toggle)
    await until(() => $('[data-entry="app"] pre.notice-text') !== null)
    const text = $('[data-entry="app"] pre.notice-text')?.textContent ?? ''
    expect(text.startsWith('GNU GENERAL PUBLIC LICENSE')).toBe(true)
    expect(text).toContain('Version 3, 29 June 2007')
    expect(text).toContain('END OF TERMS AND CONDITIONS')

    expect($('[data-entry="app-icon"] .credit')?.textContent).toContain(
      'Quran.com / quran_android contributors',
    )
    expect($('[data-entry="app-icon"] .licence a')?.textContent?.trim()).toBe('GPL-3.0')
    expect($<HTMLAnchorElement>('[data-entry="app-icon"] a.site')?.href).toBe(
      'https://github.com/quran/quran_android',
    )
  })

  it('loads the open-source licences on demand, filters them and shows a package’s licence', async () => {
    await mount()
    expect($$('[data-package]')).toHaveLength(0)
    await userEvent.click($('[data-action="toggle-licences"]') as HTMLElement)
    await until(() => $$('[data-package]').length > 100, 10_000)
    expect($('[data-section="open-source"] .count')?.textContent?.trim()).toMatch(/^\d[\d,]* packages$/)
    await userEvent.fill($('[data-section="open-source"] input[type="search"]') as HTMLElement, 'dompurify')
    await until(() => $$('[data-package]').length === 1)
    const row = $('[data-package="dompurify"]') as HTMLElement
    // The alternative the app uses, as `cargo xtask licenses` chose it from "MPL-2.0 OR Apache-2.0".
    const dompurify = (await loadThirdParty()).packages.find((p) => p.name === 'dompurify')
    expect(['MPL-2.0', 'Apache-2.0']).toContain(dompurify?.used)
    expect(row.querySelector('.pkg-licence')?.textContent?.trim()).toBe(dompurify?.used)
    await userEvent.click(row.querySelector('.pkg-head') as HTMLElement)
    await until(() => row.querySelector('pre.pkg-text, .pkg-none') !== null)
    expect(row.querySelector('.pkg-head')?.getAttribute('aria-expanded')).toBe('true')
    await userEvent.fill($('[data-section="open-source"] input[type="search"]') as HTMLElement, 'zzz-no-such')
    await until(() => $('[data-section="open-source"] .none') !== null)
  })

  it('reads in Arabic, right to left', async () => {
    await mount({ settings: { uiLanguage: 'ar' } })
    expect($('#about-attribution')?.textContent?.trim()).toBe('المصادر والحقوق')
    expect($('h1')?.textContent?.trim()).toBe('قرآن لسطح المكتب')
    expect($('[data-group="app"] .group-title')?.textContent?.trim()).toBe('هذا التطبيق')
    expect(getComputedStyle($('.hero') as HTMLElement).direction).toBe('rtl')
    expect($('[data-group="text"] .group-title')?.textContent?.trim()).toBe('نص القرآن وتخطيط الصفحات')
    expect($('[data-entry="tanzil"] .name')?.textContent?.trim()).toBe('بيانات القرآن من مشروع تنزيل')
    expect($('[data-entry="app"] a.source')?.textContent?.trim()).toBe('الشيفرة المصدرية')
  })
})
