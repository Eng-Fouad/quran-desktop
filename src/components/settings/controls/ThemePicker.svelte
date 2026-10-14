<!--
  ThemePicker: the theme as six cards (Match system, Paper, Sepia, Night, Black, High contrast), each a miniature
  of the page in that theme with the current accent. "Match system" shows its light and dark variants split along the
  diagonal. A radio group: the chosen card is the tab stop, arrow keys choose (mirrored in RTL).
  `compact` (the reading-display popover): three across with shorter miniatures and the names only.
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import type { ThemeMode } from '$lib/ipc/bindings'
  import { i18n, settings } from '$lib/stores'
  import { save } from '../model'
  import { accentSwatch, type ResolvedThemeName, themeSwatch } from '../themes'
  import { radioGroup } from './radio'

  interface Props {
    labelledBy: string
    describedBy?: string
    /** Three across, shorter miniatures, no hints (the reading-display popover). */
    compact?: boolean
  }

  let { labelledBy, describedBy, compact = false }: Props = $props()

  const THEMES: readonly ThemeMode[] = ['system', 'paper', 'sepia', 'night', 'black', 'high_contrast']

  const value = $derived(settings.value.theme)

  function hint(theme: ThemeMode): string {
    if (theme !== 'system') return i18n.t(`settings.options.themeHint.${theme}`)
    return i18n.t('settings.options.themeHint.system', {
      light: i18n.t(`settings.options.theme.${settings.value.lightVariant}`),
      dark: i18n.t(`settings.options.theme.${settings.value.darkVariant}`),
    })
  }

  /** The miniature's colours as custom properties (the table in `themes.ts`, checked against tokens.css). */
  function swatchStyle(theme: ResolvedThemeName): string {
    const s = themeSwatch(theme, settings.systemDark)
    const accent = accentSwatch(theme, settings.value.accent, settings.systemDark)
    return `--_app:${s.app};--_page:${s.page};--_text:${s.text};--_muted:${s.muted};--_border:${s.border};--_gold:${s.gold};--_accent:${accent}`
  }

  function choose(next: string): void {
    if (next !== value) void save('theme', next as ThemeMode)
  }
</script>

{#snippet mini(theme: ResolvedThemeName, part: '' | 'first' | 'second')}
  <span class={['mini', part]} style={swatchStyle(theme)} aria-hidden="true">
    <span class="sheet">
      <span class="line l1"></span>
      <span class="line l2 accent"></span>
      <span class="line l3"></span>
      <span class="line l4"></span>
      <span class="line l5 short"></span>
    </span>
  </span>
{/snippet}

<div class={['theme-picker', { compact }]}>
  <div
    class="themes"
    role="radiogroup"
    aria-labelledby={labelledBy}
    aria-describedby={describedBy}
    use:radioGroup={choose}
  >
    {#each THEMES as theme (theme)}
      {@const checked = value === theme}
      <button
        type="button"
        class={['theme', { checked }]}
        role="radio"
        aria-checked={checked}
        tabindex={checked ? 0 : -1}
        data-value={theme}
        onclick={() => choose(theme)}
      >
        <span class="art">
          {#if theme === 'system'}
            {@render mini(settings.value.lightVariant, 'first')}
            {@render mini(settings.value.darkVariant, 'second')}
          {:else}
            {@render mini(theme, '')}
          {/if}
          {#if checked}
            <span class="tick" aria-hidden="true"><Check size={12} strokeWidth={3} /></span>
          {/if}
        </span>
        <span class="name">{i18n.t(`settings.options.theme.${theme}`)}</span>
        {#if !compact}<span class="hint">{hint(theme)}</span>{/if}
      </button>
    {/each}
  </div>
</div>

<style>
  .theme-picker {
    container-type: inline-size;
  }

  /* Six in a row, or two rows of three: never one card left alone on a line. */
  .themes {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: var(--space-3);
  }

  @container (max-width: 600px) {
    .themes {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }

  @container (max-width: 300px) {
    .themes {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .compact .themes {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }

  /* Compact: three across down to 240 px, then two. */
  @container (max-width: 240px) {
    .compact .themes {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .compact .themes {
    gap: var(--space-2);
  }

  .theme {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
    padding: 6px 6px var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
    color: var(--text);
    font-family: inherit;
    text-align: start;
    cursor: pointer;
    transition:
      border-color var(--dur-fast) var(--ease-standard),
      box-shadow var(--dur-fast) var(--ease-standard),
      translate var(--dur-fast) var(--ease-standard);
  }

  .theme:hover {
    border-color: var(--border-strong);
    box-shadow: var(--shadow-1);
  }

  .theme.checked {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }

  .art {
    position: relative;
    display: block;
    block-size: 60px;
    margin-block-end: var(--space-1);
    overflow: clip;
    border-radius: var(--radius-sm);
    /* A hairline so the white and black miniatures keep an edge on any card. */
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 12%, transparent);
  }

  .mini {
    position: absolute;
    inset: 0;
    display: flex;
    justify-content: center;
    padding-block-start: 8px;
    background-color: var(--_app);
  }

  /* Match system: light on one side of the diagonal, dark on the other (physical, like the picture it is). */
  .mini.first {
    clip-path: polygon(0 0, 100% 0, 0 100%); /* physical-ok */
  }

  .mini.second {
    clip-path: polygon(100% 0, 100% 100%, 0 100%); /* physical-ok */
  }

  .sheet {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    inline-size: 62%;
    padding-block: 8px 0;
    padding-inline: 7px;
    border: 1px solid var(--_gold);
    border-block-end: 0;
    border-start-start-radius: 2px;
    border-start-end-radius: 2px;
    background-color: var(--_page);
    box-shadow: 0 0 0 2px var(--_page);
  }

  .line {
    display: block;
    inline-size: 100%;
    block-size: 3px;
    border-radius: 2px;
    background-color: var(--_text);
    opacity: 0.72;
  }

  .line.l2 {
    inline-size: 88%;
  }

  .line.l3 {
    inline-size: 96%;
    background-color: var(--_muted);
  }

  .line.l4 {
    inline-size: 92%;
  }

  .line.short {
    inline-size: 46%;
  }

  .line.accent {
    background-color: var(--_accent);
    opacity: 1;
  }

  .compact .theme {
    padding: 4px 4px 6px;
  }

  .compact .art {
    block-size: 44px;
  }

  .compact .mini {
    padding-block-start: 6px;
  }

  .compact .sheet {
    gap: 4px;
    padding-block-start: 6px;
  }

  .compact .name {
    font-size: var(--text-xs);
  }

  .tick {
    position: absolute;
    inset-block-start: 5px;
    inset-inline-end: 5px;
    display: inline-grid;
    place-items: center;
    inline-size: 18px;
    block-size: 18px;
    border-radius: var(--radius-full);
    background-color: var(--accent);
    color: var(--accent-ink);
    box-shadow: 0 0 0 2px var(--surface-raised);
  }

  .name {
    padding-inline: 2px;
    font-size: var(--text-sm);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
    text-wrap: balance;
  }

  .checked .name {
    color: var(--accent-text);
  }

  .hint {
    padding-inline: 2px;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-title);
    text-wrap: balance;
  }

  @media (forced-colors: active) {
    .theme.checked {
      outline: 2px solid Highlight;
    }

    .mini {
      forced-color-adjust: none;
    }
  }
</style>
