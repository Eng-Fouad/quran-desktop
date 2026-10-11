<!--
  Summary (§9.7 onboarding step 3). Owner: WP12c. The exact starter set (§2.5.4), in its order: each pack with when it
  is fetched (now, as you read, timings on first play) and what "Download now" fetches for it, then the exact total
  of that button. The "Work offline" switch (`networkAllowed`) applies at once; while it is on, or the app is
  offline, the download rows are disabled and only "Start reading" remains. The buttons sit in the dialog footer.
-->
<script lang="ts">
  import AudioLines from '@lucide/svelte/icons/audio-lines'
  import BookOpenText from '@lucide/svelte/icons/book-open-text'
  import CircleCheck from '@lucide/svelte/icons/circle-check'
  import Languages from '@lucide/svelte/icons/languages'
  import ScrollText from '@lucide/svelte/icons/scroll-text'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import WifiOff from '@lucide/svelte/icons/wifi-off'
  import type { LucideIcon } from '@lucide/svelte'
  import { Switch } from '$components/ui'
  import type { PackKind } from '$lib/ipc/bindings'
  import { app, i18n, packs, settings } from '$lib/stores'
  import { isInstalled } from '$lib/stores/packs.svelte'
  import { flow } from '../flow.svelte'
  import { exactTotal, whenKey } from '../format'
  import StepHeader from '../StepHeader.svelte'

  const KIND_ICON: Record<PackKind, LucideIcon> = {
    decor: Sparkles,
    translation: Languages,
    tafsir: ScrollText,
    mushaf_fonts: BookOpenText,
    wbw: Languages,
    recitation: AudioLines,
  }

  const set = $derived(flow.starterSet)
  const workOffline = $derived(!settings.value.networkAllowed)
  const blocked = $derived(!flow.canDownload)
</script>

<div class="summary">
  <StepHeader title={i18n.t('onboarding.summary.title')} lede={i18n.t('onboarding.summary.lede')} />

  <div class={['set', { blocked }]}>
    <ul class="rows" aria-label={i18n.t('onboarding.summary.listLabel')}>
      {#each set.items as item (item.pack.id)}
        {@const Icon = KIND_ICON[item.pack.kind]}
        {@const installed = isInstalled(item.pack)}
        {@const when = whenKey(item.pack.kind, item.fetch, installed)}
        {@const now = item.fetch === 'now'}
        <li
          class={['row', { now, disabled: blocked && now && !installed }]}
          data-pack={item.pack.id}
          data-fetch={item.fetch}
        >
          <span class="icon"><Icon size={16} strokeWidth={1.75} aria-hidden="true" /></span>
          <span class="text">
            <span class="name">{packs.title(item.pack)}</span>
            <span class="when">{i18n.t(`onboarding.summary.when.${when}`)}</span>
          </span>
          <span class="size">
            {#if installed && now}
              <CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" />
            {:else if now}
              {i18n.bytes(item.kib)}
            {:else}
              <span class="later">{i18n.t('onboarding.summary.later')}</span>
            {/if}
          </span>
        </li>
      {/each}
    </ul>
    <div class="total" data-total-kib={set.nowKib}>
      <span class="total-label">
        {set.nowKib > 0 ? i18n.t('onboarding.summary.total') : i18n.t('onboarding.summary.nothing')}
      </span>
      {#if set.nowKib > 0}
        <span class="total-size"
          >{exactTotal(set.nowKib, i18n.intlLocale, (kib) => i18n.bytes(kib), i18n.sizeUnitDisplay)}</span
        >
      {/if}
    </div>
  </div>

  <div class="offline-row">
    <Switch
      checked={workOffline}
      onCheckedChange={(on) => flow.setWorkOffline(on)}
      label={i18n.t('onboarding.summary.workOffline')}
      description={i18n.t('onboarding.summary.workOfflineBody')}
      class="ob-work-offline"
    />
    {#if !workOffline && !app.online}
      <p class="offline-note" role="status">
        <WifiOff size={14} strokeWidth={1.75} aria-hidden="true" />
        <span>{i18n.t('onboarding.summary.offline')}</span>
      </p>
    {/if}
  </div>
</div>

<style>
  .summary {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .set {
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-1);
    overflow: hidden;
  }

  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-block-size: 42px;
    padding-block: 5px;
    padding-inline: var(--space-4);
  }

  .row + .row {
    border-block-start: 1px solid var(--border);
  }

  .icon {
    display: grid;
    flex: none;
    place-items: center;
    inline-size: 28px;
    block-size: 28px;
    border-radius: var(--radius-sm);
    background-color: var(--surface-sunken);
    color: var(--text-muted);
  }

  .now .icon {
    background-color: var(--accent-soft);
    color: var(--accent-text);
  }

  .text {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-inline-size: 0;
  }

  .name {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .when {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .size {
    display: inline-flex;
    flex: none;
    align-items: center;
    color: var(--text);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }

  .now .size :global(svg) {
    color: var(--success-text);
  }

  .later {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .row.disabled .name,
  .row.disabled .when,
  .row.disabled .size {
    color: var(--text-faint);
  }

  .row.disabled .icon {
    background-color: var(--surface-sunken);
    color: var(--text-faint);
  }

  .total {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    padding-block: var(--space-2);
    padding-inline: var(--space-4);
    border-block-start: 1px solid var(--border-strong);
    background-color: color-mix(in srgb, var(--accent) 5%, var(--surface-raised));
  }

  .total-label {
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-title);
  }

  .total-size {
    color: var(--accent-text);
    font-size: var(--text-lg);
    font-weight: var(--weight-title);
    font-variant-numeric: tabular-nums;
  }

  .blocked .total {
    background-color: var(--surface-raised);
  }

  .blocked .total-label,
  .blocked .total-size {
    color: var(--text-faint);
  }

  .offline-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-inline: var(--space-1);
  }

  .offline-note {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    color: var(--warning-text);
    font-size: var(--text-xs);
  }
</style>
