<!--
  OfflineBadge (§7.5, BRIEF "network use is explicit and visible"): a title-bar pill while the network is unreachable
  (`app.online`, from `NetworkChanged`) or network use is turned off (`settings.networkAllowed`). Owner: WP7c.
  The tooltip says what still works; a click opens Settings, where network use is switched. Renders nothing while
  online. Takes no props: it reads stores (§7.9).
-->
<script lang="ts">
  import WifiOff from '@lucide/svelte/icons/wifi-off'
  import { Tooltip } from '$components/ui'
  import { app, i18n, settings, ui } from '$lib/stores'

  const disallowed = $derived(!settings.value.networkAllowed)
  const offline = $derived(disallowed || !app.online)
  const label = $derived(disallowed ? i18n.t('shell.offline.networkOff') : i18n.t('shell.offline.badge'))
  const explanation = $derived(
    disallowed ? i18n.t('shell.offline.disallowed') : i18n.t('shell.offline.unreachable'),
  )
</script>

{#if offline}
  <Tooltip content={explanation} side="bottom">
    {#snippet children({ props })}
      <button
        {...props}
        type="button"
        class="badge"
        data-reason={disallowed ? 'disallowed' : 'unreachable'}
        aria-label="{label}. {explanation}"
        onclick={() => ui.setView('settings')}
      >
        <WifiOff size={14} strokeWidth={2} aria-hidden="true" />
        <span>{label}</span>
      </button>
    {/snippet}
  </Tooltip>
{/if}

<style>
  .badge {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: var(--space-1);
    block-size: 24px;
    padding-inline: var(--space-2) 10px;
    border: 1px solid color-mix(in srgb, var(--warning) 32%, transparent);
    border-radius: var(--radius-full);
    background-color: var(--warning-soft);
    color: var(--warning-text);
    font-size: var(--text-xs);
    font-weight: var(--weight-label);
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease-standard);
  }

  .badge:hover {
    background-color: color-mix(in srgb, var(--warning) 20%, transparent);
  }

  @media (forced-colors: active) {
    .badge {
      border-color: CanvasText;
    }
  }
</style>
