<!--
  MenuItems (internal to Menu and ContextMenu): renders `MenuEntry` rows with the bits-ui menu parts that
  DropdownMenu and ContextMenu share: commands, checkbox and radio items, groups with headings, separators and
  submenus (recursively). Rows are 30 px, radius-xs, with a 16 px icon slot (icon, colour swatch, check or radio dot),
  the label, and a shortcut hint at the inline end. Typeahead matches the label (`textValue`), never the hint.

  It also owns the shared `.qd-menu` surface style used by the three menu containers (menu, context menu, submenu).
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import { DropdownMenu } from 'bits-ui'
  import { floatingZ, resolveDir } from './floating.svelte'
  import MenuItems from './MenuItems.svelte'
  import type { Dir, MenuEntry } from './types'

  interface Props {
    items: readonly MenuEntry[]
    dir?: Dir
  }

  let { items, dir: dirProp }: Props = $props()

  const dir = $derived(resolveDir(dirProp))
  const zIndex = floatingZ('menu')

  /** Reserve the icon slot when any row at this level shows something in it, so labels align. */
  const slot = $derived(
    items.some(
      (e) =>
        e.type === 'checkbox' ||
        e.type === 'radio' ||
        ((e.type === undefined || e.type === 'item' || e.type === 'submenu') &&
          (e.icon !== undefined || e.swatch !== undefined)),
    ),
  )

  function key(entry: MenuEntry, index: number): string {
    return entry.type === 'separator' ? `separator-${entry.id ?? index}` : entry.id
  }
</script>

