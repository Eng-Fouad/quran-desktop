<!--
  ChecklistPicker (WP11d): the shared body of `CollectionsPicker` and `TagPicker`. A filter field over a checkable list
  (ARIA 1.2 combobox with an always-visible multi-select listbox): typing filters (case-, accent- and harakat-
  insensitive, prefix matches first), ↑/↓ move the active option, Enter checks or unchecks it, or creates the typed
  name when nothing is called that ("Create “patience”"). Escape clears a typed filter first; with an empty field it
  goes on to the enclosing popover or dialog. With `chips`, the checked items also show as removable chips above the
  field, and Backspace in the empty field removes the last one.

  The picker is controlled: it reports every change through `onchange` with the complete id list and shows that choice
  at once, until `selected` catches up (or, when the change failed and `selected` never does, for a few seconds).
-->
<script lang="ts" module>
  /** One checkable entry. */
  export interface PickerItem {
    id: string
    name: string
    /** A colour token for the dot (collections and tags may have one). */
    color: string | null
    /** How often it is used (bookmarks in a collection, items with a tag); shown when above zero. */
    count: number
    /** `count` in words, for the tooltip and screen readers ("3 bookmarks"). */
    countLabel: string
  }
</script>

<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import Plus from '@lucide/svelte/icons/plus'
  import Search from '@lucide/svelte/icons/search'
  import X from '@lucide/svelte/icons/x'
  import { tick, untrack } from 'svelte'
  import Spinner from '$components/ui/Spinner.svelte'
  import TextInput from '$components/ui/TextInput.svelte'
  import { foldForMatch } from '$components/ui/filter'
  import { i18n } from '$lib/stores'

  interface Props {
    items: readonly PickerItem[]
    selected: readonly string[]
    onchange?: (ids: string[]) => void
    /** Creates an item by name (get-or-create); resolves its id, or `null` when it failed (already reported). */
    oncreate: (name: string) => Promise<string | null>
    /** Accessible name of the list. */
    listLabel: string
    placeholder: string
    createLabel: (name: string) => string
    creatingLabel: (name: string) => string
    emptyText: string
    emptyHint: string
    noMatch: (query: string) => string
    /** Show the checked items as removable chips (the tag picker). */
    chips?: { label: string; removeLabel: (name: string) => string } | null
    /** Longest name, in characters. */
    maxLength?: number
    /** The item being organised (`data-item` on the root, for tests and QA). */
    itemId?: string
    class?: string
  }

  let {
    items,
    selected,
    onchange,
    oncreate,
    listLabel,
    placeholder,
    createLabel,
    creatingLabel,
    emptyText,
    emptyHint,
    noMatch,
    chips = null,
    maxLength = 100,
    itemId,
    class: className,
  }: Props = $props()

  /** How long a reported choice is shown when `selected` never follows (the change failed). */
  const PENDING_MS = 4_000

  const uid = $props.id()
  const listId = `${uid}-list`
  const optionId = (i: number) => `${uid}-option-${i}`

  let query = $state('')
  let active = $state(-1)
  let creating = $state<string | null>(null)
  let pending = $state.raw<string[] | null>(null)
  let pendingTimer: ReturnType<typeof setTimeout> | undefined
  let list: HTMLUListElement | null = $state(null)

  const sameSet = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((id) => b.includes(id))

  /** The choice shown: the one reported last until `selected` reaches it. */
  const chosen = $derived(pending ?? [...selected])

  $effect(() => {
    const sel = selected
    untrack(() => {
      if (pending !== null && sameSet(pending, sel)) {
        clearTimeout(pendingTimer)
        pending = null
      }
    })
  })

  $effect(() => () => clearTimeout(pendingTimer))

  const folded = $derived(foldForMatch(query))
  const name = $derived(query.replace(/\s+/gu, ' ').trim())

  /** Matching items, names starting with the query first. */
  const matches = $derived.by(() => {
    if (folded === '') return [...items]
    const head: PickerItem[] = []
    const rest: PickerItem[] = []
    for (const item of items) {
      const f = foldForMatch(item.name)
      if (f.startsWith(folded)) head.push(item)
      else if (f.includes(folded)) rest.push(item)
    }
    return [...head, ...rest]
  })

  /** The typed name when no item is called that (case- and accent-insensitive). */
  const createName = $derived(
    name !== '' && !items.some((item) => foldForMatch(item.name) === folded) ? name : null,
  )
  const optionCount = $derived(matches.length + (createName === null ? 0 : 1))
  const chosenItems = $derived(
    chosen.map((id) => items.find((item) => item.id === id)).filter((x): x is PickerItem => x !== undefined),
  )

  /** A new query starts on its best match; a cleared one on nothing (so Enter never toggles by surprise). */
  let lastQuery = ''
  $effect(() => {
    const q = folded
    untrack(() => {
      if (q !== lastQuery) active = q === '' ? -1 : 0
      else if (active >= optionCount) active = optionCount - 1
      lastQuery = q
    })
  })

  $effect(() => {
    const i = active
    if (i < 0 || !list) return
    list.querySelector(`#${CSS.escape(optionId(i))}`)?.scrollIntoView({ block: 'nearest' })
  })

  function report(ids: string[]): void {
    pending = ids
    clearTimeout(pendingTimer)
    pendingTimer = setTimeout(() => (pending = null), PENDING_MS)
    onchange?.(ids)
  }

  function toggle(id: string): void {
    report(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id])
  }

  async function create(text: string): Promise<void> {
    if (creating !== null) return
    creating = text
    try {
      const id = await oncreate(text)
      if (id === null) return
      query = ''
      if (!chosen.includes(id)) report([...chosen, id])
    } finally {
      creating = null
    }
  }

  function activate(i: number): void {
    const item = matches[i]
    if (item) toggle(item.id)
    else if (i === matches.length && createName !== null) void create(createName)
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.isComposing) return
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (optionCount > 0) active = (active + 1) % optionCount
        break
      case 'ArrowUp':
        e.preventDefault()
        if (optionCount > 0) active = active <= 0 ? optionCount - 1 : active - 1
        break
      case 'Enter': {
        e.preventDefault()
        const target = active >= 0 ? active : folded !== '' && optionCount > 0 ? 0 : -1
        if (target < 0) break
        // A name picked from a filtered list is done with: the field is ready for the next one.
        const picked = target < matches.length
        activate(target)
        if (picked) query = ''
        break
      }
      case 'Escape':
        if (query !== '') {
          // The field's own Escape: the enclosing popover or dialog stays open.
          e.preventDefault()
          e.stopPropagation()
          query = ''
        }
        break
      case 'Backspace': {
        const last = chosenItems.at(-1)
        if (chips && query === '' && last) {
          e.preventDefault()
          toggle(last.id)
        }
        break
      }
    }
  }

  async function removeChip(id: string, input: HTMLInputElement | null): Promise<void> {
    toggle(id)
    await tick()
    input?.focus()
  }

  let field: HTMLInputElement | null = $state(null)
