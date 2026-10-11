/**
 * px ↔ % adapter for `Splitter` (§9.5, §9.6). paneforge sizes panes in percent of the group; the shell's pane widths
 * and limits are pixels (sidebar 240–420 px, side pane 320–640 px). These helpers convert between the two for a group
 * of a given pixel size, so `PaneLayout` (WP7c) can feed paneforge and persist pixel widths.
 */

/** Rounds a percentage to 4 decimals (paneforge compares layouts numerically; this avoids float churn). */
function roundPct(pct: number): number {
  return Math.round(pct * 10_000) / 10_000
}

/** A pixel length as a percentage of the group (0 when the group has no size yet). */
export function pxToPct(px: number, groupPx: number): number {
  if (!(groupPx > 0) || !Number.isFinite(px)) return 0
  return roundPct(Math.min(100, Math.max(0, (px / groupPx) * 100)))
}

/** A percentage of the group as whole pixels. */
export function pctToPx(pct: number, groupPx: number): number {
  if (!(groupPx > 0) || !Number.isFinite(pct)) return 0
  return Math.round((Math.min(100, Math.max(0, pct)) / 100) * groupPx)
}

export interface PanePx {
  /** Current (or default) size in px. */
  size: number
  min: number
  max: number
}

export interface PanePct {
  size: number
  minSize: number
  maxSize: number
}

/**
 * paneforge props (`defaultSize`, `minSize`, `maxSize`) for a pane with pixel constraints in a group of `groupPx`.
 * The size is clamped into [min, max]; a max wider than the group is capped at 100 %.
 */
export function panePct(pane: PanePx, groupPx: number): PanePct {
  const min = Math.max(0, Math.min(pane.min, pane.max))
  const max = Math.max(min, pane.max)
  const size = Math.min(max, Math.max(min, pane.size))
  return { size: pxToPct(size, groupPx), minSize: pxToPct(min, groupPx), maxSize: pxToPct(max, groupPx) }
}
