<!--
  SearchInput: a `TextInput` (`type="search"`, `dir="auto"`) with a search icon at the inline start
  (a spinner while `loading`), a clear button at the inline end once there is text, and an optional shortcut hint
  (`shortcut`, e.g. Ctrl+F) while it is empty. Escape first clears the text (and is consumed); on an empty field it
  propagates (closing the panel or palette). Enter calls `onSubmit`. Other attributes (e.g.
  `data-qd-focus="search"`, the `Mod+F` target) go to the `<input>`.
-->
<script lang="ts">
  import Search from '@lucide/svelte/icons/search'
  import X from '@lucide/svelte/icons/x'
  import type { HTMLInputAttributes } from 'svelte/elements'
  import { i18n } from '$lib/stores/i18n.svelte'
  import Kbd from './Kbd.svelte'
  import Spinner from './Spinner.svelte'
  import TextInput from './TextInput.svelte'
  import type { ControlSize } from './types'

  interface Props extends Omit<HTMLInputAttributes, 'size' | 'value' | 'type'> {
    value?: string
    size?: ControlSize
    loading?: boolean
    /** Shortcut label (`shortcuts.format(def)`) shown while the field is empty. */
    shortcut?: string
    onSubmit?: (value: string) => void
    /** Called after the clear button or Escape emptied the field. */
    onClear?: () => void
    fullWidth?: boolean
    ref?: HTMLInputElement | null
  }

  let {
    value = $bindable(''),
    size = 'md',
    loading = false,
    shortcut,
    onSubmit,
    onClear,
    fullWidth = true,
    ref = $bindable(null),
    placeholder,
    onkeydown,
    ...rest
  }: Props = $props()

  const iconSize = $derived(size === 'lg' ? 20 : 16)

  function clear(): void {
    value = ''
    onClear?.()
    ref?.focus()
  }

  function handleKeydown(e: KeyboardEvent & { currentTarget: EventTarget & HTMLInputElement }): void {
    onkeydown?.(e)
    if (e.defaultPrevented || e.isComposing) return
    if (e.key === 'Escape' && value !== '') {
      e.preventDefault()
      e.stopPropagation()
      clear()
    } else if (e.key === 'Enter') {
      onSubmit?.(value)
    }
  }
</script>

<TextInput
  {...rest}
  bind:value
  bind:ref
  {size}
  {fullWidth}
  type="search"
  placeholder={placeholder ?? i18n.t('common.search')}
  autocomplete="off"
  spellcheck="false"
  onkeydown={handleKeydown}
>
  {#snippet leading()}
    {#if loading}
      <Spinner size={iconSize} />
    {:else}
      <Search size={iconSize} strokeWidth={1.75} aria-hidden="true" />
    {/if}
  {/snippet}
  {#snippet trailing()}
    {#if value !== ''}
      <button type="button" class="clear" aria-label={i18n.t('common.clear')} onclick={clear}>
        <X size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    {:else if shortcut}
      <span class="hint"><Kbd chord={shortcut} size="sm" /></span>
    {/if}
  {/snippet}
</TextInput>

<style>
  .clear {
    display: grid;
    place-items: center;
    inline-size: 22px;
    block-size: 22px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-xs);
    background: none;
    color: var(--text-muted);
    cursor: pointer;
  }

  .clear:hover {
    background-color: var(--surface-hover);
    color: var(--text);
  }

  .hint {
    display: inline-flex;
    padding-inline-end: var(--space-1);
    pointer-events: none;
  }
</style>
