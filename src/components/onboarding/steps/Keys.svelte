<!--
  Keys (onboarding step 4). Teaches the three keys to remember: the command palette (`Ctrl+K` / `⌘K`), play/pause
  (`Space`) and the shortcut sheet (`?`), each as keycaps (`Kbd`) labelled the way the shortcut registry prints them on
  this platform and keyboard layout. After "Download now" it also follows the starter set's download, and offers the
  Downloads manager if part of it failed. Finish (in the footer) ends the onboarding.
-->
<script lang="ts">
  import CircleCheck from '@lucide/svelte/icons/circle-check'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
  import { Button, Kbd, Progress } from '$components/ui'
  import type { ShortcutDef } from '$lib/contracts/shortcuts'
  import { i18n, shortcuts, ui } from '$lib/stores'
  import { flow } from '../flow.svelte'
  import StepHeader from '../StepHeader.svelte'

  /** The three keys, with the default chords used until their owner registers the definition. */
  const KEYS = [
    { id: 'palette', def: 'app.palette', keys: ['Mod+k'] },
    { id: 'play', def: 'audio.toggle', keys: ['Space'] },
    { id: 'sheet', def: 'app.shortcutSheet', keys: ['?'] },
  ] as const

  /** The chord label of a registered definition, else of its default keys (formatted the same way). */
  function chord(defId: string, keys: readonly string[]): string {
    const def =
      shortcuts.defs.find((d) => d.id === defId) ??
      ({
        id: defId,
        keys: [...keys],
        group: 'app',
        labelKey: 'shortcuts.app.palette',
        scope: 'global',
        run: () => {},
      } satisfies ShortcutDef)
    return shortcuts.format(def) || keys[0] || ''
  }

  const progress = $derived(flow.progress)

  function openDownloads(): void {
    flow.complete()
    ui.setView('downloads')
  }
</script>

<div class="keys">
  <StepHeader title={i18n.t('onboarding.keys.title')} lede={i18n.t('onboarding.keys.lede')} />

  <ul class="cards">
    {#each KEYS as k (k.id)}
      <li class="card" data-key={k.id}>
        <span class="caps"><Kbd chord={chord(k.def, k.keys)} /></span>
        <span class="title">{i18n.t(`onboarding.keys.${k.id}.title`)}</span>
        <span class="body">{i18n.t(`onboarding.keys.${k.id}.body`)}</span>
      </li>
    {/each}
  </ul>

  {#if progress}
    <div class={['progress', `s-${progress.state}`]} role="status" data-starter={progress.state}>
      {#if progress.state === 'running'}
        <span class="progress-text">
          {i18n.t('onboarding.keys.downloading', { percent: progress.percent })}
        </span>
        <Progress
          value={progress.percent}
          label={i18n.t('onboarding.keys.downloading', { percent: progress.percent })}
          class="progress-bar"
        />
      {:else if progress.state === 'done'}
        <span class="progress-text">
          <CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" />
          {i18n.t('onboarding.keys.ready')}
        </span>
      {:else}
        <span class="progress-text">
          <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
          {i18n.t('onboarding.keys.failed')}
        </span>
        <Button size="sm" variant="secondary" onclick={openDownloads}>
          {i18n.t('onboarding.keys.openDownloads')}
        </Button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .keys {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-6) var(--space-4) var(--space-5);
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-1);
    text-align: center;
  }

  .caps {
    display: grid;
    place-items: center;
    min-block-size: 44px;
    margin-block-end: var(--space-2);
  }

  /* Larger keycaps than in dense UI: this step is about the keys. */
  .caps :global(.kbd) {
    font-family: var(--font-ui);
    font-size: var(--text-md);
    font-weight: var(--weight-label);
  }

  .caps :global(.cap) {
    min-inline-size: 36px;
    block-size: 36px;
    padding-inline: var(--space-2);
    border-radius: var(--radius-sm);
    box-shadow: inset 0 -2px 0 var(--border-strong);
    color: var(--text);
  }

  .title {
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .body {
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
  }

  .progress {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2) var(--space-4);
    padding-block: var(--space-3);
    padding-inline: var(--space-4);
    border-radius: var(--radius-md);
    background-color: var(--surface-sunken);
  }

  .progress-text {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }

  .progress :global(.progress-bar) {
    flex: 1 1 100%;
  }

  .s-done {
    background-color: var(--success-soft);
  }

  .s-done .progress-text :global(svg) {
    color: var(--success-text);
  }

  .s-failed {
    background-color: var(--warning-soft);
  }

  .s-failed .progress-text :global(svg) {
    color: var(--warning-text);
  }
</style>
