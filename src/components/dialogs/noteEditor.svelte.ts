/**
 * The note editor's working copy (WP11d; §7.4, §10.1 Escape row): the fields being edited, the saved version they are
 * compared with, and the draft autosave.
 *
 * - **Drafts.** Every edit is written to `ui.setDraft(key)` after a short pause (and at once when the editor goes away),
 *   so a "Discard note?" question, another overlay on top, a crash or a closed window never loses text. The key is
 *   `note:<id>` for a saved note and `note:new:<from>-<to>` for a new one; the value is a small JSON envelope with the
 *   title, the body and the tags. A draft equal to the saved note is never kept.
 * - **Dirty** compares the fields the way the backend stores them (one-line trimmed title, body without the line-ending
 *   and edge-whitespace differences the backend removes, tags as a set), so nothing asks to be saved that would not
 *   change the note.
 * - **Resuming.** `resumeMemory` keeps the caret, scroll position and Write/Preview choice of an editor that was only
 *   covered (the discard question, the palette), so it comes back exactly as it was and without the "draft restored"
 *   notice; it is forgotten when the editor finishes.
 */
import { api, call, IpcError } from '$lib/ipc'
import type { Note } from '$lib/ipc/bindings'
import { type Chord, formatChord, matchesChord, parseChord } from '$lib/shortcuts'
import { app, i18n, library, quran, ui } from '$lib/stores'
import type { TextEdit } from '$lib/text/markdown'

/** What the editor edits: a saved note (`noteId`) or a new one on a range. */
export interface NoteTarget {
  noteId?: string | null
  fromAyahId: number
  toAyahId: number
}

export interface NoteFields {
  title: string
  body: string
  tagIds: string[]
}

/** Longest title and body the backend accepts (quran-core `user_db::notes`). */
export const TITLE_MAX = 200
export const BODY_MAX = 100_000
/** The remaining-characters hint appears this close to the body limit. */
export const BODY_WARN = 2_000
/** Pause after the last keystroke before the draft is written. */
export const AUTOSAVE_MS = 400

const EMPTY: NoteFields = { title: '', body: '', tagIds: [] }

/** The `ui` draft key of a target. */
export function draftKey(target: NoteTarget): string {
  return target.noteId ? `note:${target.noteId}` : `note:new:${target.fromAyahId}-${target.toAyahId}`
}

/** The editable fields of a saved note (or empty ones for a new note). */
export function fieldsOf(note: Note | null | undefined): NoteFields {
  if (!note) return { ...EMPTY, tagIds: [] }
  return { title: note.title ?? '', body: note.body, tagIds: [...note.tagIds] }
}

/** The stored form of a title: one line, trimmed (as the backend keeps it). */
export function cleanTitle(title: string): string {
  return title.replace(/\s+/gu, ' ').trim()
}

/** The stored form of a body: `\n` line endings, edges trimmed. */
export function cleanBody(body: string): string {
  return body.replace(/\r\n?/gu, '\n').trim()
}

/** Whether two versions store the same note. */
export function sameFields(a: NoteFields, b: NoteFields): boolean {
  return (
    cleanTitle(a.title) === cleanTitle(b.title) &&
    cleanBody(a.body) === cleanBody(b.body) &&
    a.tagIds.length === b.tagIds.length &&
    a.tagIds.every((id) => b.tagIds.includes(id))
  )
}

/** A draft as stored in the `ui` store. */
export function encodeDraft(fields: NoteFields): string {
  return JSON.stringify({ v: 1, title: fields.title, body: fields.body, tagIds: fields.tagIds })
}

/** A stored draft, or `null` when there is none or it cannot be read (a bare string is taken as a body). */
export function decodeDraft(raw: string): NoteFields | null {
  if (raw === '') return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value === 'object' && value !== null && 'body' in value) {
      const v = value as Partial<Record<keyof NoteFields, unknown>>
      return {
        title: typeof v.title === 'string' ? v.title : '',
        body: typeof v.body === 'string' ? v.body : '',
        tagIds: Array.isArray(v.tagIds) ? v.tagIds.filter((t): t is string => typeof t === 'string') : [],
      }
    }
  } catch {
    // Not JSON: an older or hand-made draft holding just the body.
  }
  return { title: '', body: raw, tagIds: [] }
}

/** Where an editor that was only covered left off. */
export interface EditorMemory {
  selectionStart: number
  selectionEnd: number
  scrollTop: number
  mode: 'write' | 'preview'
  /** Focus was in the title field. */
  inTitle: boolean
}

// eslint-disable-next-line svelte/prefer-svelte-reactivity -- deliberately plain: read once when the fields mount
export const resumeMemory = new Map<string, EditorMemory>()

/** The working copy of one note in one editor. */
export class NoteDraft {
  readonly key: string
  title = $state('')
  body = $state('')
  tagIds = $state.raw<string[]>([])
  /** The saved version (empty for a new note). */
  baseline = $state.raw<NoteFields>(EMPTY)
  /** The editor opened on a draft left from an earlier session. */
  restored = $state(false)
  /** When the draft was last written (`Date.now()`), while it differs from the saved note. */
  savedAt = $state<number | null>(null)

