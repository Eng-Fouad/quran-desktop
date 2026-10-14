<!--
  MemoToolbar: the hide-mode toolbar in MushafView's overlay slot (bottom centre, above the dock). Takes no props: it
  reads the memo store. Shown while `memo.active.mode === 'hide'`; a self-test has its own bar (`SelfTestBar`).

  - **Status**: the hidden range and a slim meter of the words revealed so far ("14 of 337 words"). A click turns to
    the next hidden word when it is off screen.
  - **Actions**: Next word (W), Next ayah (Shift+W), Peek (hold Q, or hold the button), the hidden-word style (blur ↔
    blank, the `memoHideStyle` setting), Hide again, and Show the text (E).
  - `role="toolbar"`: one tab stop, arrow keys between the buttons. A mouse press never takes focus, so W and Q keep
    working after a click. Labels give way to icons when the canvas is narrow; every button keeps its tooltip and key.
-->
<script lang="ts">
  import Baseline from '@lucide/svelte/icons/baseline'
  import Droplets from '@lucide/svelte/icons/droplets'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import Pilcrow from '@lucide/svelte/icons/pilcrow'
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw'
  import WholeWord from '@lucide/svelte/icons/whole-word'
  import X from '@lucide/svelte/icons/x'
  import { mergeProps } from 'bits-ui'
  import { fly } from 'svelte/transition'
  import { Kbd, Tooltip } from '$components/ui'
  import { i18n, memo, quran, reader, settings } from '$lib/stores'
  import { holdToPeek, keyLabel, toolbar } from './keys'

  /** The dock's side card takes this much of the canvas's inline end. */
  const SIDE_DOCK_W = 288

  const session = $derived(memo.active?.mode === 'hide' ? memo.active : null)
  const counts = $derived(memo.wordCounts)
  const done = $derived(session !== null && memo.nextHidden === null)
  const pct = $derived(counts.total > 0 ? Math.round((counts.revealed / counts.total) * 1000) / 10 : 0)
  const range = $derived(session ? memo.label(session.from, session.to) : '')
  const blank = $derived(settings.value.memoHideStyle === 'blank')
  /** The overlay slot's width (the canvas, less the side card). */
  const room = $derived(reader.viewport.w - (reader.dock === 'side' ? SIDE_DOCK_W : 0))
  const layout = $derived(room >= 820 ? 'wide' : room >= 620 ? 'mid' : 'narrow')
  const motion = $derived(settings.reducedMotion ? 0 : 180)

  const keys = $derived({
    word: keyLabel('memo.revealWord'),
    ayah: keyLabel('memo.revealAyah'),
    peek: keyLabel('memo.peek'),
    hide: keyLabel('memo.hide'),
  })

  /** The status button: turn to the next hidden word when it is off screen. */
  function goToNext(): void {
    const s = session
    if (!s) return
    const word = memo.nextHidden ?? quran.firstWordOf(s.from)
    const ayah = quran.ayahOfWord(word)
    const page = quran.pageOfWord(reader.layout, word)
    if (!reader.visiblePages.includes(page) && ayah > 0) reader.goToAyah(ayah)
  }

  function toggleStyle(): void {
    void settings.update({ memoHideStyle: blank ? 'blur' : 'blank' })
  }
</script>

