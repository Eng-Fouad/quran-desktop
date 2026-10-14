/**
 * The rail's Downloads flyout (owner request 2026-10-11): whether the window has room for it, how tall it may grow, the
 * order of its job rows and the rail button's aggregate progress. Pure (no stores), so the rules are unit-tested.
 */
import type { JobPhase, JobSnapshot } from '$lib/ipc/bindings'
import { isActivePhase } from '$lib/stores/packs.svelte'

/** Below this much room (CSS px, after the UI zoom) the rail button opens the manager instead of the flyout. */
export const FLYOUT_MIN = { w: 480, h: 400 } as const
/** The flyout's inline size, narrowed to the room beside the rail. */
export const FLYOUT_W = 380
/** The flyout's height cap: 60 % of the window, but never under this, so a short window lends it all its room. */
export const FLYOUT_MIN_CAP = 440

/**
 * Whether the flyout fits a window of `w × h` CSS px. An unmeasured window (0 × 0) counts as roomy. At the 760 × 600
 * minimum window with 200 % UI scale (380 × 300) the click opens the manager directly.
 */
export function flyoutFits(w: number, h: number): boolean {
  if (w <= 0 || h <= 0) return true
  return w >= FLYOUT_MIN.w && h >= FLYOUT_MIN.h
}

/**
 * The flyout's maximum block size (px) in a window `h` CSS px tall: 60 % of it, at least `FLYOUT_MIN_CAP`. Below
 * about 500 px that is more than the room there is, so the room (`--bits-floating-available-height`) decides.
 */
export function flyoutCap(h: number): number {
  return Math.max(FLYOUT_MIN_CAP, Math.round(h * 0.6))
}

/** Running jobs first, then queued, paused and failed ones. */
const RANK: Record<JobPhase, number> = {
  downloading: 0,
  verifying: 0,
  installing: 0,
  queued: 1,
  paused: 2,
  failed: 3,
  completed: 4,
  cancelled: 4,
}

/**
 * The flyout's job rows: live jobs (not those that wait for a connection, `waits`, which it lists apart), running
 * first, then queued, paused and failed; oldest first within a phase.
 */
export function flyoutJobs(jobs: Iterable<JobSnapshot>, waits: (packId: string) => boolean): JobSnapshot[] {
  return [...jobs]
    .filter((j) => RANK[j.phase] < 4 && !waits(j.packId))
    .sort((a, b) => RANK[a.phase] - RANK[b.phase] || a.jobId - b.jobId)
}

/**
 * The rail ring's value: KiB received of the KiB known across the queued and running jobs, as a ratio in [0, 1].
 * `null` with no such job; 0 while none knows its size yet (queued, starting).
 */
export function aggregateProgress(jobs: Iterable<JobSnapshot>): number | null {
  let any = false
  let done = 0
  let total = 0
  for (const j of jobs) {
    if (!isActivePhase(j.phase)) continue
    any = true
    if (j.totalKib <= 0) continue
    total += j.totalKib
    done += Math.min(j.receivedKib, j.totalKib)
  }
  if (!any) return null
  return total > 0 ? done / total : 0
}
