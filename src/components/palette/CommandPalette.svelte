<!--
  CommandPalette (§9.7, §10.1 Mod+K): one field to go anywhere and do anything. A chrome-less glass dialog, 640 px wide
  at 14 vh: the input (search icon at the start, the scope chip at the end, `dir="auto"`), then the grouped results of
  `palette-providers.ts` — Go to, Surahs, Commands, Settings, Reciters, Recent, Search — and a footer of key hints.

  - bits-ui `Command` drives the list (`shouldFilter={false}`: the providers rank; `vimBindings={false}`, §10.1):
    ArrowUp/ArrowDown move between enabled rows (wrapping), Enter or a click runs the active row, Escape closes. Home
    and End stay with the text field (they move the caret).
  - The scope chip narrows the search to commands and settings, surahs or reciters. Typing `>`, `#` or `@` first picks
    the scope the same way; Backspace at the start of the field goes back to everything.
  - Running a row closes the palette first and acts once the dialog has gone, so a command behaves as if its key had
    been pressed where the user was, and a jump moves focus to its ayah instead of restoring it (§7.4).
  - Opened by `ui.open('palette', { query })` (Mod+K, the title-bar button) and rendered by `OverlayHost`; `open`
    follows its own overlay entry (`overlayOpen`), and Mod+K again closes it (the store's toggle).
  Owner: WP10c. Props: `OverlayComponentProps<'palette'>` (§7.9).
-->
<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import SearchIcon from '@lucide/svelte/icons/search'
  import { Command } from 'bits-ui'
  import { onDestroy, onMount, untrack } from 'svelte'
  import { Dialog, Kbd, Menu, type MenuEntry } from '$components/ui'
  import type { OverlayComponentProps } from '$lib/contracts/components'
  import { SURA_NAMES_FAMILY } from '$lib/mushaf/suraNames'
  import { fonts, history, i18n, quran, ui } from '$lib/stores'
  import { overlayOpen } from '../shell/overlay'
  import {
    exampleQueries,
    type PaletteItem,
    paletteResults,
    type PaletteScope,
    runAction,
    SCOPE_PREFIXES,
    SCOPES,
    splitScope,
  } from './palette-providers'
  import PaletteRow from './PaletteRow.svelte'

  let { query: initialQuery }: OverlayComponentProps<'palette'> = $props()

  /** If the dialog's close-focus hook never runs (it was torn down first), the chosen row still runs after this. */
  const CLOSE_FALLBACK_MS = 450
  /** The status line for screen readers waits for typing to pause. */
  const STATUS_DELAY_MS = 350

  const initial = untrack(() => splitScope(initialQuery ?? ''))
  let scope = $state<PaletteScope>(initial.scope ?? 'all')
  let query = $state(initial.rest)
  /** The active row's id (bits-ui `Command` value). */
  let selected = $state('')
  let input: HTMLInputElement | null = $state(null)
  /** The row to run once the dialog has closed. */
  let pending: PaletteItem | null = null
  let fallback: ReturnType<typeof setTimeout> | undefined
  let status = $state('')
  let statusTimer: ReturnType<typeof setTimeout> | undefined

  const isOpen = overlayOpen('palette')
  const open = $derived(isOpen())
  const groups = $derived(paletteResults(query, scope))
  const enabledCount = $derived(
    groups.reduce((n, g) => n + g.items.filter((item) => !item.disabled).length, 0),
  )
  /** Only the "Search the Quran" row is left: say so, and offer examples (§9.7 empty state). */
  const noMatches = $derived(query.trim() !== '' && groups.every((g) => g.id === 'search'))
  const glyphs = $derived(fonts.status.get(SURA_NAMES_FAMILY) === 'ready')
  const latinUi = $derived(i18n.locale !== 'ar')

  const placeholder = $derived(
    scope === 'all'
      ? i18n.t('palette.placeholder', { ref: i18n.ref(2, 255), surah: quran.surah(18)?.nameAr ?? '' })
      : i18n.t(`palette.placeholderScope.${scope}`),
  )
  const scopeName = $derived(i18n.t(`palette.scope.${scope}`))
  const scopeItems: MenuEntry[] = $derived([
    {
      type: 'radio',
      id: 'palette-scope',
      value: scope,
      onValueChange: (value: string) => setScope(value as PaletteScope),
      options: SCOPES.map((s) => ({
        value: s,
        label: i18n.t(`palette.scope.${s}`),
        kbd: s === 'all' ? undefined : SCOPE_PREFIXES[s],
      })),
    },
  ])

  // A scope prefix typed first ("> theme", "#kahf", "@minshawi") becomes the scope chip; the space after it is dropped.
  $effect(() => {
    if (scope !== 'all') {
      if (/^\s/u.test(query)) query = query.trimStart()
      return
    }
    const split = splitScope(query)
    if (split.scope === null) return
    scope = split.scope
    query = split.rest
  })

  // A polite count for screen readers once typing pauses.
  $effect(() => {
    const n = enabledCount
    const text = n === 0 ? i18n.t('palette.statusNone') : i18n.tp('palette.status', n)
    clearTimeout(statusTimer)
    statusTimer = setTimeout(() => (status = text), STATUS_DELAY_MS)
    return () => clearTimeout(statusTimer)
  })

  onMount(() => {
    // Recent rows read the reading history; refresh it while the palette is open (failures leave the group out).
    history.load().catch((e: unknown) => console.warn('[qd] palette: history unavailable', e))
  })

  function setScope(next: PaletteScope): void {
    scope = next
    input?.focus()
  }

  function onInputKeydown(e: KeyboardEvent): void {
    if (e.isComposing) return
    // Home and End move the caret in the field (bits-ui would move the selection instead).
    if (e.key === 'Home' || e.key === 'End') {
      e.stopPropagation()
      return
    }
    const el = e.currentTarget as HTMLInputElement
    if (e.key === 'Backspace' && scope !== 'all' && el.selectionStart === 0 && el.selectionEnd === 0) {
      e.preventDefault()
      scope = 'all'
    }
  }

  /** Keys the list handles anywhere in the palette (bits-ui `Command`), kept from it while a button has focus. */
  const OWN_KEYS = new Set(['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End'])

  /**
   * A button in the palette (the scope chip, an example) keeps its own keys: Enter or Space activates the button and
   * never also runs the active row, and the arrows do not move the list behind it. Escape still reaches the dialog.
   */
  function keepKeys(e: KeyboardEvent, own?: unknown): void {
    if (typeof own === 'function') (own as (e: KeyboardEvent) => void)(e)
    if (OWN_KEYS.has(e.key)) e.stopPropagation()
  }

  function choose(item: PaletteItem): void {
    if (item.disabled || pending !== null) return
    pending = item
    ui.close('palette')
    fallback = setTimeout(() => flush(), CLOSE_FALLBACK_MS)
  }

  /**
   * Runs the chosen row (once). A row that moves focus runs at once (focus is not restored); any other row runs after
   * bits-ui has given focus back to where it was, so it acts in that context.
   */
  function flush(): void {
    clearTimeout(fallback)
    const item = pending
    pending = null
    if (item === null) return
    if (item.movesFocus) runAction(item.run)
    else setTimeout(() => runAction(item.run), 0)
  }

  function onCloseAutoFocus(e: Event): void {
    if (pending?.movesFocus) e.preventDefault()
    flush()
  }

  function useExample(text: string): void {
    // Examples carry bidi isolates for display; the parser ignores them, but the field should not hold them.
    query = text.replace(/[\u2066-\u2069]/gu, '')
    scope = 'all'
    input?.focus()
  }

  onDestroy(() => {
    clearTimeout(statusTimer)
    flush()
  })
</script>

<Dialog
  {open}
  onOpenChange={(o) => {
    if (!o) ui.close('palette')
  }}
  title={i18n.t('palette.title')}
  description={i18n.t('palette.description')}
  variant="bare"
  placement="top"
  width={640}
  layer="palette"
  backdrop="faint"
  {onCloseAutoFocus}
>
  <Command.Root
    class="qd-palette"
    label={i18n.t('palette.inputLabel')}
    shouldFilter={false}
    vimBindings={false}
    loop
    bind:value={selected}
    data-scope={scope}
  >
    <div class="field">
      <span class="lead" aria-hidden="true"><SearchIcon size={18} strokeWidth={1.75} /></span>
      <Command.Input
        bind:ref={input}
        bind:value={query}
        class="input"
        dir={query === '' ? i18n.dir : 'auto'}
        data-autofocus
        {placeholder}
        onkeydown={onInputKeydown}
      />
      <Menu
        items={scopeItems}
        label={i18n.t('palette.scope.menuLabel')}
        align="end"
        minWidth={176}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          input?.focus()
        }}
      >
        {#snippet trigger({ props })}
          <button
            {...props}
            type="button"
            class={['scope', { scoped: scope !== 'all' }]}
            aria-label={i18n.t('palette.scope.chipLabel', { scope: scopeName })}
            onkeydown={(e) => keepKeys(e, props.onkeydown)}
          >
            {#if scope !== 'all'}<span class="prefix" aria-hidden="true">{SCOPE_PREFIXES[scope]}</span>{/if}
            <span>{scopeName}</span>
            <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        {/snippet}
      </Menu>
    </div>

    {#if noMatches}
      <div class="empty">
        <p class="empty-title">{i18n.t('palette.empty.title')}</p>
        {#if scope === 'all'}
          <p class="examples">
            <span class="examples-label">{i18n.t('palette.empty.try')}</span>
            {#each exampleQueries() as text (text)}
              <button
                type="button"
                class="chip"
                onclick={() => useExample(text)}
                onkeydown={(e) => keepKeys(e)}>{text}</button
              >
            {/each}
          </p>
        {/if}
      </div>
    {/if}

    <Command.List class="list" aria-label={i18n.t('palette.listLabel')}>
      <Command.Viewport class="viewport">
        {#each groups as group (group.id)}
          <Command.Group value={group.id} class="group">
            <Command.GroupHeading class={latinUi ? 'heading latin' : 'heading'}
              >{group.heading}</Command.GroupHeading
            >
            <Command.GroupItems>
              {#each group.items as item (item.id)}
                <Command.Item
                  value={item.id}
                  disabled={item.disabled}
                  class="item"
                  onSelect={() => choose(item)}
                >
                  <PaletteRow {item} active={selected === item.id} {glyphs} />
                </Command.Item>
              {/each}
            </Command.GroupItems>
          </Command.Group>
        {/each}
      </Command.Viewport>
    </Command.List>

    <footer class="hints" aria-hidden="true">
      <span class="hint"
        ><Kbd keys={['↑']} size="sm" /><Kbd keys={['↓']} size="sm" />{i18n.t('palette.hints.choose')}</span
      >
      <span class="hint"><Kbd keys={['↵']} size="sm" />{i18n.t('palette.hints.open')}</span>
      <span class="hint"
        ><Kbd keys={[i18n.t('shortcuts.keys.escape')]} size="sm" />{i18n.t('palette.hints.close')}</span
      >
      {#if scope === 'all'}
        <span class="hint prefixes">
          <span class="hint"
            ><Kbd keys={[SCOPE_PREFIXES.commands]} size="sm" />{i18n.t('palette.hints.commands')}</span
          >
          <span class="hint"
            ><Kbd keys={[SCOPE_PREFIXES.surahs]} size="sm" />{i18n.t('palette.hints.surahs')}</span
          >
          <span class="hint"
            ><Kbd keys={[SCOPE_PREFIXES.reciters]} size="sm" />{i18n.t('palette.hints.reciters')}</span
          >
        </span>
      {/if}
    </footer>
    <p class="sr-only" role="status">{status}</p>
  </Command.Root>
</Dialog>

<style>
  :global(.qd-palette) {
    display: flex;
    flex-direction: column;
    min-block-size: 0;
    max-block-size: min(560px, 80vh);
    outline: none;
  }

  .field {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-3);
    block-size: 52px;
    padding-inline: var(--space-4) var(--space-3);
    border-block-end: 1px solid var(--border);
  }

  .lead {
    display: grid;
    flex: none;
    place-items: center;
    color: var(--text-muted);
  }

  .field :global(.input) {
    flex: 1 1 auto;
    min-inline-size: 0;
    /* Stretched by the flex row, not `block-size: 100%`: Blink resets a fixed- or percent-height input's line box to
       `normal`, which for IBM Plex Sans Arabic is shorter than its dots (the field drew «ابحث فى» for «ابحث في»). */
    align-self: stretch;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: var(--text-lg);
    outline: none;
    unicode-bidi: plaintext;
  }

  .field :global(.input::placeholder) {
    color: var(--text-muted);
    opacity: 1;
  }

  .scope {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: var(--space-1);
    block-size: 26px;
    padding-inline: var(--space-2) calc(var(--space-2) - 2px);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--text-xs);
    font-weight: var(--weight-label);
    white-space: nowrap;
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      border-color var(--dur-fast) var(--ease-standard),
      color var(--dur-fast) var(--ease-standard);
  }

  .scope:hover,
  .scope[data-state='open'] {
    border-color: var(--border-input);
    background-color: var(--surface-hover);
    color: var(--text);
  }

  .scope.scoped {
    border-color: transparent;
    background-color: var(--accent-soft);
    color: var(--accent-text);
  }

  .prefix {
    font-family: var(--font-mono);
    font-weight: var(--weight-title);
  }

  :global(.qd-palette .list) {
    flex: 0 1 auto;
    min-block-size: 0;
    block-size: min(420px, var(--bits-command-list-height, auto));
    max-block-size: 420px;
    overflow-y: auto;
    overscroll-behavior: contain;
    scroll-padding-block: var(--space-2);
    transition: block-size var(--dur-quick) var(--ease-standard);
  }

  :global(.qd-palette .viewport) {
    padding: var(--space-1) var(--space-2) var(--space-2);
  }

  :global(.qd-palette .group) {
    padding-block-start: var(--space-1);
  }

  :global(.qd-palette .heading) {
    padding-block: var(--space-2) var(--space-1);
    padding-inline: var(--space-2);
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: var(--weight-title);
    line-height: 1.4;
  }

  /* §9.7: small capitals in the Latin UI only — never on Arabic text. */
  :global(.qd-palette .heading.latin) {
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  :global(.qd-palette .item) {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr) auto auto;
    align-items: center;
    column-gap: var(--space-3);
    min-block-size: 40px;
    padding-block: var(--space-1);
    padding-inline: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    cursor: pointer;
    scroll-margin-block: var(--space-2);
  }

  :global(.qd-palette .item[data-selected]) {
    background-color: var(--accent-soft);
  }

  :global(.qd-palette .item[data-disabled]) {
    cursor: default;
  }

  .empty {
    padding-block: var(--space-4) var(--space-2);
    padding-inline: var(--space-3);
    text-align: center;
  }

  .empty-title {
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
  }

  .examples {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    gap: var(--space-2);
    margin-block-start: var(--space-2);
  }

  .examples-label {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .chip {
    block-size: 26px;
    padding-inline: var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      border-color var(--dur-fast) var(--ease-standard);
  }

  .chip:hover {
    border-color: var(--border-input);
    background-color: var(--surface-hover);
  }

  .hints {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-4);
    padding-block: var(--space-2);
    padding-inline: var(--space-4);
    border-block-start: 1px solid var(--border);
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .hint {
    display: inline-flex;
    align-items: center;
    gap: calc(var(--space-1) * 1.5);
    white-space: nowrap;
  }

  .prefixes {
    gap: var(--space-3);
    margin-inline-start: auto;
  }

  @media (forced-colors: active) {
    :global(.qd-palette .item[data-selected]) {
      outline: 2px solid Highlight;
      outline-offset: -2px;
    }
  }
</style>
