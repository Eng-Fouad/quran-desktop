<!--
  PaletteRow: the content of one command-palette row — a 24 px leading badge (the surah number in a rosette, a
  command icon, a highlight swatch, a reciter's monogram or the reading-bookmark ribbon), the label with the query's
  matches emphasised, a muted detail, a surah's Arabic name (the sura-names glyph when the decor font is loaded, else
  Naskh) and, at the inline end, the shortcut keycaps or a short state ("On", "Current"). The option element itself is
  bits-ui's `Command.Item` (CommandPalette).
-->
<script lang="ts">
  import Rosette from '$components/index/Rosette.svelte'
  import SuraName from '$components/index/SuraName.svelte'
  import { Badge, Kbd } from '$components/ui'
  import { i18n } from '$lib/stores'
  import { splitMarks } from './match'
  import type { PaletteItem } from './palette-providers'

  interface Props {
    item: PaletteItem
    /** The row is the active option (keyboard or pointer). */
    active?: boolean
    /** The sura-names decor face is loaded. */
    glyphs?: boolean
  }

  let { item, active = false, glyphs = false }: Props = $props()

  const parts = $derived(splitMarks(item.label, item.marks ?? []))
  /** In the Arabic UI the label is already the Arabic name: only the calligraphic glyph adds something. */
  const arabic = $derived(
    item.arabic !== undefined && (glyphs || i18n.locale === 'en') ? item.arabic : undefined,
  )
  const badge = $derived(item.badge)
</script>

<span class="badge" aria-hidden="true">
  {#if badge.kind === 'rosette'}
    <Rosette n={badge.n} size={24} active={active && !item.disabled} />
  {:else if badge.kind === 'icon'}
    {@const Icon = badge.icon}
    <span class={['tile', { on: badge.tone === 'on' }]}>
      <Icon class={badge.mirror ? 'icon-dir' : undefined} size={15} strokeWidth={1.75} />
    </span>
  {:else if badge.kind === 'swatch'}
    <span class="tile"><span class="swatch" style:background-color={badge.color}></span></span>
  {:else if badge.kind === 'monogram'}
    <span class={['monogram', { arabic: badge.arabic }]} lang={badge.arabic ? 'ar' : undefined}
      >{badge.text}</span
    >
  {:else}
    <span class="tile ribbon-tile">
      <svg class="ribbon" viewBox="0 0 12 18" focusable="false"><path d="M1 0h10v17l-5-4.2L1 17Z" /></svg>
    </span>
  {/if}
</span>

<span class="text">
  <span class="label" dir="auto">
    {#each parts as part, i (i)}{#if part.mark}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}
  </span>
  {#if item.detail}
    <span class={['detail', { reason: item.reason }]}>{item.detail}</span>
  {/if}
</span>

{#if arabic}
  {#if glyphs}
    <SuraName n={arabic.surah} size={26} />
  {:else}
    <span class="naskh" lang="ar" dir="rtl">{arabic.text}</span>
  {/if}
{/if}

{#if item.keys && item.keys.length > 0}
  <span class="end"><Kbd chord={item.keys[0]} size="sm" /></span>
{:else if item.hint}
  <span class="end">
    <Badge tone={item.hintTone === 'accent' ? 'accent' : 'neutral'} size="sm">{item.hint}</Badge>
  </span>
{/if}

<style>
  .badge {
    display: grid;
    flex: none;
    place-items: center;
    inline-size: 24px;
    block-size: 24px;
  }

  .tile {
    display: grid;
    place-items: center;
    inline-size: 24px;
    block-size: 24px;
    border-radius: var(--radius-sm);
    background-color: color-mix(in srgb, var(--text) 6%, transparent);
    color: var(--text-muted);
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      color var(--dur-fast) var(--ease-standard);
  }

  .tile.on {
    color: var(--accent-text);
  }

  :global([data-selected]) .tile {
    background-color: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent-text);
  }

  :global([data-disabled]) .tile {
    background-color: color-mix(in srgb, var(--text) 5%, transparent);
    color: var(--text-faint);
  }

  .swatch {
    inline-size: 12px;
    block-size: 12px;
    border-radius: var(--radius-full);
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.12);
  }

  .ribbon-tile {
    background-color: color-mix(in srgb, var(--ribbon) 12%, transparent);
  }

  :global([data-selected]) .ribbon-tile {
    background-color: color-mix(in srgb, var(--ribbon) 18%, transparent);
  }

  .ribbon {
    inline-size: 9px;
    block-size: 14px;
    fill: var(--ribbon);
  }

  .monogram {
    display: grid;
    place-items: center;
    inline-size: 24px;
    block-size: 24px;
    border-radius: var(--radius-full);
    background-color: var(--accent-soft);
    color: var(--accent-text);
    font-size: 10px;
    font-weight: var(--weight-title);
    letter-spacing: 0.02em;
    line-height: 1;
  }

  .monogram.arabic {
    padding-block-end: 2px;
    font-family: var(--font-naskh);
    font-size: 14px;
    font-weight: var(--weight-label);
    letter-spacing: 0;
  }

  .text {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    min-inline-size: 0;
    /* Inline axis only: the Arabic dots below the baseline reach past the 1.3 line box (base.css `.truncate`). */
    overflow-x: clip;
    overflow-y: visible;
  }

  /* The label keeps priority: the detail ellipsises first, then the label (capped at the row). */
  .label {
    flex: 0 0 auto;
    min-inline-size: 0;
    max-inline-size: 100%;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text);
    font-size: var(--text-md);
    line-height: 1.3;
    white-space: nowrap;
    text-overflow: ellipsis;
    unicode-bidi: isolate;
  }

  mark {
    background: none;
    color: inherit;
    font-weight: var(--weight-title);
  }

  .detail {
    flex: 1 1 auto;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.3;
    white-space: nowrap;
    text-overflow: ellipsis;
    /* In the UI direction: details are written in the UI language, with any other script isolated in the text. */
    unicode-bidi: isolate;
  }

  .detail.reason {
    color: var(--danger-text);
  }

  :global([data-disabled]) .label {
    color: var(--text-muted);
  }

  .naskh {
    flex: none;
    color: var(--text-muted);
    font-family: var(--font-naskh);
    font-size: 17px;
    line-height: 1.2;
    white-space: nowrap;
  }

  .end {
    display: inline-flex;
    flex: none;
    align-items: center;
  }

  @media (forced-colors: active) {
    .tile,
    .monogram {
      border: 1px solid CanvasText;
    }

    .swatch {
      forced-color-adjust: none;
    }
  }
</style>
