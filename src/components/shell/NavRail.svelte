<!--
  NavRail (§7.5, §9.6): the 52 px column of sidebar tabs (Index … Memorize), then Downloads and Settings at the bottom.
  Owner: WP7c. Rendered inside `<nav aria-label="Sections">` by `App`.

  - A tab button opens the sidebar on that tab, or hides it when that tab is already shown (`ui.toggleSidebar`, the
    same as `Mod+1…7`): a toggle (`aria-pressed`). From the Downloads manager, which hides the sidebar, it returns to
    the reader with that tab open. Settings opens the Settings dialog over the reader and closes it when it shows
    (`aria-haspopup="dialog"`, `aria-expanded`; owner request 2026-10-11).
  - Downloads (owner request 2026-10-11) opens the activity flyout (`DownloadsFlyout`: `aria-haspopup="dialog"`,
    `aria-expanded`), never by itself. While the manager shows (`aria-current="page"`) it returns to the reader, and
    below 480 × 400 CSS px of window (the 760 × 600 minimum at 200 %) it opens the manager directly: there it is a
    plain button, without the popup attributes, since it opens no flyout. Its icon carries
    the state: a progress ring (16 px) of the running jobs' aggregate progress, else the number of downloads waiting
    for a connection; a red mark when one failed. The tooltip and the accessible name say the counts; the flyout's
    footer names its key (`Mod+Shift+D`), so the tooltip does not.
  - The shown tab, view or dialog gets the accent pill and a 3 px indicator on the rail's inline-start edge (mirrored in
    the Arabic UI, where the rail sits on the right), driven by `data-active` whatever the button's role. Tooltips name
    the tab and its shortcut.
  - In a window too short for every button (760 × 600 at 150–200 % UI scale) the tabs scroll and Downloads and
    Settings stay at the foot.
  Takes no props: it reads stores (§7.9).
-->
<script lang="ts">
  import Bookmark from '@lucide/svelte/icons/bookmark'
  import BookOpen from '@lucide/svelte/icons/book-open'
  import Brain from '@lucide/svelte/icons/brain'
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import Download from '@lucide/svelte/icons/download'
  import Highlighter from '@lucide/svelte/icons/highlighter'
  import History from '@lucide/svelte/icons/history'
  import NotebookPen from '@lucide/svelte/icons/notebook-pen'
  import Search from '@lucide/svelte/icons/search'
  import SettingsIcon from '@lucide/svelte/icons/settings'
  import type { LucideIcon } from '@lucide/svelte'
  import { mergeProps } from 'bits-ui'
  import { openManager } from '$components/downloads/actions'
  import DownloadsFlyout from '$components/downloads/DownloadsFlyout.svelte'
  import { aggregateProgress, flyoutFits } from '$components/downloads/flyout'
  import { Progress, Tooltip } from '$components/ui'
  import type { SidebarTab } from '$lib/ipc/bindings'
  import { toggleSettings } from '$lib/shortcuts/app'
  import { i18n, packs, settings, shortcuts, ui } from '$lib/stores'
  import { inDialog } from '$lib/stores/ui.svelte'

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
  /** The Settings dialog shows (Settings, or About in its frame). */
  const settingsShown = $derived(inDialog(ui.view))

  // --- Downloads ---
  let flyoutOpen = $state(false)
  const managerShown = $derived(ui.view === 'downloads')
  /** A click opens the flyout: not while the manager shows, nor in a window too small for it (it navigates there). */
  const flyoutReachable = $derived(!managerShown && flyoutFits(ui.windowSize.w, ui.windowSize.h))
  const activeJobs = $derived(packs.activeJobs.length)
  const waitingCount = $derived(packs.waitingIds.length)
  const failedCount = $derived(packs.failedJobs.length)
  /** The running jobs' aggregate progress (0–1), or null with none. */
  const progress = $derived(aggregateProgress(packs.jobs.values()))
  /** "Downloads · 2 downloads in progress · 1 waiting for a connection · 1 failed": tooltip and accessible name. */
  const downloadsLabel = $derived(
    [
      i18n.t('shell.views.downloads'),
      activeJobs > 0 ? i18n.tp('shell.rail.downloadsActive', activeJobs) : '',
      waitingCount > 0 ? i18n.tp('shell.rail.downloadsWaiting', waitingCount) : '',
      failedCount > 0 ? i18n.tp('shell.rail.downloadsFailed', failedCount) : '',
    ]
      .filter(Boolean)
      .join(i18n.t('downloads.sep')),
  )

  /** The label of a registered shortcut by id (`Ctrl+1`, `⌘,`), if it is registered. */
  function keyOf(id: string): string | undefined {
    const def = shortcuts.defs.find((d) => d.id === id)
    return def ? shortcuts.format(def) || undefined : undefined
  }

  /**
   * Runs before the flyout's own trigger handler: in the manager the button returns to the reader, and a window too
   * small for the flyout gets the manager itself. Either way the flyout stays closed (`preventDefault`).
   */
  function onDownloads(e: Event): void {
    if (e instanceof KeyboardEvent && e.key !== 'Enter' && e.key !== ' ') return
    if (managerShown) {
      e.preventDefault()
      ui.setView('reader')
    } else if (!flyoutFits(ui.windowSize.w, ui.windowSize.h)) {
      e.preventDefault()
      openManager()
    }
  }
