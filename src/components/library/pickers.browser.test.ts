/**
 * The collections and tag pickers and the rendered note body in a real browser: filtering (accent- and
 * harakat-insensitive), the keyboard (↑/↓, Enter, Escape that clears before it closes, Backspace on the chips),
 * get-or-create, the reported id lists, the choice shown at once until the library catches up, the Bookmarks panel's
 * popover end to end, and `NoteBody` (directions, list numbers, links, references).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { cleanup, render } from 'vitest-browser-svelte'
import '../../app.css'
import { api, call } from '$lib/ipc'
import { library, settings, ui } from '$lib/stores'
import { bootApp, resetApp, settle } from '../shell/testing/boot'
import CollectionsPicker from './CollectionsPicker.svelte'
import NoteBody from './NoteBody.svelte'
import TagPicker from './TagPicker.svelte'
import { stripIsolates } from './library.svelte'

const plain = (el: Element | null | undefined) =>
  stripIsolates(el?.textContent ?? '')
    .replace(/\s+/gu, ' ')
    .trim()

async function until(fn: () => boolean, ms = 2500): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await settle(20)
  }
}

/** The option rows of a picker, as their names (the create row reads "Create …"). */
function options(root: ParentNode): string[] {
  return [...root.querySelectorAll('[role="option"] .name')].map((n) => plain(n))
}

function checked(root: ParentNode): string[] {
  return [...root.querySelectorAll('[role="option"][aria-selected="true"] .name')].map((n) => plain(n))
}

afterEach(async () => {
  await cleanup()
  resetApp()
  vi.restoreAllMocks()
  await page.viewport(1280, 800)
})

