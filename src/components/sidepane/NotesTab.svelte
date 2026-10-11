<!--
  NotesTab (§9.7): the reader's notes on the pane's subject, with WP11d's note editor in compact mode. Owner: WP11b.

  - The note on exactly this ayah (or range) comes first, as a card that edits in place; without one, the composer
    for a new note on it. Then any other note that covers the subject (a note on 2:253–257 while 2:255 is shown),
    newest first, each labelled with its own range.
  - Saving, deleting and drafts belong to the editor (`NoteEditorDialog compact`: undo toasts, autosaved drafts, the
    discard question). The pane never takes the focus by itself.
-->
<script lang="ts">
  import NoteEditorDialog from '$components/dialogs/NoteEditorDialog.svelte'
  import type { Note } from '$lib/ipc/bindings'
  import { i18n, library, quran } from '$lib/stores'
  import type { Subject } from './pane.svelte'
  import TabBody from './TabBody.svelte'

  interface Props {
    subject: Subject
  }

  let { subject }: Props = $props()

  /** Notes that overlap the subject: the exact one first, then by start, newest first. */
  const covering: readonly Note[] = $derived(
    library.notes
      .filter((n) => n.fromAyahId <= subject.to && n.toAyahId >= subject.from)
      .sort(
        (a, b) =>
          Number(isExact(b)) - Number(isExact(a)) || a.fromAyahId - b.fromAyahId || b.updatedAt - a.updatedAt,
      ),
  )
  const exact = $derived(covering.find((n) => isExact(n)) ?? null)
  const others = $derived(covering.filter((n) => !isExact(n)))
  const label = $derived(
    i18n.t('sidepane.notes.label', { ref: quran.refLabel(subject.from, 'short', subject.to) }),
  )

  function isExact(n: Note): boolean {
    return n.fromAyahId === subject.from && n.toAyahId === subject.to
  }
</script>

<TabBody resetKey="{subject.from}-{subject.to}">
  <div class="notes" role="group" aria-label={label}>
    <div class="note" data-note={exact?.id ?? 'new'}>
      <NoteEditorDialog compact noteId={exact?.id} fromAyahId={subject.from} toAyahId={subject.to} />
    </div>
    {#each others as note (note.id)}
      <div class="note" data-note={note.id}>
        <p class="range">
          {i18n.t('sidepane.notes.covering', { ref: quran.refLabel(note.fromAyahId, 'long', note.toAyahId) })}
        </p>
        <NoteEditorDialog compact noteId={note.id} fromAyahId={note.fromAyahId} toAyahId={note.toAyahId} />
      </div>
    {/each}
  </div>
</TabBody>

<style>
  .notes {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .note {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-inline-size: 0;
  }

  .range {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: var(--weight-label);
  }
</style>
