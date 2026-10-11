<!--
  NoteInline (WP11d; §9.7 side pane, Notes tab): the note editor in compact mode, rendered by `NoteEditorDialog` with
  `compact` for the side pane (WP11b). One note on one range.

  - A saved note shows as a card: its title, the rendered body (`NoteBody`), its tags and when it was edited, with Edit
    and Delete. Double-click (or Enter on the card) edits it.
  - Editing (or a range without a note) shows the compact fields; the draft autosaves exactly as in the dialog, and a
    draft left from earlier opens straight into editing with "Unsaved draft restored · Revert".
  - Save (`Mod+Enter`) writes through the library (toast with Undo) and returns to the card; Cancel or Escape returns to
    it too, asking "Discard note?" only when typed body text would be lost.
  - The pane never takes the focus by itself: the caret moves into the editor only when the reader asks to edit.
-->
<script lang="ts">
  import ArchiveRestore from '@lucide/svelte/icons/archive-restore'
  import CircleCheck from '@lucide/svelte/icons/circle-check'
  import Pencil from '@lucide/svelte/icons/pencil'
  import Trash from '@lucide/svelte/icons/trash'
  import { onDestroy, untrack } from 'svelte'
  import NoteBody from '$components/library/NoteBody.svelte'
  import { Button, IconButton, Spinner } from '$components/ui'
  import { i18n, library, quran, ui } from '$lib/stores'
  import NoteEditorFields from './NoteEditorFields.svelte'
  import { chordLabel, EDITOR_CHORDS, NoteSession, refSyntaxOf, resumeMemory } from './noteEditor.svelte'

  interface Props {
    noteId?: string
    fromAyahId: number
    toAyahId: number
  }

  let { noteId, fromAyahId, toAyahId }: Props = $props()

  // `NoteEditorDialog` keys this component on its target, so one instance edits one note.
  let session = $state.raw(new NoteSession(untrack(() => ({ noteId: noteId ?? null, fromAyahId, toAyahId }))))
  /** The reader asked to edit the saved note (Edit, double-click). */
  let editingAsked = $state(false)
  /** Put the caret in the editor when it appears (only after the reader asked for it). */
  let focusEditor = $state(false)

  const draft = $derived(session.draft)
  const note = $derived(session.note)
  const editing = $derived(draft !== null && (editingAsked || note === null || draft.dirty))
  const refText = $derived(quran.refLabel(session.fromAyahId, 'long', session.toAyahId))
  const tags = $derived(
    (note?.tagIds ?? [])
      .map((id) => library.tag(id))
      .filter((t): t is NonNullable<typeof t> => t !== undefined),
  )
  const saveKeys = $derived(chordLabel(EDITOR_CHORDS.save))

  onDestroy(() => {
    const d = session.draft
    if (!d || d.finished) return
    d.suspend()
    resumeMemory.delete(d.key)
  })

  function edit(): void {
    focusEditor = true
    editingAsked = true
  }

  async function save(): Promise<void> {
    const before = session
    const wasNew = before.note === null
    const saved = await before.save()
    if (!saved || session !== before) return
    if (wasNew) {
      // The new note's draft lived under the range's key: from now on the note is edited under its own.
      before.draft?.finish()
      session = new NoteSession({ noteId: saved.id, fromAyahId: saved.fromAyahId, toAyahId: saved.toAyahId })
    } else {
      before.draft?.rebase(saved)
    }
    editingAsked = false
    focusEditor = false
  }

  async function cancel(): Promise<void> {
    const d = session.draft
    if (!d) return
    d.flush()
    if (d.asksToDiscard) {
      const ok = await ui.confirm({
        title: i18n.t('notes.editor.discard.title'),
        body: i18n.t(note ? 'notes.editor.discard.body' : 'notes.editor.discard.bodyNew', { ref: refText }),
        confirmLabel: i18n.t('notes.editor.discard.confirm'),
        danger: true,
      })
      if (!ok) return
    }
    d.revert()
    editingAsked = false
    focusEditor = false
  }

  async function remove(): Promise<void> {
    const before = session
    if (!(await before.remove())) return
    before.draft?.finish()
    if (session !== before) return
    session = new NoteSession({ noteId: null, fromAyahId: before.fromAyahId, toAyahId: before.toAyahId })
    editingAsked = false
    focusEditor = false
  }

  function onCardKeydown(e: KeyboardEvent): void {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault()
      edit()
    }
  }
</script>

