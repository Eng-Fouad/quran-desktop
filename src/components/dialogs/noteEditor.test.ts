/**
 * The note editor's working copy: draft keys and envelopes, the dirty rule that matches how the backend stores a
 * note, the autosave, revert, rebase, finish and suspend, and the resume memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initIpc } from '$lib/ipc'
import type { Note } from '$lib/ipc/bindings'
import { mockCommands } from '$lib/ipc/mock'
import { app } from '$lib/stores/app.svelte'
import { ui } from '$lib/stores/ui.svelte'
import {
  AUTOSAVE_MS,
  cleanBody,
  cleanTitle,
  decodeDraft,
  draftKey,
  encodeDraft,
  fieldsOf,
  NoteDraft,
  resumeMemory,
  sameFields,
} from './noteEditor.svelte'

const note: Note = {
  id: 'n1',
  fromAyahId: 262,
  toAyahId: 262,
  title: 'Kursi',
  body: 'The greatest ayah.',
  tagIds: ['t1', 't2'],
  createdAt: 1,
  updatedAt: 2,
}

beforeEach(() => {
  localStorage.clear()
  ui.reset()
  resumeMemory.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('drafts', () => {
  it('keys a saved note by id and a new note by its range', () => {
    expect(draftKey({ noteId: 'n1', fromAyahId: 1, toAyahId: 7 })).toBe('note:n1')
    expect(draftKey({ fromAyahId: 1, toAyahId: 7 })).toBe('note:new:1-7')
    expect(draftKey({ noteId: null, fromAyahId: 262, toAyahId: 262 })).toBe('note:new:262-262')
  })

  it('round-trips the envelope and reads a bare string as a body', () => {
    const f = { title: 'T', body: 'line 1\nline 2', tagIds: ['a'] }
    expect(decodeDraft(encodeDraft(f))).toEqual(f)
    expect(decodeDraft('')).toBeNull()
    expect(decodeDraft('just text')).toEqual({ title: '', body: 'just text', tagIds: [] })
    expect(decodeDraft('{"body": 3, "tagIds": [1, "x"]}')).toEqual({ title: '', body: '', tagIds: ['x'] })
  })

  it('compares the way the backend stores a note', () => {
    const base = fieldsOf(note)
    expect(sameFields(base, { ...base, title: '  Kursi ' })).toBe(true)
    expect(sameFields(base, { ...base, body: 'The greatest ayah.\r\n\n' })).toBe(true)
    expect(sameFields(base, { ...base, tagIds: ['t2', 't1'] })).toBe(true)
    expect(sameFields(base, { ...base, body: 'The greatest ayah!' })).toBe(false)
    expect(sameFields(base, { ...base, tagIds: ['t1'] })).toBe(false)
    expect(cleanTitle(' a \t b ')).toBe('a b')
    expect(cleanBody('\r\n x \r\n')).toBe('x')
    expect(fieldsOf(null)).toEqual({ title: '', body: '', tagIds: [] })
  })
})

describe('NoteDraft', () => {
  it('starts from the saved note and autosaves only real changes', () => {
    const d = new NoteDraft('note:n1', fieldsOf(note))
    expect(d.dirty).toBe(false)
    expect(d.restored).toBe(false)
    d.body = 'The greatest ayah. '
    d.touch()
    vi.advanceTimersByTime(AUTOSAVE_MS)
    expect(ui.draft('note:n1')).toBe('')
    d.body = 'Changed.'
    d.touch()
    expect(ui.draft('note:n1')).toBe('')
    vi.advanceTimersByTime(AUTOSAVE_MS)
    expect(decodeDraft(ui.draft('note:n1'))?.body).toBe('Changed.')
    expect(d.savedAt).not.toBeNull()
    expect(d.asksToDiscard).toBe(true)
  })

  it('a quit writes the draft still waiting for its autosave, and only while one waits', async () => {
    const quit = vi.spyOn(mockCommands, 'appQuit').mockResolvedValue({ status: 'ok', data: null })
    try {
      await initIpc()
      const d = new NoteDraft('note:n1', fieldsOf(note))
      d.body = 'Typed just before closing.'
      d.touch()
      d.touch() // one hook per pending autosave
      await app.quit()
      expect(quit).toHaveBeenCalledTimes(1)
      expect(decodeDraft(ui.draft('note:n1'))?.body).toBe('Typed just before closing.')
      // Saved, then a quit with nothing pending: the draft is not written again.
      d.rebase({ ...note, body: 'Typed just before closing.' })
      expect(ui.draft('note:n1')).toBe('')
      const write = vi.spyOn(ui, 'setDraft')
      await app.quit()
      expect(write).not.toHaveBeenCalled()
    } finally {
      app.reset()
    }
  })

  it('asks to discard only for unsaved body text, and needs a title or a body to save', () => {
    const d = new NoteDraft('note:new:1-1', fieldsOf(null))
    expect(d.canSave).toBe(false)
    d.title = 'Only a title'
    expect(d.dirty).toBe(true)
    expect(d.asksToDiscard).toBe(false)
    expect(d.canSave).toBe(true)
    d.title = ''
    d.body = '  \n '
    expect(d.canSave).toBe(false)
    d.body = 'text'
    expect(d.asksToDiscard).toBe(true)
  })

  it('restores a stored draft (with the notice) unless the same editor is resuming', () => {
    ui.setDraft('note:n1', encodeDraft({ title: 'Kursi', body: 'Draft body', tagIds: ['t1'] }))
    const restored = new NoteDraft('note:n1', fieldsOf(note))
    expect(restored.body).toBe('Draft body')
    expect(restored.tagIds).toEqual(['t1'])
    expect(restored.restored).toBe(true)
    const resumed = new NoteDraft('note:n1', fieldsOf(note), true)
    expect(resumed.body).toBe('Draft body')
    expect(resumed.restored).toBe(false)
    // A stored draft equal to the note is dropped.
    ui.setDraft('note:n2', encodeDraft(fieldsOf(note)))
    const same = new NoteDraft('note:n2', fieldsOf(note))
    expect(same.restored).toBe(false)
    expect(ui.draft('note:n2')).toBe('')
  })

  it('reverts to the saved note and rebases on a save', () => {
    ui.setDraft('note:n1', encodeDraft({ title: 'X', body: 'Y', tagIds: [] }))
    const d = new NoteDraft('note:n1', fieldsOf(note))
    d.revert()
    expect(d.fields).toEqual(fieldsOf(note))
    expect(d.restored).toBe(false)
    expect(ui.draft('note:n1')).toBe('')
    d.body = 'Saved now'
    d.flush()
    expect(ui.draft('note:n1')).not.toBe('')
    d.rebase({ ...note, body: 'Saved now' })
    expect(d.dirty).toBe(false)
    expect(ui.draft('note:n1')).toBe('')
  })

  it('finishing drops the draft and the memory; suspending keeps the draft and stops writing', () => {
    const d = new NoteDraft('note:n1', fieldsOf(note))
    d.body = 'typed'
    d.remember({ selectionStart: 1, selectionEnd: 2, scrollTop: 0, mode: 'write', inTitle: false })
    d.suspend()
    expect(decodeDraft(ui.draft('note:n1'))?.body).toBe('typed')
    expect(resumeMemory.has('note:n1')).toBe(true)
    d.body = 'after'
    d.touch()
    vi.advanceTimersByTime(AUTOSAVE_MS)
    expect(decodeDraft(ui.draft('note:n1'))?.body).toBe('typed')

    const e = new NoteDraft('note:n1', fieldsOf(note), true)
    e.finish()
    expect(e.finished).toBe(true)
    expect(ui.draft('note:n1')).toBe('')
    expect(resumeMemory.has('note:n1')).toBe(false)
    e.remember({ selectionStart: 0, selectionEnd: 0, scrollTop: 0, mode: 'write', inTitle: false })
    expect(resumeMemory.has('note:n1')).toBe(false)
  })

  it('never brings back a draft another editor finished: a suspend writes only its own edits', () => {
    // "Discard note?": the covered editor wrote its draft; when the question resolves, a fresh editor on that draft
    // can be shown for a moment before the covered one discards it and closes the editor.
    const covered = new NoteDraft('note:new:262-262', fieldsOf(null))
    covered.body = 'typed'
    covered.flush()
    covered.suspend()
    const fresh = new NoteDraft('note:new:262-262', fieldsOf(null), true)
    expect(fresh.body).toBe('typed')
    covered.finish()
    expect(ui.draft('note:new:262-262')).toBe('')
    fresh.suspend()
    expect(ui.draft('note:new:262-262')).toBe('')

    // An editor that changed something writes it: its new text, or no draft once it is back to the saved note.
    ui.setDraft('note:n1', encodeDraft({ ...fieldsOf(note), body: 'stored' }))
    const edited = new NoteDraft('note:n1', fieldsOf(note))
    edited.body = 'stored, then more'
    edited.touch()
    edited.suspend()
    expect(decodeDraft(ui.draft('note:n1'))?.body).toBe('stored, then more')
    vi.advanceTimersByTime(AUTOSAVE_MS)
    const reverted = new NoteDraft('note:n1', fieldsOf(note))
    reverted.body = note.body
    reverted.suspend()
    expect(ui.draft('note:n1')).toBe('')
  })
})