describe('TagPicker', () => {
  it('lists the tags most used first, filters them, and reports the chosen ids', async () => {
    await bootApp()
    const kursi = await library.createTag('Kursi')
    const tawhid = await library.createTag('Tawḥīd')
    const adhkar = await library.createTag('أذكار')
    // Kursi is used twice, Tawḥīd once.
    await call(
      api.noteUpsert({
        id: null,
        fromAyahId: 262,
        toAyahId: 262,
        title: null,
        body: 'a',
        tagIds: [kursi?.id ?? '', tawhid?.id ?? ''],
      }),
    )
    await call(
      api.noteUpsert({
        id: null,
        fromAyahId: 1,
        toAyahId: 1,
        title: null,
        body: 'b',
        tagIds: [kursi?.id ?? ''],
      }),
    )
    await until(() => library.tags.find((t) => t.name === 'Kursi')?.usageCount === 2)

    let selected: string[] = []
    const onchange = vi.fn((ids: string[]) => (selected = ids))
    const { container, rerender } = await render(TagPicker, {
      props: { kind: 'note', itemId: 'n1', selected, onchange },
    })
    const root = container.querySelector('.tag-picker') as HTMLElement
    expect(root.dataset.item).toBe('n1')
    expect(options(root)).toEqual(['Kursi', 'Tawḥīd', 'أذكار'])
    expect(plain(root.querySelector('[role="option"] .count'))).toContain('Used 2 times')
    const input = root.querySelector('input') as HTMLInputElement
    expect(input.getAttribute('role')).toBe('combobox')
    expect(input.getAttribute('aria-controls')).toBe(root.querySelector('[role="listbox"]')?.id)

    // Accent- and alef-insensitive filtering; Enter takes the best match and clears the field for the next one.
    await userEvent.click(input)
    await userEvent.keyboard('tawhid')
    expect(options(root)).toEqual(['Tawḥīd'])
    await userEvent.keyboard('{Enter}')
    expect(onchange).toHaveBeenLastCalledWith([tawhid?.id])
    expect(input.value).toBe('')
    // Shown at once, before `selected` catches up.
    expect(checked(root)).toEqual(['Tawḥīd'])
    await rerender({ selected })
    await userEvent.keyboard('اذكار')
    expect(options(root)).toEqual(['أذكار'])
    await userEvent.keyboard('{Enter}')
    expect(onchange).toHaveBeenLastCalledWith([tawhid?.id, adhkar?.id])
    await rerender({ selected })
    expect([...root.querySelectorAll('.chip')].map((c) => plain(c))).toEqual(['Tawḥīd', 'أذكار'])

    // Arrows move the active option; Enter on a checked one unchecks it.
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(input.getAttribute('aria-activedescendant')).toBe(root.querySelectorAll('[role="option"]')[1]?.id)
    await userEvent.keyboard('{Enter}')
    expect(onchange).toHaveBeenLastCalledWith([adhkar?.id])
    await rerender({ selected })

    // Backspace in the empty field removes the last chip; a chip's × removes it too.
    await userEvent.keyboard('{Backspace}')
    expect(onchange).toHaveBeenLastCalledWith([])
  })

  it('creates a missing tag (get-or-create) and checks it', async () => {
    await bootApp()
    await library.createTag('Patience')
    const onchange = vi.fn()
    const { container } = await render(TagPicker, {
      props: { kind: 'highlight', itemId: 'h1', selected: [], onchange },
    })
    const root = container.querySelector('.tag-picker') as HTMLElement
    const input = root.querySelector('input') as HTMLInputElement
    await userEvent.click(input)
    await userEvent.keyboard('  Gratitude  ')
    expect(options(root)).toEqual(['Create the tag “Gratitude”'])
    await userEvent.keyboard('{Enter}')
    await until(() => onchange.mock.calls.length === 1)
    const created = library.tags.find((t) => t.name === 'Gratitude')
    expect(created).toBeDefined()
    expect(onchange).toHaveBeenCalledWith([created?.id])
    expect(input.value).toBe('')
    // An existing name (in another case) is never offered for creation.
    await userEvent.keyboard('PATIENCE')
    expect(options(root)).toEqual(['Patience'])
  })

  it('clears a typed filter on Escape without closing its popover', async () => {
    await bootApp()
    await library.createTag('Night')
    const n = await library.saveNote({
      id: null,
      fromAyahId: 5,
      toAyahId: 5,
      title: null,
      body: 'x',
      tagIds: [],
    })
    await settings.update({ sidebar: { ...settings.value.sidebar, open: true, tab: 'notes' } })
    await settle(120)
    const row = document.querySelector('.sidebar-panel li.item button.row') as HTMLElement
    await userEvent.click(row, { button: 'right' })
    await settle(120)
    const tagsItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) =>
      plain(m).startsWith('Tags'),
    )
    await userEvent.click(tagsItem as HTMLElement)
    await until(() => document.querySelector('.popover .tag-picker input') !== null)
    await settle(80)
    await userEvent.keyboard('nig')
    await userEvent.keyboard('{Escape}')
    await settle(80)
    const input = document.querySelector<HTMLInputElement>('.popover .tag-picker input')
    expect(input?.value).toBe('')
    expect(ui.floating).toBeGreaterThan(0)
    // The panel applies the choice with undo.
    await userEvent.keyboard('{ArrowDown}{Enter}')
    await until(() => (library.notes.find((x) => x.id === n?.id)?.tagIds.length ?? 0) === 1)
    await until(() => document.querySelectorAll('.popover .tag-picker [aria-selected="true"]').length === 1)
    await userEvent.keyboard('{Escape}')
    await until(() => document.querySelector('.popover .tag-picker') === null)
  })
})

