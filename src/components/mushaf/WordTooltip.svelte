<!--
  WordTooltip (§8.17). Owner: WP8d. The word-by-word tooltip of the Mushaf, mounted once by the Mushaf view; takes no
  props (§7.9).

  It shows when `interactions.ts` reports a dwell (`qd:word-dwell`): the pointer moved at least 4 px onto a word and then
  rested 450 ms, with WBW enabled (`wbwTooltip` and a WBW pack). It hides on any keydown, scroll, page turn or zoom, and
  when the pointer leaves the word. Content, top to bottom: the word in `qd-hafs` 22 px (`.quran-text`, the entry's
  `text`, else the page word), its translation in the UI font 14 px, and its transliteration in italic 12 px muted
  (`wbwShowTransliteration`). The entry comes from the `translations` store's WBW cache, requested for the whole page
  when the pointer first comes over it.

  It sits above the word pill, centred on it, and flips below near the top of the window; it is visual only
  (`aria-hidden`): screen-reader users get word-by-word in the side pane's Words tab. Its surface is the §9.4 glass
  (`--glass-fill` with the palette's backdrop blur), so the Quran line under it never shows through.

  While memorising (§8.16) a hidden word gets no tooltip unless hovering reveals it (`memoRevealOnHover`): the tooltip
  would give the word away.
-->
<script lang="ts">
  import { Portal } from 'bits-ui'
  import { untrack } from 'svelte'
  import { fade } from 'svelte/transition'
  import { WORD_DWELL_EVENT, type WordDwell } from '$lib/mushaf/interactions'
  import { i18n, memo, reader, settings, translations } from '$lib/stores'

  /** Gap between the word pill and the tooltip, and the minimum distance to the window edges (CSS px). */
  const GAP = 8
  const EDGE = 8

  let target = $state.raw<WordDwell | null>(null)
  let width = $state(0)
  let height = $state(0)

  $effect(() => {
    const on = (e: CustomEvent<WordDwell | null>) => (target = e.detail)
    window.addEventListener(WORD_DWELL_EVENT, on)
    return () => window.removeEventListener(WORD_DWELL_EVENT, on)
  })

  // A page turn or a zoom moves the word away from under the tooltip (§8.17).
  $effect(() => {
    void reader.visiblePages
    void reader.qfs
    void reader.style
    untrack(() => (target = null))
  })

  const enabled = $derived(settings.value.wbwTooltip && settings.value.wbwPackId !== null)
  /** The word is hidden by the memorisation mode and hovering does not reveal it. */
  const concealed = $derived(
    target !== null && !settings.value.memoRevealOnHover && memo.isHidden(target.wordId),
  )
  /** The WBW pack's language (`wbw.en` → `en`) for the translation line. */
  const packLang = $derived(settings.value.wbwPackId?.replace(/^wbw\./, '').split(/[._]/)[0] ?? undefined)

  const entry = $derived.by(() => {
    void translations.version
    return target ? (translations.wbw.get(target.wordId) ?? null) : null
  })

  /** Placement: above the pill, else below; horizontally centred and kept inside the window. */
  const place = $derived.by(() => {
    if (!target) return null
    const a = target.anchor
    const below = a.top - GAP - height < EDGE
    const top = below ? a.bottom + GAP : a.top - GAP - height
    const centre = (a.left + a.right) / 2
    const maxLeft = Math.max(EDGE, window.innerWidth - EDGE - width)
    const left = Math.min(maxLeft, Math.max(EDGE, centre - width / 2))
    return { left: Math.round(left), top: Math.round(top), side: below ? 'below' : 'above' }
  })

  const duration = $derived(settings.reducedMotion ? 0 : 120)
</script>

{#if target && enabled && !concealed && place}
  <Portal>
    <div
      class="word-tooltip"
      data-side={place.side}
      aria-hidden="true"
      bind:offsetWidth={width}
      bind:offsetHeight={height}
      style:translate={`${place.left}px ${place.top}px`}
      style:visibility={width > 0 ? 'visible' : 'hidden'}
      transition:fade={{ duration }}
    >
      <span class="wt-word quran-text" lang="ar" dir="rtl">{entry?.text ?? target.text}</span>
      {#if entry?.translation}
        <span class="wt-translation" lang={packLang} dir="auto">{entry.translation}</span>
      {:else if !entry}
        <span class="wt-note">{i18n.t('interactions.wbw.unavailable')}</span>
      {/if}
      {#if entry?.transliteration && settings.value.wbwShowTransliteration}
        <span class="wt-translit" dir="ltr">{entry.transliteration}</span>
      {/if}
    </div>
  </Portal>
{/if}

<style>
  .word-tooltip {
    position: fixed;
    top: 0;
    left: 0; /* physical-ok: placed in viewport px with translate */
    z-index: var(--z-tooltip);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    max-inline-size: 260px;
    padding-block: var(--space-2);
    padding-inline: var(--space-3);
    border-radius: var(--radius-md);
    /*
     * §9.4: it floats over Quran text, so it is glass like the palette: translucent only where the backdrop blurs
     * (opaque --surface-raised on Linux and under reduced transparency). Never a bare translucent fill: the line
     * under it would show through the word and its gloss.
     */
    background-color: var(--glass-fill);
    backdrop-filter: var(--backdrop-palette);
    box-shadow: var(--shadow-2);
    color: var(--text);
    text-align: center;
    pointer-events: none;
  }

  .wt-word {
    font-family: var(--font-quran), var(--font-naskh);
    font-size: 22px;
    line-height: 1.6;
    color: var(--ink);
  }

  .wt-translation {
    font-family: var(--font-ui);
    font-size: 14px;
    font-weight: var(--weight-label);
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .wt-translit {
    font-family: var(--font-latin);
    font-size: 12px;
    font-style: italic;
    line-height: 1.35;
    color: var(--text-muted);
  }

  .wt-note {
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
    color: var(--text-muted);
  }

  @media (forced-colors: active) {
    .word-tooltip {
      border: 1px solid CanvasText;
    }
  }
</style>
