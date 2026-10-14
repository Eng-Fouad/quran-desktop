<!--
  NoteEditorDialog: the note editor. Opened with `ui.open('note-editor', { noteId?, fromAyahId, toAyahId })` (N, the
  action bar, the context menu, the Notes panel) and rendered by `OverlayHost`; the side pane's Notes tab embeds it
  with `compact` (see `NoteInline`).

  - A dialog (620 px) with the ayah quoted on top, or a sheet from the inline end when the window is narrower than
    720 px.
  - The draft autosaves (`NoteDraft`). Escape, the close button, Cancel or a click outside close the editor; only when
    typed body text would be lost does it ask "Discard note?" first. The question covers the editor, and
    cancelling it brings the editor back exactly where it was (the draft and the caret are kept).
  - Save (`Mod+Enter`, `Mod+S`) writes through `library.saveNote` (toast with Undo), then closes; a failure keeps the
    editor open with its draft. Delete removes a saved note (undoable from the toast) and closes.
  - Closed from outside (another overlay replaced it, the window went), the draft stays for next time and the editor
    says so when it opens again ("Unsaved draft restored · Revert").
-->
<script lang="ts">
  import ArchiveRestore from '@lucide/svelte/icons/archive-restore'
  import CircleCheck from '@lucide/svelte/icons/circle-check'
  import Trash from '@lucide/svelte/icons/trash'
  import { onDestroy, untrack } from 'svelte'
  import { Button, Dialog, Kbd, Sheet, Spinner } from '$components/ui'
  import type { NoteEditorProps } from '$lib/contracts/components'
  import { i18n, quran, ui } from '$lib/stores'
  import { overlayOpen } from '../shell/overlay'
  import NoteEditorFields from './NoteEditorFields.svelte'
  import NoteInline from './NoteInline.svelte'
  import { chordLabel, EDITOR_CHORDS, NoteSession, refSyntaxOf, resumeMemory } from './noteEditor.svelte'

  let { noteId, fromAyahId, toAyahId, compact = false }: NoteEditorProps = $props()

  /** Below this window width (CSS px) the editor is a sheet from the inline end. */
  const NARROW_BELOW = 720
  const WIDTH = 620

  // An overlay instance edits one target: `OverlayHost` mounts a new one for every `ui.open`.
  const initial = untrack(() => ({ noteId: noteId ?? null, fromAyahId, toAyahId, compact }))
  const session = initial.compact ? null : new NoteSession(initial)

  const isOpen = overlayOpen('note-editor')
  const open = $derived(isOpen())
  const narrow = $derived(ui.windowSize.w > 0 && ui.windowSize.w < NARROW_BELOW)
  const draft = $derived(session?.draft ?? null)
  const note = $derived(session?.note ?? null)
  const refText = $derived(session ? quran.refLabel(session.fromAyahId, 'long', session.toAyahId) : '')
  const title = $derived(i18n.t(note ? 'notes.editor.editTitle' : 'notes.editor.newTitle'))
  const description = $derived(i18n.t('notes.editor.on', { ref: refText }))
  const saveKeys = $derived(chordLabel(EDITOR_CHORDS.save))

  /** The save in flight, so a close asked meanwhile waits for it. */
  let saving: Promise<unknown> | null = null
  let closing = false

  onDestroy(() => {
    const d = session?.draft
    if (!d || d.finished) return
    // Covered (the discard question, the palette): keep the place. Closed from outside: keep only the draft.
    d.suspend()
    if (!ui.isOpen('note-editor')) resumeMemory.delete(d.key)
  })

  /** Close, asking first when typed text would be lost. */
  async function requestClose(): Promise<void> {
    if (!session || closing) return
    if (saving) await saving
    const d = session.draft
    if (!d) {
      ui.close('note-editor')
      return
    }
    if (d.finished) return
    d.flush()
    if (d.asksToDiscard) {
      closing = true
      const ok = await ui.confirm({
        title: i18n.t('notes.editor.discard.title'),
        body: i18n.t(note ? 'notes.editor.discard.body' : 'notes.editor.discard.bodyNew', { ref: refText }),
        confirmLabel: i18n.t('notes.editor.discard.confirm'),
        danger: true,
      })
      closing = false
      // Kept: the question covered this editor, and a fresh one has already come back on the draft.
      if (!ok) return
    }
    d.finish()
    ui.close('note-editor')
  }

  async function save(): Promise<void> {
    if (!session || saving) return
    const run = session.save()
    saving = run
    const saved = await run
    saving = null
    if (!saved) return
    session.draft?.finish()
    ui.close('note-editor')
  }

  async function remove(): Promise<void> {
    if (!session) return
    if (!(await session.remove())) return
    session.draft?.finish()
    ui.close('note-editor')
  }

  function onOpenChange(next: boolean): void {
    if (!next) void requestClose()
  }
