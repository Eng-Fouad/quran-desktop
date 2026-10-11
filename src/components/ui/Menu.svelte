<!--
  Menu (§9.5): a dropdown menu (bits-ui DropdownMenu) opened from the element `trigger` renders. Rows come from
  `items` (`MenuEntry`: commands with icon/swatch and shortcut hint, checkbox and radio items, groups, separators,
  submenus); `children` may add custom bits-ui menu parts after them.

  Keyboard (bits-ui): ↑/↓ move, Home/End, Enter/Space select, typeahead jumps to a label, → opens a submenu (← in
  RTL, from `dir`), Escape closes and returns focus to the trigger. While open it is a floating layer (§7.4), so a
  typed letter never runs a reader shortcut.
-->
<script lang="ts">
  import { DropdownMenu } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import { floatingZ, resolveDir, trackFloating } from './floating.svelte'
  import MenuItems from './MenuItems.svelte'
  import type { Align, Dir, MenuEntry, Side, TriggerProps } from './types'

  interface Props {
    items: readonly MenuEntry[]
    trigger: Snippet<[TriggerProps]>
    open?: boolean
    onOpenChange?: (open: boolean) => void
    side?: Side
    align?: Align
    sideOffset?: number
    /** Accessible name of the menu (defaults to the trigger's name through `aria-labelledby`). */
    label?: string
    /** Minimum width in px (the trigger's width is used when wider). */
    minWidth?: number
    onCloseAutoFocus?: (e: Event) => void
    dir?: Dir
    children?: Snippet
  }

  let {
    items,
    trigger,
    open = $bindable(false),
    onOpenChange,
    side = 'bottom',
    align = 'start',
    sideOffset = 4,
    label,
    minWidth,
    onCloseAutoFocus,
    dir: dirProp,
    children,
  }: Props = $props()

  const dir = $derived(resolveDir(dirProp))

  trackFloating(() => open)
  const zIndex = floatingZ('menu')
</script>

<DropdownMenu.Root bind:open {onOpenChange} {dir}>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      {@render trigger({ props })}
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content {side} {align} {sideOffset} {onCloseAutoFocus} collisionPadding={8} loop>
      {#snippet child({ props, wrapperProps })}
        <div {...wrapperProps}>
          <div
            {...props}
            class="qd-menu"
            aria-label={label}
            style:z-index={zIndex()}
            style:min-inline-size={minWidth === undefined
              ? undefined
              : `max(${minWidth}px, var(--bits-floating-anchor-width))`}
            {dir}
          >
            <MenuItems {items} {dir} />
            {@render children?.()}
          </div>
        </div>
      {/snippet}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
