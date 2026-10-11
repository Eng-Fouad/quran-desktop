/**
 * The command palette (§9.7, §10.1 Mod+K) in a real browser, driven by keyboard the way people use it: Mod+K opens it on
 * the field and closes it again, references and names answer at once, the arrows move (wrapping, skipping disabled
 * rows), Enter runs the active row after the dialog has closed (a jump moves focus to the ayah, a command acts where
 * focus was), Home/End stay in the field, the scope prefixes and the scope menu, the empty state's examples, Escape,
 * settings toggles, and the Arabic UI. The real L0 stores, shortcut listeners and `OverlayHost`, over the IPC mock.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import OverlayHost from '$components/shell/OverlayHost.svelte'
import { defaultSettings } from '$lib/contracts/settings'
import { api, call, initIpc } from '$lib/ipc'
import type { Settings } from '$lib/ipc/bindings'
import { state as mockState } from '$lib/ipc/mock'
import { app } from '$lib/stores/app.svelte'
import { history } from '$lib/stores/history.svelte'
import { i18n } from '$lib/stores/i18n.svelte'
import { library } from '$lib/stores/library.svelte'
import { player } from '$lib/stores/player.svelte'
import { quran } from '$lib/stores/quran.svelte'
import { reader } from '$lib/stores/reader.svelte'
import { settings } from '$lib/stores/settings.svelte'
import { shortcuts } from '$lib/stores/shortcuts.svelte'
import { ui } from '$lib/stores/ui.svelte'

/** `Mod` (§7.7): ⌘ when the browser runs on macOS (the mock reports the browser's platform), Ctrl elsewhere. */
const mod = () => (app.isMac ? 'Meta' : 'Control')
/** The caret's line-start and line-end keys: Home and End, ⌘← and ⌘→ on macOS (where Home and End scroll instead). */
const lineStart = () => (app.isMac ? '{Meta>}{ArrowLeft}{/Meta}' : '{Home}')
const lineEnd = () => (app.isMac ? '{Meta>}{ArrowRight}{/Meta}' : '{End}')

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)]
const input = () => $<HTMLInputElement>('[role="dialog"] [data-command-input]')
const options = () => $$('[role="dialog"] [role="option"]')
const selected = () => options().filter((o) => o.getAttribute('aria-selected') === 'true')
const plain = (el: Element | null | undefined) =>
  (el?.textContent ?? '')
    .replace(/[\u2066-\u2069]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
const headings = () => $$('[role="dialog"] [data-command-group-heading]').map((h) => plain(h))
const start = () => $<HTMLButtonElement>('#palette-test-start')

/** Two frames plus `ms`: effects, bits-ui's selection (after a tick) and short transitions have settled. */
async function settle(ms = 60): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms))
}

/** Boots the L0 stores on the mock bootstrap, mounts `OverlayHost`, and focuses a button outside the palette. */
async function boot(options: { lang?: 'en' | 'ar'; settings?: Partial<Settings> } = {}): Promise<void> {
  localStorage.clear()
  await initIpc()
  mockState.resetAll()
  mockState.settings.set({
    ...defaultSettings(),
    uiLanguage: options.lang ?? 'en',
    theme: 'paper',
    ...options.settings,
  })
  const b = await call(api.appBootstrap())
  app.init(b)
  settings.init(b)
  i18n.init(b)
  quran.init(b)
  ui.init(b)
  shortcuts.init(b)
  player.reciters = b.reciters
  reader.page = 1
  const host = document.createElement('div')
  host.dataset.testHost = ''
  const button = document.createElement('button')
  button.id = 'palette-test-start'
  button.textContent = 'Start'
  host.append(button)
  document.body.append(host)
  render(OverlayHost)
  flushSync()
  button.focus()
}

async function openWithKeys(): Promise<void> {
  await userEvent.keyboard(`{${mod()}>}k{/${mod()}}`)
  await settle(120)
}

async function typeQuery(text: string): Promise<void> {
  const el = input()
  if (!el) throw new Error('the palette is not open')
  await userEvent.clear(el)
  if (text !== '') await userEvent.type(el, text)
  await settle(80)
}

/** After a row ran: the dialog has gone (its exit transition) and the deferred action happened. */
async function afterClose(): Promise<void> {
  await settle(520)
}

