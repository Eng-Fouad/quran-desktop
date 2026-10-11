<!--
  OnboardingDialog (§9.7, §7.4). Owner: WP12c. The first-run setup: a 720 × 540 dialog over the real page 1–2 spread
  (faint backdrop, rgb(0 0 0 / .18)) in five steps — Welcome, Mushaf (with a live preview), Translation and recitation,
  Starter set, Keys — with progress dots. Takes no props: it reads stores (§7.9), and its state lives in `flow` (it
  survives another overlay on top).

  - Header: the progress dots (step n of 5), and Skip on a re-run. Footer: Back, and the step's action (Next; "Start
    reading" and "Download now" on the starter set; Finish on the keys).
  - A first run must be finished (owner 2026-10-11, `flow.mandatory`): Finish is the only way out; Escape and a click
    outside do nothing (the dialog's escape layer swallows Escape, and `ui.dismissLayer` never closes the onboarding);
    Back stays. A tour reopened from Settings › System keeps Skip, and Escape is Skip there; a click outside does
    nothing either way (a stray click must not end the setup). Finish and Skip set `onboardingDone` (never shown again)
    and close it.
  - Steps slide in from the side they come from (mirrored in RTL; instant under reduced motion), and focus moves to
    the new step's title so screen readers announce it.
  - Page 1 (hafs, `mushaf_get_pages`) is loaded once for the theme thumbnails.
-->
<script lang="ts">
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import Download from '@lucide/svelte/icons/download'
  import { onMount, tick } from 'svelte'
  import { fly } from 'svelte/transition'
  import { Button, Dialog } from '$components/ui'
  import type { PageData } from '$lib/ipc/bindings'
  import { i18n, pages, settings } from '$lib/stores'
  import { overlayOpen } from '../shell/overlay'
  import { flow, STEPS } from './flow.svelte'
  import Keys from './steps/Keys.svelte'
  import MushafSetup from './steps/MushafSetup.svelte'
  import ReadingSetup from './steps/ReadingSetup.svelte'
  import Summary from './steps/Summary.svelte'
  import Welcome from './steps/Welcome.svelte'

  /** How far a step slides in (px). */
  const SLIDE = 24

  flow.seed()

  const isOpen = overlayOpen('onboarding')
  const open = $derived(isOpen() && !flow.done)
  const last = STEPS.length - 1

  // --- page 1 for the theme thumbnails --------------------------------------------------------------------------------

  let page1 = $state.raw<PageData | null>(pages.get('hafs', 1) ?? null)

  onMount(() => {
    if (page1 === null) {
      pages
        .ensure('hafs', [1])
        .then(() => (page1 = pages.get('hafs', 1) ?? null))
        .catch((e: unknown) => console.warn('[qd] onboarding: page 1 could not be loaded', e))
    }
    return () => {
      // Closed for good (Finish or Skip): start afresh next time. Otherwise another overlay is on top: keep the step.
      if (flow.done) flow.reset()
    }
  })

  // --- step changes ----------------------------------------------------------------------------------------------------

  let body: HTMLElement | null = $state(null)
  let mounted = false

  $effect(() => {
    void flow.step
    if (!mounted) {
      mounted = true
      return
    }
    void tick().then(() =>
      body?.querySelector<HTMLElement>('[data-step-heading]')?.focus({ preventScroll: true }),
    )
  })

  function slideIn(node: Element) {
    const rtl = i18n.dir === 'rtl'
    const x = SLIDE * flow.direction * (rtl ? -1 : 1)
    return fly(node, { x, duration: settings.reducedMotion ? 0 : 260, opacity: 0 })
  }

  // --- closing ---------------------------------------------------------------------------------------------------------

  /**
   * On a re-run, Escape skips the setup (§9.7 "Never shown again after … Skip"); a first run ignores it. The check runs
   * in the capture phase, before any layer handles the key, so it sees whether a listbox of the step is open (Escape
   * then closes only that) or focus is somewhere else entirely; the dialog's own escape layer ignores the key
   * (`dismissible={false}`, so a stray click outside never ends the setup).
   */
  function onkeydowncapture(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !open || e.isComposing || !flow.skippable) return
    if (document.querySelector('.qd-listbox:not([data-ending-style])') !== null) return
    const active = document.activeElement
    if (active !== null && active !== document.body && active.closest('.qd-onboarding') === null) return
    flow.complete()
  }

  const stepLabel = $derived(i18n.t('onboarding.stepOf', { step: flow.step + 1, total: STEPS.length }))
</script>

<svelte:window {onkeydowncapture} />

<Dialog
  {open}
  title={i18n.t('onboarding.title')}
  size="lg"
  backdrop="faint"
  closeButton={false}
  dismissible={false}
  class="qd-onboarding"
