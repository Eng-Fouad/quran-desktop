<!--
  DownloadsFlyout (owner request 2026-10-11): the compact activity flyout of the rail's Downloads button, the glance
  before the full manager (`ui.view === 'downloads'`). The rail button that `trigger` renders is `NavRail`'s.

  - Arrowless, like the app's other chrome-button popovers (Repeat, Speed, the reciter picker): beside the rail on its
    inline-end side (right, or left in the Arabic UI), its bottom edge on the button's, so it grows upward.
    `min(380px, the room)` wide; at most 60 % of the window tall but never under 440 px, so a short window lends it all
    its room. Header and footer stay; the body scrolls (`ScrollArea`).
  - Header: "Downloads", the storage total and a thin usage bar on one row; the offline or Work offline note; "N updates
    available · Update all".
  - Body: the live jobs (running, then queued, paused and failed), each with its name, "8.2 of 45.7 MB" and a bar, one
    action (Pause, Resume or Retry) and Stop; a failed row says why in one line. Requests that wait for a connection
    read "Waits for a connection" with Cancel. With none: "Nothing downloading" and "Get content" links that open the
    manager on a kind. Then "Recently finished" (the last five jobs that completed this session).
  - Footer: "Manage downloads" with its key, `Mod+Shift+D`, which works inside the flyout too.
  - A floating layer; it never opens by itself. Escape or a click outside closes it and focus returns to the
    rail button; when it closes for the manager, the manager's heading takes focus instead.
-->
<script lang="ts">
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import CircleArrowUp from '@lucide/svelte/icons/circle-arrow-up'
  import CloudOff from '@lucide/svelte/icons/cloud-off'
  import WifiOff from '@lucide/svelte/icons/wifi-off'
  import { untrack, type Snippet } from 'svelte'
  import { Button, Kbd, Popover, Progress, ScrollArea, IconButton } from '$components/ui'
  import type { TriggerProps } from '$components/ui/types'
  import type { TextKey } from '$lib/contracts/i18n'
  import type { JobSnapshot, PackInfo } from '$lib/ipc/bindings'
  import { app, i18n, packs, settings, shortcuts, ui } from '$lib/stores'
  import type { FinishedJob } from '$lib/stores/packs.svelte'
  import { FOCUS_TARGETS } from '$lib/stores/ui.svelte'
  import { openManager, rowActions, updateAll, type ManagerTab } from './actions'
  import DiskUsageBar from './DiskUsageBar.svelte'
  import { FLYOUT_W, flyoutCap, flyoutFits, flyoutJobs } from './flyout'
  import { finishedLine, jobAmount, jobLine, usageTotal } from './format'
  import KindTile from './KindTile.svelte'

  interface Props {
    /** The rail button (it receives the trigger props to spread). */
    trigger: Snippet<[TriggerProps]>
    open?: boolean
  }

  let { trigger, open = $bindable(false) }: Props = $props()

  /** "Get content": the manager's kind tabs. */
  const LINKS: readonly { tab: ManagerTab; label: TextKey }[] = [
    { tab: 'mushaf_fonts', label: 'downloads.filters.kinds.mushaf' },
    { tab: 'recitation', label: 'downloads.filters.kinds.recitation' },
    { tab: 'translation', label: 'downloads.filters.kinds.translation' },
    { tab: 'tafsir', label: 'downloads.filters.kinds.tafsir' },
    { tab: 'wbw', label: 'downloads.filters.kinds.wbw' },
  ]

  const uid = $props.id()
  let heading: HTMLElement | null = $state(null)

  const side = $derived(i18n.dir === 'rtl' ? 'left' : 'right')
  const cap = $derived(flyoutCap(ui.windowSize.h))
  const online = $derived(packs.canDownload)
  const jobs = $derived(flyoutJobs(packs.jobs.values(), (id) => packs.isWaiting(id)))
  /** Packs that wait for a connection and that the catalogue knows. */
  const waiting = $derived(
    packs.waitingIds.map((id) => packs.pack(id)).filter((p): p is PackInfo => p !== undefined),
  )
  /** "Recently finished": `packs.recent` holds no more than the flyout lists (`RECENT_KEPT`). */
  const recent = $derived(
    packs.recent
      .map((f) => ({ f, p: packs.pack(f.packId) }))
      .filter((r): r is { f: FinishedJob; p: PackInfo } => r.p !== undefined),
  )
  const idle = $derived(jobs.length === 0 && waiting.length === 0)
  const manageKey = $derived.by(() => {
    const def = shortcuts.defs.find((d) => d.id === 'app.downloads')
    return def ? shortcuts.format(def) : ''
  })

  // Fresh numbers each time it opens: the disk usage, and pack updates when online (at most every 6 hours).
  $effect(() => {
    if (!open) return
    untrack(() => {
      packs.loadUsage().catch((e: unknown) => console.warn('[qd] downloads flyout: disk usage', e))
      if (packs.canDownload) {
        packs
          .checkUpdates({ ifStale: true })
          .catch((e: unknown) => console.warn('[qd] downloads flyout: updates', e))
      }
    })
  })

  // Never over the manager, nor in a window that has become too small for it.
  $effect(() => {
    if (ui.view === 'downloads' || !flyoutFits(ui.windowSize.w, ui.windowSize.h)) open = false
  })

  function manage(tab?: ManagerTab): void {
    open = false
    openManager(tab)
  }

  function onOpenAutoFocus(e: Event): void {
    e.preventDefault()
    heading?.focus({ preventScroll: true })
  }

  function onCloseAutoFocus(e: Event): void {
    if (ui.view !== 'downloads') return
    // It closed for the manager: its heading takes focus, never the rail button.
    e.preventDefault()
    void ui.focusWhenRendered(FOCUS_TARGETS.downloads)
  }

  /**
   * `Mod+Shift+D` while it is open (and no overlay is above it): the floating layer pauses the global shortcut, so the
   * key its footer names is handled here.
   */
  function onkeydown(e: KeyboardEvent): void {
    if (!open || e.defaultPrevented || ui.overlays.length > 0 || !shortcuts.matches('app.downloads', e))
      return
    e.preventDefault()
    manage()
  }

  function name(p: PackInfo | undefined, job: JobSnapshot): string {
    return p ? packs.title(p) : job.packId
  }
