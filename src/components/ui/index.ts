/**
 * Design-system primitives (ARCHITECTURE §9.5; WP7b). Every wrapper passes the UI direction to bits-ui (`dir`, with a
 * per-instance override), registers open floating layers with `ui.pushFloating()/popFloating()` (§7.4) and uses the
 * semantic tokens of `src/styles/tokens.css` only.
 *
 *   import { Button, Dialog, Menu, type MenuEntry } from '$components/ui'
 *
 * `SafeHtml.svelte` (WP0C, frozen) lives here too; import it from its file.
 */
export { default as Badge } from './Badge.svelte'
export { default as Button } from './Button.svelte'
export { default as Card } from './Card.svelte'
export { default as Combobox } from './Combobox.svelte'
export { default as ContextMenu } from './ContextMenu.svelte'
export { default as Dialog } from './Dialog.svelte'
export { default as EmptyState } from './EmptyState.svelte'
export { default as Field } from './Field.svelte'
export { default as IconButton } from './IconButton.svelte'
export { default as Kbd } from './Kbd.svelte'
export { default as Menu } from './Menu.svelte'
export { default as Popover } from './Popover.svelte'
export { default as Progress } from './Progress.svelte'
export { default as ScrollArea } from './ScrollArea.svelte'
export { default as SearchInput } from './SearchInput.svelte'
export { default as Segmented } from './Segmented.svelte'
export { default as Select } from './Select.svelte'
export { default as Sheet } from './Sheet.svelte'
export { default as Skeleton } from './Skeleton.svelte'
export { default as Slider } from './Slider.svelte'
export { default as Spinner } from './Spinner.svelte'
export { default as Splitter } from './Splitter.svelte'
export { default as Switch } from './Switch.svelte'
export { default as Tabs } from './Tabs.svelte'
export { default as TextInput } from './TextInput.svelte'
export { default as Toaster } from './Toaster.svelte'
export { default as Tooltip } from './Tooltip.svelte'
export { default as TooltipProvider } from './TooltipProvider.svelte'
export { default as VirtualList } from './VirtualList.svelte'

export { filterItems, foldForMatch, groupItems } from './filter'
export { trackFloating, resolveDir } from './floating.svelte'
export { firstTabbable, focusInitial } from './focus'
export { isMacModifier, splitChord } from './kbd'
export { panePct, pctToPx, pxToPct, type PanePct, type PanePx } from './splitter'
export type * from './types'
