<!--
  NoteEditorFields: the fields of the note editor, shared by the dialog (and its narrow-window sheet) and the
  side pane's compact editor (`NoteEditorDialog`). Edits a `NoteDraft`, which autosaves.

  - **Context** (dialog only): the opening of the ayah the note is on, in the Quran font, two lines at most with the
    cut line fading at its end (whole lines, a 24 px fade, never an ellipsis).
  - **Title**: one line, optional; Enter moves on to the body.
  - **Body**: a growing text area on the page colour, `dir="auto"` with per-line direction, and a toolbar of
    Markdown commands (bold, italic, highlight, heading, lists, quote, the note's reference) plus a formatting help
    popover. `Mod+B` / `Mod+I` format, Enter continues a list or a quote, and the editing commands keep the native
    undo stack. Write / Preview switches to the rendered note (`NoteBody`).
  - **Tags**: chips with a remove button, and a popover with the `TagPicker`; tags are saved with the note.
  - `Mod+Enter` (or `Mod+S`) anywhere in the fields calls `onsubmit`; in the compact editor Escape calls `oncancel`.
  - When the fields go away while the draft is still open (a question or another overlay covered the dialog), the caret,
    scroll position and view are remembered, and restored when they come back.
-->
<script lang="ts">
  import Bold from '@lucide/svelte/icons/bold'
  import BookOpen from '@lucide/svelte/icons/book-open'
  import CircleHelp from '@lucide/svelte/icons/circle-help'
  import Eye from '@lucide/svelte/icons/eye'
  import Heading from '@lucide/svelte/icons/heading'
  import Highlighter from '@lucide/svelte/icons/highlighter'
  import Italic from '@lucide/svelte/icons/italic'
  import List from '@lucide/svelte/icons/list'
  import ListOrdered from '@lucide/svelte/icons/list-ordered'
  import PenLine from '@lucide/svelte/icons/pen-line'
  import TagIcon from '@lucide/svelte/icons/tag'
  import TextQuote from '@lucide/svelte/icons/text-quote'
  import X from '@lucide/svelte/icons/x'
  import type { LucideIcon } from '@lucide/svelte'
  import { onMount, tick, untrack } from 'svelte'
  import NoteBody from '$components/library/NoteBody.svelte'
  import TagPicker from '$components/library/TagPicker.svelte'
  import { previews } from '$components/library/library.svelte'
  import { Button, IconButton, Popover, Segmented, TextInput } from '$components/ui'
  import { i18n, library } from '$lib/stores'
  import { bindEndMark } from '$lib/text/endmark'
  import {
    continueList,
    type InlineMark,
    type LineFormat,
    type TextEdit,
    toggleInline,
    toggleLines,
  } from '$lib/text/markdown'
  import {
    applyToTextarea,
    BODY_MAX,
    BODY_WARN,
    chordLabel,
    EDITOR_CHORDS,
    type NoteDraft,
    pressed,
    resumeMemory,
    TITLE_MAX,
  } from './noteEditor.svelte'

  interface Props {
    draft: NoteDraft
    fromAyahId: number
    /** The note's reference in words ("Al-Baqarah 2:255"), for placeholders and labels. */
    refText: string
    /** The reference the toolbar inserts, in the note syntax (`2:255`, `2:255-257`). */
    refSyntax: string
    /** The saved note's id (`null` for a new note). */
    noteId: string | null
    compact?: boolean
    /** Little width (the side pane, the narrow sheet): the Write / Preview switch shows icons only. */
    dense?: boolean
    /** The body fills the height it is given (the full-height sheet). */
    fill?: boolean
    /** Put the caret in the body when the fields appear (the dialog does it through `data-autofocus`). */
    autofocus?: boolean
    onsubmit: () => void
    oncancel?: () => void
  }

  let {
    draft,
    fromAyahId,
    refText,
    refSyntax,
    noteId,
    compact = false,
    dense = false,
    fill = false,
    autofocus = false,
    onsubmit,
    oncancel,
  }: Props = $props()

  // The fields edit one draft for their lifetime (their owner re-creates them for another).
  const memory = untrack(() => resumeMemory.get(draft.key))
  let mode = $state<'write' | 'preview'>(memory?.mode ?? 'write')
  let textarea: HTMLTextAreaElement | null = $state(null)
  let titleInput: HTMLInputElement | null = $state(null)
  let tagsOpen = $state(false)
  let helpOpen = $state(false)
  /** The text area's height (px), kept for the preview so switching never jumps. */
  let height = $state(0)

  const minLines = $derived(compact ? 4 : 9)

  // --- context ---------------------------------------------------------------------------------------------------------

  const ayahText = $derived.by(() => {
    const text = compact ? undefined : previews.text(fromAyahId)
    return text === undefined ? undefined : bindEndMark(text)
  })
  let contextEl: HTMLElement | null = $state(null)
  let contextCut = $state(false)

  $effect(() => {
    if (!compact) previews.want(fromAyahId)
  })

  $effect(() => {
    const el = contextEl
    void ayahText
    if (!el) return
    const measure = () => (contextCut = el.scrollHeight > el.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  })

  // --- body ------------------------------------------------------------------------------------------------------------

  function grow(): void {
    const el = textarea
    if (!el) return
    el.style.blockSize = 'auto'
    const next = el.scrollHeight + 2
    el.style.blockSize = `${next}px`
    height = el.getBoundingClientRect().height
  }

  /**
   * Where the caret goes when the text area first appears: where it was, else after the text. Applied once the text
   * area is in the document (the dialog's content is portaled after mount) or when it first takes the focus.
   */
  let initialSelection: [number, number] | null = untrack(() => {
    const end = draft.body.length
    return [memory?.selectionStart ?? end, memory?.selectionEnd ?? end]
  })

  function placeCaret(): void {
    const el = textarea
    if (!el || !initialSelection || !el.isConnected) return
    const [start, end] = initialSelection
    initialSelection = null
    el.setSelectionRange(start, end)
    if (memory) el.scrollTop = memory.scrollTop
  }

  let mounted = false

  onMount(() => {
    mounted = true
    grow()
    if (autofocus && textarea) {
      placeCaret()
      textarea.focus({ preventScroll: true })
    }
    if (memory?.inTitle) titleInput?.focus({ preventScroll: true })
    const frame = requestAnimationFrame(() => {
      placeCaret()
      grow()
    })
    return () => {
      mounted = false
      cancelAnimationFrame(frame)
    }
  })

  /**
   * Keeps where the editor is (caret, scroll, view, which field) as it changes, so fields that come back after being
   * covered resume there. Recorded continuously rather than at teardown, which may run after the draft has closed.
   */
  function remember(): void {
    // An event queued before the fields went away (a late `select`) must not overwrite what was kept.
    if (!mounted) return
    const el = textarea
    const kept = resumeMemory.get(draft.key) ?? memory
    const end = draft.body.length
    draft.remember({
      selectionStart: el?.selectionStart ?? kept?.selectionStart ?? end,
      selectionEnd: el?.selectionEnd ?? kept?.selectionEnd ?? end,
      scrollTop: el?.scrollTop ?? kept?.scrollTop ?? 0,
      mode,
      inTitle: titleInput !== null && document.activeElement === titleInput,
    })
  }

  function oninput(): void {
    draft.touch()
    grow()
    remember()
  }

  function apply(edit: TextEdit): void {
    if (!textarea) return
    applyToTextarea(textarea, edit)
    draft.touch()
    grow()
  }

  function format(kind: InlineMark | LineFormat): void {
    if (mode !== 'write' || !textarea) return
    const { selectionStart: a, selectionEnd: b, value } = textarea
    apply(
      kind === 'strong' || kind === 'em' || kind === 'mark'
        ? toggleInline(value, a, b, kind)
        : toggleLines(value, a, b, kind),
    )
  }

  /** Inserts the note's reference at the caret, or links the selection to it (`[selection](2:255)`). */
  function insertRef(): void {
    if (mode !== 'write' || !textarea) return
    const { selectionStart: a, selectionEnd: b, value } = textarea
    const selected = value.slice(a, b)
    if (selected.trim() !== '' && !selected.includes('\n')) {
      const insert = `[${selected}](${refSyntax})`
      apply({ from: a, to: b, insert, selectionStart: a + insert.length, selectionEnd: a + insert.length })
      return
    }
    const before = value.charAt(a - 1)
    const after = value.charAt(b)
    const lead = a > 0 && !/\s|\(/u.test(before) ? ' ' : ''
    const trail = after !== '' && !/\s|[.,;:!?)،؛]/u.test(after) ? ' ' : ''
    const insert = `${lead}${refSyntax}${trail}`
    const at = a + lead.length + refSyntax.length
    apply({ from: a, to: b, insert, selectionStart: at, selectionEnd: at })
  }

  function onBodyKeydown(e: KeyboardEvent): void {
    if (e.isComposing || e.defaultPrevented) return
    if (pressed(EDITOR_CHORDS.bold, e)) {
      e.preventDefault()
      format('strong')
      return
    }
    if (pressed(EDITOR_CHORDS.italic, e)) {
      e.preventDefault()
      format('em')
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && textarea) {
      const { selectionStart: a, selectionEnd: b, value } = textarea
      if (a !== b) return
      const edit = continueList(value, a)
      if (edit) {
        e.preventDefault()
        apply(edit)
      }
    }
  }

  function onTitleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.isComposing && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      if (mode === 'write') textarea?.focus()
    }
  }

  /** Keys of the whole form: save from any field; Escape cancels the compact editor. */
  function onFormKeydown(e: KeyboardEvent): void {
    // Before any key acts (Escape may cover the editor at once), keep where the caret is.
    remember()
    if (e.isComposing) return
    if (pressed(EDITOR_CHORDS.save, e) || pressed(EDITOR_CHORDS.saveAlt, e)) {
      e.preventDefault()
      e.stopPropagation()
      onsubmit()
      return
    }
    if (e.key === 'Escape' && compact && oncancel && !e.defaultPrevented) {
      e.preventDefault()
      e.stopPropagation()
      oncancel()
    }
  }

  async function setMode(next: string): Promise<void> {
    if (next !== 'write' && next !== 'preview') return
    if (next === 'preview' && textarea) {
      height = textarea.getBoundingClientRect().height
      remember()
    }
    const caret = resumeMemory.get(draft.key)
    mode = next
    remember()
    if (next === 'write') {
      await tick()
      const el = textarea
      if (el) {
        const end = draft.body.length
        el.setSelectionRange(caret?.selectionStart ?? end, caret?.selectionEnd ?? end)
        grow()
      }
    }
  }

  const left = $derived(BODY_MAX - draft.body.length)

  // --- tags ------------------------------------------------------------------------------------------------------------

  const tags = $derived(
    draft.tagIds.map((id) => library.tag(id)).filter((t): t is NonNullable<typeof t> => t !== undefined),
  )

  function setTags(ids: string[]): void {
    draft.tagIds = ids
    draft.touch()
  }

  // --- toolbar ---------------------------------------------------------------------------------------------------------

  interface Tool {
    id: InlineMark | LineFormat
    icon: LucideIcon
    label: string
    shortcut?: string
  }

  const tools: Tool[][] = $derived([
    [
      {
        id: 'strong',
        icon: Bold,
        label: i18n.t('notes.editor.bold'),
        shortcut: chordLabel(EDITOR_CHORDS.bold),
      },
      {
        id: 'em',
        icon: Italic,
        label: i18n.t('notes.editor.italic'),
        shortcut: chordLabel(EDITOR_CHORDS.italic),
      },
      { id: 'mark', icon: Highlighter, label: i18n.t('notes.editor.highlight') },
    ],
    [
      { id: 'heading', icon: Heading, label: i18n.t('notes.editor.heading') },
      { id: 'bullet', icon: List, label: i18n.t('notes.editor.bullets') },
      { id: 'ordered', icon: ListOrdered, label: i18n.t('notes.editor.numbers') },
      { id: 'quote', icon: TextQuote, label: i18n.t('notes.editor.quote') },
    ],
  ])

  /** The formatting buttons form one tab stop; arrow keys move between them (in the UI direction), Home and End too. */
  let toolbar: HTMLElement | null = $state(null)
  let rovingTool = $state<string>('strong')
  const toolOrder = $derived([...tools.flat().map((t) => t.id as string), 'reference'])

  function onToolbarKeydown(e: KeyboardEvent): void {
    const current = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[data-tool]') : null
    const i = current ? toolOrder.indexOf(current.dataset.tool ?? '') : -1
    if (i < 0) return
    const forward = i18n.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight'
    const back = i18n.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft'
    const n = toolOrder.length
    const next =
      e.key === forward
        ? (i + 1) % n
        : e.key === back
          ? (i - 1 + n) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : -1
    const id = toolOrder[next]
    if (id === undefined) return
    e.preventDefault()
    rovingTool = id
    toolbar?.querySelector<HTMLElement>(`[data-tool="${id}"]`)?.focus()
  }

  const help = $derived([
    `**${i18n.t('notes.editor.helpBold')}**`,
    `*${i18n.t('notes.editor.helpItalic')}*`,
    `==${i18n.t('notes.editor.helpHighlight')}==`,
    `## ${i18n.t('notes.editor.helpHeading')}`,
    `- ${i18n.t('notes.editor.helpList')}`,
    `1. ${i18n.t('notes.editor.helpNumbered')}`,
    `- [ ] ${i18n.t('notes.editor.helpTask')}`,
    `> ${i18n.t('notes.editor.helpQuote')}`,
    `[${i18n.t('notes.editor.helpRefLabel')}](2:255)`,
  ])

  const iconsOnly = $derived(dense || compact)
  const viewOptions = $derived([
    {
      value: 'write',
      label: i18n.t('notes.editor.write'),
      icon: iconsOnly ? PenLine : undefined,
      iconOnly: iconsOnly,
    },
    {
      value: 'preview',
      label: i18n.t('notes.editor.preview'),
      icon: iconsOnly ? Eye : undefined,
      iconOnly: iconsOnly,
    },
  ])
