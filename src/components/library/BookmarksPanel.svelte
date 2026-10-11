<!--
  BookmarksPanel (§7.5, §9.8): the Bookmarks sidebar panel. Owner: WP11c. The shell's `Sidebar` draws the heading;
  this is the body. Takes no props: it reads stores (§7.9).

  - A filter field (label, reference, surah name in either script) and an options menu: sort (most recent first or
    Mushaf order, remembered per viewer) and "New collection…".
  - Collection chips (when there are collections): All, then each collection with its count; right-click a chip to
    rename or delete it.
  - The reading bookmark (the ribbon, §8.9) heads the list.
  - Rows: ayah bookmarks (a filled bookmark mark, the label or "Al-Baqarah 2:255", the ayah's opening in Quran text,
    "page · time" and collection chips) and page bookmarks (a dog-ear, "Page 262", "Al-Hijr · Juz 14"). Click opens it
    in the reader (focus moves to the ayah, §7.4); a middle click opens it in the side pane without navigating (§10.2);
    the item menu (right-click, Shift+F10, More) offers Open · Open in side pane · Edit label · Collections ▸ ·
    Collections and tags… · Delete (§10.3); Delete removes it (undoable).
  - Empty state: "Press B on any ayah" with the key (§9.8).
-->
<script lang="ts">
  import ArrowDownUp from '@lucide/svelte/icons/arrow-down-up'
  import Bookmark from '@lucide/svelte/icons/bookmark'
  import CornerDownRight from '@lucide/svelte/icons/corner-down-right'
  import FolderPlus from '@lucide/svelte/icons/folder-plus'
  import PanelRightOpen from '@lucide/svelte/icons/panel-right-open'
  import Pencil from '@lucide/svelte/icons/pencil'
  import Tags from '@lucide/svelte/icons/tags'
  import Trash from '@lucide/svelte/icons/trash'
  import CollectionsPicker from '$components/library/CollectionsPicker.svelte'
  import TagPicker from '$components/library/TagPicker.svelte'
  import { rovingKeydown, typeIntoFilter } from '$components/index/roving'
  import Button from '$components/ui/Button.svelte'
  import ContextMenu from '$components/ui/ContextMenu.svelte'
  import EmptyState from '$components/ui/EmptyState.svelte'
  import IconButton from '$components/ui/IconButton.svelte'
  import Menu from '$components/ui/Menu.svelte'
  import Popover from '$components/ui/Popover.svelte'
  import SearchInput from '$components/ui/SearchInput.svelte'
  import Skeleton from '$components/ui/Skeleton.svelte'
  import type { MenuEntry, Point } from '$components/ui/types'
  import type { Bookmark as BookmarkRow, Collection } from '$lib/ipc/bindings'
  import { openPaneFor, studyKey } from '$lib/shortcuts/study'
  import { i18n, library, quran, reader, ui } from '$lib/stores'
  import { selectAyah } from '$lib/mushaf/interactions'
  import LibraryItem from './LibraryItem.svelte'
  import {
    focusAfterRemoval,
    matches,
    metaLine,
    openPage,
    openSpan,
    panelPrefs,
    spanKeywords,
    stripIsolates,
  } from './library.svelte'
  import PromptDialog from './PromptDialog.svelte'

  let query = $state('')
  let filterInput: HTMLInputElement | null = $state(null)
  /** Nothing stored at all: the empty state alone, without tools that have nothing to work on. */
  const emptyLibrary = $derived(library.status === 'ready' && library.bookmarks.length === 0 && query === '')
  let list: HTMLElement | null = $state(null)
  let tabStop = $state<string | null>(null)

  const collectionId = $derived(
    panelPrefs.collectionId !== null && library.collection(panelPrefs.collectionId)
      ? panelPrefs.collectionId
      : null,
  )
  const activeCollection = $derived(collectionId === null ? undefined : library.collection(collectionId))

  const sep = $derived(i18n.t('library.sep'))

  function pageOf(b: BookmarkRow): number {
    return b.kind === 'page' && b.page !== null ? b.page : quran.pageOfAyah(reader.layout, b.ayahId)
  }

  function refOf(b: BookmarkRow): string {
    return quran.refLabel(b.ayahId, 'long')
  }

  function titleOf(b: BookmarkRow): string {
    if (b.label) return b.label
    return b.kind === 'page' && b.page !== null ? i18n.t('library.pageLabel', { page: b.page }) : refOf(b)
  }

  function metaOf(b: BookmarkRow): string {
    const time = i18n.relTime(b.updatedAt)
    if (b.kind === 'page' && b.page !== null) {
      const { surah } = quran.ayahRef(b.ayahId)
      const where = i18n.t('library.bookmarks.pageSub', {
        surah: quran.surahName(surah),
        juz: quran.juzOf(b.ayahId),
      })
      return b.label
        ? metaLine([i18n.t('library.pageLabel', { page: b.page }), where, time])
        : metaLine([where, time])
    }
    const page = i18n.t('library.pageShort', { page: pageOf(b) })
    return b.label ? metaLine([refOf(b), page, time]) : metaLine([page, time])
  }

  const rows: BookmarkRow[] = $derived.by(() => {
    let out = library.bookmarks
    if (collectionId !== null) out = out.filter((b) => b.collectionIds.includes(collectionId))
    if (query.trim() !== '') {
      out = out.filter((b) =>
        matches(query, [
          b.label,
          stripIsolates(refOf(b)),
          ...spanKeywords({ from: b.ayahId, to: b.ayahId }),
          b.page === null ? null : i18n.t('library.pageLabel', { page: b.page }),
          ...b.collectionIds.map((c) => library.collection(c)?.name),
        ]),
      )
    }
    if (panelPrefs.bookmarkSort === 'mushaf') {
      out = [...out].sort(
        (a, b) => a.ayahId - b.ayahId || (a.kind === 'page' ? -1 : 1) - (b.kind === 'page' ? -1 : 1),
      )
    }
    return out
  })

  const ribbon = $derived(library.readingBookmark)
  const showRibbon = $derived(ribbon !== null && query.trim() === '' && collectionId === null)
  const stopId = $derived(rows.some((b) => b.id === tabStop) ? tabStop : (rows[0]?.id ?? null))

  function chipsOf(b: BookmarkRow) {
    return b.collectionIds
      .map((id) => library.collection(id))
      .filter((c): c is Collection => c !== undefined && c.id !== collectionId)
      .map((c) => ({ id: c.id, label: c.name, color: c.color }))
  }

  // --- opening ----------------------------------------------------------------------------------------------------------

  function open(b: BookmarkRow): void {
    if (b.kind === 'page' && b.page !== null && b.layout === reader.layout) openPage(b.page)
    else openSpan({ from: b.ayahId, to: b.ayahId })
  }

  /** Middle click and "Open in side pane": the study pane for the ayah, without turning the page (§10.2). */
  function openInPane(b: BookmarkRow): void {
    selectAyah(b.ayahId)
    openPaneFor(b.ayahId)
  }

  function openRibbon(): void {
    if (!ribbon) return
    if (ribbon.layout === reader.layout) {
      ui.setView('reader')
      reader.goToAyah(ribbon.ayahId, { flash: true, focus: true })
    } else {
      openSpan({ from: ribbon.ayahId, to: ribbon.ayahId })
    }
  }

  /** Arrows, Home/End and PageUp/PageDown move in the list; a typed character goes to the filter. */
  function onListKeydown(e: KeyboardEvent): void {
    if (!list) return
    if (typeIntoFilter(e, filterInput, (ch) => (query += ch))) return
    rovingKeydown(e, list)
  }

  function onFocusIn(e: FocusEvent): void {
    const id = (e.target as HTMLElement | null)?.dataset.bookmark
    if (id) tabStop = id
  }

  // --- the item menu (§10.3) --------------------------------------------------------------------------------------------

  let menuAt = $state<Point | null>(null)
  let menuFor = $state.raw<BookmarkRow | null>(null)
  let labelFor = $state.raw<BookmarkRow | null>(null)
  let labelOpen = $state(false)
  let organiseFor = $state.raw<BookmarkRow | null>(null)
  let organiseOpen = $state(false)
  let organiseAnchor: HTMLElement | null = $state(null)

  function openMenu(b: BookmarkRow, point: Point): void {
    menuFor = b
    menuAt = point
  }

  function rowEl(id: string): HTMLElement | null {
    return list?.querySelector<HTMLElement>(`[data-bookmark="${CSS.escape(id)}"]`) ?? null
  }

  function editLabel(b: BookmarkRow): void {
    labelFor = b
    requestAnimationFrame(() => (labelOpen = true))
  }

  function organise(b: BookmarkRow): void {
    organiseFor = b
    organiseAnchor = rowEl(b.id)
    requestAnimationFrame(() => (organiseOpen = true))
  }

  const menuItems: MenuEntry[] = $derived.by(() => {
    const b = menuFor
    if (b === null) return []
    const current = library.bookmarks.find((x) => x.id === b.id) ?? b
    const collectionEntries: MenuEntry[] = library.collections.map((c) => ({
      type: 'checkbox',
      id: `c-${c.id}`,
      label: c.name,
      checked: current.collectionIds.includes(c.id),
      onCheckedChange: (on: boolean) =>
        void library.setCollections(
          current.id,
          on ? [...current.collectionIds, c.id] : current.collectionIds.filter((x) => x !== c.id),
        ),
    }))
    if (collectionEntries.length > 0) collectionEntries.push({ type: 'separator', id: 'c-sep' })
    collectionEntries.push({
      id: 'c-new',
      label: i18n.t('library.menu.newCollection'),
      onSelect: () => newCollection(current),
    })
    return [
      {
        id: 'open',
        label: i18n.t('library.panel.open'),
        icon: CornerDownRight,
        onSelect: () => open(current),
      },
      {
        id: 'pane',
        label: i18n.t('library.panel.openInPane'),
        icon: PanelRightOpen,
        onSelect: () => openInPane(current),
      },
      { type: 'separator', id: 'sep-1' },
      {
        id: 'label',
        label: i18n.t('library.bookmarks.editLabel'),
        icon: Pencil,
        onSelect: () => editLabel(current),
      },
      {
        type: 'submenu',
        id: 'collections',
        label: i18n.t('library.bookmarks.collections'),
        icon: FolderPlus,
        items: collectionEntries,
      },
      {
        id: 'organise',
        label: i18n.t('library.bookmarks.organise'),
        icon: Tags,
        onSelect: () => organise(current),
      },
      { type: 'separator', id: 'sep-2' },
      {
        id: 'delete',
        label: i18n.t('library.panel.delete'),
        icon: Trash,
        danger: true,
        kbd: i18n.t('library.panel.deleteKey'),
        onSelect: () => {
          focusAfterRemoval(rowEl(current.id))
          void library.deleteBookmark(current.id)
        },
      },
    ]
  })

  // --- collections ---------------------------------------------------------------------------------------------------------

  let collectionPrompt = $state<{
    mode: 'new' | 'rename'
    for?: BookmarkRow
    collection?: Collection
  } | null>(null)
  let collectionOpen = $state(false)
  let chipMenuAt = $state<Point | null>(null)
  let chipMenuFor = $state.raw<Collection | null>(null)

  function newCollection(b?: BookmarkRow): void {
    collectionPrompt = { mode: 'new', for: b }
    requestAnimationFrame(() => (collectionOpen = true))
  }

  async function submitCollection(name: string): Promise<boolean> {
    const p = collectionPrompt
    if (!p) return false
    if (p.mode === 'rename' && p.collection)
      return (await library.renameCollection(p.collection.id, name)) !== null
    const created = await library.createCollection(name)
    if (!created) return false
    if (p.for) await library.toggleCollection(p.for.ayahId, created.id)
    return true
  }

  function chipMenu(e: MouseEvent, c: Collection): void {
    e.preventDefault()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    chipMenuFor = c
    chipMenuAt =
      e.button === 2 && e.clientX !== 0 ? { x: e.clientX, y: e.clientY } : { x: r.left, y: r.bottom + 2 }
  }

  const chipMenuItems: MenuEntry[] = $derived.by(() => {
    const c = chipMenuFor
    if (c === null) return []
    return [
      {
        id: 'rename',
        label: i18n.t('library.bookmarks.rename'),
        icon: Pencil,
        onSelect: () => {
          collectionPrompt = { mode: 'rename', collection: c }
          requestAnimationFrame(() => (collectionOpen = true))
        },
      },
      {
        id: 'delete',
        label: i18n.t('library.bookmarks.deleteCollection'),
        icon: Trash,
        danger: true,
        onSelect: () => void deleteCollection(c),
      },
    ]
  })

  async function deleteCollection(c: Collection): Promise<void> {
    const ok = await ui.confirm({
      title: i18n.t('library.bookmarks.deleteCollectionTitle', { name: c.name }),
      body: i18n.t('library.bookmarks.deleteCollectionBody'),
      confirmLabel: i18n.t('common.delete'),
      danger: true,
    })
    if (!ok) return
    if (panelPrefs.collectionId === c.id) panelPrefs.collectionId = null
    await library.deleteCollection(c.id)
  }

  // --- options menu (sort, new collection) --------------------------------------------------------------------------------

  const optionItems: MenuEntry[] = $derived([
    {
      type: 'radio',
      id: 'sort',
      label: i18n.t('library.bookmarks.sort'),
      value: panelPrefs.bookmarkSort,
      onValueChange: (v: string) => (panelPrefs.bookmarkSort = v === 'mushaf' ? 'mushaf' : 'recent'),
      options: [
        { value: 'recent', label: i18n.t('library.bookmarks.sortRecent') },
        { value: 'mushaf', label: i18n.t('library.bookmarks.sortMushaf') },
      ],
    },
    { type: 'separator', id: 'sep' },
    {
      id: 'new-collection',
      label: i18n.t('library.menu.newCollection'),
      icon: FolderPlus,
      onSelect: () => newCollection(),
    },
  ])

  const emptyKey = $derived(studyKey('study.bookmark'))
  const promptTitle = $derived(
    collectionPrompt?.mode === 'rename'
      ? i18n.t('library.collectionDialog.renameTitle')
      : i18n.t('library.collectionDialog.title'),
  )
