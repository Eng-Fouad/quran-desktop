/**
 * The rail flyout's pure rules (owner request 2026-10-11): when it fits, its height cap, the order of its job rows and
 * the rail ring's aggregate progress.
 */
import { describe, expect, it } from 'vitest'
import type { JobPhase, JobSnapshot } from '$lib/ipc/bindings'
import { aggregateProgress, flyoutCap, flyoutFits, flyoutJobs } from './flyout'

function job(packId: string, jobId: number, phase: JobPhase, receivedKib = 0, totalKib = 0): JobSnapshot {
  return {
    jobId,
    packId,
    phase,
    receivedKib,
    totalKib,
    itemsDone: 0,
    itemsTotal: 0,
    rateKibS: 0,
    etaS: null,
    error: null,
  }
}

describe('flyoutFits', () => {
  it('needs 480 × 400 CSS px; the 760 × 600 window at 200 % (380 × 300) opens the manager instead', () => {
    expect(flyoutFits(1600, 1000)).toBe(true)
    expect(flyoutFits(507, 400)).toBe(true) // 760 × 600 at 150 %
    expect(flyoutFits(380, 300)).toBe(false)
    expect(flyoutFits(479, 900)).toBe(false)
    expect(flyoutFits(900, 399)).toBe(false)
    expect(flyoutFits(0, 0)).toBe(true)
  })
})

describe('flyoutCap', () => {
  it('is 60 % of the window, never under 440 px (so a short window has no cap but its room)', () => {
    expect(flyoutCap(1000)).toBe(600)
    expect(flyoutCap(800)).toBe(480)
    expect(flyoutCap(600)).toBe(440)
    expect(flyoutCap(400)).toBe(440)
  })
})

describe('flyoutJobs', () => {
  it('lists running, then queued, paused and failed jobs, leaving out what waits for a connection', () => {
    const jobs = [
      job('failed', 1, 'failed'),
      job('paused', 2, 'paused'),
      job('queued', 3, 'queued'),
      job('installing', 4, 'installing'),
      job('downloading', 5, 'downloading'),
      job('offline', 6, 'failed'),
    ]
    expect(flyoutJobs(jobs, (id) => id === 'offline').map((j) => j.packId)).toEqual([
      'installing',
      'downloading',
      'queued',
      'paused',
      'failed',
    ])
  })
})

describe('aggregateProgress', () => {
  it('sums what the queued and running jobs received of what they know', () => {
    expect(aggregateProgress([])).toBeNull()
    expect(aggregateProgress([job('a', 1, 'paused', 10, 20), job('b', 2, 'failed')])).toBeNull()
    expect(aggregateProgress([job('a', 1, 'queued')])).toBe(0)
    expect(
      aggregateProgress([
        job('a', 1, 'downloading', 30, 100),
        job('b', 2, 'downloading', 70, 100),
        job('c', 3, 'queued'),
        job('d', 4, 'paused', 50, 50),
      ]),
    ).toBe(0.5)
  })
})
