<!--
  StylePicker (§9.7): the Mushaf style as four cards (Hafs, Madani 1421 AH, Madani 1405 AH, Tajweed), each with what it
  is and where its fonts stand: included, downloaded, partly downloaded ("212 of 604 pages"), downloaded as you read,
  or needing a connection (offline or with network use off, the page shows the Hafs fallback, §8.5). A radio group.
  Tajweed needs COLR colour fonts: when this webview failed the §8.6 probe (`fonts.v4Supported === false`), its card says
  so and cannot be chosen (choosing it would only be switched back to Madani 1421 AH).
  `compact` (the reading-display popover): two across, each card its name and where its fonts stand, in one line of
  status text (no tile, no hint), with the same availability rules.
-->
<script lang="ts">
  import BookOpen from '@lucide/svelte/icons/book-open'
  import Palette from '@lucide/svelte/icons/palette'
  import Type from '@lucide/svelte/icons/type'
  import type { LucideIcon } from '@lucide/svelte'
  import { Badge } from '$components/ui'
  import type { Tone } from '$components/ui'
  import type { MushafStyle } from '$lib/ipc/bindings'
  import { app, fonts, i18n, packs, settings } from '$lib/stores'
  import { isInstalled, mushafPackId } from '$lib/stores/packs.svelte'
  import { save } from '../model'
  import { radioGroup } from './radio'

  interface Props {
    labelledBy: string
    describedBy?: string
    /** Two across, names and status only (the reading-display popover). */
    compact?: boolean
  }

  let { labelledBy, describedBy, compact = false }: Props = $props()

  const STYLES: readonly { style: MushafStyle; icon: LucideIcon }[] = [
    { style: 'hafs', icon: Type },
    { style: 'qcf_v2', icon: BookOpen },
    { style: 'qcf_v1', icon: BookOpen },
    { style: 'qcf_v4', icon: Palette },
  ]

  const value = $derived(settings.value.mushafStyle)
  const online = $derived(settings.value.networkAllowed && app.online)

  /** Tajweed (V4) cannot be drawn by this webview (§8.6 probe). */
  const unsupported = (style: MushafStyle) => style === 'qcf_v4' && fonts.v4Supported === false

  function availability(style: MushafStyle): { text: string; tone: Tone } {
    if (unsupported(style)) return { text: i18n.t('settings.mushaf.styleBadge.unsupported'), tone: 'warning' }
    const id = mushafPackId(style)
    if (id === null) return { text: i18n.t('settings.mushaf.styleBadge.included'), tone: 'success' }
    const pack = packs.pack(id)
    if (pack && isInstalled(pack))
      return { text: i18n.t('settings.mushaf.styleBadge.downloaded'), tone: 'success' }
    const state = pack?.state
    if ((state?.type === 'partial' || state?.type === 'paused') && state.data.itemsPresent > 0) {
      return {
        text: i18n.t('settings.mushaf.styleBadge.partial', {
          present: state.data.itemsPresent,
          total: state.data.itemsTotal,
        }),
        tone: online ? 'neutral' : 'warning',
      }
    }
    return online
      ? { text: i18n.t('settings.mushaf.styleBadge.onDemand'), tone: 'neutral' }
      : { text: i18n.t('settings.mushaf.styleBadge.offline'), tone: 'warning' }
  }

  function choose(next: string): void {
    if (next !== value && !unsupported(next as MushafStyle)) void save('mushafStyle', next as MushafStyle)
  }
</script>

<div
  class={['styles', { compact }]}
  role="radiogroup"
  aria-labelledby={labelledBy}
  aria-describedby={describedBy}
  use:radioGroup={choose}
>
  {#each STYLES as { style, icon: Icon } (style)}
    {@const checked = value === style}
    {@const status = availability(style)}
    {@const off = unsupported(style)}
    <button
      type="button"
      class={['style', { checked, off }]}
      role="radio"
      aria-checked={checked}
      aria-disabled={off || undefined}
      tabindex={checked ? 0 : -1}
      data-value={style}
      onclick={() => choose(style)}
    >
      {#if compact}
        <span class="text">
          <span class="title">{i18n.t(`settings.options.mushafStyle.${style}`)}</span>
          <span class="status-text" data-tone={status.tone}>{status.text}</span>
        </span>
      {:else}
        <span class="tile" aria-hidden="true"><Icon size={18} strokeWidth={1.75} /></span>
        <span class="text">
          <span class="title">{i18n.t(`settings.options.mushafStyle.${style}`)}</span>
          <span class="hint">{i18n.t(`settings.options.mushafStyleHint.${style}`)}</span>
          <span class="status"><Badge tone={status.tone} size="sm">{status.text}</Badge></span>
        </span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .styles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr));
    gap: var(--space-3);
  }

  .style {
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr);
    align-items: start;
    gap: var(--space-3);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
    color: var(--text);
    font-family: inherit;
    text-align: start;
    cursor: pointer;
    transition:
      border-color var(--dur-fast) var(--ease-standard),
      box-shadow var(--dur-fast) var(--ease-standard);
  }

  .style:hover {
    border-color: var(--border-strong);
    box-shadow: var(--shadow-1);
  }

  .style.checked {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }

  .style.off {
    cursor: default;
  }

  .style.off:hover {
    border-color: var(--border);
    box-shadow: none;
  }

  .off .tile,
  .off .title,
  .off .hint {
    opacity: 0.6;
  }

  .tile {
    display: inline-grid;
    place-items: center;
    inline-size: 36px;
    block-size: 36px;
    border-radius: var(--radius-md);
    background-color: color-mix(in srgb, var(--text-muted) 12%, var(--surface-raised));
    color: var(--text-muted);
  }

  .checked .tile {
    background-color: var(--accent-soft);
    color: var(--accent-text);
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }

  .title {
    font-size: var(--text-md);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .checked .title {
    color: var(--accent-text);
  }

  .hint {
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
  }

  .status {
    margin-block-start: var(--space-1);
  }

  /* Compact: two across, the name over one wrapping line of status in its tone's text colour. */
  .compact {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2);
  }

  .compact .style {
    grid-template-columns: minmax(0, 1fr);
    padding-block: var(--space-2);
    padding-inline: var(--space-3);
  }

  .compact .title {
    font-size: var(--text-sm);
  }

  .status-text {
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-title);
  }

  .status-text[data-tone='success'] {
    color: var(--success-text);
  }

  .status-text[data-tone='warning'] {
    color: var(--warning-text);
  }

  @media (forced-colors: active) {
    .style.checked {
      outline: 2px solid Highlight;
    }
  }
</style>
