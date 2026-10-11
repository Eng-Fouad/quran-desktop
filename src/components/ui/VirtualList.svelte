<!--
  VirtualList (§9.5): a vertically virtualised list (virtua `VList`) for long, variable-height content: search
  results, translation mode, the page grid, notes. Only the rows near the viewport are mounted; heights are measured
  as rows render (`itemSize` is a hint for unmeasured rows). The list fills its container (give it a height) and uses
  the thin `--border-strong` scrollbar.

  Methods (via `bind:this`): `scrollToIndex(i, { align, smooth, offset })`, `scrollTo(px)`, `scrollBy(px)`,
  `getScrollOffset()`, `findItemIndex(px)`, `getItemOffset(i)`, `getViewportSize()`, `getScrollSize()`. Scrolling
  to an ayah: find its row index and call `scrollToIndex(index, { align: 'start' })`.
-->
<script lang="ts" generics="T">
  import type { Snippet } from 'svelte'
  import { VList } from 'virtua/svelte'

  interface ScrollToIndexOptions {
    align?: 'start' | 'center' | 'end' | 'nearest'
    smooth?: boolean
    offset?: number
  }

  interface Props {
    data: readonly T[]
    /** Renders one row: `(item, index)`. */
    children: Snippet<[T, number]>
    /** A stable key per row (strongly recommended when rows can be inserted or removed). */
    getKey?: (item: T, index: number) => string | number
    /** Size hint for rows not measured yet (px). */
    itemSize?: number
    /** Extra pixels rendered before and after the viewport (virtua `bufferSize`). */
    overscan?: number
    /** Rows kept mounted while off screen (e.g. the focused row). */
    keepMounted?: readonly number[]
    /** Accessible role and name of the scroller (`list` + a label for a list of results). */
    role?: string
    label?: string
    onscroll?: (offset: number) => void
    onscrollend?: () => void
    class?: string
  }

  let {
    data,
    children,
    getKey,
    itemSize,
    overscan,
    keepMounted,
    role,
    label,
    onscroll,
    onscrollend,
    class: className,
  }: Props = $props()

  let list: VList<T> | undefined = $state()

  export function scrollToIndex(index: number, options?: ScrollToIndexOptions): void {
    list?.scrollToIndex(index, options)
  }

  export function scrollTo(offset: number): void {
    list?.scrollTo(offset)
  }

  export function scrollBy(offset: number): void {
    list?.scrollBy(offset)
  }

  export function getScrollOffset(): number {
    return list?.getScrollOffset() ?? 0
  }

  export function getViewportSize(): number {
    return list?.getViewportSize() ?? 0
  }

  export function getScrollSize(): number {
    return list?.getScrollSize() ?? 0
  }

  export function findItemIndex(offset: number): number {
    return list?.findItemIndex(offset) ?? 0
  }

  export function getItemOffset(index: number): number {
    return list?.getItemOffset(index) ?? 0
  }
</script>

<VList
  bind:this={list}
  {data}
  {children}
  {getKey}
  {itemSize}
  bufferSize={overscan}
  {keepMounted}
  {onscroll}
  {onscrollend}
  class={['qd-virtual-list', className].filter(Boolean).join(' ')}
  {role}
  aria-label={label}
/>

<style>
  :global(.qd-virtual-list) {
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
  }
</style>
