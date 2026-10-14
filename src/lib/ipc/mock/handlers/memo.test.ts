/**
 * The memorisation mock against the `user_db::memo` and `user_db::presets` rules: the schedule for every strength and
 * rating, the manual statuses, sparse reads with `review` derived for overdue ayahs, self-tests (random start, finish
 * once), preset validation, normalisation and order, and the events every mutation emits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { events, type LoopPresetInput, type MemoProgress, type UserDataKind } from '../../bindings'
import { installMockRuntime } from '../index'
import type { Result } from '../result'
import { state } from '../state'
import {
  AGAIN_S,
  DAY_S,
  memoHandlers as h,
  NEW_SCHEDULE,
  scheduleReview,
  scheduleSetStatus,
  type Schedule,
} from './memo'

function ok<T>(r: Result<T>): T {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.error.kind}: ${r.error.message}`)
  return r.data
}

function errKind<T>(r: Result<T>): string {
  if (r.status === 'ok') throw new Error(`expected an error, got ${JSON.stringify(r.data)}`)
  return r.error.kind
}

const T0 = 1_700_000_000

function at(strength: number, patch: Partial<Schedule> = {}): Schedule {
  return {
    status: 'learning',
    strength,
    reviews: 3,
    lapses: 1,
    lastReviewedAt: T0 - DAY_S,
    dueAt: T0,
    ...patch,
  }
}

function preset(patch: Partial<LoopPresetInput> = {}): LoopPresetInput {
  return {
    id: null,
    name: 'Al-Mulk',
    reciterId: 7,
    fromAyahId: 5242,
    toAyahId: 5271,
    ayahRepeat: 3,
    rangeRepeat: 1,
    gap: { type: 'none' },
    speedPct: 100,
    ...patch,
  }
}

let seen: UserDataKind[][] = []
let stopListening: (() => void) | null = null

beforeEach(async () => {
  localStorage.clear()
  await installMockRuntime()
  state.resetAll()
  state.loadAll()
  seen = []
  stopListening = await events.userDataChanged.listen((e) => seen.push(e.payload.kinds))
})

afterEach(() => {
  stopListening?.()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the schedule', () => {
  it('follows the table for every strength', () => {
    for (let s = 0; s <= 5; s++) {
      const again = scheduleReview(at(s), 1, T0)
      expect([again.strength, again.lapses, again.dueAt]).toEqual([Math.max(s - 2, 0), 2, T0 + AGAIN_S])
      const hard = scheduleReview(at(s), 2, T0)
      expect([hard.strength, hard.lapses, hard.dueAt]).toEqual([Math.max(s, 1), 1, T0 + DAY_S])
      const good = scheduleReview(at(s), 3, T0)
      expect([good.strength, good.dueAt]).toEqual([Math.min(s + 1, 5), T0 + 2 ** s * DAY_S])
      const easy = scheduleReview(at(s), 4, T0)
      expect([easy.strength, easy.dueAt]).toEqual([Math.min(s + 2, 5), T0 + 2 ** (s + 1) * DAY_S])
      for (const next of [again, hard, good, easy]) {
        expect(next.reviews).toBe(4)
        expect(next.lastReviewedAt).toBe(T0)
        expect(next.status).toBe(next.strength >= 4 ? 'memorized' : 'learning')
      }
    }
    expect(() => scheduleReview(at(1), 0, T0)).toThrow(/rating/)
    expect(() => scheduleReview(at(1), 5, T0)).toThrow(/rating/)
  })

  it('sets statuses by hand like user_db::memo', () => {
    expect(scheduleSetStatus(at(5), 'new', T0)).toBeNull()
    expect(scheduleSetStatus(at(5), 'learning', T0)).toEqual(at(3, { dueAt: T0 }))
    expect(scheduleSetStatus(at(1), 'memorized', T0)).toEqual(
      at(4, { status: 'memorized', dueAt: T0 + 16 * DAY_S }),
    )
    expect(scheduleSetStatus(at(5), 'memorized', T0)).toEqual(
      at(5, { status: 'memorized', dueAt: T0 + 32 * DAY_S }),
    )
    expect(scheduleSetStatus(at(2), 'review', T0)).toEqual(at(2, { status: 'review', dueAt: T0 }))
    expect(scheduleSetStatus({ ...NEW_SCHEDULE }, 'learning', T0)).toEqual({
      ...NEW_SCHEDULE,
      status: 'learning',
      dueAt: T0,
    })
  })
})

describe('progress', () => {
  it('answers one row per ayah from mutations and the stored rows only from reads', async () => {
    const rows = ok(await h.memoReview({ fromAyahId: 10, toAyahId: 12, rating: 3, mistakes: 2 }))
    expect(rows.map((r) => [r.ayahId, r.status, r.strength])).toEqual([
      [10, 'learning', 1],
      [11, 'learning', 1],
      [12, 'learning', 1],
    ])
    expect(ok(await h.memoProgress(1, 100)).map((r) => r.ayahId)).toEqual([10, 11, 12])
    expect(ok(await h.memoProgress(13, 20))).toEqual([])
    const reset = ok(await h.memoSetStatus(11, 13, 'new'))
    expect(reset.map((r) => [r.ayahId, r.status, r.strength, r.dueAt])).toEqual([
      [11, 'new', 0, null],
      [12, 'new', 0, null],
      [13, 'new', 0, null],
    ])
    expect(ok(await h.memoProgress(1, 6236)).map((r) => r.ayahId)).toEqual([10])
    expect(seen).toEqual([['memo'], ['memo']])
  })

  it('reads an overdue memorised ayah as review, and keeps the stored status', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0 * 1000)
    ok(await h.memoSetStatus(5, 5, 'memorized'))
    const [fresh] = ok(await h.memoProgress(5, 5))
    expect(fresh?.status).toBe('memorized')
    vi.setSystemTime((T0 + 17 * DAY_S) * 1000)
    const [later] = ok(await h.memoProgress(5, 5))
    expect(later?.status).toBe('review')
    expect(state.memo.value.progress.find((p: MemoProgress) => p.ayahId === 5)?.status).toBe('memorized')
    // Reviewing it goes on from the stored strength (4): good → 5, due in 16 days.
    const [next] = ok(await h.memoReview({ fromAyahId: 5, toAyahId: 5, rating: 3, mistakes: 0 }))
    expect(next).toEqual(expect.objectContaining({ status: 'memorized', strength: 5, reviews: 1 }))
    expect(next?.dueAt).toBe(T0 + 17 * DAY_S + 16 * DAY_S)
  })

  it('validates ranges and ratings, and writes nothing on an error', async () => {
    expect(errKind(await h.memoProgress(0, 3))).toBe('invalid_argument')
    expect(errKind(await h.memoProgress(10, 3))).toBe('invalid_argument')
    expect(errKind(await h.memoProgress(1, 6237))).toBe('invalid_argument')
    expect(errKind(await h.memoReview({ fromAyahId: 1, toAyahId: 2, rating: 0, mistakes: 0 }))).toBe(
      'invalid_argument',
    )
    expect(errKind(await h.memoReview({ fromAyahId: 1, toAyahId: 2, rating: 5, mistakes: 0 }))).toBe(
      'invalid_argument',
    )
    expect(state.memo.value.progress).toEqual([])
    expect(seen).toEqual([])
  })
})

describe('self-tests', () => {
  it('start at a random ayah of the range and finish once', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
    const t = ok(await h.memoTestStart(100, 109))
    expect(t).toEqual(
      expect.objectContaining({ id: 1, fromAyahId: 100, toAyahId: 109, startAyahId: 109, finishedAt: null }),
    )
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(ok(await h.memoTestStart(100, 109)).startAyahId).toBe(100)

    const done = ok(await h.memoTestFinish({ id: t.id, reveals: 4, mistakes: 1, rating: 2 }))
    expect(done).toEqual(expect.objectContaining({ reveals: 4, mistakes: 1, rating: 2 }))
    expect(done.finishedAt).not.toBeNull()
    expect(errKind(await h.memoTestFinish({ id: t.id, reveals: 0, mistakes: 0, rating: 2 }))).toBe(
      'invalid_argument',
    )
    expect(errKind(await h.memoTestFinish({ id: 99, reveals: 0, mistakes: 0, rating: 2 }))).toBe('not_found')
    expect(errKind(await h.memoTestFinish({ id: 2, reveals: 0, mistakes: 0, rating: 9 }))).toBe(
      'invalid_argument',
    )
    // Finishing records the test only; the schedule is untouched (the UI rates with memo_review).
    expect(state.memo.value.progress).toEqual([])
    expect(seen).toEqual([['memo'], ['memo'], ['memo']])
  })
})

describe('loop presets', () => {
  it('validates and normalises like user_db::presets, and lists by name', async () => {
    const a = ok(
      await h.loopPresetUpsert(
        preset({
          name: '  zeta  ',
          ayahRepeat: 250,
          rangeRepeat: -3,
          speedPct: 123,
          gap: { type: 'multiplier', data: { pct: 900 } },
        }),
      ),
    )
    expect(a).toEqual(
      expect.objectContaining({
        id: 1,
        name: 'zeta',
        ayahRepeat: 99,
        rangeRepeat: 0,
        speedPct: 125,
        gap: { type: 'multiplier', data: { pct: 300 } },
      }),
    )
    ok(await h.loopPresetUpsert(preset({ name: 'Alpha', gap: { type: 'fixed', data: { ms: 90_000 } } })))
    ok(await h.loopPresetUpsert(preset({ name: 'beta' })))
    expect(ok(await h.loopPresetList()).map((p) => p.name)).toEqual(['Alpha', 'beta', 'zeta'])
    expect(ok(await h.loopPresetList()).find((p) => p.name === 'Alpha')?.gap).toEqual({
      type: 'fixed',
      data: { ms: 30_000 },
    })

    expect(errKind(await h.loopPresetUpsert(preset({ name: '  ' })))).toBe('invalid_argument')
    expect(errKind(await h.loopPresetUpsert(preset({ name: 'x'.repeat(101) })))).toBe('invalid_argument')
    expect(errKind(await h.loopPresetUpsert(preset({ fromAyahId: 9, toAyahId: 3 })))).toBe('invalid_argument')
    expect(errKind(await h.loopPresetUpsert(preset({ id: 77 })))).toBe('not_found')

    const renamed = ok(await h.loopPresetUpsert(preset({ id: a.id, name: 'Eta' })))
    expect(renamed).toEqual(expect.objectContaining({ id: a.id, name: 'Eta', createdAt: a.createdAt }))
    ok(await h.loopPresetDelete(a.id))
    expect(errKind(await h.loopPresetDelete(a.id))).toBe('not_found')
    expect(ok(await h.loopPresetList()).map((p) => p.name)).toEqual(['Alpha', 'beta'])
    expect(seen.every((k) => k.length === 1 && k[0] === 'presets')).toBe(true)
    expect(seen).toHaveLength(5)
  })
})
