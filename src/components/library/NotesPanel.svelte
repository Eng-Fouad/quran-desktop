<!--
  NotesPanel (§7.5, §9.8): the Notes sidebar panel. Owner: WP11c. The shell's `Sidebar` draws the heading; this is the
  body. Takes no props: it reads stores (§7.9).

  - A search field over titles, bodies, references and surah names, tag chips to narrow by tag, and "New note" for the
    reader's action target (§8.15; the note editor, WP11d).
  - Notes, most recently edited first. Each row: the title (or the body's first line), a two-line plain excerpt of the
    body (the Markdown is never rendered here), the opening of its first ayah in Quran text, and
    "Al-Baqarah 2:255–257 · edited 3 days ago" with its tags.
  - Click shows the note's ayahs in the reader with the side pane's Notes tab; double-click or Edit opens the editor;
    the item menu (§10.3: Open · Edit · Delete, plus Tags…) and Delete remove it (undoable).
  - Empty state: "N to add a note" with the key (§9.8).
-->
<script lang="ts">
  import CornerDownRight from '@lucide/svelte/icons/corner-down-right'
  import NotebookPen from '@lucide/svelte/icons/notebook-pen'
  import Pencil from '@lucide/svelte/icons/pencil'
  import Plus from '@lucide/svelte/icons/plus'
  import StickyNote from '@lucide/svelte/icons/sticky-note'
  import Tags from '@lucide/svelte/icons/tags'
  import Trash from '@lucide/svelte/icons/trash'
  import { rovingKeydown, typeIntoFilter } from '$components/index/roving'
  import TagPicker from '$components/library/TagPicker.svelte'
  import Button from '$components/ui/Button.svelte'
  import ContextMenu from '$components/ui/ContextMenu.svelte'
  import EmptyState from '$components/ui/EmptyState.svelte'
  import IconButton from '$components/ui/IconButton.svelte'
  import Popover from '$components/ui/Popover.svelte'
  import SearchInput from '$components/ui/SearchInput.svelte'
  import Skeleton from '$components/ui/Skeleton.svelte'
  import type { MenuEntry, Point } from '$components/ui/types'
  import type { Note, Tag } from '$lib/ipc/bindings'
  import { selectAyah } from '$lib/mushaf/interactions'
  import { editNoteOn, spanLabel, studyKey, targetSpan } from '$lib/shortcuts/study'
  import { i18n, library, quran, ui } from '$lib/stores'
  import LibraryItem from './LibraryItem.svelte'
  import {
    focusAfterRemoval,
    matches,
    metaLine,
    noteExcerpt,
    noteHeadline,
    openSpan,
    spanKeywords,
    stripIsolates,
  } from './library.svelte'

  let query = $state('')
  let filterInput: HTMLInputElement | null = $state(null)
  /** Nothing stored at all: the empty state alone, without tools that have nothing to work on. */
  const emptyLibrary = $derived(library.status === 'ready' && library.notes.length === 0 && query === '')
  let tagId = $state<string | null>(null)
  let list: HTMLElement | null = $state(null)
  /** An item's row in this panel's list. */
  const rowEl = (id: string) => list?.querySelector<HTMLElement>(`[data-note="${CSS.escape(id)}"]`) ?? null
  let tabStop = $state<string | null>(null)

  const sep = $derived(i18n.t('library.sep'))
  /** Tags that some note carries (the chips). */
  const noteTags: Tag[] = $derived(
    library.tags.filter((t) => library.notes.some((n) => n.tagIds.includes(t.id))),
  )
  const activeTag = $derived(tagId !== null && noteTags.some((t) => t.id === tagId) ? tagId : null)

  function refOf(n: Note): string {
    return quran.refLabel(n.fromAyahId, 'long', n.toAyahId !== n.fromAyahId ? n.toAyahId : undefined)
  }

  function titleOf(n: Note): string {
    const head = noteHeadline(n.title, n.body)
    return head === '' ? i18n.t('library.notes.untitled') : head
  }

  /** The excerpt under the title: the body without the line the title came from. */
  function excerptOf(n: Note): string {
    if (n.title !== null && n.title.trim() !== '') return noteExcerpt(n.body)
    const lines = n.body.split('\n')
    const first = lines.findIndex((l) => l.trim() !== '')
    return noteExcerpt(lines.slice(first + 1).join('\n'))
  }

  function metaOf(n: Note): string {
    return metaLine([refOf(n), i18n.t('library.panel.updated', { time: i18n.relTime(n.updatedAt) })])
  }

  function chipsOf(n: Note) {
    return n.tagIds
      .map((id) => library.tag(id))
      .filter((t): t is Tag => t !== undefined)
      .map((t) => ({ id: t.id, label: t.name, color: t.color }))
  }

  const rows: Note[] = $derived.by(() => {
    let out = library.notes
    if (activeTag !== null) out = out.filter((n) => n.tagIds.includes(activeTag))
    if (query.trim() !== '') {
      out = out.filter((n) =>
        matches(query, [
          n.title,
          n.body,
          stripIsolates(refOf(n)),
          ...spanKeywords({ from: n.fromAyahId, to: n.toAyahId }),
          ...n.tagIds.map((id) => library.tag(id)?.name),
        ]),
      )
    }
    return out
  })

  const stopId = $derived(rows.some((n) => n.id === tabStop) ? tabStop : (rows[0]?.id ?? null))

  /** "New note" works on the reader's action target (§8.15). */
  const target = $derived(targetSpan())
  const newLabel = $derived(
    target ? i18n.t('library.notes.newNoteOn', { ref: spanLabel(target) }) : i18n.t('library.notes.newNote'),
  )

  function open(n: Note): void {
    openSpan({ from: n.fromAyahId, to: n.toAyahId }, { select: true })
    ui.openSidePane('notes')
  }

  function edit(n: Note): void {
    ui.open('note-editor', { noteId: n.id, fromAyahId: n.fromAyahId, toAyahId: n.toAyahId })
  }

  function newNote(): void {
    if (target) editNoteOn(target)
  }

  function inPane(n: Note): void {
    selectAyah(n.fromAyahId)
    if (n.toAyahId > n.fromAyahId) selectAyah(n.toAyahId, true)
    ui.openSidePane('notes')
  }

  /** Arrows, Home/End and PageUp/PageDown move in the list; a typed character goes to the filter. */
  function onListKeydown(e: KeyboardEvent): void {
    if (!list) return
    if (typeIntoFilter(e, filterInput, (ch) => (query += ch))) return
    rovingKeydown(e, list)
  }

  function onFocusIn(e: FocusEvent): void {
    const id = (e.target as HTMLElement | null)?.dataset.note
    if (id) tabStop = id
  }

  function onDblClick(e: MouseEvent): void {
    const id = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-note]')?.dataset.note
    const n = id ? library.notes.find((x) => x.id === id) : undefined
    if (n) edit(n)
  }

  // --- the item menu (§10.3: Open · Edit · Delete) ------------------------------------------------------------------------

  let menuAt = $state<Point | null>(null)
  let menuFor = $state.raw<Note | null>(null)
  let tagsFor = $state.raw<Note | null>(null)
  let tagsOpen = $state(false)
  let tagsAnchor: HTMLElement | null = $state(null)

  function editTags(n: Note): void {
    tagsFor = n
    tagsAnchor = list?.querySelector<HTMLElement>(`[data-note="${CSS.escape(n.id)}"]`) ?? null
    requestAnimationFrame(() => (tagsOpen = true))
  }

  const menuItems: MenuEntry[] = $derived.by(() => {
    const n = menuFor
    if (n === null) return []
    return [
      { id: 'open', label: i18n.t('library.panel.open'), icon: CornerDownRight, onSelect: () => open(n) },
      { id: 'edit', label: i18n.t('library.notes.edit'), icon: Pencil, onSelect: () => edit(n) },
      { id: 'tags', label: i18n.t('library.panel.tags'), icon: Tags, onSelect: () => editTags(n) },
      { type: 'separator', id: 'sep' },
      {
        id: 'delete',
        label: i18n.t('library.panel.delete'),
        icon: Trash,
        danger: true,
        kbd: i18n.t('library.panel.deleteKey'),
        onSelect: () => {
          focusAfterRemoval(rowEl(n.id))
          void library.deleteNote(n.id)
        },
      },
    ]
  })

  const emptyKey = $derived(studyKey('study.note'))