{#if session}
  <div
    class={['memo-bar', `l-${layout}`]}
    role="toolbar"
    aria-label={i18n.t('memo.toolbar.region')}
    data-qd-memo-toolbar=""
    use:toolbar
    transition:fly={{ y: 8, duration: motion }}
  >
    <Tooltip content={i18n.t('memo.toolbar.goTo')} side="top">
      {#snippet children({ props })}
        <button {...mergeProps(props, { onclick: goToNext })} type="button" class="status" data-tb>
          <span class="badge" aria-hidden="true"><EyeOff size={16} strokeWidth={1.75} /></span>
          <span class="lines">
            <span class="title">{i18n.t('memo.toolbar.hiding', { range })}</span>
            <span class="meter-row">
              <span class="meter" aria-hidden="true"
                ><span class="fill" style:inline-size={`${pct}%`}></span></span
              >
              <span class="count" aria-live="off">
                {done
                  ? i18n.t('memo.toolbar.allRevealed')
                  : i18n.tp('memo.toolbar.progress', counts.total, { revealed: counts.revealed })}
              </span>
            </span>
          </span>
        </button>
      {/snippet}
    </Tooltip>

    <span class="sep" aria-hidden="true"></span>

    {#snippet action(
      label: string,
      Icon: typeof Eye,
      kbd: string | undefined,
      onclick: (() => void) | undefined,
      extra: Record<string, unknown> = {},
    )}
      <Tooltip content={label} {kbd} side="top" disabled={layout === 'wide'}>
        {#snippet children({ props })}
          <button
            {...mergeProps(props, extra, { onclick })}
            type="button"
            class="act"
            data-tb
            aria-label={label}
          >
            <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
            {#if layout === 'wide'}<span class="act-label">{label}</span>{/if}
            {#if kbd && layout !== 'narrow'}<Kbd chord={kbd} size="sm" class="act-kbd" />{/if}
          </button>
        {/snippet}
      </Tooltip>
    {/snippet}

    {@render action(i18n.t('memo.toolbar.revealWord'), WholeWord, keys.word, () => memo.revealNextWord(), {
      disabled: done,
      'data-act': 'word',
    })}
    {@render action(i18n.t('memo.toolbar.revealAyah'), Pilcrow, keys.ayah, () => memo.revealNextAyah(), {
      disabled: done,
      'data-act': 'ayah',
    })}

    <Tooltip content={i18n.t('memo.toolbar.peekHint')} kbd={keys.peek} side="top">
      {#snippet children({ props })}
        <button
          {...props}
          type="button"
          class={['act', 'peek', { on: memo.peeking }]}
          data-tb
          data-act="peek"
          aria-label={i18n.t('memo.toolbar.peek')}
          aria-pressed={memo.peeking}
          use:holdToPeek
        >
          <Eye size={18} strokeWidth={1.75} aria-hidden="true" />
          {#if layout === 'wide'}<span class="act-label">{i18n.t('memo.toolbar.peek')}</span>{/if}
          {#if keys.peek && layout !== 'narrow'}<Kbd chord={keys.peek} size="sm" class="act-kbd" />{/if}
        </button>
      {/snippet}
    </Tooltip>

    <span class="sep" aria-hidden="true"></span>

    <Tooltip
      content={`${i18n.t('memo.toolbar.style')}: ${i18n.t(blank ? 'memo.toolbar.styleBlank' : 'memo.toolbar.styleBlur')}`}
      side="top"
    >
      {#snippet children({ props })}
        <button
          {...mergeProps(props, { onclick: toggleStyle })}
          type="button"
          class="icon"
          data-tb
          data-act="style"
          data-style={blank ? 'blank' : 'blur'}
          aria-label={`${i18n.t('memo.toolbar.style')}: ${i18n.t(blank ? 'memo.toolbar.styleBlank' : 'memo.toolbar.styleBlur')}`}
        >
          {#if blank}
            <Baseline size={18} strokeWidth={1.75} aria-hidden="true" />
          {:else}
            <Droplets size={18} strokeWidth={1.75} aria-hidden="true" />
          {/if}
        </button>
      {/snippet}
    </Tooltip>

    <Tooltip content={i18n.t('memo.toolbar.restart')} side="top">
      {#snippet children({ props })}
        <button
          {...mergeProps(props, { onclick: () => memo.restart() })}
          type="button"
          class="icon"
          data-tb
          data-act="restart"
          aria-label={i18n.t('memo.toolbar.restart')}
          disabled={counts.revealed === 0}
        >
          <RotateCcw size={17} strokeWidth={1.75} aria-hidden="true" />
        </button>
      {/snippet}
    </Tooltip>

    <Tooltip content={i18n.t('memo.toolbar.stop')} kbd={keys.hide} side="top">
      {#snippet children({ props })}
        <button
          {...mergeProps(props, { onclick: () => memo.stop() })}
          type="button"
          class="icon close"
          data-tb
          data-act="stop"
          aria-label={i18n.t('memo.toolbar.stop')}
        >
          <X size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
      {/snippet}
    </Tooltip>
  </div>
{/if}

<style>
  .memo-bar {
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

  /* --- status -------------------------------------------------------------------------------------------------- */

  .status {
    flex: 0 1 auto;
    gap: var(--space-3);
    min-inline-size: 0;
    block-size: 42px;
    padding-inline: 4px var(--space-3);
    border-radius: var(--radius-full);
  }

  .status:hover {
    background-color: var(--surface-hover);
  }

  .badge {
    display: grid;
    place-items: center;
    flex: none;
    inline-size: 34px;
    block-size: 34px;
    border-radius: var(--radius-full);
    background-color: var(--accent-soft);
    color: var(--accent-text);
  }

  .lines {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-inline-size: 0;
  }

  .title {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meter-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .meter {
    position: relative;
    flex: none;
    inline-size: 64px;
    block-size: 4px;
    overflow: hidden;
    border-radius: var(--radius-full);
    background-color: color-mix(in srgb, var(--border-input) 40%, transparent);
  }

  .fill {
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;
    border-radius: inherit;
    background-color: var(--accent);
    transition: inline-size var(--dur-normal) var(--ease-standard);
  }

  .count {
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
    white-space: nowrap;
  }

  .sep {
    flex: none;
    inline-size: 1px;
    block-size: 24px;
    margin-inline: var(--space-1);
    background-color: var(--border);
  }

  /* --- actions ------------------------------------------------------------------------------------------------- */

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

  .act :global(.act-kbd) {
    margin-inline-start: 2px;
  }

  .peek.on {
    background-color: var(--accent-soft);
    color: var(--accent-text);
  }

  .peek.on :global(svg) {
    color: var(--accent-text);
  }

  .icon {
    justify-content: center;
    inline-size: 36px;
    block-size: 36px;
    border-radius: var(--radius-full);
  }

  .close:hover {
    color: var(--text);
  }

  .l-narrow .status {
    padding-inline-end: var(--space-2);
  }

  .l-narrow .act {
    padding-inline: 9px;
  }

  .l-narrow .meter {
    inline-size: 40px;
  }

  @media (forced-colors: active) {
    .memo-bar {
      border-color: CanvasText;
    }

    .fill {
      background-color: Highlight;
    }

    .peek.on {
      outline: 2px solid Highlight;
    }
  }
</style>
