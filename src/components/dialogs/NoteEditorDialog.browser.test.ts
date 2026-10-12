/**
 * The note editor in a real browser (WP11d acceptance; §7.4, §10.1 Escape row, §9.5): opening from `ui.open`, the
 * autosaved draft, Escape that asks "Discard note?" only for unsaved body text (and resumes exactly when the question is
 * cancelled), saving and deleting through the library (undo toasts), a draft restored after the editor was closed from
 * outside, the Markdown commands (Mod+B, list continuation, the toolbar) that never reach the reader's shortcuts, the
 * preview (rendered through SafeHtml, references navigate), tags, the narrow-window sheet, the side pane's compact
 * editor, and the Arabic UI.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { cleanup, render } from 'vitest-browser-svelte'
import '../../app.css'
import { stripIsolates } from '$components/library/library.svelte'
import { app, library, reader, settings, ui } from '$lib/stores'
import { bootApp, resetApp, settle } from '../shell/testing/boot'
import NoteEditorDialog from './NoteEditorDialog.svelte'
import { AUTOSAVE_MS, decodeDraft, resumeMemory } from './noteEditor.svelte'

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const plain = (el: Element | null | undefined) =>
  stripIsolates(el?.textContent ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
const editor = () => $('.note-editor')
const textarea = () => $<HTMLTextAreaElement>('.note-editor textarea')
const titleField = () => $<HTMLInputElement>('.note-editor input[aria-label="Title"]')
const button = (label: string, root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => plain(b) === label || b.getAttribute('aria-label') === label,
  )
const mod = () => (app.isMac ? 'Meta' : 'Control')
/** A Write / Preview switch option (its label is drawn twice: shown, and reserved for the bold width). */
const view = (label: string) =>
  $$('.note-editor .view-switch button').find((b) => b.querySelector('.text > span')?.textContent === label)

async function until(fn: () => boolean, ms = 2500): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await settle(20)
  }
}

async function openEditor(props: { noteId?: string; fromAyahId: number; toAyahId: number }): Promise<void> {
  ui.open('note-editor', props)
  flushSync()
  await until(() => textarea() !== null || $('.note-editor .loading') !== null)
  await settle(260)
}

async function chord(key: string): Promise<void> {
  await userEvent.keyboard(`{${mod()}>}${key}{/${mod()}}`)
  await settle(40)
}

afterEach(async () => {
  // Unmount first: an editor that goes away keeps its draft, which must not reach the next test.
  await cleanup()
  resetApp()
  localStorage.clear()
  resumeMemory.clear()
  vi.restoreAllMocks()
  await page.viewport(1280, 800)
})