</script>

<div class="panel">
  {#if !emptyLibrary}
    <div class="tools">
      <SearchInput
        bind:value={query}
        bind:ref={filterInput}
        size="sm"
        placeholder={i18n.t('library.bookmarks.filter')}
        aria-label={i18n.t('library.bookmarks.filter')}
      />
      <Menu items={optionItems} align="end" label={i18n.t('library.bookmarks.options')}>
        {#snippet trigger({ props })}
          <IconButton {...props} label={i18n.t('library.bookmarks.options')} icon={ArrowDownUp} size="sm" />
        {/snippet}
      </Menu>
    </div>
  {/if}

  {#if library.collections.length > 0}
    <div class="chips" role="group" aria-label={i18n.t('library.bookmarks.collections')}>
      <button
        type="button"
        class="chip"
        aria-pressed={collectionId === null}
        onclick={() => (panelPrefs.collectionId = null)}
      >
        {i18n.t('library.bookmarks.all')}
        <span class="count">{i18n.num(library.bookmarks.length)}</span>
      </button>
      {#each library.collections as c (c.id)}
        <button
          type="button"
          class="chip"
          aria-pressed={collectionId === c.id}
          onclick={() => (panelPrefs.collectionId = collectionId === c.id ? null : c.id)}
          oncontextmenu={(e) => chipMenu(e, c)}
        >
          {#if c.color}<span class="dot" style:background-color={c.color}></span>{/if}
          <span class="chip-name" dir="auto">{c.name}</span>
          <span class="count">{i18n.num(c.itemCount)}</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="scroll" aria-busy={library.status === 'loading'}>
    {#if library.status === 'loading' || library.status === 'idle'}
      <div class="skeletons" aria-hidden="true">
        {#each [0, 1, 2, 3] as i (i)}
          <div class="skeleton-row">
            <Skeleton w={28} h={28} radius="full" />
            <div class="skeleton-lines">
              <Skeleton w="55%" h={12} />
              <Skeleton w="85%" h={12} />
              <Skeleton w="35%" h={10} />
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
    {:else}
      {#if showRibbon && ribbon}
        <button
          type="button"
          class="ribbon-row"
          aria-label={`${i18n.t('library.bookmarks.readingBookmark')}${sep}${stripIsolates(quran.refLabel(ribbon.ayahId, 'long'))}`}
          onclick={openRibbon}
        >
          <svg class="ribbon" viewBox="0 0 14 22" aria-hidden="true">
            <path d="M1 0h12v21l-6-4.6L1 21Z" />
          </svg>
          <span class="ribbon-main">
            <span class="ribbon-top">
              <span class="ribbon-title">{i18n.t('library.bookmarks.readingBookmark')}</span>
              <span class="ribbon-time">{i18n.relTime(ribbon.updatedAt)}</span>
            </span>
            <span class="ribbon-meta">
              {[
                quran.refLabel(ribbon.ayahId, 'long'),
                i18n.t('library.pageShort', { page: ribbon.page }),
              ].join(sep)}<span class="ribbon-time-inline">{sep}{i18n.relTime(ribbon.updatedAt)}</span>
            </span>
          </span>
        </button>
      {/if}

      {#if rows.length > 0}
        <div
          class="list"
          data-qd-roving-list
          bind:this={list}
          role="presentation"
          onkeydown={onListKeydown}
          onfocusin={onFocusIn}
        >
          <ul class="rows" aria-label={i18n.t('library.bookmarks.list')}>
            {#each rows as b (b.id)}
              <LibraryItem
                title={titleOf(b)}
                userText={b.label !== null}
                meta={metaOf(b)}
                ayahId={b.ayahId}
                chips={chipsOf(b)}
                label={`${titleOf(b)}${i18n.t('library.sep')}${stripIsolates(metaOf(b))}`}
                tabStop={b.id === stopId}
                data={{ bookmark: b.id }}
                onopen={() => open(b)}
                onaux={() => openInPane(b)}
                onmenu={(p) => openMenu(b, p)}
                ondelete={() => void library.deleteBookmark(b.id)}
              >
                {#snippet lead()}
                  {#if b.kind === 'page'}
                    <svg class="dog-ear" viewBox="0 0 18 22" aria-hidden="true">
                      <path class="sheet" d="M1.5 1.5h9.5l5.5 5.5v13.5h-15Z" />
                      <path class="fold" d="M11 1.5v5.5h5.5Z" />
                    </svg>
                  {:else}
                    <span class="mark"><Bookmark size={16} strokeWidth={1.75} fill="currentColor" /></span>
                  {/if}
                {/snippet}
              </LibraryItem>
            {/each}
          </ul>
        </div>
      {:else if query.trim() !== ''}
        <EmptyState
          compact
          title={i18n.t('library.panel.noMatches', { query: query.trim() })}
          body={i18n.t('library.panel.noMatchesBody', { ref: i18n.ref(2, 255) })}
        />
      {:else if activeCollection}
        <EmptyState
          compact
          title={i18n.t('library.bookmarks.emptyCollection', { name: activeCollection.name })}
          body={i18n.t('library.bookmarks.emptyCollectionBody')}
        />
      {:else if !showRibbon}
        <EmptyState
          title={i18n.t('library.bookmarks.emptyTitle')}
          body={i18n.t('library.bookmarks.emptyBody', { key: emptyKey ?? 'B' })}
          kbd={emptyKey}
        />
      {:else}
        <EmptyState
          compact
          title={i18n.t('library.bookmarks.emptyTitle')}
          body={i18n.t('library.bookmarks.emptyBody', { key: emptyKey ?? 'B' })}
          kbd={emptyKey}
        />
      {/if}
    {/if}
  </div>
</div>

<ContextMenu
  at={menuAt}
  onClose={() => (menuAt = null)}
  items={menuItems}
  label={menuFor ? titleOf(menuFor) : undefined}
/>
<ContextMenu
  at={chipMenuAt}
  onClose={() => (chipMenuAt = null)}
  items={chipMenuItems}
  label={chipMenuFor?.name}
/>

<PromptDialog
  bind:open={labelOpen}
  title={i18n.t('library.bookmarks.labelTitle')}
  description={labelFor ? stripIsolates(refOf(labelFor)) : undefined}
  label={i18n.t('library.bookmarks.labelField')}
  initial={labelFor?.label ?? ''}
  placeholder={i18n.t('library.bookmarks.labelPlaceholder')}
  confirmLabel={i18n.t('common.save')}
  maxLength={200}
  allowEmpty
  onsubmit={async (value) =>
    labelFor !== null && (await library.setBookmarkLabel(labelFor.id, value === '' ? null : value)) !== null}
/>

<PromptDialog
  bind:open={collectionOpen}
  title={promptTitle}
  description={collectionPrompt?.for
    ? i18n.t('library.collectionDialog.addsAyah', { ref: refOf(collectionPrompt.for) })
    : undefined}
  label={i18n.t('library.collectionDialog.name')}
  initial={collectionPrompt?.collection?.name ?? ''}
  placeholder={i18n.t('library.collectionDialog.placeholder')}
  confirmLabel={collectionPrompt?.mode === 'rename'
    ? i18n.t('common.save')
    : collectionPrompt?.for
      ? i18n.t('library.collectionDialog.createAndAdd')
      : i18n.t('library.collectionDialog.create')}
  maxLength={100}
  onsubmit={submitCollection}
/>

{#if organiseFor}
  {@const b = library.bookmarks.find((x) => x.id === organiseFor?.id) ?? organiseFor}
  <Popover
    bind:open={organiseOpen}
    anchor={organiseAnchor}
    side={i18n.dir === 'rtl' ? 'left' : 'right'}
    align="start"
    width={300}
    label={i18n.t('library.bookmarks.organise')}
  >
    <div class="organise">
      <p class="organise-title">{titleOf(b)}</p>
      <section>
        <h3 class="organise-heading">{i18n.t('library.bookmarks.collections')}</h3>
        <CollectionsPicker
          bookmarkId={b.id}
          selected={b.collectionIds}
          onchange={(ids) => void library.setCollections(b.id, ids)}
        />
      </section>
      <section>
        <h3 class="organise-heading">{i18n.t('library.panel.tagsHeading')}</h3>
        <TagPicker
          kind="bookmark"
          itemId={b.id}
          selected={b.tagIds}
          onchange={(ids) => void library.setTags('bookmark', b.id, ids)}
        />
      </section>
    </div>
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
    max-inline-size: 180px;
    padding-inline: var(--space-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--text-xs);
    font-weight: var(--weight-label);
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      color var(--dur-fast) var(--ease-standard);
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

  .count {
    color: inherit;
    font-variant-numeric: tabular-nums;
    opacity: 0.75;
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
    container-type: inline-size;
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
    background-color: var(--accent-soft);
    color: var(--accent);
  }

  .dog-ear {
    inline-size: 18px;
    block-size: 22px;
    overflow: visible;
  }

  .dog-ear .sheet {
    fill: var(--accent-soft);
    stroke: var(--accent);
    stroke-width: 1.4;
    stroke-linejoin: round;
  }

  .dog-ear .fold {
    fill: var(--accent);
    opacity: 0.55;
  }

  /* The reading bookmark: the ribbon of §8.9, heading the list. */
  .ribbon-row {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr);
    align-items: center;
    column-gap: var(--space-3);
    inline-size: 100%;
    min-block-size: 52px;
    margin-block-end: var(--space-2);
    padding-block: var(--space-2);
    padding-inline: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background-color: color-mix(in srgb, var(--ribbon) 6%, transparent);
    color: var(--text);
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease-standard);
  }

  .ribbon-row:hover {
    background-color: color-mix(in srgb, var(--ribbon) 11%, transparent);
  }

  .ribbon {
    justify-self: center;
    inline-size: 14px;
    block-size: 22px;
    fill: var(--ribbon);
    filter: drop-shadow(0 1px 1px rgb(0 0 0 / 0.18));
  }

  .ribbon-main {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-inline-size: 0;
  }

  .ribbon-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .ribbon-title {
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
  }

  .ribbon-time-inline {
    display: none;
  }

  /* A narrow sidebar: the time joins the meta line, so the title never wraps. */
  @container (max-width: 270px) {
    .ribbon-time {
      display: none;
    }

    .ribbon-time-inline {
      display: inline;
    }
  }

  .ribbon-time {
    flex: none;
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
  }

  .ribbon-meta {
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .skeletons {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding-block: var(--space-2);
    padding-inline: var(--space-2);
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

  .organise {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .organise-title {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-title);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .organise-heading {
    margin-block-end: var(--space-1);
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: var(--weight-title);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .organise-heading:lang(ar) {
    letter-spacing: 0;
    text-transform: none;
  }

  @media (forced-colors: active) {
    .chip[aria-pressed='true'] {
      border-color: Highlight;
    }

    .ribbon,
    .dog-ear .fold {
      fill: CanvasText;
    }
  }
</style>
