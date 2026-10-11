<!--
  SelfTestBar (§8.16, §7.5). Owner: WP9b. The running self-test in MushafView's overlay slot. Takes no props: it reads
  the memo store (§7.9). Shown while a self-test runs (`memo.test`).

  - **Status**: "Recite from Al-Mulk 67:12", then "to 67:30 · 01:23 · 2 hints · 1 mistake".
  - **Actions**: Reveal (W, a counted hint), Mistake (M, with its count; a second button takes one back), Finish
    (opens the rating, §5.10), and × to cancel the test unrated.
  - Same toolbar behaviour as `MemoToolbar` (one tab stop, arrows, a mouse press keeps focus where it was).
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import ListChecks from '@lucide/svelte/icons/list-checks'
  import Minus from '@lucide/svelte/icons/minus'
  import WholeWord from '@lucide/svelte/icons/whole-word'
  import X from '@lucide/svelte/icons/x'
  import { mergeProps } from 'bits-ui'
  import { fly } from 'svelte/transition'
  import { Kbd, Tooltip } from '$components/ui'
  import { openRating } from '$lib/shortcuts/memorize'
  import { i18n, memo, quran, reader, settings } from '$lib/stores'
  import { keyLabel, mistakeKeyLabel, toolbar } from './keys'

  const SIDE_DOCK_W = 288

  const test = $derived(memo.active?.mode === 'test' ? memo.test : null)
  const room = $derived(reader.viewport.w - (reader.dock === 'side' ? SIDE_DOCK_W : 0))
  const layout = $derived(room >= 760 ? 'wide' : room >= 600 ? 'mid' : 'narrow')
  const motion = $derived(settings.reducedMotion ? 0 : 180)
  const done = $derived(test !== null && memo.nextHidden === null)

  const keys = $derived({
    reveal: keyLabel('memo.revealWord'),
    mistake: mistakeKeyLabel(),
    finish: keyLabel('memo.hide'),
  })

  /** The elapsed time, ticking each second while a test runs. */
  let now = $state(Date.now())
  $effect(() => {
    if (!test) return
    now = Date.now()
    const id = setInterval(() => (now = Date.now()), 1000)
    return () => clearInterval(id)
  })
  const elapsed = $derived(test ? i18n.duration(Math.max(0, now - memo.testStartedAt)) : '')

  const start = $derived(test ? memo.label(test.startAyahId) : '')
  /** "to 67:30": the end of the recited span, short form (the surah is in the first line unless it changes). */
  const end = $derived.by(() => {
    if (!test) return ''
    const a = quran.ayahRef(test.startAyahId)
    const b = quran.ayahRef(test.toAyahId)
    return b.surah === a.surah && b.surah > 0 ? i18n.ref(b.surah, b.ayah) : memo.label(test.toAyahId)
  })
  const meta = $derived(
    test
      ? [
          i18n.t('memo.test.reciteRange', { ref: end }),
          elapsed,
          i18n.tp('memo.test.hints', memo.testReveals),
          i18n.tp('memo.test.mistakes', memo.testMistakes),
        ].join(' · ')
      : '',
  )
</script>

