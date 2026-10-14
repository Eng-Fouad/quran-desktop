/**
 * Select and Combobox: keyboard selection, typeahead on the closed trigger, the listbox direction and alignment
 * in the Arabic UI, groups, the floating-layer registration, and combobox filtering (Arabic letter folding).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import { ui } from '$lib/stores/ui.svelte'
import Select from './Select.svelte'
import { installShortcuts, parkPointer, resetUi, setUi, settle, spyShortcut } from './testing/harness'
import type { SelectItem } from './types'

const RECITERS: SelectItem[] = [
  { value: 'afasy', label: 'Mishary Alafasy', hint: 'مشاري العفاسي', hintLang: 'ar' },
  { value: 'husary', label: 'Mahmoud Khalil Al-Husary', hint: 'محمود خليل الحصري', hintLang: 'ar' },
  { value: 'minshawi', label: 'Mohamed Siddiq Al-Minshawi', hint: 'محمد صديق المنشاوي', hintLang: 'ar' },
  { value: 'sudais', label: 'Abdurrahman As-Sudais', hint: 'عبد الرحمن السديس', hintLang: 'ar' },
]
const TAFSIR: SelectItem[] = [
  { value: 'muyassar', label: 'التفسير الميسر', group: 'العربية' },
  { value: 'ibn-kathir', label: 'تفسير ابن كثير', group: 'العربية', keywords: ['Ibn Kathir'] },
  { value: 'maarif', label: "Ma'arif al-Qur'an", group: 'English' },
]

const trigger = () => document.querySelector<HTMLElement>('[data-select-trigger]')
const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]')
const highlighted = () =>
  document.querySelector('[role="option"][data-highlighted]')?.textContent?.trim() ?? ''

beforeEach(() => parkPointer())

afterEach(() => {
  resetUi()
  for (const host of document.querySelectorAll('[data-test-host]')) host.remove()
})

describe('Select', () => {
  it('opens with the keyboard, moves, selects with Enter and closes', async () => {
    const onValueChange = vi.fn()
    await render(Select, { props: { items: RECITERS, value: 'afasy', label: 'Reciter', onValueChange } })
    expect(trigger()?.textContent).toContain('Mishary Alafasy')
    trigger()?.focus()
    await userEvent.keyboard('{ArrowDown}')
    await settle(150)
    expect(listbox()).not.toBeNull()
    expect(ui.floating).toBe(1)
    expect(highlighted()).toContain('Mishary Alafasy') // starts on the selected row
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(highlighted()).toContain('Mohamed Siddiq')
    await userEvent.keyboard('{Enter}')
    await settle(200)
    expect(onValueChange).toHaveBeenCalledWith('minshawi')
    expect(listbox()).toBeNull()
    expect(ui.floating).toBe(0)
    expect(trigger()?.textContent).toContain('Mohamed Siddiq Al-Minshawi')
    expect(document.activeElement).toBe(trigger())
  })

  it('selects by typeahead while closed, like a native select', async () => {
    const onValueChange = vi.fn()
    await render(Select, { props: { items: RECITERS, value: 'afasy', label: 'Reciter', onValueChange } })
    trigger()?.focus()
    await userEvent.keyboard('a')
    expect(onValueChange).toHaveBeenLastCalledWith('sudais')
  })

  it('closes on Escape without changing the value', async () => {
    const onValueChange = vi.fn()
    await render(Select, { props: { items: RECITERS, value: 'afasy', label: 'Reciter', onValueChange } })
    trigger()?.focus()
    await userEvent.keyboard('{Enter}')
    await settle(150)
    await userEvent.keyboard('{ArrowDown}{Escape}')
    await settle(200)
    expect(listbox()).toBeNull()
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('runs in RTL in the Arabic UI: direction, end-aligned rows, and the listbox under the trigger’s start edge', async () => {
    setUi('ar')
    // Away from the window edge, so collision avoidance does not shift the list.
    const host = document.createElement('div')
    host.style.padding = '48px'
    host.dataset.testHost = ''
    document.body.append(host)
    await render(Select, {
      target: host,
      props: { items: RECITERS, value: 'husary', label: 'القارئ', size: 'sm' },
    })
    const t = trigger()
    expect(t?.getAttribute('dir')).toBe('rtl')
    t?.focus()
    await userEvent.keyboard('{Enter}')
    await settle(200)
    const box = listbox()
    expect(box).not.toBeNull()
    const content = box?.closest<HTMLElement>('.qd-listbox')
    expect(content?.getAttribute('dir')).toBe('rtl')
    expect(getComputedStyle(content as HTMLElement).direction).toBe('rtl')
    // Start alignment in RTL: the right edges line up (the list may be wider than the trigger).
    const tr = t?.getBoundingClientRect()
    const lr = content?.getBoundingClientRect()
    expect(Math.abs((lr?.right ?? 0) - (tr?.right ?? 0))).toBeLessThan(2)
    // The label sits at the inline start (right), the Arabic hint at the inline end (left).
    const row = document.querySelector<HTMLElement>('[role="option"][data-value="husary"]')
    const label = row?.querySelector('.label')?.getBoundingClientRect()
    const hint = row?.querySelector('.hint')?.getBoundingClientRect()
    expect((hint?.right ?? 0) <= (label?.left ?? 0)).toBe(true)
    expect(row?.querySelector('.hint')?.getAttribute('lang')).toBe('ar')
    // Keys still move through the rows in document order.
    expect(highlighted()).toContain('Mahmoud')
    await userEvent.keyboard('{ArrowDown}')
    expect(highlighted()).toContain('Mohamed')
  })

  it('groups rows under their headings', async () => {
    await render(Select, { props: { items: TAFSIR, value: 'muyassar', label: 'Tafsir' } })
    trigger()?.focus()
    await userEvent.keyboard('{Enter}')
    await settle(150)
    const groups = [...document.querySelectorAll('[role="group"]')]
    expect(groups.map((g) => g.querySelector('.heading')?.textContent)).toEqual(['العربية', 'English'])
    expect(groups[0]?.querySelectorAll('[role="option"]')).toHaveLength(2)
  })

  it('keeps arrows and letters away from reader shortcuts while open', async () => {
    const uninstall = installShortcuts()
    const nextAyah = spyShortcut(['ArrowDown'], { scope: 'reader', labelKey: 'shortcuts.nav.nextAyah' })
    const bookmark = spyShortcut(['b'], { scope: 'reader' })
    await render(Select, { props: { items: RECITERS, value: 'afasy', label: 'Reciter' } })
    trigger()?.focus()
    await userEvent.keyboard('{Enter}')
    await settle(150)
    await userEvent.keyboard('{ArrowDown}b')
    expect(nextAyah).not.toHaveBeenCalled()
    expect(bookmark).not.toHaveBeenCalled()
    uninstall()
  })
})

describe('Combobox (searchable Select)', () => {
  const input = () => document.querySelector<HTMLInputElement>('input[role="combobox"]')

  it('shows the selected label, filters as you type, and selects with Enter', async () => {
    const onValueChange = vi.fn()
    await render(Select, {
      props: {
        items: RECITERS,
        value: 'afasy',
        label: 'Reciter',
        searchable: true,
        emptyText: 'No matches',
        onValueChange,
      },
    })
    expect(input()?.value).toBe('Mishary Alafasy')
    expect(input()?.getAttribute('dir')).toBe('auto')
    input()?.focus()
    await userEvent.keyboard('{ArrowDown}')
    await settle(150)
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(4) // the whole list until typing
    await userEvent.clear(input() as HTMLInputElement)
    await userEvent.type(input() as HTMLInputElement, 'sud')
    await settle(100)
    const options = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim() ?? '')
    expect(options).toHaveLength(1)
    expect(options[0]).toContain('Abdurrahman As-Sudais')
    await userEvent.keyboard('{Enter}')
    await settle(200)
    expect(onValueChange).toHaveBeenCalledWith('sudais')
    expect(input()?.value).toBe('Abdurrahman As-Sudais')
  })

  it('matches Arabic without harakat or letter variants, hints and keywords too', async () => {
    await render(Select, {
      props: {
        items: [...RECITERS, ...TAFSIR],
        value: '',
        label: 'Source',
        searchable: true,
        emptyText: 'No matches',
      },
    })
    input()?.focus()
    // Non-US characters are inserted without key events here, so open the list first (a real Arabic layout sends
    // keydown, which opens it).
    await userEvent.keyboard('{ArrowDown}')
    await userEvent.type(input() as HTMLInputElement, 'الحُصَري')
    await settle(100)
    let options = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? '')
    expect(options).toHaveLength(1)
    expect(options[0]).toContain('Husary')
    await userEvent.clear(input() as HTMLInputElement)
    await userEvent.type(input() as HTMLInputElement, 'kathir')
    await settle(100)
    options = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? '')
    expect(options).toHaveLength(1)
    expect(options[0]).toContain('ابن كثير')
  })

  it('says so when nothing matches', async () => {
    await render(Select, {
      props: { items: RECITERS, value: '', label: 'Reciter', searchable: true, emptyText: 'No matches' },
    })
    input()?.focus()
    await userEvent.type(input() as HTMLInputElement, 'zzz')
    await settle(100)
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0)
    expect(document.querySelector('[role="status"]')?.textContent).toBe('No matches')
  })
})