  readonly fields: NoteFields = $derived({ title: this.title, body: this.body, tagIds: this.tagIds })
  readonly dirty = $derived(!sameFields(this.fields, this.baseline))
  /** A note needs a title or a body (and fits the limits). */
  readonly canSave = $derived(
    (cleanTitle(this.title) !== '' || cleanBody(this.body) !== '') &&
      this.body.length <= BODY_MAX &&
      this.title.length <= TITLE_MAX,
  )
  /** Closing would lose typed text: the §10.1 "Discard note?" question applies. */
  readonly asksToDiscard = $derived(this.dirty && cleanBody(this.body) !== '')

  #timer: ReturnType<typeof setTimeout> | undefined
  /** Unregisters the quit hook of a pending autosave. */
  #unquit: (() => void) | null = null
  #closed = false
  #finished = false

  /**
   * Opens a working copy of `baseline` under `key`, starting from the stored draft when one differs from it. `resumed`
   * says the same editor is coming back after being covered (no "restored" notice then).
   */
  constructor(key: string, baseline: NoteFields, resumed = false) {
    this.key = key
    this.baseline = baseline
    const stored = decodeDraft(ui.draft(key))
    const differs = stored !== null && !sameFields(stored, baseline)
    if (stored !== null && !differs) ui.clearDraft(key)
    const start = differs ? stored : baseline
    this.title = start.title
    this.body = start.body
    this.tagIds = [...start.tagIds]
    this.restored = differs && !resumed
    if (differs) this.savedAt = Date.now()
  }

  /** An edit happened: the draft is written after a short pause, or when the app quits first (`app.beforeQuit`). */
  touch(): void {
    if (this.#closed) return
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => this.flush(), AUTOSAVE_MS)
    this.#unquit ??= app.beforeQuit(() => this.flush())
  }

