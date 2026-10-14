<!--
  DockError: the dock's error state, in the bar (`row`) or the side card (`card`).

  - Offline and the surah is not on disk: "Offline — Al-Baqarah isn't downloaded for Mishary Alafasy" with
    [Download when online]: a request that waits for the network (`packs.installWhenOnline`, shown in Downloads as
    "Waits for a connection"), then pins the surah; it never fails for being offline. The error goes by itself once
    the app is online with network use allowed (`player`), when Play can stream the surah again.
  - No audio output: "No audio output — reconnecting…" with a spinner; the engine retries every 2 s by itself.
  - Anything else: "Couldn't play: <the localised error>" with [Retry].
  Each can be dismissed. Announced politely (`role="status"`).
-->
<script lang="ts">
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
  import WifiOff from '@lucide/svelte/icons/wifi-off'
  import X from '@lucide/svelte/icons/x'
  import { Button, IconButton, Spinner } from '$components/ui'
  import { i18n, packs, player, quran, ui } from '$lib/stores'
  import type { PlayerError } from '$lib/stores/player.svelte'
  import { reciterName } from './dock.svelte'

  interface Props {
    error: PlayerError
    layout?: 'row' | 'card'
  }

  let { error, layout = 'row' }: Props = $props()

  const surahName = $derived(error.surah ? quran.surahName(error.surah) : '')
  const reciter = $derived(player.reciters.find((r) => r.id === error.reciterId) ?? player.reciter)
  const message = $derived.by(() => {
    switch (error.kind) {
      case 'offline':
        return surahName
          ? i18n.t('player.errors.offline', { surah: surahName, reciter: reciterName(reciter) })
          : i18n.t('player.errors.offlineShort')
      case 'output':
        return i18n.t('player.errors.noOutput')
      case 'other':
        return i18n.t('player.errors.failed', { reason: i18n.t(`errors.${error.error.kind}`) })
    }
  })

  function downloadWhenOnline(): void {
    const surah = error.surah
    const reciterId = error.reciterId
    if (!surah || reciterId === null) return
    const name = surahName
    packs
      .installWhenOnline(`audio.qdc.${reciterId}`, { type: 'items', data: { items: [surah] } })
      .then((how) =>
        ui.toast({
          message: i18n.t(how === 'waiting' ? 'player.errors.queued' : 'player.more.downloading', {
            surah: name,
          }),
        }),
      )
      .catch(ui.toastError)
    player.dismissError()
  }
</script>

<div class={['dock-error', `l-${layout}`, `k-${error.kind}`]} role="status">
  <span class="icon" aria-hidden="true">
    {#if error.kind === 'output'}
      <Spinner size={18} />
    {:else if error.kind === 'offline'}
      <WifiOff size={18} strokeWidth={1.75} />
    {:else}
      <TriangleAlert size={18} strokeWidth={1.75} />
    {/if}
  </span>
  <span class="message">{message}</span>
  <span class="buttons">
    {#if error.kind === 'offline' && error.surah}
      <Button size="sm" variant="secondary" onclick={downloadWhenOnline}>
        {i18n.t('player.errors.downloadWhenOnline')}
      </Button>
    {:else if error.kind === 'other'}
      <Button size="sm" variant="secondary" onclick={() => void player.retry()}
        >{i18n.t('common.retry')}</Button
      >
    {/if}
    <IconButton
      label={i18n.t('player.errors.dismiss')}
      icon={X}
      size="sm"
      onclick={() => player.dismissError()}
    />
  </span>
</div>

<style>
  .dock-error {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    block-size: 100%;
    padding-inline: var(--space-4) var(--space-2);
  }

  .icon {
    display: grid;
    place-items: center;
    flex: none;
    color: var(--warning);
  }

  .k-other .icon {
    color: var(--danger);
  }

  .k-output .icon {
    color: var(--text-muted);
  }

  .message {
    flex: 1 1 auto;
    min-inline-size: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    line-height: 1.35;
  }

  .buttons {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-1);
  }

  .l-card {
    flex-wrap: wrap;
    align-content: center;
    row-gap: var(--space-2);
    padding-inline: var(--space-3) var(--space-2);
  }

  .l-card .message {
    flex-basis: calc(100% - 30px);
    font-size: var(--text-xs);
  }

  .l-card .buttons {
    flex: 1 1 100%;
    justify-content: flex-end;
  }
</style>
