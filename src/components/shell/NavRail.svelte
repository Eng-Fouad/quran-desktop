<!--
  NavRail (§7.5, §9.6): the 52 px column of sidebar tabs (Index … Memorize), then Downloads and Settings at the bottom.
  Owner: WP7c. Rendered inside `<nav aria-label="Sections">` by `App`.

  - A tab button opens the sidebar on that tab, or hides it when that tab is already shown (`ui.toggleSidebar`, the
    same as `Mod+1…7`); Downloads and Settings switch the canvas view and back.
  - The shown tab or view gets the accent pill and a 3 px indicator on the rail's inline-start edge (mirrored in the
    Arabic UI, where the rail sits on the right). Tooltips name the tab and its shortcut.
  - Downloads shows an activity dot while jobs run (`packs.activeJobs`).
  Takes no props: it reads stores (§7.9).
-->
<script lang="ts">
  import Bookmark from '@lucide/svelte/icons/bookmark'
  import BookOpen from '@lucide/svelte/icons/book-open'
  import Brain from '@lucide/svelte/icons/brain'
  import Download from '@lucide/svelte/icons/download'
  import Highlighter from '@lucide/svelte/icons/highlighter'
  import History from '@lucide/svelte/icons/history'
  import NotebookPen from '@lucide/svelte/icons/notebook-pen'
  import Search from '@lucide/svelte/icons/search'
  import SettingsIcon from '@lucide/svelte/icons/settings'
  import type { LucideIcon } from '@lucide/svelte'
  import { Tooltip } from '$components/ui'
  import type { AppView, SidebarTab } from '$lib/ipc/bindings'
  import { i18n, packs, settings, shortcuts, ui } from '$lib/stores'

  interface TabItem {
    tab: SidebarTab
    icon: LucideIcon
  }

  const tabs: readonly TabItem[] = [
    { tab: 'index', icon: BookOpen },
    { tab: 'search', icon: Search },
    { tab: 'bookmarks', icon: Bookmark },
    { tab: 'highlights', icon: Highlighter },
    { tab: 'notes', icon: NotebookPen },
    { tab: 'history', icon: History },
    { tab: 'memorize', icon: Brain },
  ]

  /** The tab whose panel is shown, if the sidebar is open. */
  const activeTab = $derived(ui.sidebarOpen ? settings.value.sidebar.tab : null)
  const tooltipSide = $derived(i18n.dir === 'rtl' ? 'left' : 'right')
  const activeJobs = $derived(packs.activeJobs.length)

  /** The label of a registered shortcut by id (`Ctrl+1`, `⌘,`), if it is registered. */
  function keyOf(id: string): string | undefined {
    const def = shortcuts.defs.find((d) => d.id === id)
    return def ? shortcuts.format(def) || undefined : undefined
  }

  function toggleView(view: AppView): void {
    ui.setView(ui.view === view ? 'reader' : view)
  }
</script>

<div class="rail">
  <div class="group" role="group">
    {#each tabs as { tab, icon: Icon } (tab)}
      {@const label = i18n.t(`shell.tabs.${tab}`)}
      <Tooltip content={label} kbd={keyOf(`view.sidebarTab.${tab}`)} side={tooltipSide}>
        {#snippet children({ props })}
          <button
            {...props}
            type="button"
            class="item"
            data-tab={tab}
            aria-label={label}
            aria-pressed={activeTab === tab}
            onclick={() => ui.toggleSidebar(tab)}
          >
            <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
          </button>
        {/snippet}
      </Tooltip>
    {/each}
  </div>

  <span class="spacer"></span>

  <div class="group" role="group">
    <Tooltip
      content={activeJobs > 0
        ? `${i18n.t('shell.views.downloads')} · ${i18n.tp('shell.rail.downloadsActive', activeJobs)}`
        : i18n.t('shell.views.downloads')}
      kbd={keyOf('app.downloads')}
      side={tooltipSide}
    >
      {#snippet children({ props })}
        <button
          {...props}
          type="button"
          class="item"
          data-view="downloads"
          aria-label={i18n.t('shell.views.downloads')}
          aria-pressed={ui.view === 'downloads'}
          onclick={() => toggleView('downloads')}
        >
          <Download size={20} strokeWidth={1.75} aria-hidden="true" />
          {#if activeJobs > 0}<span class="activity" aria-hidden="true"></span>{/if}
        </button>
      {/snippet}
    </Tooltip>
    <Tooltip content={i18n.t('shell.views.settings')} kbd={keyOf('app.settings')} side={tooltipSide}>
      {#snippet children({ props })}
        <button
          {...props}
          type="button"
          class="item"
          data-view="settings"
          aria-label={i18n.t('shell.views.settings')}
          aria-pressed={ui.view === 'settings'}
          onclick={() => toggleView('settings')}
        >
          <SettingsIcon size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
      {/snippet}
    </Tooltip>
  </div>
</div>

<style>
  .rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    block-size: 100%;
    /* The first item lines up with the sidebar heading (both centred 24 px below the title bar). */
    padding-block: var(--space-1) var(--space-2);
    background-color: var(--surface-chrome);
    border-inline-end: 1px solid var(--border);
  }

  .group {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
  }

  .spacer {
    flex: 1 1 auto;
    min-block-size: var(--space-4);
  }

  .item {
    position: relative;
    display: grid;
    place-items: center;
    inline-size: 40px;
    block-size: 40px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-md);
    background-color: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      color var(--dur-fast) var(--ease-standard);
  }

  .item:hover {
    background-color: var(--surface-hover);
    color: var(--text);
  }

  .item:active {
    background-color: color-mix(in srgb, var(--text) 10%, transparent);
  }

  .item[aria-pressed='true'] {
    background-color: var(--accent-soft);
    color: var(--accent-text);
  }

  /* The selection indicator: a 3 px pill on the rail's inline-start edge (6 px from the item). */
  .item::before {
    content: '';
    position: absolute;
    inset-inline-start: -6px;
    inset-block: 50% auto;
    inline-size: 3px;
    block-size: 0;
    border-radius: var(--radius-full);
    background-color: var(--accent);
    translate: 0 -50%;
    transition: block-size var(--dur-normal) var(--ease-emphasized);
  }

  .item[aria-pressed='true']::before {
    block-size: 18px;
  }

  .activity {
    position: absolute;
    inset-block-start: 8px;
    inset-inline-end: 8px;
    inline-size: 8px;
    block-size: 8px;
    border: 2px solid var(--surface-app);
    border-radius: var(--radius-full);
    background-color: var(--accent);
    box-sizing: content-box;
    animation: qd-pulse 1.6s var(--ease-standard) infinite;
  }

  @keyframes qd-pulse {
    50% {
      opacity: 0.45;
    }
  }

  @media (forced-colors: active) {
    .item[aria-pressed='true'] {
      outline: 2px solid Highlight;
    }
  }
</style>
