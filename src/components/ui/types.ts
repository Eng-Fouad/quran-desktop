/**
 * Shared prop types of the §9.5 design-system primitives (`src/components/ui`, WP7b). Consumers import them from
 * `$components/ui` together with the components.
 */
import type { LucideIcon } from '@lucide/svelte'
import type { Snippet } from 'svelte'

export type { Tone } from '$lib/contracts/stores'

/** Text direction of a primitive. Every wrapper defaults to the UI direction (`i18n.dir`, §9.5, §11.3). */
export type Dir = 'ltr' | 'rtl'

/** Control heights (§9.5): sm 28 px, md 32 px, lg 40 px. */
export type ControlSize = 'sm' | 'md' | 'lg'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link'

/** Preferred side of a floating layer relative to its anchor (bits-ui / floating-ui). */
export type Side = 'top' | 'right' | 'bottom' | 'left'
export type Align = 'start' | 'center' | 'end'

/** A virtual anchor for a floating layer: a viewport point (context menus opened by `ui.contextMenu`, §7.4). */
export interface Point {
  x: number
  y: number
}

/** The props a primitive hands to a trigger snippet: spread them on the element that opens the layer. */
export interface TriggerProps {
  props: Record<string, unknown>
}

// --- Menu / ContextMenu (§9.5, §10.3) -----------------------------------------------------------------------------

interface MenuEntryBase {
  /** Stable key (also the default `data-menu-id`). */
  id: string
  label: string
  disabled?: boolean
}

/** A command. `kbd` is the shortcut hint shown at the inline end (a label from `shortcuts.format(def)`). */
export interface MenuActionEntry extends MenuEntryBase {
  type?: 'item'
  onSelect: () => void
  icon?: LucideIcon
  /** A colour dot in the icon slot (highlight colours, §10.3), e.g. `var(--user-hl-yellow-solid)`. */
  swatch?: string
  kbd?: string
  /** Destructive commands use the danger text colour. */
  danger?: boolean
  /** Keep the menu open after selecting (steppers, toggles that preview). */
  keepOpen?: boolean
}

export interface MenuCheckboxEntry extends MenuEntryBase {
  type: 'checkbox'
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  kbd?: string
  keepOpen?: boolean
}

export interface MenuRadioGroupEntry {
  type: 'radio'
  id: string
  /** Optional group heading. */
  label?: string
  value: string
  onValueChange: (value: string) => void
  options: readonly { value: string; label: string; disabled?: boolean; kbd?: string; swatch?: string }[]
  keepOpen?: boolean
}

export interface MenuSubmenuEntry extends MenuEntryBase {
  type: 'submenu'
  icon?: LucideIcon
  swatch?: string
  items: readonly MenuEntry[]
}

export interface MenuGroupEntry {
  type: 'group'
  id: string
  /** Optional heading (text-2xs, uppercase in the Latin UI). */
  label?: string
  items: readonly MenuEntry[]
}

export interface MenuSeparatorEntry {
  type: 'separator'
  id?: string
}

/** One row of a `Menu` or `ContextMenu` (data-driven, so every menu looks and behaves the same). */
export type MenuEntry =
  | MenuActionEntry
  | MenuCheckboxEntry
  | MenuRadioGroupEntry
  | MenuSubmenuEntry
  | MenuGroupEntry
  | MenuSeparatorEntry

// --- Select / Combobox / Segmented / Tabs -------------------------------------------------------------------------

export interface SelectItem {
  value: string
  label: string
  /** Secondary text at the inline end (a size, a language, an Arabic name). */
  hint?: string
  /** Language of `hint` (e.g. `ar` for an Arabic name), so it gets the right font and direction. */
  hintLang?: string
  /** Extra words the combobox filter matches (aliases, transliterations). */
  keywords?: readonly string[]
  icon?: LucideIcon
  disabled?: boolean
  /** Items with the same group are listed together under that heading (first-appearance order). */
  group?: string
}

export interface SegmentedOption {
  value: string
  label: string
  icon?: LucideIcon
  /** Show only the icon (the label becomes the accessible name and the tooltip). */
  iconOnly?: boolean
  disabled?: boolean
}

export interface TabItem {
  value: string
  label: string
  icon?: LucideIcon
  /** A count or short status after the label. */
  badge?: string | number
  disabled?: boolean
}

/** The snippet a `Field` renders its control with: wire these onto the input. */
export interface FieldControlProps {
  id: string
  /** Space-separated ids of the hint or error text (`aria-describedby`), if any. */
  describedBy: string | undefined
  invalid: boolean
  required: boolean
}

export type FieldControl = Snippet<[FieldControlProps]>