>
  {#snippet header()}
    <div class="top">
      <div class="progress" role="group" aria-label={i18n.t('onboarding.progressLabel')}>
        <ol class="dots">
          {#each STEPS as id, i (id)}
            <li
              class={['dot', { done: i < flow.step, current: i === flow.step }]}
              aria-current={i === flow.step ? 'step' : undefined}
            >
              <span class="sr-only">{i18n.t(`onboarding.steps.${id}`)}</span>
            </li>
          {/each}
        </ol>
        <span class="step-label">{stepLabel}</span>
      </div>
      {#if flow.skippable}
        <Button size="sm" variant="ghost" onclick={() => flow.complete()} data-action="skip">
          {i18n.t('common.skip')}
        </Button>
      {/if}
    </div>
  {/snippet}

  <div class="steps" bind:this={body} data-step={flow.stepId}>
    {#key flow.step}
      <div class="step" in:slideIn>
        {#if flow.stepId === 'welcome'}
          <Welcome page={page1} />
        {:else if flow.stepId === 'mushaf'}
          <MushafSetup />
        {:else if flow.stepId === 'reading'}
          <ReadingSetup />
        {:else if flow.stepId === 'summary'}
          <Summary />
        {:else}
          <Keys />
        {/if}
      </div>
    {/key}
  </div>

  {#snippet footer()}
    <div class="actions">
      <div class="start">
        {#if flow.step > 0}
          <Button variant="ghost" onclick={() => flow.back()} data-action="back">
            {#snippet icon()}
              {#if i18n.dir === 'rtl'}<ChevronRight size={16} aria-hidden="true" />{:else}<ChevronLeft
                  size={16}
                  aria-hidden="true"
                />{/if}
            {/snippet}
            {i18n.t('common.back')}
          </Button>
        {/if}
      </div>
      <div class="end">
        {#if flow.stepId === 'summary'}
          <Button
            variant="secondary"
            disabled={flow.committing}
            onclick={() => void flow.start(false)}
            data-action="start-reading"
          >
            {i18n.t('onboarding.summary.startReading')}
          </Button>
          <Button
            variant="primary"
            disabled={!flow.canDownload || flow.pendingDownloads.length === 0}
            loading={flow.committing}
            onclick={() => void flow.start(true)}
            data-action="download-now"
          >
            {#snippet icon()}<Download size={16} aria-hidden="true" />{/snippet}
            {i18n.t('onboarding.summary.downloadNow')}
          </Button>
        {:else if flow.step === last}
          <Button variant="primary" onclick={() => flow.complete()} data-action="finish">
            {i18n.t('onboarding.finish')}
          </Button>
        {:else}
          <Button variant="primary" onclick={() => flow.next()} data-action="next">
            {i18n.t('common.next')}
            {#snippet iconEnd()}
              {#if i18n.dir === 'rtl'}<ChevronLeft size={16} aria-hidden="true" />{:else}<ChevronRight
                  size={16}
                  aria-hidden="true"
                />{/if}
            {/snippet}
          </Button>
        {/if}
      </div>
    </div>
  {/snippet}
</Dialog>

<style>
  /* §9.7: 720 × 540 (smaller windows: what fits). */
  :global(.dialog.qd-onboarding) {
    block-size: min(540px, 100%);
    overflow: hidden;
  }

  /* The Dialog's header holds the progress row; its body scrolls if a step is taller than the dialog. */
  :global(.dialog.qd-onboarding > .header) {
    padding-block-start: var(--space-4);
  }

  :global(.dialog.qd-onboarding > .body) {
    padding-block-start: var(--space-3);
    scrollbar-gutter: stable;
  }

  :global(.dialog.qd-onboarding > .footer) {
    padding-block: var(--space-3) var(--space-4);
    border-block-start: 1px solid var(--border);
  }

  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    min-block-size: 28px;
  }

  .progress {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .dots {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .dot {
    inline-size: 8px;
    block-size: 8px;
    border-radius: var(--radius-full);
    background-color: var(--border-strong);
    transition:
      inline-size var(--dur-gentle) var(--ease-emphasized),
      background-color var(--dur-gentle) var(--ease-standard);
  }

  .dot.done {
    background-color: color-mix(in srgb, var(--accent) 55%, var(--surface-raised));
  }

  .dot.current {
    inline-size: 24px;
    background-color: var(--accent);
  }

  .step-label {
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .steps {
    display: grid;
    min-block-size: 100%;
  }

  .step {
    grid-area: 1 / 1;
    min-inline-size: 0;
  }

  .actions {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .start,
  .end {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .start {
    min-block-size: 32px;
  }

  @media (forced-colors: active) {
    .dot {
      background-color: GrayText;
    }

    .dot.current,
    .dot.done {
      background-color: Highlight;
    }
  }
</style>
