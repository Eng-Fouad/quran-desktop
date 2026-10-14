<!--
  ListboxItems (internal to Select and Combobox): the option rows of a listbox, grouped under headings when items
  carry a `group`. 30 px rows like menu rows: a check slot, the label, an optional muted hint at the inline end (an
  Arabic name gets its own language and direction). The selected row shows the check; the highlighted row uses
  `--surface-hover`. Owns the shared `.qd-listbox` surface style.
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import { Select } from 'bits-ui'
  import { groupItems } from './filter'
  import type { SelectItem } from './types'

  interface Props {
    items: readonly SelectItem[]
  }

  let { items }: Props = $props()

  const groups = $derived(groupItems(items))
  const icons = $derived(items.some((item) => item.icon !== undefined))
</script>

{#snippet option(item: SelectItem)}
  {@const Icon = item.icon}
  <Select.Item value={item.value} label={item.label} disabled={item.disabled}>
    {#snippet child({ props, selected })}
      <div {...props} class="option">
        <span class="check" aria-hidden="true">
          {#if selected}<Check size={16} strokeWidth={2} />{/if}
        </span>
        {#if icons}
          <span class="icon" aria-hidden="true">
            {#if Icon}<Icon size={16} strokeWidth={1.75} />{/if}
          </span>
        {/if}
        <span class="label">{item.label}</span>
        {#if item.hint}
          <span class="hint" lang={item.hintLang} dir={item.hintLang ? 'auto' : undefined}>{item.hint}</span>
        {/if}
      </div>
    {/snippet}
  </Select.Item>
{/snippet}

{#each groups as group (group.heading)}
  {#if group.heading === ''}
    {#each group.items as item (item.value)}
      {@render option(item)}
    {/each}
  {:else}
    <Select.Group>
      {#snippet child({ props })}
        <div {...props} class="group">
          <Select.GroupHeading>
            {#snippet child({ props: headingProps })}
              <div {...headingProps} class="heading">{group.heading}</div>
            {/snippet}
          </Select.GroupHeading>
          {#each group.items as item (item.value)}
            {@render option(item)}
          {/each}
        </div>
      {/snippet}
    </Select.Group>
  {/if}
{/each}

<style>
  :global(.qd-listbox) {
    display: flex;
    flex-direction: column;
    min-inline-size: max(180px, var(--bits-floating-anchor-width, 0px));
    max-inline-size: min(420px, calc(100vw - 16px));
    max-block-size: min(340px, var(--bits-floating-available-height, 340px));
    padding: var(--space-1);
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-2);
    color: var(--text);
    font-size: var(--text-sm);
    line-height: 1.3;
    z-index: var(--z-menu);
    outline: none;
    transform-origin: var(--bits-floating-transform-origin);
    transition:
      opacity var(--dur-fast) var(--ease-decelerate),
      scale var(--dur-fast) var(--ease-decelerate);
  }

  :global(.qd-listbox[data-starting-style]),
  :global(.qd-listbox[data-ending-style]) {
    opacity: 0;
    scale: 0.97;
  }

  @media (forced-colors: active) {
    :global(.qd-listbox) {
      border: 1px solid CanvasText;
    }
  }

  .option {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-block-size: 30px;
    padding-block: var(--space-1);
    padding-inline: var(--space-2);
    border-radius: var(--radius-xs);
    cursor: default;
    outline: none;
    user-select: none;
  }

  .option[data-highlighted] {
    background-color: var(--surface-hover);
  }

  .option[data-disabled] {
    color: var(--text-faint);
  }

  .check {
    display: grid;
    flex: none;
    place-items: center;
    inline-size: 16px;
    color: var(--accent-text);
  }

  .icon {
    display: grid;
    flex: none;
    place-items: center;
    inline-size: 16px;
    color: var(--text-muted);
  }

  .label {
    flex: 1 1 auto;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hint {
    flex: none;
    max-inline-size: 45%;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hint:lang(ar) {
    font-family: var(--font-naskh);
    font-size: var(--text-sm);
  }

  .heading {
    padding-block: var(--space-2) var(--space-1);
    padding-inline: var(--space-2);
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: var(--weight-title);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .heading:lang(ar) {
    text-transform: none;
  }

  .group + .group,
  .option + .group {
    margin-block-start: var(--space-1);
    padding-block-start: var(--space-1);
    border-block-start: 1px solid var(--border);
  }
</style>