</script>

{#if compact}
  {#key `${noteId ?? 'new'}|${fromAyahId}|${toAyahId}`}
    <NoteInline {noteId} {fromAyahId} {toAyahId} />
  {/key}
{:else if session}
  {#snippet body()}
    {#if session.status === 'loading' || !draft}
      <div class="loading" role="status">
        <Spinner size={20} />
        <span>{i18n.t('notes.editor.loading')}</span>
      </div>
    {:else}
      {#if session.missing}
        <p class="notice">{i18n.t('notes.editor.missing')}</p>
      {/if}
      <NoteEditorFields
        {draft}
        fromAyahId={session.fromAyahId}
        {refText}
        refSyntax={refSyntaxOf(session.fromAyahId, session.toAyahId)}
        noteId={note?.id ?? null}
        dense={narrow}
        fill={narrow}
        onsubmit={() => void save()}
      />
    {/if}
  {/snippet}

  {#snippet footer()}
    <div class="foot">
      {#if note}
        <Button variant="ghost" class="delete" loading={session.deleting} onclick={() => void remove()}>
          {#snippet icon()}<Trash size={16} strokeWidth={1.75} aria-hidden="true" />{/snippet}
          {i18n.t('notes.editor.delete')}
        </Button>
      {/if}
      <p class="status" aria-live="polite">
        {#if draft?.restored}
          <ArchiveRestore size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>{i18n.t('notes.editor.status.restored')}</span>
          <Button
            variant="link"
            size="sm"
            class="revert"
            title={i18n.t('notes.editor.status.revertHint')}
            onclick={() => draft?.revert()}
          >
            {i18n.t('notes.editor.status.revert')}
          </Button>
        {:else if draft?.dirty && !draft.canSave}
          <span>{i18n.t('notes.editor.status.needsText')}</span>
        {:else if draft?.dirty && draft.savedAt !== null}
          <CircleCheck size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>{i18n.t('notes.editor.status.draftSaved')}</span>
        {:else if note && !draft?.dirty}
          <span>{i18n.t('notes.editor.status.edited', { time: i18n.relTime(note.updatedAt) })}</span>
        {/if}
      </p>
      <Button variant="secondary" onclick={() => void requestClose()}>{i18n.t('common.cancel')}</Button>
      <Button
        variant="primary"
        class="save"
        loading={session.saving}
        disabled={!draft?.canSave}
        aria-label={i18n.t('notes.editor.save')}
        aria-keyshortcuts={saveKeys}
        title={i18n.t('notes.editor.saveHint', { keys: saveKeys })}
        onclick={() => void save()}
      >
        {i18n.t('common.save')}
        <Kbd chord={saveKeys} size="sm" class="save-keys" />
      </Button>
    </div>
  {/snippet}

  {#if narrow}
    <Sheet {open} {onOpenChange} {title} {description} side="end" width={480} class="note-editor" {footer}>
      {@render body()}
    </Sheet>
  {:else}
    <Dialog {open} {onOpenChange} {title} {description} width={WIDTH} class="note-editor" {footer}>
      {@render body()}
    </Dialog>
  {/if}
{/if}

<style>
  .loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    min-block-size: 240px;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .notice {
    margin-block: 0 var(--space-3);
    padding-block: var(--space-2);
    padding-inline: var(--space-3);
    border-radius: var(--radius-sm);
    background-color: var(--warning-soft);
    color: var(--warning-text);
    font-size: var(--text-sm);
  }

  .foot {
    display: flex;
    flex: 1 1 auto;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    min-inline-size: 0;
  }

  .foot :global(.delete) {
    margin-inline-start: calc(var(--space-2) * -1);
    color: var(--danger-text);
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

  .status :global(.revert) {
    flex: none;
    font-size: var(--text-xs);
  }

  .foot :global(.save) {
    gap: var(--space-2);
  }

  .foot :global(.save .save-keys) {
    color: inherit;
    opacity: 0.85;
  }

  .foot :global(.save .save-keys kbd) {
    border-color: color-mix(in srgb, currentColor 35%, transparent);
    background-color: transparent;
    box-shadow: none;
    color: inherit;
  }
</style>
