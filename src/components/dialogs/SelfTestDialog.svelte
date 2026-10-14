<!--
  SelfTestDialog: the `self-test` overlay. Props are exactly `OverlayProps['self-test']` (`{ fromAyahId, toAyahId }`).
  Rendered by `OverlayHost` while it is the top overlay.

  Two steps, chosen when it opens:
  - **Setup** (no self-test running): the range with its memorisation status, how hidden words look (the
    `memoHideStyle` setting), the keys used while reciting, and "Start the test" (`memo.startTest`: a random start ayah,
    the reader jumps there and hides from it to the end of the range).
  - **Rating** (a self-test runs; the bar's Finish, `E` or `Shift+E` open it): what was recited, the time, hints and
    mistakes, then the four answers (keys 1–4), each with the interval until the next review for the weakest
    ayah, and the suggested answer marked. "Keep reciting" closes the dialog; "Discard the test" ends it unrated.
-->
<script lang="ts">
  import Baseline from '@lucide/svelte/icons/baseline'
  import CalendarClock from '@lucide/svelte/icons/calendar-clock'
  import Droplets from '@lucide/svelte/icons/droplets'
  import { untrack } from 'svelte'
  import { Button, Dialog, Kbd, Segmented } from '$components/ui'
  import RangeStatus from '$components/memo/RangeStatus.svelte'
  import { keyLabel, mistakeKeyLabel } from '$components/memo/keys'
  import type { OverlayComponentProps } from '$lib/contracts/components'
  import {
    DAY_S,
    RATING_NAMES,
    RATINGS,
    type Rating,
    schedule,
    suggestRating,
    summarize,
  } from '$lib/stores/memo.svelte'
  import { i18n, memo, quran, settings, ui } from '$lib/stores'
  import { overlayOpen } from '../shell/overlay'

  let props: OverlayComponentProps<'self-test'> = $props()
  const isOpen = overlayOpen('self-test')

  /** Which step this instance shows, fixed when it opens (OverlayHost mounts a fresh instance per open). */
  const step: 'setup' | 'rate' = untrack(() => (memo.test ? 'rate' : 'setup'))

  const from = $derived(Math.min(props.fromAyahId, props.toAyahId))
  const to = $derived(Math.max(props.fromAyahId, props.toAyahId))
  const valid = $derived(quran.isAyahId(from) && quran.isAyahId(to))
  const summary = $derived(summarize(memo.progress, from, to, memo.clock))
  const surahName = $derived(quran.surahName(quran.ayahRef(from).surah))
  const shortRange = $derived.by(() => {
    const a = quran.ayahRef(from)
    const b = quran.ayahRef(to)
    return a.surah === 0 ? '' : i18n.ref(a.surah, a.ayah, b.ayah, b.surah)
  })

  let starting = $state(false)
  let saving = $state<Rating | null>(null)

  $effect(() => {
    if (step === 'setup' && valid) void memo.loadProgress(from, to)
  })
  // The rating previews intervals from the recited span's strengths.
  $effect(() => {
    const t = memo.test
    if (step === 'rate' && t) void memo.loadProgress(t.startAyahId, t.toAyahId)
  })

  function close(): void {
    ui.close('self-test')
  }

  async function start(): Promise<void> {
    if (starting || !valid) return
    starting = true
    const ok = await memo.startTest(from, to)
    starting = false
    if (ok) close()
  }

  const styleOptions = $derived([
    { value: 'blur', label: i18n.t('memo.toolbar.styleBlur'), icon: Droplets },
    { value: 'blank', label: i18n.t('memo.toolbar.styleBlank'), icon: Baseline },
  ])

  const keys = $derived([
    { label: i18n.t('memo.dialog.keyReveal'), kbd: keyLabel('memo.revealWord') },
    { label: i18n.t('memo.dialog.keyRevealAyah'), kbd: keyLabel('memo.revealAyah') },
    { label: i18n.t('memo.dialog.keyMistake'), kbd: mistakeKeyLabel() },
    { label: i18n.t('memo.dialog.keyPeek'), kbd: keyLabel('memo.peek') },
  ])

  // --- rating -------------------------------------------------------------------------------------------------------

  /**
   * The test as it stood when the rating opened. The reader keys are off while the dialog is open, so nothing changes
   * it; a snapshot also keeps the figures steady while the dialog closes after the answer.
   */
  const test = untrack(() => memo.test)
  const result = untrack(() => ({
    hints: memo.testReveals,
    mistakes: memo.testMistakes,
    elapsedMs: Math.max(0, Date.now() - memo.testStartedAt),
    words: memo.wordCounts.total,
  }))
  const recited = $derived(test ? memo.label(test.startAyahId, test.toAyahId) : '')
  const elapsed = $derived(i18n.duration(result.elapsedMs))
  const weakest = $derived(test ? memo.minStrength(test.startAyahId, test.toAyahId) : 0)
  const suggested = suggestRating(result.hints, result.mistakes, result.words)

  function interval(r: Rating): string {
    const s = schedule(weakest, r).intervalS
    return s < DAY_S
      ? i18n.tp('memo.interval.minutes', Math.round(s / 60))
      : i18n.tp('memo.interval.days', Math.round(s / DAY_S))
  }

  async function rate(r: Rating): Promise<void> {
    if (saving !== null) return
    saving = r
    const ok = await memo.finishTest(r)
    saving = null
    if (ok) close()
  }

  function discard(): void {
    memo.cancelTest()
    close()
  }

  /** Keys 1–4 answer (the dialog is a layer, so the reader's digit shortcuts are off while it is open). */
  function onkeydown(e: KeyboardEvent): void {
    if (step !== 'rate' || !isOpen() || e.defaultPrevented) return
    if (e.altKey || e.ctrlKey || e.metaKey || e.repeat || e.isComposing) return
    const digit = /^Digit([1-4])$/.exec(e.code)?.[1] ?? /^Numpad([1-4])$/.exec(e.code)?.[1]
    if (!digit) return
    e.preventDefault()
    void rate(Number(digit) as Rating)
  }
</script>

<svelte:window {onkeydown} />

{#if step === 'setup'}
  <Dialog
    open={isOpen()}
    onOpenChange={(open) => {
      if (!open) close()
    }}
    title={i18n.t('memo.dialog.title')}
    description={i18n.t('memo.dialog.description')}
    size="md"
    class="self-test-dialog"
  >
    <div class="setup" data-qd-self-test="setup">
      <section class="range-card" aria-label={i18n.t('memo.dialog.range')}>
        <div class="range-head">
          <span class="range-name">{surahName}</span>
          <span class="range-ref">{shortRange}</span>
          <span class="range-count">{i18n.tp('common.ayahCount', to - from + 1)}</span>
        </div>
        <RangeStatus {summary} />
      </section>

      <div class="field">
        <span class="field-label" id="st-style-label">{i18n.t('memo.dialog.style')}</span>
        <Segmented
          label={i18n.t('memo.dialog.style')}
          size="sm"
          options={styleOptions}
          value={settings.value.memoHideStyle}
          onValueChange={(v) => void settings.update({ memoHideStyle: v === 'blank' ? 'blank' : 'blur' })}
        />
      </div>

      <section class="keys" aria-label={i18n.t('memo.dialog.keys')}>
        <h3 class="keys-title">{i18n.t('memo.dialog.keys')}</h3>
        <dl class="key-list">
          {#each keys as k (k.label)}
            <div class="key-row">
              <dt>{k.label}</dt>
              <dd>
                {#if k.kbd}<Kbd chord={k.kbd} size="sm" />{/if}
              </dd>
            </div>
          {/each}
        </dl>
      </section>
    </div>

    {#snippet footer()}
      <Button variant="secondary" onclick={close}>{i18n.t('common.cancel')}</Button>
      <Button variant="primary" data-autofocus="" loading={starting} disabled={!valid} onclick={start}>
        {i18n.t('memo.dialog.start')}
      </Button>
    {/snippet}
  </Dialog>
{:else}
  <Dialog
    open={isOpen()}
    onOpenChange={(open) => {
      if (!open) close()
    }}
    title={i18n.t('memo.dialog.rateTitle')}
    description={i18n.t('memo.dialog.rateDescription', { range: recited })}
    size="md"
    width={600}
    class="self-test-dialog"
  >
    <div class="rate" data-qd-self-test="rate">
      <dl class="stats">
        <div class="stat wide">
          <dt>{i18n.t('memo.dialog.recited')}</dt>
          <dd>{recited}</dd>
        </div>
        <div class="stat">
          <dt>{i18n.t('memo.dialog.time')}</dt>
          <dd class="num">{elapsed}</dd>
        </div>
        <div class="stat">
          <dt>{i18n.t('memo.dialog.hints')}</dt>
          <dd class="num">{i18n.num(result.hints)}</dd>
        </div>
        <div class="stat">
          <dt>{i18n.t('memo.dialog.mistakes')}</dt>
          <dd class={['num', { bad: result.mistakes > 0 }]}>{i18n.num(result.mistakes)}</dd>
        </div>
      </dl>

      <div class="answers" role="group" aria-label={i18n.t('memo.dialog.rateTitle')}>
        {#each RATINGS as r (r)}
          {@const name = RATING_NAMES[r]}
          <button
            type="button"
            class={['answer', `r-${name}`, { suggested: r === suggested }]}
            data-rating={r}
            data-autofocus={r === suggested ? '' : undefined}
            aria-busy={saving === r || undefined}
            disabled={saving !== null}
            aria-describedby={`st-hint-${r}`}
            onclick={() => void rate(r)}
          >
            <span class="answer-top">
              <Kbd keys={[i18n.num(r)]} size="sm" />
              {#if r === suggested}<span class="tag">{i18n.t('memo.dialog.suggested')}</span>{/if}
            </span>
            <span class="answer-name">{i18n.t(`memo.rating.${name}`)}</span>
            <span class="answer-hint" id={`st-hint-${r}`}>{i18n.t(`memo.ratingHint.${name}`)}</span>
            <span class="answer-next" title={i18n.t('memo.dialog.next', { interval: interval(r) })}>
              <CalendarClock size={14} strokeWidth={1.75} aria-hidden="true" />
              <span class="sr-only">{i18n.t('memo.dialog.next', { interval: interval(r) })}</span>
              <span aria-hidden="true">{interval(r)}</span>
            </span>
          </button>
        {/each}
      </div>
    </div>

    {#snippet footer()}
      <Button variant="ghost" class="discard" onclick={discard}>{i18n.t('memo.dialog.discard')}</Button>
      <span class="grow"></span>
      <Button variant="secondary" onclick={close}>{i18n.t('memo.dialog.keepReciting')}</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .setup,
  .rate {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  /* --- setup ------------------------------------------------------------------------------------------------------ */

  .range-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background-color: color-mix(in srgb, var(--surface-sunken) 45%, var(--surface-raised));
  }

  .range-head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
  }

  .range-name {
    color: var(--text);
    font-size: var(--text-lg);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .range-ref {
    color: var(--text-muted);
    font-size: var(--text-md);
    font-variant-numeric: tabular-nums;
  }

  .range-count {
    margin-inline-start: auto;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .field-label,
  .keys-title {
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
  }

  .keys {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .keys-title {
    margin: 0;
  }

  .key-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2) var(--space-6);
    margin: 0;
  }

  .key-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    min-inline-size: 0;
    padding-block: 4px;
    border-block-end: 1px dashed var(--border);
  }

  .key-row dt {
    min-inline-size: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .key-row dd {
    display: flex;
    flex: none;
    margin: 0;
  }

  /* --- rating ----------------------------------------------------------------------------------------------------- */

  .stats {
    display: grid;
    grid-template-columns: minmax(0, 2fr) repeat(3, minmax(0, 1fr));
    gap: 1px;
    margin: 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background-color: var(--border);
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-block: var(--space-2);
    padding-inline: var(--space-3);
    background-color: var(--surface-raised);
  }

  .stat dt {
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: var(--weight-label);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  :global(html[lang='ar']) .stat dt {
    letter-spacing: 0;
    text-transform: none;
  }

  .stat dd {
    margin: 0;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-label);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .num {
    font-variant-numeric: tabular-nums;
  }

  .bad {
    color: var(--danger-text);
  }

  .answers {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--space-2);
  }

  .answer {
    --_tone: var(--text-muted);

    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    min-block-size: 132px;
    padding: var(--space-3);
    border: 1px solid var(--border-input);
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
    color: var(--text);
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      border-color var(--dur-fast) var(--ease-standard);
  }

  .answer::before {
    content: '';
    position: absolute;
    inset-block-start: -1px;
    inset-inline: -1px;
    block-size: 3px;
    border-start-start-radius: var(--radius-md);
    border-start-end-radius: var(--radius-md);
    background-color: var(--_tone);
  }

  .r-again {
    --_tone: var(--danger);
  }

  .r-hard {
    --_tone: var(--warning);
  }

  .r-good {
    --_tone: var(--accent);
  }

  .r-easy {
    --_tone: var(--success);
  }

  .answer:hover:not(:disabled) {
    border-color: var(--_tone);
    background-color: color-mix(in srgb, var(--_tone) 6%, var(--surface-raised));
  }

  .answer:focus-visible {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .answer:disabled {
    cursor: default;
  }

  .answer:disabled:not([aria-busy='true']) {
    opacity: 0.55;
  }

  .answer.suggested {
    border-color: var(--_tone);
    box-shadow: inset 0 0 0 1px var(--_tone);
  }

  .answer-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    inline-size: 100%;
    margin-block-end: var(--space-1);
  }

  .tag {
    padding-block: 1px;
    padding-inline: 6px;
    border-radius: var(--radius-full);
    background-color: color-mix(in srgb, var(--_tone) 14%, var(--surface-raised));
    color: var(--text);
    font-size: var(--text-2xs);
    font-weight: var(--weight-label);
  }

  .answer-name {
    font-size: var(--text-lg);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .answer-hint {
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
  }

  .answer-next {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-block-start: auto;
    padding-block-start: var(--space-2);
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    font-variant-numeric: tabular-nums;
  }

  .answer-next :global(svg) {
    flex: none;
    color: var(--text-muted);
  }

  .grow {
    flex: 1 1 auto;
  }

  @media (forced-colors: active) {
    .answer::before {
      forced-color-adjust: none;
    }

    .answer.suggested {
      outline: 2px solid Highlight;
    }
  }
</style>