<section
  class="note-inline"
  aria-label={i18n.t('notes.compact.label', { ref: refText })}
  data-note={note?.id}
>
  {#if session.status === 'loading' || !draft}
    <div class="loading" role="status">
      <Spinner size={16} />
      <span>{i18n.t('notes.editor.loading')}</span>
    </div>
  {:else if editing}
    <div class="editing">
      <NoteEditorFields
        {draft}
        fromAyahId={session.fromAyahId}
        {refText}
        refSyntax={refSyntaxOf(session.fromAyahId, session.toAyahId)}
        noteId={note?.id ?? null}
        compact
        autofocus={focusEditor}
        onsubmit={() => void save()}
        oncancel={() => void cancel()}
      />
      {#if draft.dirty || note !== null || draft.restored}
        <div class="actions">
          <p class="status" aria-live="polite">
            {#if draft.restored}
              <ArchiveRestore size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{i18n.t('notes.editor.status.restored')}</span>
            {:else if draft.dirty && !draft.canSave}
              <span>{i18n.t('notes.editor.status.needsText')}</span>
            {:else if draft.dirty && draft.savedAt !== null}
              <CircleCheck size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{i18n.t('notes.editor.status.draftSaved')}</span>
            {/if}
          </p>
          <Button size="sm" variant="ghost" onclick={() => void cancel()}>
            {draft.restored ? i18n.t('notes.editor.status.revert') : i18n.t('common.cancel')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={session.saving}
            disabled={!draft.canSave}
            aria-label={i18n.t('notes.editor.save')}
            aria-keyshortcuts={saveKeys}
            title={i18n.t('notes.editor.saveHint', { keys: saveKeys })}
            onclick={() => void save()}
          >
            {i18n.t('common.save')}
          </Button>
        </div>
      {/if}
    </div>
  {:else if note}
    <!-- The card edits on double-click or Enter (a shortcut for the Edit button beside it). -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <article
      class="card"
      tabindex="0"
      title={i18n.t('notes.compact.hint')}
      ondblclick={edit}
      onkeydown={onCardKeydown}
    >
      {#if note.title}
        <h3 class="title" dir="auto">{note.title}</h3>
      {/if}
      {#if note.body.trim() !== ''}
        <NoteBody body={note.body} size="sm" />
      {/if}
      {#if tags.length > 0}
        <ul class="chips" aria-label={i18n.t('notes.editor.tags')}>
          {#each tags as tag (tag.id)}
            <li class="chip">
              {#if tag.color}<span class="dot" style:background-color={tag.color} aria-hidden="true"
                ></span>{/if}
              <bdi>{tag.name}</bdi>
            </li>
          {/each}
        </ul>
      {/if}
      <footer class="meta">
        <span class="when"
          >{i18n.t('notes.editor.status.edited', { time: i18n.relTime(note.updatedAt) })}</span
        >
        <IconButton size="sm" icon={Pencil} label={i18n.t('notes.compact.edit')} onclick={edit} />
        <IconButton
          size="sm"
          icon={Trash}
          label={i18n.t('notes.editor.delete')}
          disabled={session.deleting}
          onclick={() => void remove()}
        />
      </footer>
    </article>
  {/if}
</section>

<style>
  .note-inline {
    min-inline-size: 0;
  }

  .loading {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding-block: var(--space-3);
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .editing {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .status {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: var(--space-1);
    min-inline-size: 0;
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .status > span {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-block: var(--space-3) var(--space-1);
    padding-inline: var(--space-4) var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background-color: var(--surface-page);
    outline: none;
    transition: border-color var(--dur-fast) var(--ease-standard);
  }

  .card:hover {
    border-color: var(--border-strong);
  }

  .card:focus-visible {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .title {
    margin: 0;
    padding-inline-end: var(--space-2);
    font-size: var(--text-md);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
    unicode-bidi: plaintext;
    text-align: start;
  }

  .card :global(.note-body) {
    padding-inline-end: var(--space-2);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    max-inline-size: 100%;
    block-size: 22px;
    padding-inline: var(--space-2);
    border-radius: var(--radius-full);
    background-color: var(--accent-soft);
    color: var(--accent-text);
    font-size: var(--text-2xs);
    font-weight: var(--weight-label);
  }

  .dot {
    flex: none;
    inline-size: 6px;
    block-size: 6px;
    border-radius: var(--radius-full);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: var(--space-0_5);
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .when {
    flex: 1 1 auto;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