{#snippet hint(kbd: string | undefined)}
  {#if kbd}<kbd class="hint"><bdi dir="ltr">{kbd}</bdi></kbd>{/if}
{/snippet}

{#snippet swatchDot(color: string)}
  <span class="swatch" style:background-color={color}></span>
{/snippet}

{#each items as entry, index (key(entry, index))}
  {#if entry.type === 'separator'}
    <DropdownMenu.Separator>
      {#snippet child({ props })}
        <div {...props} class="separator"></div>
      {/snippet}
    </DropdownMenu.Separator>
  {:else if entry.type === 'group'}
    <DropdownMenu.Group>
      {#snippet child({ props })}
        <div {...props} class="group">
          {#if entry.label}
            <DropdownMenu.GroupHeading>
              {#snippet child({ props: headingProps })}
                <div {...headingProps} class="heading">{entry.label}</div>
              {/snippet}
            </DropdownMenu.GroupHeading>
          {/if}
          <MenuItems items={entry.items} {dir} />
        </div>
      {/snippet}
    </DropdownMenu.Group>
  {:else if entry.type === 'radio'}
    <DropdownMenu.RadioGroup value={entry.value} onValueChange={entry.onValueChange}>
      {#snippet child({ props })}
        <div {...props} class="group" aria-label={entry.label}>
          {#if entry.label}
            <div class="heading" aria-hidden="true">{entry.label}</div>
          {/if}
          {#each entry.options as option (option.value)}
            <DropdownMenu.RadioItem
              value={option.value}
              disabled={option.disabled}
              textValue={option.label}
              closeOnSelect={!entry.keepOpen}
            >
              {#snippet child({ props: itemProps, checked })}
                <div {...itemProps} class={['item', { slot }]}>
                  <span class="lead" aria-hidden="true">
                    {#if option.swatch}
                      {@render swatchDot(option.swatch)}
                    {:else if checked}
                      <span class="dot"></span>
                    {/if}
                  </span>
                  <span class="label">{option.label}</span>
                  {#if option.swatch && checked}<Check
                      class="check"
                      size={16}
                      strokeWidth={2}
                      aria-hidden="true"
                    />{/if}
                  {@render hint(option.kbd)}
                </div>
              {/snippet}
            </DropdownMenu.RadioItem>
          {/each}
        </div>
      {/snippet}
    </DropdownMenu.RadioGroup>
  {:else if entry.type === 'checkbox'}
    <DropdownMenu.CheckboxItem
      checked={entry.checked}
      onCheckedChange={entry.onCheckedChange}
      disabled={entry.disabled}
      textValue={entry.label}
      closeOnSelect={!entry.keepOpen}
    >
      {#snippet child({ props, checked })}
        <div {...props} class={['item', { slot }]}>
          <span class="lead" aria-hidden="true">
            {#if checked}<Check size={16} strokeWidth={2} />{/if}
          </span>
          <span class="label">{entry.label}</span>
          {@render hint(entry.kbd)}
        </div>
      {/snippet}
    </DropdownMenu.CheckboxItem>
  {:else if entry.type === 'submenu'}
    {@const Icon = entry.icon}
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger disabled={entry.disabled} textValue={entry.label}>
        {#snippet child({ props })}
          <div {...props} class={['item', 'sub-trigger', { slot }]}>
            <span class="lead" aria-hidden="true">
              {#if entry.swatch}
                {@render swatchDot(entry.swatch)}
              {:else if Icon}
                <Icon size={16} strokeWidth={1.75} />
              {/if}
            </span>
            <span class="label">{entry.label}</span>
            <ChevronRight class="chevron icon-dir" size={16} strokeWidth={1.75} aria-hidden="true" />
          </div>
        {/snippet}
      </DropdownMenu.SubTrigger>
      <DropdownMenu.SubContent sideOffset={2} alignOffset={-5} collisionPadding={8} loop>
        {#snippet child({ props, wrapperProps })}
          <div {...wrapperProps}>
            <div {...props} class="qd-menu" style:z-index={zIndex()} {dir}>
              <MenuItems items={entry.items} {dir} />
            </div>
          </div>
        {/snippet}
      </DropdownMenu.SubContent>
    </DropdownMenu.Sub>
  {:else}
    {@const Icon = entry.icon}
    <DropdownMenu.Item
      onSelect={entry.onSelect}
      disabled={entry.disabled}
      textValue={entry.label}
      closeOnSelect={!entry.keepOpen}
    >
      {#snippet child({ props })}
        <div {...props} class={['item', { slot, danger: entry.danger }]} data-menu-id={entry.id}>
          <span class="lead" aria-hidden="true">
            {#if entry.swatch}
              {@render swatchDot(entry.swatch)}
            {:else if Icon}
              <Icon size={16} strokeWidth={1.75} />
            {/if}
          </span>
          <span class="label">{entry.label}</span>
          {@render hint(entry.kbd)}
        </div>
      {/snippet}
    </DropdownMenu.Item>
  {/if}
{/each}

<style>
  /* The menu surface, shared by Menu, ContextMenu and submenus (all render MenuItems). */
  :global(.qd-menu) {
    min-inline-size: 184px;
    max-inline-size: min(360px, calc(100vw - 16px));
    max-block-size: var(--bits-floating-available-height, 70vh);
    overflow: auto;
    padding: var(--space-1);
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-2);
    color: var(--text);
    font-size: var(--text-sm);
    line-height: 1.3;
    z-index: var(--z-menu);
    outline: none;
    overscroll-behavior: contain;
    transform-origin: var(--bits-floating-transform-origin);
    transition:
      opacity var(--dur-fast) var(--ease-decelerate),
      scale var(--dur-fast) var(--ease-decelerate);
  }

  :global(.qd-menu[data-starting-style]),
  :global(.qd-menu[data-ending-style]) {
    opacity: 0;
    scale: 0.97;
  }

  @media (forced-colors: active) {
    :global(.qd-menu) {
      border: 1px solid CanvasText;
    }
  }

  .item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-block-size: 30px;
    padding-block: var(--space-1);
    padding-inline: var(--space-2);
    border-radius: var(--radius-xs);
    color: var(--text);
    cursor: default;
    outline: none;
    user-select: none;
  }

  .item[data-highlighted],
  .sub-trigger[data-state='open'] {
    background-color: var(--surface-hover);
  }

  .item[data-disabled] {
    color: var(--text-faint);
  }

  .danger {
    color: var(--danger-text);
  }

  .danger[data-highlighted] {
    background-color: var(--danger-soft);
  }

  .lead {
    display: none;
    flex: none;
    place-items: center;
    inline-size: 16px;
    block-size: 16px;
    color: var(--text-muted);
  }

  .slot .lead {
    display: grid;
  }

  .item[data-highlighted] .lead {
    color: var(--text);
  }

  .danger .lead {
    color: inherit;
  }

  .swatch {
    inline-size: 12px;
    block-size: 12px;
    border-radius: var(--radius-full);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 18%, transparent);
  }

  .dot {
    inline-size: 6px;
    block-size: 6px;
    border-radius: var(--radius-full);
    background-color: var(--accent);
  }

  .label {
    flex: 1 1 auto;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item :global(.check) {
    flex: none;
    color: var(--accent-text);
  }

  .hint {
    flex: none;
    margin-inline-start: var(--space-4);
    color: var(--text-muted);
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .item :global(.chevron) {
    flex: none;
    margin-inline-start: var(--space-3);
    color: var(--text-muted);
  }

  .separator {
    block-size: 1px;
    margin-block: var(--space-1);
    margin-inline: calc(-1 * var(--space-1));
    background-color: var(--border);
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
</style>