{#if test}
  <div
    class={['test-bar', `l-${layout}`]}
    role="toolbar"
    aria-label={i18n.t('memo.test.region')}
    data-qd-self-test-bar=""
    use:toolbar
    transition:fly={{ y: 8, duration: motion }}
  >
    <div class="status">
      <span class="badge" aria-hidden="true"><ListChecks size={16} strokeWidth={1.75} /></span>
      <span class="lines">
        <span class="title">{i18n.t('memo.test.reciteFrom', { ref: start })}</span>
        <span class="meta">{meta}</span>
      </span>
    </div>

    <span class="sep" aria-hidden="true"></span>

    <Tooltip
      content={i18n.t('memo.toolbar.revealWord')}
      kbd={keys.reveal}
      side="top"
      disabled={layout === 'wide'}
    >
      {#snippet children({ props })}
        <button
          {...mergeProps(props, { onclick: () => memo.revealNextWord() })}
          type="button"
          class="act"
          data-tb
          data-act="reveal"
          aria-label={i18n.t('memo.test.reveal')}
          disabled={done}
        >
          <WholeWord size={18} strokeWidth={1.75} aria-hidden="true" />
          {#if layout !== 'narrow'}<span class="act-label">{i18n.t('memo.test.reveal')}</span>{/if}
          {#if keys.reveal && layout === 'wide'}<Kbd chord={keys.reveal} size="sm" />{/if}
        </button>
      {/snippet}
    </Tooltip>

    <div class="mistakes">
      <Tooltip
        content={i18n.t('memo.test.mistake')}
        kbd={keys.mistake}
        side="top"
        disabled={layout === 'wide'}
      >
        {#snippet children({ props })}
          <button
            {...mergeProps(props, { onclick: () => memo.addMistake() })}
            type="button"
            class="act mistake"
            data-tb
            data-act="mistake"
            aria-label={`${i18n.t('memo.test.mistake')}, ${i18n.tp('memo.test.mistakes', memo.testMistakes)}`}
          >
            <CircleAlert size={18} strokeWidth={1.75} aria-hidden="true" />
            {#if layout !== 'narrow'}<span class="act-label">{i18n.t('memo.test.mistake')}</span>{/if}
            <span class={['tally', { some: memo.testMistakes > 0 }]} aria-hidden="true"
              >{i18n.num(memo.testMistakes)}</span
            >
            {#if keys.mistake && layout === 'wide'}<Kbd chord={keys.mistake} size="sm" />{/if}
          </button>
        {/snippet}
      </Tooltip>
      {#if memo.testMistakes > 0}
        <Tooltip content={i18n.t('memo.test.undoMistake')} side="top">
          {#snippet children({ props })}
            <button
              {...mergeProps(props, { onclick: () => memo.undoMistake() })}
              type="button"
              class="icon small"
              data-tb
              data-act="undo-mistake"
              aria-label={i18n.t('memo.test.undoMistake')}
            >
              <Minus size={14} strokeWidth={2} aria-hidden="true" />
            </button>
          {/snippet}
        </Tooltip>
      {/if}
    </div>

    <span class="sep" aria-hidden="true"></span>

    <Tooltip content={i18n.t('memo.dialog.rateTitle')} kbd={keys.finish} side="top">
      {#snippet children({ props })}
        <button
          {...mergeProps(props, { onclick: openRating })}
          type="button"
          class="finish"
          data-tb
          data-act="finish"
        >
          <Check size={16} strokeWidth={2.25} aria-hidden="true" />
          <span>{i18n.t('memo.test.finish')}</span>
        </button>
      {/snippet}
    </Tooltip>

    <Tooltip content={i18n.t('memo.test.cancel')} side="top">
      {#snippet children({ props })}
        <button
          {...mergeProps(props, { onclick: () => memo.cancelTest() })}
          type="button"
          class="icon"
          data-tb
          data-act="cancel"
          aria-label={i18n.t('memo.test.cancel')}
        >
          <X size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
      {/snippet}
    </Tooltip>
  </div>
{/if}

<style>
  .test-bar {
    display: flex;
    align-items: center;
    gap: 2px;
    max-inline-size: calc(100vw - 32px);
    padding: 5px;
    padding-inline-end: 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background-color: var(--glass-fill);
    backdrop-filter: var(--backdrop-dock);
    box-shadow: var(--shadow-2);
    color: var(--text);
    pointer-events: auto;
  }

  button {
    all: unset;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    flex: none;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  button:focus-visible {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  button:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .status {
    display: flex;
    flex: 0 1 auto;
    align-items: center;
    gap: var(--space-3);
    min-inline-size: 0;
    block-size: 42px;
    padding-inline: 4px var(--space-3);
  }

  .badge {
    display: grid;
    place-items: center;
    flex: none;
    inline-size: 34px;
    block-size: 34px;
    border-radius: var(--radius-full);
    background-color: var(--warning-soft);
    color: var(--warning-text);
  }

  .lines {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-inline-size: 0;
  }

  .title {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    font-size: var(--text-sm);
    font-weight: var(--weight-title);
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sep {
    flex: none;
    inline-size: 1px;
    block-size: 24px;
    margin-inline: var(--space-1);
    background-color: var(--border);
  }

  .act {
    gap: 6px;
    block-size: 36px;
    padding-inline: 10px;
    border-radius: var(--radius-full);
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    white-space: nowrap;
  }

  .act:hover:not(:disabled),
  .icon:hover:not(:disabled) {
    background-color: var(--surface-hover);
  }

  .act :global(svg),
  .icon :global(svg) {
    flex: none;
    color: var(--text-muted);
  }

  .act:hover:not(:disabled) :global(svg),
  .icon:hover:not(:disabled) :global(svg) {
    color: var(--text);
  }

  .mistakes {
    display: inline-flex;
    align-items: center;
  }

  .tally {
    display: inline-grid;
    place-items: center;
    min-inline-size: 20px;
    block-size: 20px;
    padding-inline: 5px;
    border-radius: var(--radius-full);
    background-color: color-mix(in srgb, var(--text) 8%, transparent);
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .tally.some {
    background-color: var(--danger-soft);
    color: var(--danger-text);
  }

  .icon {
    justify-content: center;
    inline-size: 36px;
    block-size: 36px;
    border-radius: var(--radius-full);
  }

  .icon.small {
    inline-size: 26px;
    block-size: 26px;
  }

  .finish {
    gap: 6px;
    block-size: 36px;
    padding-inline: 12px 14px;
    border-radius: var(--radius-full);
    background-color: var(--accent);
    color: var(--accent-ink);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    white-space: nowrap;
  }

  .finish:hover {
    background-color: color-mix(in srgb, var(--accent) 90%, var(--text));
  }

  @media (forced-colors: active) {
    .test-bar {
      border-color: CanvasText;
    }

    .finish {
      border: 1px solid ButtonText;
    }
  }
</style>
