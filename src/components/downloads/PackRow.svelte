<!--
  PackRow: one pack of the Downloads manager, 56 px. The kind icon (or `leading`, a reciter's monogram), the
  title with an "In use" or "Recommended" mark, the subtitle ("English · 507 kB · Version 1.1.2"), and on the end
  side the state badge and the actions: Download / Pause / Resume / Stop / Remove / Update / Retry.

  - While a job runs, a 4 px progress bar and "12.4 of 93.2 MB · 1.9 MB/s · 0:42 left" sit under the subtitle; a
    paused job keeps its bar (muted) and amount; a failed one shows the reason (the raw message on hover). A download
    that waits for a connection ("Download when online", or a job the connection broke while the app stays offline)
    reads "Waiting · Waits for a connection" with Cancel: it starts by itself, so it is no failure.
  - Right-click (or Shift+F10 / the menu key on a focused control) opens the row's menu: its actions and Open
    folder.
  - Below 560 px of row width (a narrow canvas, 150–200 % UI scale) the badge and actions wrap under the title, so the
    name keeps the row's width (a container query on the row; owner request 2026-10-11).
  - `children` renders under the row (a recitation's surah grid); `extraActions` before the actions (its toggle).
-->
<script lang="ts">
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import WifiOff from '@lucide/svelte/icons/wifi-off'
  import type { Snippet } from 'svelte'
  import { Badge, Button, ContextMenu, IconButton, Progress } from '$components/ui'
  import type { Tone } from '$components/ui'
  import type { PackInfo } from '$lib/ipc/bindings'
  import { i18n, packs, settings } from '$lib/stores'
  import { hasContent, languageOf, mushafPackId, reciterIdOf } from '$lib/stores/packs.svelte'
  import { rowActions, rowMenu } from './actions'
  import { jobLine, subtitle } from './format'
  import KindTile from './KindTile.svelte'

  interface Props {
    pack: PackInfo
    /** Replaces the kind icon (a reciter's monogram). */
    leading?: Snippet
    /** Controls before the actions (a recitation's surah toggle). */
    extraActions?: Snippet
    /** Content under the row, inside the same list item. */
    children?: Snippet
  }

  let { pack, leading, extraActions, children }: Props = $props()

  const job = $derived(packs.jobs.get(pack.id))
  const items = $derived(packs.items.get(pack.id))
  const pending = $derived(packs.pending.has(pack.id))
  const waiting = $derived(packs.isWaiting(pack.id))
  const name = $derived(packs.title(pack))
  const description = $derived(pack.description[i18n.locale] || pack.description.en)
  const sub = $derived(subtitle(pack, items))
  const actions = $derived(rowActions(pack, job))
  const menu = $derived(rowMenu(pack, job))
  const line = $derived(job ? jobLine(job) : '')

  /** The pack is what the reader uses now (style, translation, tafsir, word by word or reciter). */
  const inUse = $derived.by(() => {
    const s = settings.value
    switch (pack.kind) {
      case 'mushaf_fonts':
        return mushafPackId(s.mushafStyle) === pack.id
      case 'translation':
        return s.translations.includes(pack.id)
      case 'tafsir':
        return s.tafsirPackId === pack.id
      case 'wbw':
        return s.wbwPackId === pack.id
      case 'recitation':
        return reciterIdOf(pack.id) === s.reciterId
      default:
        return false
    }
  })

  /** Recommended and not on this computer yet; language packs only for the UI language. */
  const recommended = $derived.by(() => {
    if (!pack.recommended || inUse || hasContent(pack) || job) return false
    const lang = pack.kind === 'recitation' ? null : languageOf(pack)
    return lang === null || lang === i18n.locale
  })

  const badge = $derived.by((): { tone: Tone; label: string } | null => {
    if (waiting) return { tone: 'neutral', label: i18n.t('downloads.badge.waiting') }
    if (job) {
      switch (job.phase) {
        case 'queued':
          return { tone: 'neutral', label: i18n.t('downloads.badge.queued') }
        case 'verifying':
          return { tone: 'accent', label: i18n.t('downloads.badge.verifying') }
        case 'installing':
          return { tone: 'accent', label: i18n.t('downloads.badge.installing') }
        case 'paused':
          return { tone: 'warning', label: i18n.t('downloads.badge.paused') }
        case 'failed':
          return { tone: 'danger', label: i18n.t('downloads.badge.failed') }
        default:
          return null
      }
    }
    if (pending) return { tone: 'neutral', label: i18n.t('downloads.badge.queued') }
    if (pack.state.type === 'update_available')
      return { tone: 'accent', label: i18n.t('downloads.badge.update') }
    if (pack.state.type === 'installed')
      return { tone: 'success', label: i18n.t('downloads.badge.installed') }
    return null
  })
</script>

<ContextMenu items={menu} label={i18n.t('downloads.row.menuLabel', { name })}>
  {#snippet trigger({ props })}
    <li
      {...props}
      class="pack"
      data-pack-id={pack.id}
      data-kind={pack.kind}
      data-state={pack.state.type}
      data-job={waiting ? 'waiting' : job?.phase}
      aria-busy={job !== undefined && job.phase !== 'paused' && job.phase !== 'failed' ? true : undefined}
    >
      <div class="row">
        <div class="lead" aria-hidden="true">
          {#if leading}
            {@render leading()}
          {:else}
            <KindTile kind={pack.kind} />
          {/if}
        </div>

        <div class="body">
          <div class="line1">
            <span class="name" title={description || undefined}>{name}</span>
            {#if inUse}
              <span class="mark in-use">{i18n.t('downloads.badge.inUse')}</span>
            {:else if recommended}
              <span class="mark">{i18n.t('downloads.badge.recommended')}</span>
            {/if}
          </div>
          <p class="sub">{sub}</p>
          <span class="sr-only">{description}</span>

          {#if waiting}
            <p class="waiting">
              <WifiOff size={14} strokeWidth={2} aria-hidden="true" />
              <span>{i18n.t('downloads.progress.waiting')}</span>
            </p>
          {:else if job && job.phase === 'failed'}
            <p class="error" title={job.error?.message}>
              <CircleAlert size={14} strokeWidth={2} aria-hidden="true" />
              <span
                >{i18n.t('downloads.progress.failed')}{i18n.t('downloads.sep')}{i18n.t(
                  `errors.${job.error?.kind ?? 'internal'}`,
                )}</span
              >
            </p>
          {:else if job}
            <div class={['progress', { paused: job.phase === 'paused' }]}>
              <Progress
                class={job.phase === 'paused' ? 'paused' : undefined}
                value={job.receivedKib}
                max={Math.max(1, job.totalKib)}
                indeterminate={job.phase === 'verifying' || job.phase === 'installing'}
                label={i18n.t('downloads.progress.label', { name })}
                valueText={line}
              />
              <span class="stats">{line}</span>
            </div>
          {/if}
        </div>

        <div class="end" role="group" aria-label={i18n.t('downloads.row.actionsLabel', { name })}>
          {#if badge}<Badge tone={badge.tone} size="sm">{badge.label}</Badge>{/if}
          {#if extraActions}{@render extraActions()}{/if}
          {#each actions as a (a.id)}
            {#if a.style === 'text'}
              <Button
                size="sm"
                variant={a.variant}
                disabled={a.disabled}
                title={a.disabled ? i18n.t('downloads.actions.needsNetwork') : undefined}
                onclick={a.run}
                data-action={a.id}
              >
                {#snippet icon()}<a.icon aria-hidden="true" />{/snippet}
                {a.label}
              </Button>
            {:else}
              <IconButton
                size="sm"
                label={a.label}
                icon={a.icon}
                disabled={a.disabled}
                class={a.danger ? 'danger' : undefined}
                onclick={a.run}
                data-action={a.id}
              />
            {/if}
          {/each}
        </div>
      </div>
      {#if children}{@render children()}{/if}
    </li>
  {/snippet}
</ContextMenu>

<style>
  .pack {
    position: relative;
    display: flex;
    flex-direction: column;
    container: pack-row / inline-size;
    transition: background-color var(--dur-fast) var(--ease-standard);
  }

  .row {
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr) auto;
    align-items: center;
    column-gap: 14px;
    min-block-size: 56px;
    padding-block: 10px;
    padding-inline: var(--space-4) var(--space-3);
  }

  .pack:hover > .row {
    background-color: color-mix(in srgb, var(--surface-hover) 60%, transparent);
  }

  .lead {
    display: flex;
    align-self: start;
    margin-block-start: 1px;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }

  .line1 {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 var(--space-2);
    min-inline-size: 0;
  }

  /* A narrow canvas wraps the name (two lines at most) rather than cutting it. */
  .name {
    display: -webkit-box;
    overflow: hidden;
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-label);
    line-height: 1.4;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  /* A clamp has to clip both axes: give Arabic ink (≈ 1.5 em with its dots and marks) a line box it fits in. */
  .name:lang(ar) {
    line-height: 1.6;
  }

  .mark {
    flex: none;
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: var(--weight-title);
    line-height: 1.4;
    white-space: nowrap;
  }

  .mark.in-use {
    color: var(--accent-text);
  }

  .mark::before {
    content: '';
    display: inline-block;
    inline-size: 5px;
    block-size: 5px;
    margin-inline-end: 5px;
    border-radius: var(--radius-full);
    background-color: currentColor;
    vertical-align: 0.12em;
  }

  .sub {
    margin: 0;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    line-height: 1.45;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .progress {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-3);
    margin-block-start: 6px;
  }

  .progress > :global(.bar) {
    flex: 1 1 160px;
    max-inline-size: 360px;
  }

  .progress :global(.bar.paused) {
    --_fill: var(--text-faint);
  }

  /* Progress arrives 10 times a second: easing each step would keep a transition running for the whole download
     (the page would never be idle, and nothing reads smoother for it). */
  .progress :global(.bar:not(.indeterminate) .fill) {
    transition: none;
  }

  .stats {
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    line-height: 1.4;
    white-space: nowrap;
  }

  .paused .stats {
    color: var(--warning-text);
  }

  .error,
  .waiting {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    margin-block-start: 4px;
    color: var(--danger-text);
    font-size: var(--text-xs);
    line-height: 1.45;
  }

  .waiting {
    color: var(--text-muted);
  }

  .error :global(svg),
  .waiting :global(svg) {
    flex: none;
  }

  .end {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .end :global(.danger:hover:not(:disabled)) {
    color: var(--danger-text);
  }

  /* A narrow row: the badge and the actions move under the title, at the body's inline start. */
  @container pack-row (max-width: 560px) {
    .row {
      grid-template-columns: 36px minmax(0, 1fr);
      row-gap: var(--space-2);
    }

    .end {
      grid-column: 2;
      flex-wrap: wrap;
      justify-content: flex-start;
    }
  }
</style>