  /** Writes the draft now (or drops it when nothing differs from the saved note). */
  flush(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#unquit?.()
    this.#unquit = null
    if (this.#closed) return
    if (this.dirty) {
      ui.setDraft(this.key, encodeDraft(this.fields))
      this.savedAt = Date.now()
    } else {
      ui.clearDraft(this.key)
      this.savedAt = null
      this.restored = false
    }
  }

  /** Back to the saved note; the draft is dropped. */
  revert(): void {
    this.title = this.baseline.title
    this.body = this.baseline.body
    this.tagIds = [...this.baseline.tagIds]
    this.restored = false
    this.flush()
  }

  /** The note was saved: it becomes the new baseline, and the draft goes. */
  rebase(note: Note): void {
    this.baseline = fieldsOf(note)
    this.restored = false
    this.flush()
  }

  /** The editor is done (saved, discarded, or closed with nothing to keep): the draft and the memory go. */
  finish(): void {
    clearTimeout(this.#timer)
    this.#unquit?.()
    this.#unquit = null
    this.#closed = true
    this.#finished = true
    ui.clearDraft(this.key)
    resumeMemory.delete(this.key)
    this.savedAt = null
  }

  /** The editor goes away while editing (covered or closed from outside): what was typed stays as the draft. */
  suspend(): void {
    this.flush()
    this.#closed = true
  }

  /** No more writes (finished or suspended). */
  get closed(): boolean {
    return this.#closed
  }

  /** Saved, discarded or closed unchanged: nothing of this editor is kept. */
  get finished(): boolean {
    return this.#finished
  }

  /** Remembers where the editor is (caret, scroll, view), unless it has finished. */
  remember(memory: EditorMemory): void {
    if (!this.#finished) resumeMemory.set(this.key, memory)
  }
}

/**
 * One editor's session on a target: resolves the saved note, opens its working copy, and saves or deletes through the
 * library store (which toasts, records the undo entry and never rejects).
 */
export class NoteSession {
  readonly target: NoteTarget
  /** `loading` while a saved note not yet in the library is fetched. */
  status = $state<'loading' | 'ready'>('ready')
  note = $state.raw<Note | null>(null)
  draft = $state.raw<NoteDraft | null>(null)
  /** The note asked for no longer exists (this is a new note on its range). */
  missing = $state(false)
  saving = $state(false)
  deleting = $state(false)

  constructor(target: NoteTarget) {
    this.target = target
    const id = target.noteId ?? null
    if (id === null) {
      this.#open(null)
      return
    }
    const known = library.notes.find((n) => n.id === id)
    if (known) {
      this.#open(known)
      return
    }
    this.status = 'loading'
    void loadNote(id).then((note) => {
      this.missing = note === null
      this.#open(note)
      this.status = 'ready'
    })
  }

  /** The first ayah the note covers. */
  get fromAyahId(): number {
    return this.note?.fromAyahId ?? this.target.fromAyahId
  }

  /** The last ayah the note covers. */
  get toAyahId(): number {
    return this.note?.toAyahId ?? this.target.toAyahId
  }

  #open(note: Note | null): void {
    this.note = note
    const key = draftKey({
      noteId: note?.id ?? null,
      fromAyahId: note?.fromAyahId ?? this.target.fromAyahId,
      toAyahId: note?.toAyahId ?? this.target.toAyahId,
    })
    const draft = new NoteDraft(key, fieldsOf(note), resumeMemory.has(key))
    // A tag deleted since the draft was written is dropped.
    const live = liveTagIds(draft.tagIds)
    if (live.length !== draft.tagIds.length) draft.tagIds = live
    this.draft = draft
  }

  /**
   * Saves the working copy. Resolves the stored note (also when there was nothing to write), or `null` when it was not
   * saved (nothing to save, already saving, or a failure the library has toasted: the draft stays).
   */
  async save(): Promise<Note | null> {
    const draft = this.draft
    if (!draft || this.saving || this.deleting || !draft.canSave) return null
    if (this.note && !draft.dirty) return this.note
    this.saving = true
    draft.flush()
    try {
      const title = cleanTitle(draft.title)
      const saved = await library.saveNote({
        id: this.note?.id ?? null,
        fromAyahId: this.fromAyahId,
        toAyahId: this.toAyahId,
        title: title === '' ? null : title,
        body: draft.body,
        tagIds: liveTagIds(draft.tagIds),
      })
      if (saved) this.note = saved
      return saved
    } finally {
      this.saving = false
    }
  }

  /** Deletes the saved note (undo is in the toast). Resolves whether it was deleted. */
  async remove(): Promise<boolean> {
    const note = this.note
    if (!note || this.saving || this.deleting) return false
    this.deleting = true
    try {
      return await library.deleteNote(note.id)
    } finally {
      this.deleting = false
    }
  }
}

/**
 * The saved note an editor opens: from the library, else from the backend (the library may still be loading).
 * `null` when it no longer exists; other failures are toasted and also give `null`.
 */
export async function loadNote(id: string): Promise<Note | null> {
  const known = library.notes.find((n) => n.id === id)
  if (known) return known
  try {
    return await call(api.noteGet(id))
  } catch (e) {
    if (!(e instanceof IpcError && e.kind === 'not_found')) ui.toastError(e)
    return null
  }
}

/**
 * A range in the note syntax, which links when rendered: `2:255`, `2:255-257`; a range across surahs is written as its
 * first ayah (the syntax has no cross-surah form).
 */
export function refSyntaxOf(fromAyahId: number, toAyahId: number): string {
  const from = quran.ayahRef(fromAyahId)
  const to = quran.ayahRef(toAyahId)
  if (from.surah === 0) return ''
  return to.surah === from.surah && to.ayah > from.ayah
    ? `${from.surah}:${from.ayah}-${to.ayah}`
    : `${from.surah}:${from.ayah}`
}

/** The tag ids that still exist (a draft may name a tag deleted since). */
export function liveTagIds(ids: readonly string[]): string[] {
  return ids.filter((id) => library.tag(id) !== undefined)
}

// --- keys ------------------------------------------------------------------------------------------------------------

/**
 * The editor's own chords (matched with the §7.7 hybrid rules, so they work on Arabic and AZERTY layouts). They are
 * handled inside the editor and stop there, so the reader's `Mod+B` (sidebar) and `Mod+I` (side pane) never fire
 * while typing a note.
 */
export const EDITOR_CHORDS = {
  save: parseChord('Mod+Enter'),
  saveAlt: parseChord('Mod+s'),
  bold: parseChord('Mod+b'),
  italic: parseChord('Mod+i'),
} as const satisfies Record<string, Chord>

/** Whether a key event is the chord. */
export function pressed(chord: Chord, e: KeyboardEvent): boolean {
  return matchesChord(chord, e, app.isMac)
}

/** A chord as the user reads it (`Ctrl+B`, `⌘B`), for `Kbd` and tooltips. */
export function chordLabel(chord: Chord): string {
  return formatChord(chord, { isMac: app.isMac, keyLabel: (key) => i18n.t(`shortcuts.keys.${key}`) })
}

/**
 * Applies a text edit to a textarea through the browser's editing commands, so Ctrl+Z undoes a formatting command like
 * typing; where those are unavailable the text is replaced directly (and an `input` event keeps bindings current).
 */
export function applyToTextarea(el: HTMLTextAreaElement, edit: TextEdit): void {
  el.focus({ preventScroll: true })
  el.setSelectionRange(edit.from, edit.to)
  if (edit.from !== edit.to || edit.insert !== '') {
    let done: boolean
    try {
      done =
        edit.insert === ''
          ? document.execCommand('delete')
          : document.execCommand('insertText', false, edit.insert)
    } catch {
      done = false
    }
    if (!done) {
      el.setRangeText(edit.insert, edit.from, edit.to, 'end')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }
  el.setSelectionRange(edit.selectionStart, edit.selectionEnd)
}
