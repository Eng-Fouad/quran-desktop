<!--
  Select (§9.5): pick one value from a list (bits-ui Select). The trigger is 32 px (sm 28), radius-sm, with a 1 px
  `--border-input`, the selected label (or a muted placeholder) and a chevron at the inline end. The listbox opens
  below it at least as wide as the trigger, with grouped rows, hints and a check on the selected row.

  Keyboard: Enter/Space/↓ opens, ↑/↓ move, Home/End, typeahead jumps to a label (also while closed), Enter selects,
  Escape closes. The listbox follows the UI direction (§9.5) and counts as a floating layer while open (§7.4).
  `searchable` turns it into a `Combobox` (type to filter; long lists such as reciters or translations).
-->
<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import { Select } from 'bits-ui'
  import Combobox from './Combobox.svelte'
  import { floatingZ, resolveDir, trackFloating } from './floating.svelte'
  import ListboxItems from './ListboxItems.svelte'
  import type { Dir, SelectItem } from './types'

  interface Props {
    items: readonly SelectItem[]
    value?: string
    onValueChange?: (value: string) => void
    open?: boolean
    placeholder?: string
    /** Accessible name when no visible `<label for>` / `Field` names the trigger. */
    label?: string
    id?: string
    'aria-labelledby'?: string
    'aria-describedby'?: string
    invalid?: boolean
    required?: boolean
    disabled?: boolean
    /** Form field name (renders a hidden input). */
    name?: string
    size?: 'sm' | 'md'
    fullWidth?: boolean
    /** Type to filter (renders a Combobox). */
    searchable?: boolean
    /** Combobox only: shown when nothing matches the query. */
    emptyText?: string
    dir?: Dir
    class?: string
  }

  let {
    items,
    value = $bindable(''),
    onValueChange,
    open = $bindable(false),
    placeholder = '',
    label,
    id,
    'aria-labelledby': labelledBy,
    'aria-describedby': describedBy,
    invalid = false,
    required = false,
    disabled = false,
    name,
    size = 'md',
    fullWidth = false,
    searchable = false,
    emptyText = '',
    dir: dirProp,
    class: className,
  }: Props = $props()

  const dir = $derived(resolveDir(dirProp))
  const selected = $derived(items.find((item) => item.value === value))
  const typeahead = $derived(
    items.map(({ value: v, label: l, disabled: d }) => ({ value: v, label: l, disabled: d })),
  )

  trackFloating(() => open && !searchable)
  const zIndex = floatingZ('menu')

  function setValue(next: string): void {
    if (next === value) return
    value = next
    onValueChange?.(next)
  }
</script>

{#if searchable}
  <Combobox
    {items}
    bind:value
    bind:open
    {onValueChange}
    {placeholder}
    {label}
    {id}
    aria-labelledby={labelledBy}
    aria-describedby={describedBy}
    {invalid}
    {required}
    {disabled}
    {name}
    {size}
    {fullWidth}
    {emptyText}
    {dir}
    class={className}
  />
{:else}
  <Select.Root
    type="single"
    bind:value={() => value, setValue}
    bind:open
    items={typeahead}
    {disabled}
    {required}
    {name}
    allowDeselect={false}
    loop
  >
    <Select.Trigger {id}>
      {#snippet child({ props })}
        {@const Icon = selected?.icon}
        <button
          {...props}
          class={['trigger', `s-${size}`, { full: fullWidth, invalid }, className]}
          role="combobox"
          aria-label={label}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          {dir}
        >
          {#if Icon}<Icon class="lead" size={16} strokeWidth={1.75} aria-hidden="true" />{/if}
          <span class={['value', { placeholder: selected === undefined }]}
            >{selected?.label ?? placeholder}</span
          >
          <ChevronDown class="chevron" size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      {/snippet}
    </Select.Trigger>
    <Select.Portal>
      <Select.Content align="start" sideOffset={4} collisionPadding={8} {dir}>
        {#snippet child({ props, wrapperProps })}
          <div {...wrapperProps}>
            <div {...props} class="qd-listbox" style:z-index={zIndex()} {dir}>
              <Select.Viewport>
                {#snippet child({ props: viewportProps })}
                  <div {...viewportProps}>
                    <ListboxItems {items} />
                  </div>
                {/snippet}
              </Select.Viewport>
            </div>
          </div>
        {/snippet}
      </Select.Content>
    </Select.Portal>
  </Select.Root>
{/if}

<style>
  .trigger {
    --_h: 32px;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-inline-size: 120px;
    max-inline-size: 100%;
    block-size: var(--_h);
    padding-block: 0;
    padding-inline: var(--space-3) var(--space-2);
    border: 1px solid var(--border-input);
    border-radius: var(--radius-sm);
    background-color: var(--surface-raised);
    color: var(--text);
    font-family: inherit;
    font-size: var(--text-md);
    text-align: start;
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      border-color var(--dur-fast) var(--ease-standard);
  }

  .s-sm {
    --_h: 28px;
    font-size: var(--text-sm);
  }

  .full {
    display: flex;
    inline-size: 100%;
  }

  .trigger:hover:not(:disabled) {
    background-color: color-mix(in srgb, var(--surface-raised) 94%, var(--text));
  }

  .trigger[data-state='open'] {
    border-color: var(--accent);
  }

  .trigger:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .invalid {
    border-color: var(--danger);
  }

  .trigger :global(.lead) {
    flex: none;
    color: var(--text-muted);
  }

  .value {
    flex: 1 1 auto;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .placeholder {
    color: var(--text-muted);
  }

  .trigger :global(.chevron) {
    flex: none;
    color: var(--text-muted);
    transition: rotate var(--dur-quick) var(--ease-standard);
  }

  .trigger[data-state='open'] :global(.chevron) {
    rotate: 180deg;
  }
</style>
