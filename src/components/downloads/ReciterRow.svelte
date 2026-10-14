<!--
  ReciterRow: a recitation pack as a `PackRow` with the reciter's monogram (Latin initials in the English UI, the first
  Arabic letter in Naskh in the Arabic UI, on an accent-soft disc, as in the player dock) and a "Surahs" toggle that
  opens its `SurahGrid` under the row. Which grids are open survives leaving the view (`downloadsView`).
-->
<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import { Button } from '$components/ui'
  import type { PackInfo } from '$lib/ipc/bindings'
  import { i18n, packs } from '$lib/stores'
  import { monogram } from './format'
  import PackRow from './PackRow.svelte'
  import SurahGrid from './SurahGrid.svelte'
  import { downloadsView } from './view.svelte'

  interface Props {
    pack: PackInfo
  }

  let { pack }: Props = $props()

  const uid = $props.id()
  const expanded = $derived(downloadsView.expanded.has(pack.id))
  const name = $derived(packs.title(pack))
</script>

<PackRow {pack}>
  {#snippet leading()}
    <span class="monogram" lang={i18n.locale}>{monogram(pack)}</span>
  {/snippet}
  {#snippet extraActions()}
    <Button
      size="sm"
      variant="ghost"
      aria-expanded={expanded}
      aria-controls="{uid}-surahs"
      aria-label={i18n.t(expanded ? 'downloads.actions.hideSurahsOf' : 'downloads.actions.showSurahsOf', {
        name,
      })}
      onclick={() => downloadsView.toggle(pack.id)}
      data-action="surahs"
    >
      {#snippet iconEnd()}<ChevronDown
          class={['qd-dl-chevron', { open: expanded }]}
          aria-hidden="true"
        />{/snippet}
      {i18n.t('downloads.actions.showSurahs')}
    </Button>
  {/snippet}
  {#if expanded}
    <div id="{uid}-surahs" class="panel">
      <SurahGrid {pack} />
    </div>
  {/if}
</PackRow>

<style>
  .monogram {
    display: inline-grid;
    place-items: center;
    inline-size: 36px;
    block-size: 36px;
    border-radius: var(--radius-full);
    background-color: var(--accent-soft);
    color: var(--accent-text);
    font-size: var(--text-xs);
    font-weight: var(--weight-title);
    letter-spacing: 0.02em;
    line-height: 1;
  }

  .monogram:lang(ar) {
    font-family: var(--font-naskh);
    font-size: 18px;
    font-weight: var(--weight-label);
    letter-spacing: 0;
    line-height: 1;
  }

  .panel {
    padding-block: var(--space-1) var(--space-5);
    /* Under the row's text: its padding, the 36 px lead and the column gap. */
    padding-inline: calc(var(--space-4) + 36px + 14px) var(--space-4);
  }

  :global(.qd-dl-chevron) {
    transition: rotate var(--dur-quick) var(--ease-standard);
  }

  :global(.qd-dl-chevron.open) {
    rotate: 180deg;
  }
</style>
