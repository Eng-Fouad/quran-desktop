<!--
  ContextMenu (§9.5, §10.3): the same rows and keyboard model as `Menu`, opened at a point.

  Two ways to open it:
  - **Trigger area** (`trigger`): right-click (or a touch long-press) inside the element the snippet renders opens the
    menu at the pointer (bits-ui ContextMenu).
  - **Programmatic** (`at`): a viewport point, e.g. from `ui.contextMenu` (§7.4): right-click on the Mushaf canvas, or
    `Shift+F10` / the `ContextMenu` key on the focused ayah. The menu shows while `at` is set and calls `onClose` when
    it closes (selection, Escape, outside click); focus then returns to where it was before it opened.

  While open it is a floating layer (§7.4): typeahead (`b` → "Bookmark") never runs the reader's `b` shortcut.
-->
<script lang="ts">
  import { ContextMenu, DropdownMenu } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import { floatingZ, resolveDir, trackFloating } from './floating.svelte'
  import MenuItems from './MenuItems.svelte'
  import type { Dir, MenuEntry, Point, TriggerProps } from './types'

  interface Props {
    items: readonly MenuEntry[]
    /** Trigger-area mode: the element whose right-click opens the menu. */
    trigger?: Snippet<[TriggerProps]>
    /** Programmatic mode: open at this viewport point; `null` closes. */
    at?: Point | null
    /** Programmatic mode: the menu closed (clear the point here). */
    onClose?: () => void
    /** Trigger-area mode: open state. */
    open?: boolean
    onOpenChange?: (open: boolean) => void
    /** Accessible name of the menu ("Ayah 2:255"). */
    label?: string
    /** Trigger-area mode: ignore right-clicks (they fall through to the default handling). */
    disabled?: boolean
    onCloseAutoFocus?: (e: Event) => void
    dir?: Dir
  }

  let {
    items,
    trigger,
    at = null,
    onClose,
    open = $bindable(false),
    onOpenChange,
    label,
    disabled = false,
    onCloseAutoFocus,
    dir: dirProp,
  }: Props = $props()

  const dir = $derived(resolveDir(dirProp))
  const pointOpen = $derived(trigger === undefined && at !== null)
  /** A zero-size virtual element at the point (floating-ui's `Measurable`). */
  const anchor = $derived.by(() => {
    if (at === null) return null
    const { x, y } = at
    return { getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }) }
  })

  /** Where focus was when the programmatic menu opened (restored when it closes). */
  let returnFocus: HTMLElement | null = null
  /** The programmatic menu's content element (still mounted while its exit transition runs). */
  let pointContent: HTMLElement | null = $state(null)

  $effect.pre(() => {
    if (!pointOpen) return
    const active = document.activeElement
    returnFocus = active instanceof HTMLElement && active !== document.body ? active : null
  })

  trackFloating(() => (trigger === undefined ? pointOpen : open))
  const zIndex = floatingZ('menu')

  function handlePointOpenChange(next: boolean): void {
    if (!next) onClose?.()
  }

  /** bits-ui's close focus handling: ours, unless the consumer takes over (`preventDefault()` in its handler). */
  function onPointCloseAutoFocus(e: Event): void {
    onCloseAutoFocus?.(e)
    if (e.defaultPrevented) returnFocus = null
    e.preventDefault()
  }

  /** Once the menu has fully closed (after its exit transition), focus goes back to where it was. */
  function onPointOpenChangeComplete(open: boolean): void {
    if (open) return
    const target = returnFocus
    returnFocus = null
    const active = document.activeElement
    // Focus is still in the closing menu (or already fell to the body): move it back.
    const lost = active === null || active === document.body || (pointContent?.contains(active) ?? false)
    if (target?.isConnected && lost) target.focus({ preventScroll: true })
  }
</script>

{#snippet surface(props: Record<string, unknown>, wrapperProps: Record<string, unknown>)}
  <div {...wrapperProps}>
    <div {...props} class="qd-menu" aria-label={label} style:z-index={zIndex()} {dir}>
      <MenuItems {items} {dir} />
    </div>
  </div>
{/snippet}

{#if trigger}
  <ContextMenu.Root bind:open {onOpenChange} {dir}>
    <ContextMenu.Trigger {disabled}>
      {#snippet child({ props })}
        {@render trigger({ props })}
      {/snippet}
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content collisionPadding={8} {onCloseAutoFocus} loop>
        {#snippet child({ props, wrapperProps })}
          {@render surface(props, wrapperProps)}
        {/snippet}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>
{:else}
  <DropdownMenu.Root
    open={pointOpen}
    onOpenChange={handlePointOpenChange}
    onOpenChangeComplete={onPointOpenChangeComplete}
    {dir}
  >
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        bind:ref={pointContent}
        customAnchor={anchor}
        side={dir === 'rtl' ? 'left' : 'right'}
        align="start"
        sideOffset={2}
        collisionPadding={8}
        onCloseAutoFocus={onPointCloseAutoFocus}
        loop
      >
        {#snippet child({ props, wrapperProps })}
          {@render surface(props, wrapperProps)}
        {/snippet}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{/if}