afterEach(() => {
  vi.restoreAllMocks()
  shortcuts.reset()
  ui.reset()
  history.reset()
  library.reset()
  player.reset()
  reader.reset()
  quran.reset()
  settings.reset()
  app.reset()
  for (const host of document.querySelectorAll('[data-test-host]')) host.remove()
  document.documentElement.lang = 'en'
  document.documentElement.dir = 'ltr'
})

describe('Command palette: opening and closing', () => {
  it('opens with Mod+K on the field, as a labelled glass dialog at 14 vh', async () => {
    await boot()
    await openWithKeys()
    expect(ui.isTop('palette')).toBe(true)
    expect(document.activeElement).toBe(input())
    const dialog = $('[role="dialog"]') as HTMLElement
    const name = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent
    expect(name).toBe('Command palette')
    const box = dialog.getBoundingClientRect()
    expect(Math.round(box.width)).toBe(640)
    expect(Math.abs(box.top - 0.14 * window.innerHeight)).toBeLessThanOrEqual(2)
    expect(input()?.getAttribute('role')).toBe('combobox')
    expect(ui.layerOpen).toBe(true)
  })

  it('closes with Mod+K again and gives focus back', async () => {
    await boot()
    await openWithKeys()
    await userEvent.keyboard(`{${mod()}>}k{/${mod()}}`)
    expect(ui.isOpen('palette')).toBe(false)
    await afterClose()
    expect(input()).toBeNull()
    expect(document.activeElement).toBe(start())
  })

  it('closes with Escape and gives focus back', async () => {
    await boot()
    await openWithKeys()
    await typeQuery('kahf')
    await userEvent.keyboard('{Escape}')
    await afterClose()
    expect(ui.isOpen('palette')).toBe(false)
    expect(document.activeElement).toBe(start())
  })

  it('starts from the query it was opened with, scope prefix included', async () => {
    await boot()
    ui.open('palette', { query: '> theme' })
    await settle(150)
    expect(input()?.value).toBe('theme')
    expect(plain($('[role="dialog"] button.scope'))).toContain('Commands')
    expect(headings()).toEqual(['Commands', 'Settings'])
  })
})