</script>

<svelte:window {onkeydown} />

{#snippet actions(p: PackInfo, job: JobSnapshot | undefined)}
  <div class="acts" role="group" aria-label={i18n.t('downloads.row.actionsLabel', { name: packs.title(p) })}>
    {#each rowActions(p, job) as a (a.id)}
      <IconButton
        size="sm"
        label={a.label}
        icon={a.icon}
        disabled={a.disabled}
        tooltipSide="top"
        onclick={a.run}
        data-action={a.id}
      />
    {/each}
  </div>
{/snippet}

<Popover
  bind:open
  {trigger}
  {side}
  align="end"
  sideOffset={10}
  width={FLYOUT_W}
  padding="none"
  label={i18n.t('downloads.title')}
  role="dialog"
  {onOpenAutoFocus}
  {onCloseAutoFocus}
>
  <div class="flyout" style:--_cap="{cap}px" data-qd-flyout="downloads">
    <!-- Not `header` / `footer`: in a popover (portalled to the body) they would be page landmarks. -->
    <div class="head">
      <div class="title-row">
        <h2 class="title" tabindex="-1" bind:this={heading}>{i18n.t('downloads.title')}</h2>
        <span class="total">{usageTotal(packs.usage)}</span>
        <DiskUsageBar usage={packs.usage} variant="strip" />
      </div>
      {#if !settings.value.networkAllowed}
        <p class="note" data-note="network-off">
          <CloudOff size={14} strokeWidth={2} aria-hidden="true" />{i18n.t(
            'downloads.banner.networkOffTitle',
          )}
        </p>
      {:else if !app.online}
        <p class="note" data-note="offline">
          <WifiOff size={14} strokeWidth={2} aria-hidden="true" />{i18n.t('downloads.banner.offlineTitle')}
        </p>
      {/if}
      {#if packs.updatable.length > 0}
        <div class="updates" data-qd-updates>
          <CircleArrowUp size={16} strokeWidth={1.75} aria-hidden="true" />
          <span class="updates-text">{i18n.tp('downloads.banner.updates', packs.updatable.length)}</span>
          <Button
            size="sm"
            variant="link"
            disabled={!online}
            title={online ? undefined : i18n.t('downloads.actions.needsNetwork')}
            onclick={updateAll}
            data-action="update-all">{i18n.t('downloads.banner.updateAll')}</Button
          >
        </div>
      {/if}
    </div>

    <ScrollArea class="body">
      <div class="content">
        {#if idle}
          <div class="idle">
            <p class="nothing">{i18n.t('downloads.flyout.nothing')}</p>
            <h3 class="caption" id="{uid}-get">{i18n.t('downloads.flyout.getContent')}</h3>
            <ul class="links" aria-labelledby="{uid}-get">
              {#each LINKS as link (link.tab)}
                <li>
                  <button type="button" class="chip" data-tab={link.tab} onclick={() => manage(link.tab)}
                    >{i18n.t(link.label)}</button
                  >
                </li>
              {/each}
            </ul>
          </div>
        {:else}
          <ul class="rows" aria-label={i18n.t('downloads.flyout.jobs')}>
            {#each jobs as job (job.packId)}
              {@const p = packs.pack(job.packId)}
              <li class="row" data-pack-id={job.packId} data-job={job.phase}>
                {#if p}<KindTile kind={p.kind} size={32} />{/if}
                <div class="row-body">
                  <span class="name" title={name(p, job)}>{name(p, job)}</span>
                  {#if job.phase === 'failed'}
                    <p class="line error" title={job.error?.message}>
                      <CircleAlert size={14} strokeWidth={2} aria-hidden="true" />
                      <span class="clip">{i18n.t(`errors.${job.error?.kind ?? 'internal'}`)}</span>
                    </p>
                  {:else}
                    <Progress
                      class={job.phase === 'paused' ? 'paused' : undefined}
                      value={job.receivedKib}
                      max={Math.max(1, job.totalKib)}
                      indeterminate={job.phase === 'verifying' || job.phase === 'installing'}
                      label={i18n.t('downloads.progress.label', { name: name(p, job) })}
                      valueText={jobLine(job)}
                    />
                    <span class={['line', 'stats', { paused: job.phase === 'paused' }]}>{jobAmount(job)}</span
                    >
                  {/if}
                </div>
                {#if p}{@render actions(p, job)}{/if}
              </li>
            {/each}
            {#each waiting as p (p.id)}
              <li class="row" data-pack-id={p.id} data-job="waiting">
                <KindTile kind={p.kind} size={32} />
                <div class="row-body">
                  <span class="name" title={packs.title(p)}>{packs.title(p)}</span>
                  <p class="line">
                    <WifiOff size={14} strokeWidth={2} aria-hidden="true" />
                    <span class="clip">{i18n.t('downloads.progress.waiting')}</span>
                  </p>
                </div>
                {@render actions(p, packs.jobOf(p.id))}
              </li>
            {/each}
          </ul>
        {/if}

        {#if recent.length > 0}
          <section class="recent" aria-labelledby="{uid}-recent">
            <h3 class="caption" id="{uid}-recent">{i18n.t('downloads.flyout.recent')}</h3>
            <ul class="rows">
              {#each recent as { f, p } (f.packId)}
                <li class="row done" data-pack-id={f.packId}>
                  <KindTile kind={p.kind} size={32} />
                  <div class="row-body">
                    <span class="name" title={packs.title(p)}>{packs.title(p)}</span>
                    <span class="line">{finishedLine(f, p)}</span>
                  </div>
                </li>
              {/each}
            </ul>
          </section>
        {/if}
      </div>
    </ScrollArea>

    <div class="foot">
      <Button variant="secondary" size="sm" fullWidth onclick={() => manage()} data-action="manage">
        {#snippet iconEnd()}{#if manageKey}<Kbd chord={manageKey} size="sm" />{/if}{/snippet}
        {i18n.t('downloads.flyout.manage')}
      </Button>
    </div>
  </div>
</Popover>

<style>
  .flyout {
    display: flex;
    flex-direction: column;
    max-block-size: min(var(--bits-floating-available-height, 100vh), var(--_cap));
    min-block-size: 0;
  }

  .head {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: var(--space-2);
    padding-block: var(--space-3) var(--space-2);
    padding-inline: var(--space-4);
    border-block-end: 1px solid var(--border);
  }

  .title-row {
    display: grid;
    grid-template-columns: auto auto minmax(48px, 1fr);
    align-items: center;
    gap: var(--space-3);
  }

  .title {
    margin: 0;
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-title);
    line-height: 1.4;
    white-space: nowrap;
    outline: none;
  }

  .total {
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .note,
  .updates {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.45;
  }

  .note {
    color: var(--warning-text);
  }

  .updates {
    color: var(--accent-text);
  }

  .updates-text {
    flex: 1 1 auto;
    min-inline-size: 0;
    color: var(--text);
  }

  .note :global(svg),
  .updates :global(svg) {
    flex: none;
  }

  /* The body shrinks to what the cap and the room leave, and scrolls. */
  .flyout :global(.body) {
    display: flex;
    flex: 0 1 auto;
    flex-direction: column;
    min-block-size: 0;
  }

  .flyout :global(.body > [data-scroll-area-viewport]) {
    flex: 0 1 auto;
    block-size: auto;
    min-block-size: 0;
  }

  .content {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-block: var(--space-2);
  }

  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .row {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr) auto;
    align-items: center;
    column-gap: var(--space-3);
    min-block-size: 52px;
    padding-block: 6px;
    padding-inline: var(--space-4) var(--space-3);
  }

  .row.done {
    min-block-size: 44px;
  }

  .row-body {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-inline-size: 0;
  }

  .name {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .name:lang(ar) {
    line-height: 1.6;
  }

  .row-body > :global(.bar) {
    margin-block: 2px;
  }

  .row-body :global(.bar.paused) {
    --_fill: var(--text-faint);
  }

  /* Progress arrives 10 times a second: no eased steps (see PackRow). */
  .row-body :global(.bar:not(.indeterminate) .fill) {
    transition: none;
  }

  .line {
    display: flex;
    align-items: center;
    gap: 6px;
    min-inline-size: 0;
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    line-height: 1.45;
  }

  .line :global(svg) {
    flex: none;
  }

  .clip {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stats.paused {
    color: var(--warning-text);
  }

  .error {
    color: var(--danger-text);
  }

  .acts {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .idle {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-block: var(--space-1) var(--space-2);
    padding-inline: var(--space-4);
  }

  .nothing {
    margin: 0;
    color: var(--text);
    font-size: var(--text-sm);
  }

  .caption {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: var(--weight-title);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  :global(:root[lang='ar']) .caption {
    letter-spacing: 0;
    text-transform: none;
  }

  .recent > .caption {
    padding-block: var(--space-1);
    padding-inline: var(--space-4);
  }

  .links {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .chip {
    padding-block: 3px;
    padding-inline: var(--space-3);
    border: 1px solid var(--border-input);
    border-radius: var(--radius-full);
    background-color: transparent;
    color: var(--text);
    font: inherit;
    font-size: var(--text-xs);
    line-height: 1.5;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease-standard);
  }

  .chip:hover {
    background-color: var(--surface-hover);
  }

  .foot {
    flex: none;
    padding: var(--space-2);
    border-block-start: 1px solid var(--border);
  }

  .foot :global(.kbd) {
    margin-inline-start: var(--space-1);
  }

  @media (forced-colors: active) {
    .chip {
      border-color: ButtonText;
    }
  }
</style>
