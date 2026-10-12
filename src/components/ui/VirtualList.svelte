<!--
  VirtualList (§9.5): a vertically virtualised list (virtua `VList`) for long, variable-height content: search
  results, translation mode, the page grid, notes. Only the rows near the viewport are mounted; heights are measured
  as rows render (`itemSize` is a hint for unmeasured rows). The list fills its container (give it a height) and uses
  the thin `--border-strong` scrollbar.

  Methods (via `bind:this`): `scrollToIndex(i, { align, smooth, offset })`, `scrollTo(px)`, `scrollBy(px)`,
  `getScrollOffset()`, `findItemIndex(px)`, `getItemOffset(i)`, `getViewportSize()`, `getScrollSize()`. Scrolling
  to an ayah: find its row index and call `scrollToIndex(index, { align: 'start' })`.

  A jump (`scrollToIndex` without `smooth`) is held on its row until the rows around it are measured. virtua re-aims a
  jump while rows change size, but stops 150 ms (wall time) after the last change; an engine that takes longer than
  that to lay out a screen of new rows (WebKitGTK shaping Arabic in software, 200–500 ms a frame) left the row up to a
  row's height off. The hold checks the row each frame and re-aims when it moved, and lets go once it stayed put for 3
  frames and 150 ms, after 3 s, at the next scroll asked for, or at the user's own wheel, touch, press or key.
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

  /** A held jump lets go once its row stayed put this many frames and this long, and after `HOLD_MAX_MS` at most. */
  const HOLD_QUIET_FRAMES = 3
  const HOLD_QUIET_MS = 150
  const HOLD_MAX_MS = 3000

  interface Hold {
    index: number
    options: ScrollToIndexOptions
    /** `performance.now()` when the jump was asked for, and when it was last aimed. */
    since: number
    aimed: number
    /** Frames since it was last aimed. */
    quiet: number
    frame: number
  }
  let hold: Hold | null = null

  function release(): void {
    if (hold) cancelAnimationFrame(hold.frame)
    hold = null
  }

  /** The user's own scrolling ends a hold asked for before it (not one that this event's handlers just asked for). */
  function onInput(e: Event): void {
    if (hold && hold.since <= e.timeStamp) release()
  }

  /** The offset virtua scrolls to for the held row (its `scrollToIndex` arithmetic), within the scroll range. */
  function aim(l: VList<T>, h: Hold): number {
    const { align = 'start', offset = 0 } = h.options
    const size = l.getItemSize(h.index)
    const view = l.getViewportSize()
    const at =
      offset +
      l.getItemOffset(h.index) +
      (align === 'end' ? size - view : align === 'center' ? (size - view) / 2 : 0)
    return Math.min(Math.max(0, at), Math.max(0, l.getScrollSize() - view))
  }

  function step(): void {
    const h = hold
    const l = list
    if (!h || !l) return
    const now = performance.now()
    if (now - h.since > HOLD_MAX_MS) return release()
    // WebKit keeps whole-pixel scroll offsets (it truncates): within a pixel is on target.
    if (Math.abs(l.getScrollOffset() - aim(l, h)) > 1) {
      l.scrollToIndex(h.index, h.options)
      h.aimed = now
      h.quiet = 0
    } else if (++h.quiet >= HOLD_QUIET_FRAMES && now - h.aimed >= HOLD_QUIET_MS) {
      return release()
    }
    h.frame = requestAnimationFrame(step)
  }

  export function scrollToIndex(index: number, options: ScrollToIndexOptions = {}): void {
    release()
    const l = list
    if (!l) return
    let resolved = options
    if (options.align === 'nearest') {
      // Resolved now, as virtua does: held at the edge it scrolls to, or not scrolled at all.
      const top = l.getItemOffset(index)
      const scroll = l.getScrollOffset()
      if (top < scroll) resolved = { ...options, align: 'start' }
      else if (top + l.getItemSize(index) > scroll + l.getViewportSize())
        resolved = { ...options, align: 'end' }
      else return
    }
    l.scrollToIndex(index, resolved)
    if (resolved.smooth) return
    const now = performance.now()
    hold = { index, options: resolved, since: now, aimed: now, quiet: 0, frame: requestAnimationFrame(step) }
  }

  export function scrollTo(offset: number): void {
    release()
    list?.scrollTo(offset)
  }

  export function scrollBy(offset: number): void {
    release()
    list?.scrollBy(offset)
  }

  $effect(() => release)

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
  onwheel={onInput}
  ontouchstart={onInput}
  onpointerdown={onInput}
  onkeydown={onInput}
/>

<style>
  :global(.qd-virtual-list) {
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
  }
</style>