describe('Command palette: keyboard flows', () => {
  it('answers "2:255" and jumps there after closing, moving focus to the ayah', async () => {
    const goToAyah = vi.spyOn(reader, 'goToAyah')
    await boot()
    await openWithKeys()
    await typeQuery('2:255')
    expect(headings()).toEqual(['Go to'])
    expect(selected()).toEqual([options()[0]])
    expect(plain(options()[0])).toContain(`${quran.surah(2)?.nameSimple} 2:255`)
    expect(input()?.getAttribute('aria-activedescendant')).toBe(options()[0]?.id)
    await userEvent.keyboard('{Enter}')
    expect(ui.isOpen('palette')).toBe(false)
    await afterClose()
    expect(goToAyah).toHaveBeenCalledTimes(1)
    expect(goToAyah).toHaveBeenCalledWith(quran.ayahId(2, 255), { select: false, flash: true, focus: true })
    // The jump owns focus: it is not handed back to where the palette was opened.
    expect(document.activeElement).not.toBe(start())
  })

  it('moves with the arrows, wrapping, and opens a page keeping the focus return', async () => {
    const goToPage = vi.spyOn(reader, 'goToPage')
    await boot()
    await openWithKeys()
    await typeQuery('18')
    expect(options().map((o) => o.getAttribute('data-value'))).toEqual(['goto:surah:18', 'goto:page:18'])
    expect(selected()[0]).toBe(options()[0])
    await userEvent.keyboard('{ArrowDown}')
    await settle(30)
    expect(selected()[0]).toBe(options()[1])
    await userEvent.keyboard('{ArrowDown}')
    await settle(30)
    expect(selected()[0]).toBe(options()[0])
    await userEvent.keyboard('{ArrowUp}')
    await settle(30)
    expect(selected()[0]).toBe(options()[1])
    await userEvent.keyboard('{Enter}')
    await afterClose()
    expect(goToPage).toHaveBeenCalledWith(18, { push: true, transition: true })
    expect(document.activeElement).toBe(start())
  })

  it('shows an out-of-range reference disabled with its reason, and Enter does nothing', async () => {
    const goToAyah = vi.spyOn(reader, 'goToAyah')
    await boot()
    await openWithKeys()
    await typeQuery('2:300')
    const [row] = options()
    expect(options()).toHaveLength(1)
    expect(row?.getAttribute('aria-disabled')).toBe('true')
    expect(plain(row?.querySelector('.detail'))).toMatch(/286/u)
    expect(selected()).toHaveLength(0)
    await userEvent.keyboard('{ArrowDown}{Enter}')
    await settle(80)
    expect(ui.isTop('palette')).toBe(true)
    expect(goToAyah).not.toHaveBeenCalled()
  })

  it('keeps Home and End for the caret', async () => {
    await boot()
    await openWithKeys()
    await typeQuery('theme')
    const before = selected()[0]
    await userEvent.keyboard('{Home}{End}')
    expect(selected()[0]).toBe(before)
    await userEvent.keyboard(lineStart())
    expect(input()?.selectionStart).toBe(0)
    await userEvent.keyboard(lineEnd())
    expect(input()?.selectionStart).toBe(5)
    expect(selected()[0]).toBe(before)
  })

  it('runs a command where focus was, once the palette has closed', async () => {
    await boot()
    const wasOpen = settings.value.sidebar.open
    // What the world looked like when the command ran: the palette closed (no layer open), focus back where it was.
    const seen: { layerOpen: boolean; focus: Element | null }[] = []
    const toggleSidebar = ui.toggleSidebar.bind(ui)
    vi.spyOn(ui, 'toggleSidebar').mockImplementation((tab) => {
      seen.push({ layerOpen: ui.layerOpen, focus: document.activeElement })
      toggleSidebar(tab)
    })
    await openWithKeys()
    await typeQuery('hide sidebar')
    expect(options()[0]?.getAttribute('data-value')).toBe('cmd:view.sidebar')
    expect(plain(options()[0]?.querySelector('.kbd')).replace(/\s/gu, '')).toBe(app.isMac ? '⌘B' : 'Ctrl+B')
    await userEvent.keyboard('{Enter}')
    await afterClose()
    expect(seen).toEqual([{ layerOpen: false, focus: start() }])
    expect(settings.value.sidebar.open).toBe(!wasOpen)
    expect(document.activeElement).toBe(start())
  })

  it('lets the buttons keep Enter: the scope chip opens its menu, an example fills the field, no row runs', async () => {
    const goToAyah = vi.spyOn(reader, 'goToAyah')
    const navigate = vi.spyOn(ui, 'navigate')
    await boot()
    await openWithKeys()
    await typeQuery('2:255')
    await userEvent.keyboard('{Tab}')
    expect(document.activeElement?.classList.contains('scope')).toBe(true)
    await userEvent.keyboard('{Enter}')
    await settle(150)
    expect($('[role="menu"]')).not.toBeNull()
    await userEvent.keyboard('{Escape}')
    await settle(150)
    expect($('[role="menu"]')).toBeNull()
    expect(ui.isTop('palette')).toBe(true)
    expect(document.activeElement).toBe(input())
    await typeQuery('xyzzy')
    await userEvent.keyboard('{Tab}{Tab}')
    expect(plain(document.activeElement)).toBe('2:255')
    await userEvent.keyboard('{Enter}')
    await settle(80)
    expect(input()?.value).toBe('2:255')
    expect(ui.isTop('palette')).toBe(true)
    expect(goToAyah).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('runs the row exactly once with reduced motion too (no exit transition)', async () => {
    const goToPage = vi.spyOn(reader, 'goToPage')
    await boot({ settings: { motion: 'reduce' } })
    expect(settings.reducedMotion).toBe(true)
    await openWithKeys()
    await typeQuery('p 262')
    await userEvent.keyboard('{Enter}')
    await afterClose()
    expect(input()).toBeNull()
    expect(goToPage).toHaveBeenCalledTimes(1)
    expect(goToPage).toHaveBeenCalledWith(262, { push: true, transition: true })
  })

  it('turns a typed prefix into the scope chip, and Backspace at the start clears it', async () => {
    await boot()
    await openWithKeys()
    await userEvent.type(input() as HTMLInputElement, '#')
    await settle(80)
    expect(input()?.value).toBe('')
    expect(plain($('[role="dialog"] button.scope'))).toContain('Surahs')
    expect(options()).toHaveLength(114)
    await userEvent.type(input() as HTMLInputElement, ' kahf')
    await settle(80)
    expect(input()?.value).toBe('kahf')
    expect(options()[0]?.getAttribute('data-value')).toBe('surah:18')
    await userEvent.keyboard(`${lineStart()}{Backspace}`)
    await settle(80)
    expect(plain($('[role="dialog"] button.scope'))).toContain('Everything')
    expect(input()?.value).toBe('kahf')
    expect(headings()[0]).toBe('Surahs')
  })

  it('chooses a scope from the chip menu and returns to the field', async () => {
    await boot()
    await openWithKeys()
    await userEvent.click($('[role="dialog"] button.scope') as HTMLElement)
    await settle(150)
    const radios = $$('[role="menuitemradio"]')
    expect(radios.map((r) => plain(r))).toEqual(['Everything', 'Commands >', 'Surahs #', 'Reciters @'])
    await userEvent.click(radios[3] as HTMLElement)
    await settle(200)
    expect(plain($('[role="dialog"] button.scope'))).toContain('Reciters')
    expect(document.activeElement).toBe(input())
    expect(headings()).toEqual(['Reciters'])
    expect(options().length).toBe(player.reciters.length)
    expect(ui.isTop('palette')).toBe(true)
  })
})

describe('Command palette: rows and states', () => {
  it('toggles a setting from its row and shows the new state', async () => {
    await boot()
    expect(settings.value.showPageFrame).toBe(true)
    await openWithKeys()
    await typeQuery('page frame')
    const row = $('[role="dialog"] [data-value="setting:showPageFrame"]')
    expect(plain(row)).toContain('On')
    await userEvent.click(row as HTMLElement)
    await afterClose()
    expect(settings.value.showPageFrame).toBe(false)
    expect(ui.toasts.at(-1)?.message).toMatch(/: Off$/u)
  })

  it('says when nothing matches, offers a full-text search and example references', async () => {
    await boot()
    await openWithKeys()
    await typeQuery('xyzzy')
    expect(plain($('[role="dialog"] .empty-title'))).toBe('No matches.')
    expect(options().map((o) => o.getAttribute('data-value'))).toEqual(['search'])
    expect(plain(options()[0])).toBe('Search the Quran for “xyzzy”')
    const chips = $$('[role="dialog"] .chip')
    expect(chips.map((c) => plain(c))).toEqual(['2:255', 'p 262', 'j 15', 'الكهف'])
    await userEvent.click(chips[0] as HTMLElement)
    await settle(80)
    expect(input()?.value).toBe('2:255')
    expect(document.activeElement).toBe(input())
    expect(headings()).toEqual(['Go to'])
  })

  it('opens empty with the reading bookmark first, then the commands', async () => {
    await boot()
    library.readingBookmark = {
      ayahId: quran.ayahId(18, 45),
      layout: 'v2',
      page: 297,
      updatedAt: Math.floor(Date.now() / 1000) - 3 * 86_400,
    }
    await openWithKeys()
    expect(headings()).toEqual(['Recent', 'Commands'])
    expect(plain(options()[0])).toContain('Continue from reading bookmark')
    expect(selected()[0]).toBe(options()[0])
  })

  it('mirrors in the Arabic UI: right-to-left, no capitals on headings, Arabic names', async () => {
    await boot({ lang: 'ar' })
    await openWithKeys()
    const dialog = $('[role="dialog"]') as HTMLElement
    expect(dialog.getAttribute('dir')).toBe('rtl')
    expect(input()?.getAttribute('dir')).toBe('rtl')
    await typeQuery('الكهف')
    expect(input()?.getAttribute('dir')).toBe('auto')
    expect(headings()[0]).toBe('السور')
    const heading = $('[role="dialog"] [data-command-group-heading]') as HTMLElement
    expect(getComputedStyle(heading).textTransform).toBe('none')
    expect(getComputedStyle(heading).letterSpacing).toBe('normal')
    expect(plain(options()[0])).toContain('الكهف')
    // The scope chip sits at the inline end: the left edge in RTL.
    const chip = ($('[role="dialog"] button.scope') as HTMLElement).getBoundingClientRect()
    const field = ($('[role="dialog"] .field') as HTMLElement).getBoundingClientRect()
    expect(chip.left - field.left).toBeLessThan(40)
  })
})