</script>

<div class="rail">
  <div class="group tabs" role="group">
    {#each tabs as { tab, icon: Icon } (tab)}
      {@const label = i18n.t(`shell.tabs.${tab}`)}
      <Tooltip content={label} kbd={keyOf(`view.sidebarTab.${tab}`)} side={tooltipSide}>
        {#snippet children({ props })}
          <button
            {...props}
            type="button"
            class="item"
            data-tab={tab}
            data-active={activeTab === tab ? '' : undefined}
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
    <DownloadsFlyout bind:open={flyoutOpen}>
      {#snippet trigger({ props })}
        <Tooltip content={downloadsLabel} side={tooltipSide} disabled={flyoutOpen}>
          {#snippet children({ props: tip })}
            <button
              {...mergeProps({ onclick: onDownloads, onkeydown: onDownloads }, props, tip)}
              type="button"
              class="item"
              data-view="downloads"
              data-active={managerShown ? '' : undefined}
              data-flyout={flyoutOpen ? 'open' : undefined}
              data-badged={progress !== null || waitingCount > 0 ? '' : undefined}
              aria-label={downloadsLabel}
              aria-haspopup={flyoutReachable ? 'dialog' : undefined}
              aria-expanded={flyoutReachable ? flyoutOpen : undefined}
              aria-current={managerShown ? 'page' : undefined}
            >
              <Download class="glyph" size={20} strokeWidth={1.75} aria-hidden="true" />
              {#if progress !== null}
                <span class="badge ring" aria-hidden="true" data-badge="progress">
                  <Progress variant="ring" size={16} value={progress} max={1} />
                </span>
              {:else if waitingCount > 0}
                <span class="badge count" aria-hidden="true" data-badge="waiting"
                  >{i18n.num(waitingCount)}</span
                >
              {/if}
              {#if failedCount > 0}
                <span class="badge error" aria-hidden="true" data-badge="failed">
                  <CircleAlert size={14} strokeWidth={2.25} />
                </span>
              {/if}
            </button>
          {/snippet}
        </Tooltip>
      {/snippet}
    </DownloadsFlyout>
    <Tooltip content={i18n.t('shell.views.settings')} kbd={keyOf('app.settings')} side={tooltipSide}>
      {#snippet children({ props })}
        <button
          {...props}
          type="button"
          class="item"
          data-view="settings"
          data-active={settingsShown ? '' : undefined}
          aria-label={i18n.t('shell.views.settings')}
          aria-haspopup="dialog"
          aria-expanded={settingsShown}
          onclick={toggleSettings}
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

  /* A short window (760 × 600 at 150–200 % UI scale) scrolls the tabs, so Downloads and Settings stay in reach. The
     group spans the rail, so the pills and focus rings are not clipped. */
  .tabs {
    flex: 0 1 auto;
    align-self: stretch;
    min-block-size: 0;
    margin-block: -4px;
    padding-block: 4px;
    overflow-y: auto;
    scrollbar-width: none;
  }

  .spacer {
    flex: 1 1 auto;
    min-block-size: var(--space-4);
  }

  /* Never shrunk by a short rail: the tab group scrolls instead. */
  .item {
    position: relative;
    display: grid;
    flex: none;
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

  .item[data-active] {
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

  .item[data-active]::before {
    block-size: 18px;
  }

  /* The flyout is open: the button reads pressed, without the pill (that marks the shown view). */
  .item[data-flyout='open']:not([data-active]) {
    background-color: var(--surface-hover);
    color: var(--text);
  }

  /* A mark in the bottom corner moves the icon 3 px towards the other one, so the two read apart. */
  .item[data-badged] :global(.glyph) {
    margin-block-end: 6px;
    margin-inline-end: 6px;
  }

  /* Downloads' state marks: on a disc of the app surface, cut out of the icon's corner. */
  .badge {
    position: absolute;
    display: grid;
    place-items: center;
    border-radius: var(--radius-full);
    background-color: var(--surface-app);
    pointer-events: none;
  }

  .ring,
  .count {
    inset-block-end: 2px;
    inset-inline-end: 2px;
  }

  .ring {
    inline-size: 18px;
    block-size: 18px;
  }

  /* Progress arrives 10 times a second: no eased steps (see PackRow). */
  .ring :global(.arc) {
    transition: none;
  }

  .count {
    min-inline-size: 12px;
    block-size: 14px;
    padding-inline: 2px;
    border: 2px solid var(--surface-app);
    background-color: color-mix(in srgb, var(--text) 14%, var(--surface-app));
    color: var(--text);
    font-size: 10px;
    font-weight: var(--weight-title);
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .error {
    inset-block-start: 3px;
    inset-inline-end: 3px;
    inline-size: 16px;
    block-size: 16px;
    color: var(--danger-text);
  }

  @media (forced-colors: active) {
    .item[data-active] {
      outline: 2px solid Highlight;
    }
  }
</style>
