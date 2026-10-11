<!--
  FollowChip (§8.12). Owner: WP8e. "Return to recitation", in the canvas overlay slot of `MushafView`. Takes no props: it
  reads the reader store (§7.9).

  It shows while the recitation plays with follow-along on and its page is off screen because the user navigated (the
  follow-along does not turn within 4 s of a manual navigation, `reader.followChip`). A click turns to the recitation's
  page and follows it again; × or Escape dismisses it until the recitation reaches another page.

  The arrow points the way the book turns to get there (← towards later pages, physical book order, never mirrored,
  §11.3), and the page number says where. It is announced politely (`role="status"`); its buttons keep the reader's
  selection (`interactions.ts` treats buttons as "not blank").
-->
<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left'
  import ArrowRight from '@lucide/svelte/icons/arrow-right'
  import X from '@lucide/svelte/icons/x'
  import { fly } from 'svelte/transition'
  import { i18n, reader, settings } from '$lib/stores'

  const target = $derived(reader.followChip ? reader.followTarget : null)
  /** Later pages lie to the left in an RTL book. */
  const later = $derived(target !== null && target > Math.max(...reader.visiblePages))
  const where = $derived(target === null ? '' : i18n.t('reader.follow.where', { page: i18n.num(target) }))
  const motion = $derived(settings.reducedMotion ? 0 : 180)

  /** Escape on a focused chip button dismisses the chip (the reader's Escape shortcut also checks for this focus). */
  function onkeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    e.preventDefault()
    reader.dismissFollowChip()
  }
</script>

{#if target !== null}
  <div class="follow" role="status" data-qd-follow-chip="" transition:fly={{ y: 8, duration: motion }}>
    <button type="button" class="chip" title={where} onclick={() => reader.returnToRecitation()} {onkeydown}>
      {#if later}
        <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
      {:else}
        <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
      {/if}
      <span class="label">{i18n.t('reader.follow.back')}</span>
      <span class="page" aria-hidden="true">{i18n.num(target)}</span>
      <span class="sr-only">{where}</span>
    </button>
    <button
      type="button"
      class="dismiss"
      aria-label={i18n.t('common.dismiss')}
      title={i18n.t('common.dismiss')}
      onclick={() => reader.dismissFollowChip()}
      {onkeydown}
    >
      <X size={14} strokeWidth={2} aria-hidden="true" />
    </button>
  </div>
{/if}

<style>
  .follow {
    display: flex;
    align-items: center;
    gap: 2px;
    inline-size: fit-content;
    padding: 3px;
    border-radius: var(--radius-full);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-2);
    pointer-events: auto;
  }

  .chip,
  .dismiss {
    all: unset;
    display: inline-flex;
    align-items: center;
    border-radius: var(--radius-full);
    cursor: pointer;
  }

  .chip {
    gap: var(--space-2);
    block-size: 30px;
    padding-inline: var(--space-3) var(--space-1);
    background-color: var(--accent);
    color: var(--accent-ink);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    line-height: 1;
    white-space: nowrap;
  }

  /* The destination page, a small counter on the chip. */
  .page {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-inline-size: 24px;
    block-size: 22px;
    padding-inline: 6px;
    border-radius: var(--radius-full);
    background-color: color-mix(in srgb, var(--accent-ink) 18%, transparent);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .dismiss {
    justify-content: center;
    inline-size: 26px;
    block-size: 26px;
    color: var(--text-muted);
  }

  .chip:hover {
    background-color: var(--accent-strong);
  }

  .dismiss:hover {
    background-color: var(--surface-hover);
    color: var(--text);
  }

  .chip:focus-visible,
  .dismiss:focus-visible {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  @media (forced-colors: active) {
    .chip {
      border: 1px solid ButtonText;
    }

    .page {
      border: 1px solid ButtonText;
    }
  }
</style>
