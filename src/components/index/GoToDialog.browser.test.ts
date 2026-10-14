/**
 * The Go to dialog (Mod+G) in a real browser: focus on open, candidates from the reference parser, keyboard choice,
 * disabled out-of-range candidates, the jump after the dialog has closed (focus moves to the ayah), Escape, and the
 * Arabic UI. Lives next to the Index tests so it runs with them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import GoToDialog from '$components/dialogs/GoToDialog.svelte'
import { syntheticIndex } from '$lib/ipc/mock/synthetic'
import { quran } from '$lib/stores/quran.svelte'
import { reader } from '$lib/stores/reader.svelte'
import { ui } from '$lib/stores/ui.svelte'
import { bootIndex, resetIndex, settle } from './testing/setup'

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)]
const input = () => $<HTMLInputElement>('[role="dialog"] input[role="combobox"]')
const options = () => $$('[role="option"]')
const plain = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/[\u2066-\u2069]/gu, '')
const activeOption = () => {
  const id = input()?.getAttribute('aria-activedescendant')
  return id ? document.getElementById(id) : null
}

const index = syntheticIndex()

async function open(props: { initial?: string } = {}, lang: 'en' | 'ar' = 'en'): Promise<void> {
  bootIndex({ index, lang })
  ui.open('goto', props)
  await render(GoToDialog, { props })
  await settle(260)
}

async function typeQuery(text: string): Promise<void> {
  const el = input()
  if (!el) throw new Error('no input')
  await userEvent.clear(el)
  if (text !== '') await userEvent.type(el, text)
  await settle(20)
}

afterEach(() => resetIndex())

describe('Go to', () => {
  it('opens on the input, with examples, as a labelled combobox', async () => {
    await open()
    expect(document.activeElement).toBe(input())
    const dialog = $('[role="dialog"]')
    const labelledBy = dialog?.getAttribute('aria-labelledby') ?? ''
    expect(document.getElementById(labelledBy)?.textContent).toBe('Go to')
    expect(input()?.getAttribute('aria-expanded')).toBe('false')
    expect($$('.chip').map((c) => plain(c))).toEqual(['2:255', 'p 262', 'j 15', 'h 30', 'Al-Kahf'])
    expect(ui.layerOpen).toBe(true)
  })

  it('fills the input from an example', async () => {
    await open()
    await userEvent.click($$('.chip')[0] as HTMLElement)
    await settle(20)
    expect(input()?.value).toBe('2:255')
    expect(options()).toHaveLength(1)
    expect(document.activeElement).toBe(input())
  })

  it('starts from the initial text', async () => {
    await open({ initial: 'p 262' })
    expect(input()?.value).toBe('p 262')
    expect(plain(activeOption())).toContain('Page 262')
  })

  it('jumps to an ayah after the dialog has closed, moving focus to it', async () => {
    const goToAyah = vi.spyOn(reader, 'goToAyah')
    await open()
    await typeQuery('2:255')
    expect(options()).toHaveLength(1)
    expect(plain(activeOption())).toContain('Al-Baqara 2:255')
    expect(input()?.getAttribute('aria-expanded')).toBe('true')
    await userEvent.keyboard('{Enter}')
    expect(ui.isOpen('goto')).toBe(false)
    await settle(500)
    expect(goToAyah).toHaveBeenCalledTimes(1)
    expect(goToAyah).toHaveBeenCalledWith(quran.ayahId(2, 255), { select: false, flash: true, focus: true })
  })

  it('selects an ayah range', async () => {
    const goToAyah = vi.spyOn(reader, 'goToAyah')
    await open()
    await typeQuery('2:255-257')
    await userEvent.keyboard('{Enter}')
    await settle(500)
    // One jump selects the whole range (`selectTo`), so its first ayah flashes and is announced with the range.
    expect(goToAyah).toHaveBeenCalledWith(quran.ayahId(2, 255), {
      select: true,
      selectTo: quran.ayahId(2, 257),
      flash: true,
      focus: true,
    })
    await expect
      .poll(() => reader.selection)
      .toMatchObject({ fromAyahId: quran.ayahId(2, 255), toAyahId: quran.ayahId(2, 257) })
  })

  it('moves between candidates with the arrows and opens a page', async () => {
    const goToPage = vi.spyOn(reader, 'goToPage')
    await open()
    await typeQuery('18')
    expect(options().map((o) => o.querySelector('.title')?.textContent)).toEqual(['Al-Kahf', 'Page 18'])
    expect(activeOption()).toBe(options()[0])
    await userEvent.keyboard('{ArrowDown}')
    expect(activeOption()).toBe(options()[1])
    expect(options()[1]?.getAttribute('aria-selected')).toBe('true')
    await userEvent.keyboard('{ArrowDown}')
    expect(activeOption()).toBe(options()[0])
    await userEvent.keyboard('{ArrowUp}{Enter}')
    await settle(500)
    expect(goToPage).toHaveBeenCalledWith(18, { push: true, transition: true })
  })

  it('opens a surah by name, with a click', async () => {
    const goToAyah = vi.spyOn(reader, 'goToAyah')
    await open()
    await typeQuery('kahf')
    await userEvent.click(options()[0] as HTMLElement)
    await settle(500)
    expect(goToAyah).toHaveBeenCalledWith(quran.surahRange(18).from, { flash: true, focus: true })
  })

  it('shows out-of-range targets disabled, with the reason, and never opens them', async () => {
    const goToAyah = vi.spyOn(reader, 'goToAyah')
    await open()
    await typeQuery('2:300')
    const option = options()[0]
    expect(option?.getAttribute('aria-disabled')).toBe('true')
    expect(option?.textContent).toContain('Al-Baqara has 286 ayahs')
    expect(input()?.getAttribute('aria-activedescendant')).toBeNull()
    await userEvent.keyboard('{Enter}')
    // Playwright never clicks an aria-disabled element; a DOM click still reaches the handler.
    ;(option as HTMLElement).click()
    await settle(300)
    expect(goToAyah).not.toHaveBeenCalled()
    expect(ui.isOpen('goto')).toBe(true)
  })

  it('says when nothing matches', async () => {
    await open()
    await typeQuery('qqqzzz')
    expect(options()).toHaveLength(0)
    expect($('.none')?.textContent).toContain('Nothing matches “qqqzzz”.')
  })

  it('closes on Escape without jumping', async () => {
    const goToAyah = vi.spyOn(reader, 'goToAyah')
    await open()
    await typeQuery('2:255')
    await userEvent.keyboard('{Escape}')
    await settle(400)
    expect(ui.isOpen('goto')).toBe(false)
    expect(goToAyah).not.toHaveBeenCalled()
  })

  it('runs right to left in the Arabic UI and takes Arabic references', async () => {
    const goToPage = vi.spyOn(reader, 'goToPage')
    await open({}, 'ar')
    expect(getComputedStyle($('[role="dialog"]') as HTMLElement).direction).toBe('rtl')
    expect(input()?.getAttribute('dir')).toBe('rtl')
    await typeQuery('ص ٢٦٢')
    expect(options()[0]?.querySelector('.title')?.textContent).toBe('الصفحة ٢٦٢')
    await userEvent.keyboard('{Enter}')
    await settle(500)
    expect(goToPage).toHaveBeenCalledWith(262, { push: true, transition: true })
  })
})
