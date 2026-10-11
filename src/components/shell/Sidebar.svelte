<!--
  Sidebar (§7.5, §9.6): the panel of `settings.sidebar.tab` under a shared heading. Owner: WP7c.

  The shell draws the heading (the tab name and a hide button), so every panel starts at the same height with the same
  type; panels render their body only (search input, lists, empty states) and own their scrolling. `PaneLayout` places
  it: docked beside the canvas, or floating over it in a narrow window. Takes no props: it reads stores (§7.9).
-->
<script lang="ts">
  import PanelLeftClose from '@lucide/svelte/icons/panel-left-close'
  import IndexPanel from '$components/index/IndexPanel.svelte'
  import BookmarksPanel from '$components/library/BookmarksPanel.svelte'
  import HighlightsPanel from '$components/library/HighlightsPanel.svelte'
  import HistoryPanel from '$components/library/HistoryPanel.svelte'
  import NotesPanel from '$components/library/NotesPanel.svelte'
  import MemoPanel from '$components/memo/MemoPanel.svelte'
  import SearchPanel from '$components/search/SearchPanel.svelte'
  import { IconButton } from '$components/ui'
  import { i18n, settings, shortcuts, ui } from '$lib/stores'

  const panels = {
    index: IndexPanel,
    search: SearchPanel,
    bookmarks: BookmarksPanel,
    highlights: HighlightsPanel,
    notes: NotesPanel,
    history: HistoryPanel,
    memorize: MemoPanel,
  }

  const tab = $derived(settings.value.sidebar.tab)
  const Panel = $derived(panels[tab])
  const hideKey = $derived.by(() => {
    const def = shortcuts.defs.find((d) => d.id === 'view.sidebar')
    return def ? shortcuts.format(def) : undefined
  })
</script>

<div class="sidebar-panel" data-tab={tab}>
  <header class="head">
    <h2 class="title" id="qd-sidebar-title">{i18n.t(`shell.tabs.${tab}`)}</h2>
    <IconButton
      label={i18n.t('shell.sidebar.hide')}
      icon={PanelLeftClose}
      size="sm"
      mirror
      shortcut={hideKey}
      tooltipSide="bottom"
      onclick={() => ui.closeSidebar()}
    />
  </header>
  <div class="body">
    <Panel />
  </div>
</div>

<style>
  .sidebar-panel {
    display: flex;
    flex-direction: column;
    block-size: 100%;
    min-block-size: 0;
  }

  .head {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-2);
    block-size: 48px;
    padding-inline: var(--space-4) var(--space-2);
  }

  .title {
    flex: 1 1 auto;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .body {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-block-size: 0;
  }
</style>