</script>

<div class={['picker', className]} data-item={itemId}>
  {#if chips && chosenItems.length > 0}
    <ul class="chips" aria-label={chips.label}>
      {#each chosenItems as item (item.id)}
        <li class="chip">
          {#if item.color}<span class="dot" style:background-color={item.color} aria-hidden="true"
            ></span>{/if}
          <bdi class="chip-name">{item.name}</bdi>
          <button
            type="button"
            class="chip-x"
            aria-label={chips.removeLabel(item.name)}
            onclick={() => removeChip(item.id, field)}
          >
            <X size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <TextInput
    bind:value={query}
    bind:ref={field}
    size="sm"
    type="text"
    {placeholder}
    maxlength={maxLength}
    autocomplete="off"
    spellcheck={false}
    role="combobox"
    aria-label={placeholder}
    aria-expanded={optionCount > 0}
    aria-controls={listId}
    aria-autocomplete="list"
    aria-activedescendant={active >= 0 ? optionId(active) : undefined}
    {onkeydown}
  >
    {#snippet leading()}<Search size={14} strokeWidth={1.75} aria-hidden="true" />{/snippet}
  </TextInput>

  <!-- Options are chosen through the field (aria-activedescendant); the pointer keeps the focus in it. -->
  <ul
    bind:this={list}
    id={listId}
    class="options"
    role="listbox"
    aria-label={listLabel}
    aria-multiselectable="true"
    onmousedown={(e) => e.preventDefault()}
  >
    {#each matches as item, i (item.id)}
      {@const on = chosen.includes(item.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <li
        id={optionId(i)}
        role="option"
        class="option"
        class:active={i === active}
        aria-selected={on}
        data-id={item.id}
        onclick={() => toggle(item.id)}
        onpointermove={() => (active = i)}
      >
        <span class={['box', { on }]} aria-hidden="true">
          {#if on}<Check size={12} strokeWidth={2.75} />{/if}
        </span>
        {#if item.color}<span class="dot" style:background-color={item.color} aria-hidden="true"></span>{/if}
        <span class="name"><bdi>{item.name}</bdi></span>
        {#if item.count > 0}
          <span class="count" title={item.countLabel}>
            <span aria-hidden="true">{i18n.num(item.count)}</span>
            <span class="sr-only">{item.countLabel}</span>
          </span>
        {/if}
      </li>
    {/each}
    {#if createName !== null}
      {@const i = matches.length}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <li
        id={optionId(i)}
        role="option"
        class="option create"
        class:active={i === active}
        aria-selected="false"
        aria-busy={creating !== null || undefined}
        onclick={() => void create(createName)}
        onpointermove={() => (active = i)}
      >
        <span class="box plus" aria-hidden="true">
          {#if creating !== null}<Spinner size={12} />{:else}<Plus size={12} strokeWidth={2.5} />{/if}
        </span>
        <span class="name">
          {creating !== null ? creatingLabel(creating) : createLabel(createName)}
        </span>
      </li>
    {/if}
  </ul>

  {#if items.length === 0 && createName === null}
    <p class="hint"><span class="hint-title">{emptyText}</span> {emptyHint}</p>
  {:else if matches.length === 0 && createName === null && folded !== ''}
    <p class="hint">{noMatch(query.trim())}</p>
  {/if}
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-inline-size: 0;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    max-inline-size: 100%;
    block-size: 24px;
    padding-inline: var(--space-2) var(--space-0_5);
    border-radius: var(--radius-full);
    background-color: var(--accent-soft);
    color: var(--accent-text);
    font-size: var(--text-xs);
    font-weight: var(--weight-label);
  }

  .chip-name {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip-x {
    display: inline-grid;
    flex: none;
    place-items: center;
    inline-size: 20px;
    block-size: 20px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-full);
    background: none;
    color: inherit;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease-standard);
  }

  .chip-x:hover {
    background-color: color-mix(in srgb, currentColor 14%, transparent);
  }

  .options {
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-block-size: 220px;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    list-style: none;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
  }

  .options:empty {
    display: none;
  }

  .option {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-2);
    min-block-size: 30px;
    padding-inline: var(--space-2);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: var(--text-sm);
    cursor: pointer;
    user-select: none;
  }

  .option.active {
    background-color: var(--surface-hover);
  }

  .box {
    display: inline-grid;
    flex: none;
    place-items: center;
    inline-size: 16px;
    block-size: 16px;
    border: 1px solid var(--border-input);
    border-radius: var(--radius-xs);
    background-color: var(--surface-raised);
    color: var(--accent-ink);
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      border-color var(--dur-fast) var(--ease-standard);
  }

  .box.on {
    border-color: var(--accent);
    background-color: var(--accent);
  }

  .box.plus {
    border-color: transparent;
    background: none;
    color: var(--accent-text);
  }

  .dot {
    flex: none;
    inline-size: 8px;
    block-size: 8px;
    border-radius: var(--radius-full);
  }

  .name {
    flex: 1 1 auto;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .create .name {
    color: var(--accent-text);
    font-weight: var(--weight-label);
  }

  .count {
    flex: none;
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
  }

  .hint {
    margin: 0;
    padding-inline: var(--space-1);
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
  }

  .hint-title {
    color: var(--text);
    font-weight: var(--weight-label);
  }

  @media (forced-colors: active) {
    .option.active {
      outline: 1px solid Highlight;
    }

    .box.on {
      background-color: Highlight;
    }
  }
</style>