</script>

<!-- Form-level keys (save from any field); every control inside keeps its own semantics. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class={['fields', { compact, fill }]} onkeydown={onFormKeydown} onfocusin={remember}>
  {#if !compact}
    <figure class="context" aria-label={i18n.t('notes.editor.context')}>
      {#if ayahText === undefined}
        <span class="context-skeleton" aria-hidden="true"></span>
      {:else}
        <p bind:this={contextEl} class={['ayah', 'quran-text', { cut: contextCut }]} lang="ar" dir="rtl">
          {ayahText}
        </p>
      {/if}
    </figure>
  {/if}

  <TextInput
    bind:value={draft.title}
    bind:ref={titleInput}
    class="title"
    size={compact ? 'sm' : 'md'}
    placeholder={i18n.t('notes.editor.titlePlaceholder')}
    aria-label={i18n.t('notes.editor.title')}
    maxlength={TITLE_MAX}
    autocomplete="off"
    data-autofocus={!compact && memory?.inTitle ? '' : undefined}
    oninput={() => draft.touch()}
    onkeydown={onTitleKeydown}
  />

  <div class={['editor', `mode-${mode}`]}>
    <!-- The focus lives on the buttons (one roving tab stop); the toolbar only moves it between them. -->
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div
      bind:this={toolbar}
      class="toolbar"
      role="toolbar"
      aria-label={i18n.t('notes.editor.toolbar')}
      onkeydown={onToolbarKeydown}
    >
      {#each tools as group, g (g)}
        {#if g > 0}<span class="sep" aria-hidden="true"></span>{/if}
        {#each group as tool (tool.id)}
          <IconButton
            size="sm"
            icon={tool.icon}
            label={tool.label}
            shortcut={tool.shortcut}
            disabled={mode !== 'write'}
            tabindex={rovingTool === tool.id ? 0 : -1}
            data-tool={tool.id}
            onmousedown={(e: MouseEvent) => e.preventDefault()}
            onclick={() => format(tool.id)}
          />
        {/each}
      {/each}
      <span class="sep" aria-hidden="true"></span>
      <IconButton
        size="sm"
        icon={BookOpen}
        label={i18n.t('notes.editor.reference', { ref: refSyntax })}
        disabled={mode !== 'write'}
        tabindex={rovingTool === 'reference' ? 0 : -1}
        data-tool="reference"
        onmousedown={(e: MouseEvent) => e.preventDefault()}
        onclick={insertRef}
      />
      <span class="spacer"></span>
      {#if !compact}
        <Popover
          bind:open={helpOpen}
          side="bottom"
          align="end"
          width={340}
          label={i18n.t('notes.editor.helpTitle')}
          class="note-popover"
        >
          {#snippet trigger({ props })}
            <IconButton {...props} size="sm" icon={CircleHelp} label={i18n.t('notes.editor.help')} />
          {/snippet}
          <div class="help">
            <p class="help-intro">{i18n.t('notes.editor.helpIntro')}</p>
            <dl class="help-list">
              {#each help as sample (sample)}
                <div class="help-row">
                  <dt><code dir="auto">{sample}</code></dt>
                  <dd><NoteBody body={sample} size="sm" onref={() => undefined} /></dd>
                </div>
              {/each}
              <div class="help-row">
                <dt><code dir="ltr">2:255</code></dt>
                <dd class="help-ref">{i18n.t('notes.editor.helpRef')}</dd>
              </div>
            </dl>
          </div>
        </Popover>
      {/if}
      <Segmented
        class="view-switch"
        size="sm"
        options={viewOptions}
        value={mode}
        onValueChange={setMode}
        label={i18n.t('notes.editor.view')}
      />
    </div>

    {#if mode === 'write'}
      <textarea
        bind:this={textarea}
        bind:value={draft.body}
        class="body"
        dir="auto"
        rows={minLines}
        maxlength={BODY_MAX}
        spellcheck="true"
        placeholder={i18n.t(compact ? 'notes.compact.placeholder' : 'notes.editor.bodyPlaceholder', {
          ref: refText,
        })}
        aria-label={i18n.t('notes.editor.body')}
        data-autofocus={!compact && !memory?.inTitle ? '' : undefined}
        style:--_min-lines={minLines}
        {oninput}
        onkeydown={onBodyKeydown}
        onfocus={placeCaret}
        onkeyup={remember}
        onselect={remember}
        onpointerup={remember}
        onscroll={remember}></textarea>
    {:else}
      <div class="preview" style:min-block-size={height > 0 ? `${height}px` : undefined}>
        {#if draft.body.trim() === ''}
          <p class="preview-empty">{i18n.t('notes.editor.previewEmpty')}</p>
        {:else}
          <NoteBody body={draft.body} size={compact ? 'sm' : 'md'} />
        {/if}
      </div>
    {/if}
  </div>

  {#if left <= BODY_WARN}
    <p class={['limit', { over: left < 0 }]} aria-live="polite">
      {left >= 0 ? i18n.tp('notes.editor.charsLeft', left) : i18n.tp('notes.editor.tooLong', -left)}
    </p>
  {/if}

  <div class="tags">
    {#if tags.length > 0}
      <ul class="chips" aria-label={i18n.t('notes.editor.tags')}>
        {#each tags as tag (tag.id)}
          <li class="chip">
            {#if tag.color}<span class="dot" style:background-color={tag.color} aria-hidden="true"
              ></span>{/if}
            <bdi class="chip-name">{tag.name}</bdi>
            <button
              type="button"
              class="chip-x"
              aria-label={i18n.t('notes.editor.removeTag', { name: tag.name })}
              onclick={() => setTags(draft.tagIds.filter((id) => id !== tag.id))}
            >
              <X size={12} strokeWidth={2} aria-hidden="true" />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    <Popover
      bind:open={tagsOpen}
      side="top"
      align="start"
      width={300}
      label={i18n.t('notes.editor.tags')}
      class="note-popover"
    >
      {#snippet trigger({ props })}
        <Button {...props} size="sm" variant="ghost" class="add-tags">
          {#snippet icon()}<TagIcon size={16} strokeWidth={1.75} aria-hidden="true" />{/snippet}
          {tags.length > 0 ? i18n.t('notes.editor.editTags') : i18n.t('notes.editor.addTags')}
        </Button>
      {/snippet}
      <TagPicker kind="note" itemId={noteId ?? draft.key} selected={draft.tagIds} onchange={setTags} />
    </Popover>
  </div>
</div>

<style>
  .fields {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-inline-size: 0;
  }

  /* In the full-height sheet the writing area takes the room that is left. */
  .fields.fill {
    min-block-size: 100%;
  }

  .fill .editor {
    flex: 1 1 auto;
  }

  .fill .body,
  .fill .preview {
    flex: 1 1 auto;
    max-block-size: none;
  }

  .fields.compact {
    gap: var(--space-2);
  }

  /* --- context ------------------------------------------------------------------------------------------------------ */

  .context {
    margin: 0;
    padding-block: var(--space-1);
    padding-inline: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background-color: var(--surface-page);
  }

  .ayah {
    /* Two lines of the Quran font; the second fades out at its end when the ayah goes on. */
    --_line: 2.05em;
    max-block-size: calc(var(--_line) * 2);
    margin: 0;
    overflow: hidden;
    color: var(--ink);
    font-family: var(--font-quran);
    font-size: 22px;
    line-height: var(--_line);
    text-align: start;
  }

  /* The Quran text is always right-to-left, so its end is on the left in both UI directions. */
  .ayah.cut {
    mask-image:
      linear-gradient(#000, #000), linear-gradient(to left, transparent 0, #000 var(--space-6)); /* physical-ok */
    mask-position: top, bottom;
    mask-size: 100% 50%;
    mask-repeat: no-repeat;
  }

  .context-skeleton {
    display: block;
    block-size: calc(22px * 2.05);
    border-radius: var(--radius-sm);
    background: linear-gradient(to left, var(--surface-hover) 0, var(--surface-hover) 62%, transparent 62%);
    opacity: 0.8;
  }

  /* The title sits on the page colour with the body: one sheet to write on. */
  .fields :global(.box.title) {
    background-color: var(--surface-page);
  }

  /* --- editor ------------------------------------------------------------------------------------------------------- */

  .editor {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-input);
    border-radius: var(--radius-md);
    background-color: var(--surface-page);
    transition: border-color var(--dur-fast) var(--ease-standard);
  }

  .editor:hover:not(:focus-within) {
    border-color: var(--text-muted);
  }

  .editor:has(textarea:focus-visible) {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-0_5);
    padding: var(--space-1);
    border-block-end: 1px solid var(--border);
  }

  .sep {
    inline-size: 1px;
    block-size: 16px;
    margin-inline: var(--space-1);
    background-color: var(--border-strong);
  }

  .spacer {
    flex: 1 1 auto;
  }

  /* Stays at the end of the toolbar, also when a narrow sheet wraps it onto a second line. */
  .toolbar :global(.view-switch) {
    margin-inline-start: auto;
  }

  .body {
    --_lh: 1.65;
    display: block;
    inline-size: 100%;
    min-block-size: calc(var(--_min-lines) * var(--_lh) * 1em + var(--space-3) * 2);
    max-block-size: min(52vh, 520px);
    padding-block: var(--space-3);
    padding-inline: var(--space-4);
    border: 0;
    border-radius: 0 0 var(--radius-md) var(--radius-md);
    background: none;
    color: var(--text);
    font-family: inherit;
    font-size: var(--text-md);
    line-height: var(--_lh);
    text-align: start;
    unicode-bidi: plaintext;
    resize: none;
    outline: none;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
  }

  .compact .body {
    max-block-size: 50vh;
    padding-inline: var(--space-3);
    font-size: var(--text-sm);
  }

  .body::placeholder {
    color: var(--text-faint);
    opacity: 1;
  }

  .preview {
    max-block-size: min(52vh, 520px);
    padding-block: var(--space-3);
    padding-inline: var(--space-4);
    overflow-y: auto;
    scrollbar-width: thin;
  }

  .compact .preview {
    padding-inline: var(--space-3);
  }

  .preview-empty {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .limit {
    margin-block: calc(var(--space-2) * -1) 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    text-align: end;
  }

  .limit.over {
    color: var(--danger-text);
  }

  /* --- tags --------------------------------------------------------------------------------------------------------- */

  .tags {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1);
    min-block-size: 28px;
  }

  .chips {
    display: contents;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    max-inline-size: 100%;
    block-size: 24px;
    padding-inline: var(--space-2) var(--space-0_5);
    border-radius: var(--radius-full);
    background-color: var(--accent-soft);
    color: var(--accent-text);
    font-size: var(--text-xs);
    font-weight: var(--weight-label);
  }

  .chip-name {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip-x {
    display: inline-grid;
    flex: none;
    place-items: center;
    inline-size: 20px;
    block-size: 20px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-full);
    background: none;
    color: inherit;
    cursor: pointer;
  }

  .chip-x:hover {
    background-color: color-mix(in srgb, currentColor 14%, transparent);
  }

  .tags :global(.add-tags) {
    color: var(--text-muted);
  }

  /* --- help --------------------------------------------------------------------------------------------------------- */

  .help {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .help-intro {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .help-list {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
    gap: var(--space-1) var(--space-3);
    margin: 0;
  }

  .help-row {
    display: contents;
  }

  .help-row dt,
  .help-row dd {
    display: flex;
    align-items: center;
    min-block-size: 24px;
    margin: 0;
  }

  .help-row code {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    unicode-bidi: plaintext;
  }

  .help-ref {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  @media (forced-colors: active) {
    .editor {
      border-color: CanvasText;
    }
  }
</style>