describe('CollectionsPicker', () => {
  it('lists collections in their order with counts, toggles and creates', async () => {
    await bootApp()
    const duas = await library.createCollection('Duas')
    await library.createCollection('Stories', '#2f6b5e')
    await library.toggleBookmark(262)
    const b = library.bookmarkOf(262)
    await library.toggleCollection(262, duas?.id ?? '')
    await until(() => library.collection(duas?.id ?? '')?.itemCount === 1)

    const onchange = vi.fn()
    const { container } = await render(CollectionsPicker, {
      props: { bookmarkId: b?.id ?? '', selected: [duas?.id ?? ''], onchange },
    })
    const root = container.querySelector('.collections-picker') as HTMLElement
    expect(options(root)).toEqual(['Duas', 'Stories'])
    expect(checked(root)).toEqual(['Duas'])
    expect(plain(root.querySelector('[role="option"] .count'))).toContain('1 bookmark')
    expect(root.querySelectorAll('.dot')).toHaveLength(1)

    await userEvent.click(root.querySelectorAll<HTMLElement>('[role="option"]')[1] as HTMLElement)
    expect(onchange).toHaveBeenLastCalledWith([duas?.id, library.collections[1]?.id])

    await userEvent.click(root.querySelector('input') as HTMLElement)
    await userEvent.keyboard('Prophets')
    await userEvent.keyboard('{Enter}')
    await until(() => library.collections.some((c) => c.name === 'Prophets'))
    const prophets = library.collections.find((c) => c.name === 'Prophets')
    await until(
      () => (onchange.mock.lastCall?.[0] as string[] | undefined)?.includes(prophets?.id ?? '') === true,
    )
  })

  it('shows the empty state when there are no collections', async () => {
    await bootApp()
    const { container } = await render(CollectionsPicker, { props: { bookmarkId: 'b', selected: [] } })
    const root = container.querySelector('.collections-picker') as HTMLElement
    expect(plain(root)).toContain('No collections yet.')
    expect(plain(root)).toContain('Type a name to create the first one.')
  })

  it('works in the Bookmarks panel popover, end to end (setCollections, undo)', async () => {
    await bootApp()
    await library.createCollection('Duas')
    await library.toggleBookmark(262)
    await settings.update({ sidebar: { ...settings.value.sidebar, open: true, tab: 'bookmarks' } })
    await settle(120)
    const row = document.querySelector('.sidebar-panel li.item button.row') as HTMLElement
    await userEvent.click(row, { button: 'right' })
    await settle(120)
    const organise = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) =>
      plain(m).startsWith('Collections and tags'),
    )
    await userEvent.click(organise as HTMLElement)
    await until(() => document.querySelector('.popover .collections-picker') !== null)
    await settle(80)
    const option = document.querySelector<HTMLElement>('.popover .collections-picker [role="option"]')
    await userEvent.click(option as HTMLElement)
    await until(() => (library.bookmarkOf(262)?.collectionIds.length ?? 0) === 1)
    expect(option?.getAttribute('aria-selected')).toBe('true')
    await library.undo()
    await until(() => (library.bookmarkOf(262)?.collectionIds.length ?? 1) === 0)
    await until(() => option?.getAttribute('aria-selected') === 'false')
  })

  it('mirrors in the Arabic UI', async () => {
    await bootApp({ settings: { uiLanguage: 'ar' } })
    await library.createCollection('أدعية')
    const { container } = await render(CollectionsPicker, { props: { bookmarkId: 'b', selected: [] } })
    const root = container.querySelector('.collections-picker') as HTMLElement
    const input = root.querySelector('input') as HTMLInputElement
    expect(input.placeholder).toBe('ابحث عن مجموعة أو أنشئ واحدة')
    expect(getComputedStyle(root).direction).toBe('rtl')
  })
})

describe('NoteBody', () => {
  it('gives each block its own direction, keeps list numbers, and links references and web addresses', async () => {
    await bootApp()
    const open = vi.spyOn(api, 'systemOpenExternal')
    const onref = vi.fn()
    const body = [
      '## تأمّل',
      'An English line',
      '',
      '> سطر عربي',
      '> second line',
      '',
      '3. third',
      '4. fourth',
      '',
      'See 2:255 and https://quran.com/2/255.',
    ].join('\n')
    const { container } = await render(NoteBody, { props: { body, onref } })
    const root = container.querySelector('.note-body') as HTMLElement
    const h3 = root.querySelector('h3') as HTMLElement
    expect(h3.dir).toBe('auto')
    expect(getComputedStyle(h3).direction).toBe('rtl')
    expect(getComputedStyle(root.querySelector('p') as HTMLElement).direction).toBe('ltr')
    expect((root.querySelector('blockquote') as HTMLElement).dir).toBe('rtl')
    expect((root.querySelector('ol') as HTMLOListElement).start).toBe(3)

    await userEvent.click(root.querySelector('button.ref[data-ref="2:255"]') as HTMLElement)
    expect(onref).toHaveBeenCalledWith(262, 262)

    const link = root.querySelector('a.note-link') as HTMLAnchorElement
    expect(link.textContent).toBe('https://quran.com/2/255')
    expect(link.title).toContain('quran.com')
    await userEvent.click(link)
    expect(open).toHaveBeenCalledWith('https://quran.com/2/255')
    expect(location.href).not.toContain('quran.com')
  })

  it('never renders markup from the note', async () => {
    await bootApp()
    const { container } = await render(NoteBody, {
      props: { body: '<img src=x onerror="window.__pwned = 1"> **ok** <script>window.__pwned = 2</script>' },
    })
    await settle(60)
    const root = container.querySelector('.note-body') as HTMLElement
    expect(root.querySelector('img, script')).toBeNull()
    expect(root.querySelector('strong')?.textContent).toBe('ok')
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })
})