describe('NoteEditorDialog: opening and saving', () => {
  it('opens a new note on the target with the ayah quoted and the caret in the body', async () => {
    await bootApp()
    await openEditor({ fromAyahId: 262, toAyahId: 262 })
    const dialog = editor() as HTMLElement
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(plain(dialog.querySelector('h2'))).toBe('New note')
    expect(plain(dialog)).toContain('On Al-Baqarah 2:255')
    expect(document.activeElement).toBe(textarea())
    expect(textarea()?.getAttribute('dir')).toBe('auto')
    expect(stripIsolates(textarea()?.placeholder ?? '')).toContain('Al-Baqarah 2:255')
    await until(() => $('.note-editor .context .ayah.quran-text') !== null)
    const ayah = $('.note-editor .context .ayah') as HTMLElement
    expect(ayah.getAttribute('dir')).toBe('rtl')
    expect(ayah.getAttribute('lang')).toBe('ar')
    // A note needs text before it can be saved; the editor is a layer for the shortcuts (§7.7 rule 1).
    expect($<HTMLButtonElement>('.note-editor button.save')?.disabled).toBe(true)
    expect(ui.layerOpen).toBe(true)
  })

  it('autosaves the draft, then saves the note with Mod+Enter (undo toast) and closes', async () => {
    await bootApp()
    await openEditor({ fromAyahId: 262, toAyahId: 264 })
    await userEvent.click(titleField() as HTMLElement)
    await userEvent.keyboard('Ayat  al-Kursi ')
    await userEvent.click(textarea() as HTMLElement)
    await userEvent.keyboard('The greatest ayah.')
    await settle(AUTOSAVE_MS + 100)
    const draft = decodeDraft(ui.draft('note:new:262-264'))
    expect(draft).toMatchObject({ title: 'Ayat  al-Kursi ', body: 'The greatest ayah.' })
    expect(plain(editor())).toContain('Draft saved')

    await chord('{Enter}')
    await until(() => library.notes.length === 1)
    expect(library.notes[0]).toMatchObject({
      fromAyahId: 262,
      toAyahId: 264,
      title: 'Ayat al-Kursi',
      body: 'The greatest ayah.',
    })
    await until(() => !ui.isOpen('note-editor'))
    expect(ui.draft('note:new:262-264')).toBe('')
    await until(() => plain($('[data-sonner-toast]')).includes('Added a note to Al-Baqarah 2:255–257'))
    expect(library.canUndo).toBe(true)
  })

  it('edits a saved note, saves only real changes, and deletes it (undoable)', async () => {
    await bootApp()
    const note = await library.saveNote({
      id: null,
      fromAyahId: 1,
      toAyahId: 7,
      title: 'The Opening',
      body: 'Seven oft-repeated verses.',
      tagIds: [],
    })
    expect(note).not.toBeNull()
    const undoDepth = library.undoStack.length
    await openEditor({ noteId: note?.id, fromAyahId: 1, toAyahId: 7 })
    expect(plain(editor()?.querySelector('h2'))).toBe('Edit note')
    expect(plain(editor())).toContain('On Al-Fatihah 1:1–7')
    expect(titleField()?.value).toBe('The Opening')
    expect(textarea()?.value).toBe('Seven oft-repeated verses.')
    expect(plain(editor())).toMatch(/Edited/)

    // Nothing changed: Save just closes, with no new library change.
    await chord('{Enter}')
    await until(() => !ui.isOpen('note-editor'))
    expect(library.undoStack.length).toBe(undoDepth)

    await openEditor({ noteId: note?.id, fromAyahId: 1, toAyahId: 7 })
    await userEvent.click(button('Delete note') as HTMLElement)
    await until(() => library.notes.length === 0)
    await until(() => !ui.isOpen('note-editor'))
    await until(() => plain($('[data-sonner-toast]')).includes('Deleted the note on Al-Fatihah 1:1–7'))
    await library.undo()
    await until(() => library.notes.length === 1)
  })

  it('keeps the draft when a save fails and stays open', async () => {
    await bootApp()
    await openEditor({ fromAyahId: 8, toAyahId: 8 })
    const save = vi.spyOn(library, 'saveNote').mockResolvedValue(null)
    await userEvent.click(textarea() as HTMLElement)
    await userEvent.keyboard('kept')
    await chord('{Enter}')
    expect(save).toHaveBeenCalledOnce()
    await settle(100)
    expect(ui.isOpen('note-editor')).toBe(true)
    expect(decodeDraft(ui.draft('note:new:8-8'))?.body).toBe('kept')
  })
})

describe('NoteEditorDialog: closing (§10.1)', () => {
  it('closes at once when there is no unsaved body text', async () => {
    await bootApp()
    await openEditor({ fromAyahId: 262, toAyahId: 262 })
    // A title alone is not body text: no question (§10.1 asks only for a non-empty unsaved body).
    await userEvent.click(titleField() as HTMLElement)
    await userEvent.keyboard('Only a title')
    await userEvent.keyboard('{Escape}')
    await settle(60)
    expect(ui.isOpen('confirm')).toBe(false)
    expect(ui.isOpen('note-editor')).toBe(false)
    expect(ui.draft('note:new:262-262')).toBe('')
  })

  it('asks "Discard note?" for typed body text; Cancel resumes where it was, Discard drops the draft', async () => {
    await bootApp()
    await openEditor({ fromAyahId: 262, toAyahId: 262 })
    await userEvent.click(textarea() as HTMLElement)
    await userEvent.keyboard('First line{Enter}second line')
    textarea()?.setSelectionRange(3, 5)
    await userEvent.keyboard('{Escape}')
    await until(() => ui.topOverlay?.kind === 'confirm')
    expect(ui.isOpen('note-editor')).toBe(true)
    expect(ui.topOverlay?.props).toMatchObject({
      title: 'Discard note?',
      confirmLabel: 'Discard',
      danger: true,
    })
    await until(() => $('[data-confirm]') !== null)
    await settle(120)

    // Cancel: the editor comes back with its text and the same selection, without the "restored" notice.
    await userEvent.click(button('Cancel', $('[role="dialog"]') ?? document) as HTMLElement)
    await until(() => textarea() !== null)
    await settle(260)
    expect(textarea()?.value).toBe('First line\nsecond line')
    expect([textarea()?.selectionStart, textarea()?.selectionEnd]).toEqual([3, 5])
    expect(plain(editor())).not.toContain('restored')

    await userEvent.keyboard('{Escape}')
    await until(() => ui.topOverlay?.kind === 'confirm')
    await until(() => $('[data-confirm]') !== null)
    await settle(120)
    await userEvent.click($('[data-confirm]') as HTMLElement)
    await until(() => !ui.isOpen('note-editor'))
    expect(ui.draft('note:new:262-262')).toBe('')
    // Still none once every editor instance has gone after its exit: the editor the answer uncovers can show for a
    // moment before the covered one discards the draft, and it must not write it back as it goes.
    await until(() => editor() === null)
    expect(ui.draft('note:new:262-262')).toBe('')
    expect(library.notes).toHaveLength(0)
  })

  it('restores a draft left by an editor closed from outside, and Revert drops it', async () => {
    await bootApp()
    await openEditor({ fromAyahId: 300, toAyahId: 300 })
    await userEvent.click(textarea() as HTMLElement)
    await userEvent.keyboard('Unfinished thought')
    ui.close('note-editor')
    flushSync()
    await settle(400)
    expect(decodeDraft(ui.draft('note:new:300-300'))?.body).toBe('Unfinished thought')

    await openEditor({ fromAyahId: 300, toAyahId: 300 })
    expect(textarea()?.value).toBe('Unfinished thought')
    expect(plain(editor())).toContain('Unsaved draft restored')
    await userEvent.click(button('Revert') as HTMLElement)
    await settle(60)
    expect(textarea()?.value).toBe('')
    expect(ui.draft('note:new:300-300')).toBe('')
  })
})

