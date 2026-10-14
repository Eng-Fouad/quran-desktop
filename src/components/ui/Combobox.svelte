<!--
  Combobox: a select you can type into to filter (bits-ui Combobox), for long lists (reciters, translations,
  tafsir). Same look as `TextInput` (`--surface-sunken` fill, 1 px `--border-input`, `dir="auto"`) with a chevron
  toggle at the inline end. The list filters as you type (case-, accent- and harakat-insensitive, Arabic letter
  variants folded); `emptyText` shows when nothing matches. While closed the input shows the selected label; on
  opening the whole list shows until you type.
-->
<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import { Combobox, mergeProps } from 'bits-ui'
  import { filterItems } from './filter'
  import { floatingZ, resolveDir, trackFloating } from './floating.svelte'
  import ListboxItems from './ListboxItems.svelte'
  import type { Dir, SelectItem } from './types'

  interface Props {
    items: readonly SelectItem[]
    value?: string
    onValueChange?: (value: string) => void
    open?: boolean
    placeholder?: string
    label?: string
    id?: string
    'aria-labelledby'?: string
    'aria-describedby'?: string
    invalid?: boolean
    required?: boolean
    disabled?: boolean
    name?: string
    size?: 'sm' | 'md'
    fullWidth?: boolean
    /** Shown in the list when nothing matches the query. */
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
    emptyText = '',
    dir: dirProp,
    class: className,
  }: Props = $props()

  const dir = $derived(resolveDir(dirProp))
  const selectedLabel = $derived(items.find((item) => item.value === value)?.label ?? '')
  /** What the user typed since the list opened (`null`: nothing yet, so every item shows). */
  let query = $state<string | null>(null)
  const shown = $derived(query === null ? [...items] : filterItems(items, query))
  /** The input text: the query while typing, otherwise the selected label. */
  const inputText = $derived(open && query !== null ? query : selectedLabel)

  trackFloating(
    () => open,
    () => (open = false),
  )
  const zIndex = floatingZ('menu')

  $effect(() => {
    if (!open) query = null
  })

  function setValue(next: string): void {
    if (next === value) return
    value = next
    onValueChange?.(next)
  }

  function oninput(e: Event & { currentTarget: HTMLInputElement }): void {
    query = e.currentTarget.value
  }

  function onfocus(e: FocusEvent & { currentTarget: HTMLInputElement }): void {
    e.currentTarget.select()
  }
</script>

<Combobox.Root
  type="single"
  bind:value={() => value, setValue}
  bind:open
  inputValue={inputText}
  {disabled}
  {required}
  {name}
  allowDeselect={false}
  loop
>
  <div class={['field', `s-${size}`, { full: fullWidth, invalid, disabled }, className]} {dir}>
    <Combobox.Input {id}>
      {#snippet child({ props })}
        <input
          {...mergeProps(props, { oninput, onfocus })}
          class="input"
          {placeholder}
          aria-label={label}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          dir="auto"
          autocomplete="off"
          spellcheck="false"
        />
      {/snippet}
    </Combobox.Input>
    <Combobox.Trigger>
      {#snippet child({ props })}
        <button {...props} class="toggle" tabindex={-1} aria-hidden="true">
          <ChevronDown size={16} strokeWidth={1.75} />
        </button>
      {/snippet}
    </Combobox.Trigger>
  </div>
  <Combobox.Portal>
    <Combobox.Content align="start" sideOffset={4} collisionPadding={8} {dir}>
      {#snippet child({ props, wrapperProps })}
        <div {...wrapperProps}>
          <div {...props} class="qd-listbox" style:z-index={zIndex()} {dir}>
            <Combobox.Viewport>
              {#snippet child({ props: viewportProps })}
                <div {...viewportProps}>
                  <ListboxItems items={shown} />
                </div>
              {/snippet}
            </Combobox.Viewport>
            {#if shown.length === 0 && emptyText}
              <p class="empty" role="status">{emptyText}</p>
            {/if}
          </div>
        </div>
      {/snippet}
    </Combobox.Content>
  </Combobox.Portal>
</Combobox.Root>

<style>
  .field {
    --_h: 32px;
    position: relative;
    display: inline-flex;
    align-items: center;
    min-inline-size: 160px;
    max-inline-size: 100%;
    block-size: var(--_h);
    border: 1px solid var(--border-input);
    border-radius: var(--radius-sm);
    background-color: var(--surface-sunken);
    transition: border-color var(--dur-fast) var(--ease-standard);
  }

  .s-sm {
    --_h: 28px;
  }

  .full {
    display: flex;
    inline-size: 100%;
  }

  .field:hover:not(.disabled) {
    border-color: var(--text-muted);
  }

  .field:focus-within {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .invalid {
    border-color: var(--danger);
  }

  .disabled {
    opacity: 0.5;
  }

  .input {
    flex: 1 1 auto;
    min-inline-size: 0;
    /* Stretched by the flex row, not `block-size: 100%`: Blink resets a fixed- or percent-height input's line box to
       `normal`, which for IBM Plex Sans Arabic is shorter than its dots (the field drew «ابحث فى» for «ابحث في»). */
    align-self: stretch;
    padding-block: 0;
    padding-inline: var(--space-3) var(--space-1);
    border: 0;
    background: none;
    color: var(--text);
    font-family: inherit;
    font-size: var(--text-md);
    text-align: start;
    outline: none;
    unicode-bidi: plaintext;
  }

  .s-sm .input {
    font-size: var(--text-sm);
  }

  .toggle {
    display: grid;
    flex: none;
    place-items: center;
    inline-size: 28px;
    block-size: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
  }

  .empty {
    padding-block: var(--space-3);
    padding-inline: var(--space-3);
    color: var(--text-muted);
    font-size: var(--text-sm);
    text-align: center;
  }
</style>
