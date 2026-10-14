<!--
  SidePane: the study pane. `AyahHeader` (56 px) over four tabs — Translation, Tafsir, Notes and Words — for the
  pane's subject. Takes no props: it reads stores.

  - **Subject** (`pane.subject`, see `pane.svelte.ts`): the pinned ayah, else a selection that pins the pane, else the
    recited ayah, else the selection, else the reader's action target. A selection over several ayahs is shown whole
    (each tab lists up to `MAX_SPAN` ayahs and says when it stops).
  - **Tabs** persist in `settings.sidePane.tab` (`ui.openSidePane(tab)`); only the shown tab is mounted. The Notes
    tab carries the number of notes on the subject.
  - Docked (`aside`, `PaneLayout`) or in the narrow-window `Sheet`, which has its own title and close button; the
    header's close button shows only when docked.
-->
<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { Tabs } from '$components/ui'
  import type { TabItem } from '$components/ui'
  import type { SidePaneTab } from '$lib/ipc/bindings'
  import { i18n, library, settings, ui } from '$lib/stores'
  import star8 from '../../assets/star8.svg'
  import AyahHeader from './AyahHeader.svelte'
  import NotesTab from './NotesTab.svelte'
  import { pane } from './pane.svelte'
  import TafsirTab from './TafsirTab.svelte'
  import TranslationTab from './TranslationTab.svelte'
  import WordsTab from './WordsTab.svelte'

  const TAB_ORDER: readonly SidePaneTab[] = ['translation', 'tafsir', 'notes', 'words']

  const subject = $derived(pane.subject)
  const tab = $derived(settings.value.sidePane.tab)

  /** Notes on (or overlapping) the subject: the Notes tab's badge. */
  const noteCount = $derived.by(() => {
    const s = subject
    if (s === null) return 0
    return library.notes.filter((n) => n.fromAyahId <= s.to && n.toAyahId >= s.from).length
  })

  const tabs: readonly TabItem[] = $derived(
    TAB_ORDER.map((value) => ({
      value,
      label: i18n.t(`sidepane.tabs.${value}`),
      badge: value === 'notes' && noteCount > 0 ? i18n.num(noteCount) : undefined,
    })),
  )

  /**
   * Fields where the reader types. Once one takes focus, the pane holds its subject (`pane.hold`) until focus leaves
   * the pane: a recitation moving on never swaps a half-written note away, nor the Save button under the pointer.
   */
  const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

  let root: HTMLDivElement | undefined = $state()

  function isEditable(el: EventTarget | null): boolean {
    return el instanceof Element && el.closest(EDITABLE) !== null
  }

  function onfocusin(e: FocusEvent): void {
    if (isEditable(e.target)) pane.hold()
  }

  function onfocusout(e: FocusEvent): void {
    const next = e.relatedTarget
    if (next instanceof Node && root?.contains(next)) return
    // A popover of the pane (tags, formatting help) or a question over it ("Discard note?") took focus: let go only
    // once it has closed (below).
    if (ui.layerOpen) return
    pane.release()
  }

  // A layer closed and focus did not come back into the pane: let go.
  $effect(() => {
    if (ui.layerOpen) return
    untrack(() => {
      const active = document.activeElement
      if (!(active instanceof Node && root?.contains(active))) pane.release()
    })
  })

  // Unmounted with focus inside (Mod+I while typing): no focusout follows, so let go here.
  onDestroy(() => pane.release())

  // A pinned pane with no pin yet (first start in "pinned" mode): pin what it shows.
  $effect(() => {
    if (pane.pinned && pane.live !== null) pane.settlePin()
  })

  function isTab(v: string): v is SidePaneTab {
    return (TAB_ORDER as readonly string[]).includes(v)
  }

  function selectTab(v: string): void {
    if (isTab(v) && v !== settings.value.sidePane.tab) ui.openSidePane(v)
  }
</script>

<div
  class="side-pane-root"
  class:sheet={!ui.paneDocked}
  data-qd-pane
  data-tab={tab}
  bind:this={root}
  {onfocusin}
  {onfocusout}
>
  {#if subject}
    <AyahHeader {subject} />
    <Tabs
      {tabs}
      value={tab}
      onValueChange={selectTab}
      label={i18n.t('sidepane.tabs.label')}
      fill
      class="pane-tabs"
    >
      {#snippet panel(value)}
        {#if value === 'translation'}
          <TranslationTab {subject} />
        {:else if value === 'tafsir'}
          <TafsirTab {subject} />
        {:else if value === 'notes'}
          <NotesTab {subject} />
        {:else if value === 'words'}
          <WordsTab {subject} />
        {/if}
      {/snippet}
    </Tabs>
  {:else}
    <div class="nothing" role="status">
      <span class="star" style:--_star={`url("${star8}")`} aria-hidden="true"></span>
      <p class="title">{i18n.t('sidepane.empty.title')}</p>
      <p class="body">{i18n.t('sidepane.empty.body')}</p>
    </div>
  {/if}
</div>

<style>
  .side-pane-root {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    block-size: 100%;
    min-block-size: 0;
    min-inline-size: 0;
    background-color: var(--surface-raised);
    color: var(--text);
  }

  /* In the narrow-window sheet, the sheet's own padding would frame the pane twice: bleed to its edges. */
  .sheet {
    margin-block: calc(-1 * var(--space-2)) calc(-1 * var(--space-5));
    margin-inline: calc(-1 * var(--space-5));
    block-size: calc(100% + var(--space-2) + var(--space-5));
  }

  .side-pane-root :global(.pane-tabs) {
    flex: 1 1 auto;
    min-block-size: 0;
  }

  .side-pane-root :global(.pane-tabs > [role='tablist']) {
    padding-inline: var(--space-3);
  }

  .side-pane-root :global(.pane-tabs > [role='tabpanel']:not([hidden])) {
    display: flex;
    flex-direction: column;
  }

  .nothing {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: var(--space-8) var(--space-6);
    text-align: center;
  }

  .star {
    inline-size: 40px;
    block-size: 40px;
    margin-block-end: var(--space-2);
    background-color: var(--frame-gold);
    mask: var(--_star) center / contain no-repeat;
  }

  .title {
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-title);
  }

  .body {
    max-inline-size: 260px;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
  }

  @media (forced-colors: active) {
    .star {
      background-color: CanvasText;
    }
  }
</style>
