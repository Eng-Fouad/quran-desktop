<!--
  StepHeader (§9.7 onboarding): the title and lede of a step. Owner: WP12c. The title takes focus when the dialog opens
  (`data-autofocus`) and when the step changes (`data-step-heading`, `tabindex=-1`), so screen readers read the step
  first and Tab reaches its first control; the welcome headline uses the onboarding headline size (§9.3
  `--text-3xl`), the other steps `--text-2xl`.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    title: string
    lede: string
    /** The welcome step's headline size. */
    hero?: boolean
    /** Leading art (the welcome step's app icon). */
    art?: Snippet
  }

  let { title, lede, hero = false, art }: Props = $props()
</script>

<!-- Not `header`: inside the onboarding dialog that would be a second banner landmark (HTML-AAM). -->
<div class={['step-header', { hero }]}>
  {#if art}<div class="art">{@render art()}</div>{/if}
  <div class="text">
    <h2 class="title" tabindex="-1" data-step-heading data-autofocus>{title}</h2>
    <p class="lede">{lede}</p>
  </div>
</div>

<style>
  .step-header {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }

  .art {
    flex: none;
    display: grid;
    place-items: center;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-inline-size: 0;
  }

  .title {
    margin: 0;
    color: var(--text);
    font-size: var(--text-2xl);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
    outline: none;
  }

  .hero .title {
    font-size: var(--text-3xl);
  }

  .lede {
    margin: 0;
    max-inline-size: 60ch;
    color: var(--text-muted);
    font-size: var(--text-md);
    line-height: var(--leading-ui);
  }
</style>