describe('NoteEditorDialog: writing', () => {
  it('formats with Mod+B / Mod+I and the toolbar, continues lists on Enter, and keeps reader keys out', async () => {
    await bootApp({ settings: { sidebar: { open: true, tab: 'index', widthPx: 300 } } })
    await openEditor({ fromAyahId: 262, toAyahId: 262 })
    const ta = textarea() as HTMLTextAreaElement
    await userEvent.click(ta)
    await userEvent.keyboard('make it bold')
    ta.setSelectionRange(9, 9)
    await chord('b')
    expect(ta.value).toBe('make it **bold**')
    await chord('b')
    expect(ta.value).toBe('make it bold')
    ta.setSelectionRange(5, 7)
    await chord('i')
    expect(ta.value).toBe('make *it* bold')
    // The reader's Mod+B (sidebar) and Mod+I (side pane) never fired.
    expect(settings.value.sidebar.open).toBe(true)
    expect(settings.value.sidePane.open).toBe(false)

    ta.setSelectionRange(ta.value.length, ta.value.length)
    await userEvent.keyboard('{Enter}- first{Enter}second{Enter}')
    expect(ta.value).toBe('make *it* bold\n- first\n- second\n- ')
    await userEvent.keyboard('{Enter}')
    expect(ta.value).toBe('make *it* bold\n- first\n- second\n')

    await userEvent.keyboard('quoted')
    await userEvent.click($('.note-editor [data-tool="quote"]') as HTMLElement)
    expect(ta.value.endsWith('\n> quoted')).toBe(true)
    expect(document.activeElement).toBe(ta)
    await userEvent.click($('.note-editor [data-tool="reference"]') as HTMLElement)
    expect(ta.value.endsWith('> quoted 2:255')).toBe(true)
  })

  it('previews the Markdown through SafeHtml; references show the ayah', async () => {
    await bootApp()
    await openEditor({ fromAyahId: 262, toAyahId: 262 })
    const ta = textarea() as HTMLTextAreaElement
    await userEvent.click(ta)
    await userEvent.fill(ta, '## Point\n**Throne** verse, see 2:256 and <b>tags</b>\n\n3. third\n4. fourth')
    await userEvent.click(view('Preview') as HTMLElement)
    await settle(60)
    const body = $('.note-editor .preview .note-body') as HTMLElement
    expect(body.querySelector('h3')?.textContent).toBe('Point')
    expect(body.querySelector('strong')?.textContent).toBe('Throne')
    expect(body.querySelector('b')).toBeNull()
    expect(plain(body)).toContain('<b>tags</b>')
    expect(body.querySelector('ol')?.start).toBe(3)
    expect(body.querySelector('p')?.dir).toBe('auto')
    const goTo = vi.spyOn(reader, 'goToAyah')
    await userEvent.click(body.querySelector('button.ref[data-ref="2:256"]') as HTMLElement)
    expect(goTo).toHaveBeenCalledWith(263, expect.objectContaining({ flash: true }))
    // The toolbar is idle in the preview; Write returns to the text.
    expect(($('.note-editor [data-tool="strong"]') as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(view('Write') as HTMLElement)
    await settle(60)
    expect(textarea()?.value).toContain('## Point')
  })

  it('adds tags from the picker and saves them with the note', async () => {
    await bootApp()
    await library.createTag('Tawhid')
    await openEditor({ fromAyahId: 262, toAyahId: 262 })
    await userEvent.click(textarea() as HTMLElement)
    await userEvent.keyboard('Tagged')
    await userEvent.click(button('Add tags') as HTMLElement)
    await until(() => $('.popover .tag-picker input') !== null)
    await settle(60)
    await userEvent.keyboard('Patience')
    await until(() => plain($('.popover .tag-picker')).includes('Create the tag “Patience”'))
    await userEvent.keyboard('{Enter}')
    await until(() => library.tags.some((t) => t.name === 'Patience'))
    await userEvent.keyboard('taw{Enter}')
    await settle(60)
    await userEvent.keyboard('{Escape}')
    await settle(150)
    expect(ui.isOpen('note-editor')).toBe(true)
    expect($$('.note-editor .tags .chip').map((c) => plain(c))).toEqual(['Patience', 'Tawhid'])

    await chord('{Enter}')
    await until(() => library.notes.length === 1)
    const ids = library.notes[0]?.tagIds ?? []
    expect(ids.map((id) => library.tag(id)?.name).sort()).toEqual(['Patience', 'Tawhid'])
  })
})

describe('NoteEditorDialog: edges', () => {
  it('makes the formatting toolbar one tab stop that arrow keys move through', async () => {
    await bootApp()
    await openEditor({ fromAyahId: 262, toAyahId: 262 })
    const tool = (id: string) => $<HTMLButtonElement>(`.note-editor [data-tool="${id}"]`) as HTMLButtonElement
    expect($$('.note-editor [data-tool]').filter((b) => b.tabIndex === 0)).toHaveLength(1)
    tool('strong').focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(tool('em'))
    await userEvent.keyboard('{End}')
    expect(document.activeElement).toBe(tool('reference'))
    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(tool('strong'))
    await userEvent.keyboard('{ArrowLeft}')
    expect(document.activeElement).toBe(tool('reference'))
    expect(tool('reference').tabIndex).toBe(0)
    expect(tool('strong').tabIndex).toBe(-1)
  })

  it('opens a note that no longer exists as a new note on its range, and says so', async () => {
    await bootApp()
    await openEditor({ noteId: '01900000-0000-7000-8000-000000000000', fromAyahId: 10, toAyahId: 10 })
    await until(() => textarea() !== null)
    expect(plain(editor()?.querySelector('h2'))).toBe('New note')
    expect(plain(editor())).toContain('That note no longer exists, so this is a new one.')
    expect(plain(editor())).toContain('On Al-Baqarah 2:3')
  })
})

describe('NoteEditorDialog: layouts', () => {
  it('is a sheet from the inline end in a narrow window', async () => {
    await bootApp({ size: [700, 820] })
    await openEditor({ fromAyahId: 1, toAyahId: 1 })
    const sheet = editor() as HTMLElement
    expect(sheet.classList.contains('sheet')).toBe(true)
    expect(sheet.classList.contains('side-end')).toBe(true)
    expect(Math.round(sheet.getBoundingClientRect().right)).toBe(700)
  })

  it('mirrors in the Arabic UI', async () => {
    await bootApp({ settings: { uiLanguage: 'ar' } })
    await openEditor({ fromAyahId: 262, toAyahId: 262 })
    const dialog = editor() as HTMLElement
    expect(dialog.getAttribute('dir')).toBe('rtl')
    expect(plain(dialog.querySelector('h2'))).toBe('ملاحظة جديدة')
    expect(plain(dialog)).toContain('على البقرة')
    expect(textarea()?.placeholder).toContain('اكتب تأمّلك')
  })
})

describe('NoteEditorDialog compact (side pane)', () => {
  it('writes a note inline, shows it as a card, and edits it again', async () => {
    await bootApp()
    const { container } = await render(NoteEditorDialog, {
      props: { fromAyahId: 262, toAyahId: 262, compact: true },
    })
    await settle(80)
    const inline = container.querySelector('.note-inline') as HTMLElement
    expect(stripIsolates(inline.getAttribute('aria-label') ?? '')).toContain('Al-Baqarah 2:255')
    // The pane never takes the focus by itself.
    const ta = inline.querySelector('textarea') as HTMLTextAreaElement
    expect(document.activeElement).not.toBe(ta)
    await userEvent.click(ta)
    await userEvent.keyboard('Inline **note**')
    await settle(40)
    await userEvent.click(button('Save', inline) as HTMLElement)
    await until(() => library.notes.length === 1)
    await until(() => inline.querySelector('.card') !== null)
    expect(inline.querySelector('.card .note-body strong')?.textContent).toBe('note')
    expect(ui.isOpen('note-editor')).toBe(false)

    await userEvent.dblClick(inline.querySelector('.card') as HTMLElement)
    await until(() => inline.querySelector('textarea') !== null)
    await settle(40)
    const again = inline.querySelector('textarea') as HTMLTextAreaElement
    expect(again.value).toBe('Inline **note**')
    expect(document.activeElement).toBe(again)
    await userEvent.keyboard(' edited')
    await userEvent.keyboard('{Escape}')
    await until(() => ui.topOverlay?.kind === 'confirm')
    ui.resolveConfirm(true)
    await until(() => inline.querySelector('.card') !== null)
    expect(library.notes[0]?.body).toBe('Inline **note**')
  })
})