</script>

<div class="panel">
  {#if !emptyLibrary}
    <div class="tools">
      <SearchInput
        bind:value={query}
        bind:ref={filterInput}
        size="sm"
        placeholder={i18n.t('library.notes.filter')}
        aria-label={i18n.t('library.notes.filter')}
      />
      <IconButton
        label={newLabel}
        icon={Plus}
        size="sm"
        shortcut={emptyKey}
        disabled={target === null}
        onclick={newNote}
      />
    </div>
  {/if}

  {#if noteTags.length > 0}
    <div class="chips" role="group" aria-label={i18n.t('library.panel.tagsHeading')}>
      {#each noteTags as t (t.id)}
        <button
          type="button"
          class="chip"
          aria-pressed={activeTag === t.id}
          onclick={() => (tagId = activeTag === t.id ? null : t.id)}
        >
          {#if t.color}<span class="dot" style:background-color={t.color}></span>{/if}
          <span class="chip-name" dir="auto">{t.name}</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="scroll" aria-busy={library.status === 'loading'}>
    {#if library.status === 'loading' || library.status === 'idle'}
      <div class="skeletons" aria-hidden="true">
        {#each [0, 1, 2] as i (i)}
          <div class="skeleton-row">
            <Skeleton w={28} h={28} radius="full" />
            <div class="skeleton-lines">
              <Skeleton w="60%" h={12} />
              <Skeleton w="95%" h={10} />
              <Skeleton w="80%" h={10} />
              <Skeleton w="45%" h={10} />
            </div>
          </div>
        {/each}
      </div>
    {:else if library.status === 'error'}
      <EmptyState
        compact
        title={i18n.t('library.panel.loadError')}
        body={i18n.t('library.panel.loadErrorBody')}
      >
        {#snippet action()}
          <Button size="sm" onclick={() => void library.loadAll()}>{i18n.t('library.panel.retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else if rows.length > 0}
      <div
        class="list"
        data-qd-roving-list
        bind:this={list}
        role="presentation"
        onkeydown={onListKeydown}
        onfocusin={onFocusIn}
        ondblclick={onDblClick}
      >
        <ul class="rows" aria-label={i18n.t('library.notes.list')}>
          {#each rows as n (n.id)}
            <LibraryItem
              title={titleOf(n)}
              userText
              excerpt={excerptOf(n)}
              ayahId={n.fromAyahId}
              meta={metaOf(n)}
              chips={chipsOf(n)}
              label={`${titleOf(n)}${sep}${stripIsolates(metaOf(n))}`}
              tabStop={n.id === stopId}
              data={{ note: n.id }}
              onopen={() => open(n)}
              onaux={() => inPane(n)}
              onmenu={(p) => {
                menuFor = n
                menuAt = p
              }}
              ondelete={() => void library.deleteNote(n.id)}
            >
              {#snippet lead()}
                <span class="mark"><StickyNote size={15} strokeWidth={1.75} /></span>
              {/snippet}
            </LibraryItem>
          {/each}
        </ul>
      </div>
    {:else if query.trim() !== '' || activeTag !== null}
      <EmptyState
        compact
        title={i18n.t('library.panel.noMatches', { query: query.trim() })}
        body={i18n.t('library.panel.noMatchesBody', { ref: i18n.ref(2, 255) })}
      />
    {:else}
      <EmptyState
        title={i18n.t('library.notes.emptyTitle')}
        body={i18n.t('library.notes.emptyBody', { key: emptyKey ?? 'N' })}
        kbd={emptyKey}
      >
        {#snippet action()}
          {#if target}
            <Button size="sm" variant="secondary" onclick={newNote}>
              {#snippet icon()}<NotebookPen size={16} strokeWidth={1.75} aria-hidden="true" />{/snippet}
              {newLabel}
            </Button>
          {/if}
        {/snippet}
      </EmptyState>
    {/if}
  </div>
</div>

<ContextMenu
  at={menuAt}
  onClose={() => (menuAt = null)}
  items={menuItems}
  label={menuFor ? titleOf(menuFor) : undefined}
/>

{#if tagsFor}
  {@const n = library.notes.find((x) => x.id === tagsFor?.id) ?? tagsFor}
  <Popover
    bind:open={tagsOpen}
    anchor={tagsAnchor}
    side={i18n.dir === 'rtl' ? 'left' : 'right'}
    align="start"
    width={300}
    label={i18n.t('library.panel.tagsHeading')}
  >
    <TagPicker
      kind="note"
      itemId={n.id}
      selected={n.tagIds}
      onchange={(ids) => void library.setTags('note', n.id, ids)}
    />
  </Popover>
{/if}

<style>
  .panel {
    display: flex;
    flex-direction: column;
    block-size: 100%;
    min-block-size: 0;
  }

  .tools {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-1);
    padding-block: var(--space-1) var(--space-2);
    padding-inline: var(--space-3) var(--space-2);
  }

  /* A row that scrolls sideways when it is longer than the panel, fading out at its inline end. */
  .chips {
    display: flex;
    flex: none;
    gap: var(--space-1);
    padding-block: 0 var(--space-2);
    padding-inline: var(--space-3);
    overflow-x: auto;
    scrollbar-width: none;
    mask-image: linear-gradient(to left, transparent 0, #000 var(--space-5));
  }

  :global([dir='rtl']) .chips {
    mask-image: linear-gradient(to right, transparent 0, #000 var(--space-5));
  }

  .chip {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 6px;
    block-size: 26px;
    max-inline-size: 160px;
    padding-inline: var(--space-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--text-xs);
    font-weight: var(--weight-label);
    cursor: pointer;
  }

  .chip:hover {
    background-color: var(--surface-hover);
    color: var(--text);
  }

  .chip[aria-pressed='true'] {
    border-color: var(--accent);
    background-color: var(--accent-soft);
    color: var(--accent-text);
  }

  .chip-name {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dot {
    flex: none;
    inline-size: 7px;
    block-size: 7px;
    border-radius: var(--radius-full);
  }

  .scroll {
    flex: 1 1 auto;
    min-block-size: 0;
    overflow-x: hidden;
    overflow-y: auto;
    padding-block: 0 var(--space-4);
    padding-inline: var(--space-1);
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }

  .rows {
    margin: 0;
    padding: 0;
  }

  .mark {
    display: grid;
    place-items: center;
    inline-size: 28px;
    block-size: 28px;
    border-radius: var(--radius-full);
    background-color: color-mix(in srgb, var(--text-muted) 12%, transparent);
    color: var(--text-muted);
  }

  .skeletons {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    padding: var(--space-2);
  }

  .skeleton-row {
    display: grid;
    grid-template-columns: 28px 1fr;
    gap: var(--space-3);
  }

  .skeleton-lines {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  @media (forced-colors: active) {
    .chip[aria-pressed='true'] {
      border-color: Highlight;
    }
  }
</style>
