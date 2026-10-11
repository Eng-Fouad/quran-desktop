<!--
  HintChip (§8.11). Owner: WP8f. The one-time page-turn hint in the canvas overlay slot: "Scroll, swipe or press ← →
  to turn pages". Takes no props: it reads stores (§7.9).

  - **Once.** It is offered until `settings.hintsSeen` contains `"page_turn"`; showing it to the end, "Got it", or
    turning a page while it waits or shows adds that id, so it never comes back.
  - **When.** After the welcome flow (`onboardingDone`), in the Mushaf with no dialog open, 1.2 s after the reader
    settles (never during boot or a turn). It stays 12 s (not counting while the page rail is open and it steps aside),
    and leaves as soon as a page is turned, since that is what it teaches.
  - The keys are keycaps in one left-to-right group, so the arrows read ← → in both UI languages (§11.3). The chip is a
    polite status, read once when it appears.
-->
<script module lang="ts">
  /** The `settings.hintsSeen` id of this hint (§8.11). */
  export const PAGE_TURN_HINT = 'page_turn'
</script>

<script lang="ts">
  import { untrack } from 'svelte'
  import { fly } from 'svelte/transition'
  import Kbd from '$components/ui/Kbd.svelte'
  import { i18n, reader, settings, ui } from '$lib/stores'
  import { splitAround } from '$lib/util/format'
  import { railState } from './PageRail.svelte'

  /** The reader settles this long before the hint appears. */
  const DELAY_MS = 1200
  /** How long the hint stays. */
  const SHOW_MS = 12_000

  const seen = $derived(settings.value.hintsSeen.includes(PAGE_TURN_HINT))
  const eligible = $derived(
    !seen &&
      settings.value.onboardingDone &&
      settings.value.readingMode === 'mushaf' &&
      ui.view === 'reader' &&
      ui.overlays.length === 0,
  )

  let visible = $state(false)
  /** Marked seen in this mount (the settings round trip may lag behind). */
  let done = false
  let delayTimer: ReturnType<typeof setTimeout> | undefined
  let showTimer: ReturnType<typeof setTimeout> | undefined

  function markSeen(): void {
    clearTimeout(delayTimer)
    clearTimeout(showTimer)
    visible = false
    if (done) return
    done = true
    const current = settings.value.hintsSeen
    if (!current.includes(PAGE_TURN_HINT)) void settings.update({ hintsSeen: [...current, PAGE_TURN_HINT] })
  }

  // Offer the hint once the reader has settled with nothing else on screen.
  $effect(() => {
    const ready = eligible && !reader.turning && !reader.flipping
    untrack(() => {
      if (done || visible) return
      clearTimeout(delayTimer)
      delayTimer = undefined
      if (!ready) return
      delayTimer = setTimeout(() => {
        delayTimer = undefined
        if (done || !eligible) return
        visible = true
        if (!railState.open) showTimer = setTimeout(markSeen, SHOW_MS)
      }, DELAY_MS)
    })
  })

  // The open page rail hides it: its 12 s wait for the rail to go, so it is never marked seen unshown.
  $effect(() => {
    const open = railState.open
    untrack(() => {
      if (!visible) return
      clearTimeout(showTimer)
      showTimer = open ? undefined : setTimeout(markSeen, SHOW_MS)
    })
  })

  // A dialog opening hides it until later; a page turn means the lesson is learnt.
  $effect(() => {
    if (!eligible && visible)
      untrack(() => {
        clearTimeout(showTimer)
        visible = false
      })
  })

  // A turn shows none of the pages shown before (a spread folding to one of its pages on a resize is not a turn).
  let pagesBefore = untrack(() => reader.visiblePages)
  $effect(() => {
    const pages = reader.visiblePages
    untrack(() => {
      const turned = !pages.some((p) => pagesBefore.includes(p))
      pagesBefore = pages
      if (turned && !done && !seen && (visible || delayTimer !== undefined)) markSeen()
    })
  })

  $effect(() => () => {
    clearTimeout(delayTimer)
    clearTimeout(showTimer)
  })

  const parts = $derived(splitAround(i18n.t('pagenav.hint.pageTurn'), 'keys'))
  const motion = $derived(settings.reducedMotion ? 0 : 200)
</script>

{#if visible && !railState.open}
  <div
    class="hint"
    role="status"
    data-qd-pagenav="hint"
    data-qd-keep-selection=""
    transition:fly={{ y: 8, duration: motion }}
  >
    <svg class="pages" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M12 6.5c-2-1.6-4.6-2.2-8-2v13c3.4-.2 6 .4 8 2 2-1.6 4.6-2.2 8-2v-13c-3.4-.2-6 .4-8 2Z" />
      <path d="M12 6.5v13" />
    </svg>
    <span class="text" aria-hidden="true">
      {#if parts}
        {parts[0]}<bdi dir="ltr" class="keys"><Kbd keys={['←']} /><Kbd keys={['→']} /></bdi>{parts[1]}
      {:else}
        {i18n.t('pagenav.hint.pageTurnText')}
      {/if}
    </span>
    <span class="sr-only">{i18n.t('pagenav.hint.pageTurnText')}</span>
    <button type="button" class="ok" onclick={markSeen}>{i18n.t('pagenav.hint.dismiss')}</button>
  </div>
{/if}

<style>
  .hint {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    inline-size: fit-content;
    max-inline-size: calc(100vw - 2 * var(--space-6));
    min-block-size: 40px;
    padding-block: var(--space-1);
    padding-inline: var(--space-3) var(--space-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background-color: var(--glass-fill);
    backdrop-filter: var(--backdrop-dock);
    box-shadow: var(--shadow-2);
    color: var(--text);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
  }

  .pages {
    flex: none;
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.75;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .keys {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-block: -2px;
    vertical-align: middle;
  }

  .ok {
    all: unset;
    flex: none;
    display: inline-flex;
    align-items: center;
    block-size: 30px;
    padding-inline: var(--space-3);
    border-radius: var(--radius-full);
    color: var(--accent-text);
    font-weight: var(--weight-label);
    cursor: pointer;
  }

  .ok:hover {
    background-color: var(--surface-hover);
  }

  .ok:focus-visible {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  @media (forced-colors: active) {
    .hint {
      border-color: CanvasText;
    }

    .pages {
      stroke: CanvasText;
    }
  }
</style>
