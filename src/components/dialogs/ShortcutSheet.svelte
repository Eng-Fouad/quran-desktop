<!--
  ShortcutSheet (§7.4, §10.1): the `?` overlay listing every registered shortcut. Owner: WP7c. Rendered by
  `OverlayHost` while `shortcuts` is the top overlay; its Dialog's `open` follows its own overlay entry, so closing
  animates out while the host keeps it mounted.

  A filter field (focused on open) narrows the table by action, group or key; Escape first clears it, then closes.
  Takes no props: it reads stores (§7.9).
-->
<script lang="ts">
  import { Dialog, Kbd, SearchInput } from '$components/ui'
  import { i18n, shortcuts, ui } from '$lib/stores'
  import { splitAround } from '$lib/util/format'
  import { overlayOpen } from '../shell/overlay'
  import ShortcutTable from './ShortcutTable.svelte'

  const isOpen = overlayOpen('shortcuts')
  let query = $state('')

  const sheetKey = $derived.by(() => {
    const def = shortcuts.defs.find((d) => d.id === 'app.shortcutSheet')
    return def ? shortcuts.format(def) : '?'
  })
  const footerParts = $derived(splitAround(i18n.t('shell.shortcutSheet.footer'), 'key'))
</script>

<Dialog
  open={isOpen()}
  onOpenChange={(open) => {
    if (!open) ui.close('shortcuts')
  }}
  title={i18n.t('shortcuts.app.shortcutSheet')}
  description={i18n.t('shell.shortcutSheet.description')}
  width={880}
  class="shortcut-sheet"
>
  <div class="filter">
    <SearchInput
      bind:value={query}
      placeholder={i18n.t('shell.shortcutSheet.filter')}
      aria-label={i18n.t('shell.shortcutSheet.filter')}
      data-autofocus
    />
  </div>
  <ShortcutTable {query} />

  {#snippet footer()}
    <p class="hint">
      {#if footerParts}
        {footerParts[0]}<Kbd chord={sheetKey} size="sm" />{footerParts[1]}
      {:else}
        {i18n.t('shell.shortcutSheet.footer', { key: sheetKey })}
      {/if}
    </p>
  {/snippet}
</Dialog>

<style>
  .filter {
    position: sticky;
    inset-block-start: calc(-1 * var(--space-4));
    z-index: 1;
    margin-block: calc(-1 * var(--space-4)) var(--space-4);
    padding-block: var(--space-4) var(--space-2);
    background-color: var(--surface-raised);
  }

  .hint {
    flex: 1 1 auto;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .hint :global(.kbd) {
    margin-inline: var(--space-1);
  }
</style>
