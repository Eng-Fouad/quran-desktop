/**
 * Mock handlers: memorisation and loop presets (§5.17). Owner: WP9b.
 *
 * Behaves like `quran-core`'s `user_db::memo` and `user_db::presets` (WP2b) on the `memo` state slice:
 *
 * - **Progress** is stored sparsely (one row per reviewed ayah). `memo_progress` answers the stored rows of the range in
 *   ayah order; a `memorized` ayah whose `dueAt` has passed is answered as `review`. The mutating calls answer one row
 *   per ayah of their range (an ayah without a row is `new`, strength 0).
 * - **Schedule** (§5.10, D25), per ayah of a reviewed range, `s` the strength before:
 *   1 again → `max(s−2, 0)`, lapses +1, due in 10 min; 2 hard → `max(s, 1)`, due in 1 day; 3 good → `min(s+1, 5)`, due in
 *   2^s days; 4 easy → `min(s+2, 5)`, due in 2^(s+1) days. Status `memorized` from strength 4, else `learning`.
 * - **Manual status**: `new` deletes the rows; `learning` caps the strength at 3 and makes the ayahs due now;
 *   `memorized` raises it to at least 4, due like a "good" answer at that strength; `review` makes them due now.
 * - **Self-tests**: `memo_test_start` picks the start ayah uniformly in the range; `memo_test_finish` records the
 *   result once (finishing again is `invalid_argument`, an unknown id `not_found`) and leaves the schedule alone (the UI
 *   rates the span with `memo_review`).
 * - **Presets**: names are trimmed, 1–100 characters; repeats clamp to 0–99, the speed to 50–200 in steps of 5 and the
 *   gap to its limits (like `Settings::validated`); the list is ordered by name (case-insensitive), then id; deleting is
 *   final; an unknown id is `not_found`.
 * - **Events**: every successful mutation emits `user-data-changed` (`memo` for progress and tests, `presets` for presets).
 */
import { SETTING_LIMITS } from '$lib/contracts/settings'
import {
  events,
  type GapSetting,
  type LoopPreset,
  type LoopPresetInput,
  type MemoProgress,
  type MemoReviewInput,
  type MemoStatus,
  type MemoTest,
  type MemoTestResult,
  type UserDataKind,
} from '../../bindings'
import { assertAyahRange, assertRange, type Handlers, handle, MockError, nowSecs } from '../result'
import { type MemoState, state } from '../state'

/** Every ayah of the Quran (Hafs numbering). */
export const AYAH_COUNT = 6236
export const MAX_STRENGTH = 5
export const MEMORIZED_STRENGTH = 4
export const AGAIN_S = 10 * 60
export const DAY_S = 86_400
/** Longest preset name, in characters (quran-core `PRESET_NAME_MAX_CHARS`). */
export const PRESET_NAME_MAX_CHARS = 100

/** One ayah's stored schedule (a `memo_ayah` row without its id). */
export type Schedule = Omit<MemoProgress, 'ayahId'>

export const NEW_SCHEDULE: Readonly<Schedule> = Object.freeze({
  status: 'new',
  strength: 0,
  reviews: 0,
  lapses: 0,
  lastReviewedAt: null,
  dueAt: null,
})

/** The §5.10 table: one review with `rating` at `now` (Unix seconds). */
export function scheduleReview(prev: Schedule, rating: number, now: number): Schedule {
  const s = Math.min(prev.strength, MAX_STRENGTH)
  let strength: number
  let lapses = prev.lapses
  let interval: number
  switch (rating) {
    case 1:
      strength = Math.max(s - 2, 0)
      lapses += 1
      interval = AGAIN_S
      break
    case 2:
      strength = Math.max(s, 1)
      interval = DAY_S
      break
    case 3:
      strength = Math.min(s + 1, MAX_STRENGTH)
      interval = 2 ** s * DAY_S
      break
    case 4:
      strength = Math.min(s + 2, MAX_STRENGTH)
      interval = 2 ** (s + 1) * DAY_S
      break
    default:
      throw new MockError('invalid_argument', `rating ${rating} is not 1..=4`)
  }
  return {
    status: strength >= MEMORIZED_STRENGTH ? 'memorized' : 'learning',
    strength,
    reviews: prev.reviews + 1,
    lapses,
    lastReviewedAt: now,
    dueAt: now + interval,
  }
}

/** `memo_set_status`: the manual change; `null` deletes the row. */
export function scheduleSetStatus(prev: Schedule, status: MemoStatus, now: number): Schedule | null {
  const s = Math.min(prev.strength, MAX_STRENGTH)
  switch (status) {
    case 'new':
      return null
    case 'learning':
      return { ...prev, status: 'learning', strength: Math.min(s, MEMORIZED_STRENGTH - 1), dueAt: now }
    case 'memorized': {
      const strength = Math.max(s, MEMORIZED_STRENGTH)
      return { ...prev, status: 'memorized', strength, dueAt: now + 2 ** strength * DAY_S }
    }
    case 'review':
      return { ...prev, status: 'review', strength: s, dueAt: now }
  }
}

/** The status a reader sees: an overdue `memorized` ayah is `review`. */
function seen(ayahId: number, s: Schedule, now: number): MemoProgress {
  const status = s.status === 'memorized' && s.dueAt !== null && s.dueAt < now ? 'review' : s.status
  return { ayahId, ...s, status }
}

function checkRating(rating: number): void {
  if (!Number.isInteger(rating) || rating < 1 || rating > 4) {
    throw new MockError('invalid_argument', `rating ${rating} is not 1..=4`)
  }
}

async function changed(kind: UserDataKind): Promise<void> {
  try {
    await events.userDataChanged.emit({ kinds: [kind] })
  } catch (e) {
    console.error('[mock IPC] user-data-changed', e)
  }
}

/** Runs a mutation on a copy of the slice, which replaces it only when `fn` returns (a rolled-back transaction). */
async function mutate<T>(kind: UserDataKind, fn: (m: MemoState) => T): Promise<T> {
  const draft = structuredClone(state.memo.value)
  const out = fn(draft)
  state.memo.set(draft)
  await changed(kind)
  return structuredClone(out)
}

/** Applies `next(prev)` to every ayah of `from..=to`; answers one row per ayah. */
function updateRange(
  m: MemoState,
  from: number,
  to: number,
  now: number,
  next: (prev: Schedule) => Schedule | null,
): MemoProgress[] {
  const rows = new Map(m.progress.map((p) => [p.ayahId, p] as const))
  const out: MemoProgress[] = []
  for (let id = from; id <= to; id++) {
    const row = rows.get(id)
    const prev: Schedule = row ? stored(row) : { ...NEW_SCHEDULE }
    const s = next(prev)
    if (s === null) {
      rows.delete(id)
      out.push(seen(id, NEW_SCHEDULE, now))
    } else {
      rows.set(id, { ayahId: id, ...s })
      out.push(seen(id, s, now))
    }
  }
  m.progress = [...rows.values()].sort((a, b) => a.ayahId - b.ayahId)
  return out
}

/** A stored row as a schedule (the slice keeps the stored status, never the derived `review`). */
function stored(p: MemoProgress): Schedule {
  const { ayahId: _id, ...s } = p
  return s
}

// --- presets --------------------------------------------------------------------------------------------------------

/** One line of at most 100 characters, trimmed. */
function presetName(raw: string): string {
  const name = raw.trim()
  if (name === '') throw new MockError('invalid_argument', 'preset name is empty')
  if ([...name].length > PRESET_NAME_MAX_CHARS) {
    throw new MockError('invalid_argument', `preset name is longer than ${PRESET_NAME_MAX_CHARS} characters`)
  }
  return name
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** `Settings::validated` rules for the preset's numbers. */
function clampGap(gap: GapSetting): GapSetting {
  switch (gap.type) {
    case 'none':
      return gap
    case 'fixed':
      return {
        type: 'fixed',
        data: { ms: clamp(gap.data.ms, SETTING_LIMITS.gapFixedMs.min, SETTING_LIMITS.gapFixedMs.max) },
      }
    case 'multiplier':
      return {
        type: 'multiplier',
        data: {
          pct: clamp(gap.data.pct, SETTING_LIMITS.gapMultiplierPct.min, SETTING_LIMITS.gapMultiplierPct.max),
        },
      }
  }
}

function clampSpeed(pct: number): number {
  const { min, max, step } = SETTING_LIMITS.speedPct
  return Math.min(max, Math.max(min, Math.round(pct / step) * step))
}

const nocase = (s: string) => s.replace(/[A-Z]/gu, (c) => c.toLowerCase())

function sortPresets(list: LoopPreset[]): LoopPreset[] {
  return list.sort((a, b) => {
    const x = nocase(a.name)
    const y = nocase(b.name)
    return x < y ? -1 : x > y ? 1 : a.id - b.id
  })
}

export const memoHandlers: Handlers<
  | 'memoProgress'
  | 'memoSetStatus'
  | 'memoReview'
  | 'memoTestStart'
  | 'memoTestFinish'
  | 'loopPresetList'
  | 'loopPresetUpsert'
  | 'loopPresetDelete'
> = {
  memoProgress: handle((fromAyahId: number, toAyahId: number) => {
    assertAyahRange(fromAyahId, toAyahId, AYAH_COUNT)
    const now = nowSecs()
    return state.memo.value.progress
      .filter((p) => p.ayahId >= fromAyahId && p.ayahId <= toAyahId)
      .sort((a, b) => a.ayahId - b.ayahId)
      .map((p) => seen(p.ayahId, stored(p), now))
  }),

  memoSetStatus: handle((fromAyahId: number, toAyahId: number, status: MemoStatus) => {
    assertAyahRange(fromAyahId, toAyahId, AYAH_COUNT)
    if (!['new', 'learning', 'memorized', 'review'].includes(status)) {
      throw new MockError('invalid_argument', `status ${String(status)}`)
    }
    const now = nowSecs()
    return mutate('memo', (m) =>
      updateRange(m, fromAyahId, toAyahId, now, (prev) => scheduleSetStatus(prev, status, now)),
    )
  }),

  memoReview: handle((input: MemoReviewInput) => {
    assertAyahRange(input.fromAyahId, input.toAyahId, AYAH_COUNT)
    checkRating(input.rating)
    const now = nowSecs()
    return mutate('memo', (m) =>
      updateRange(m, input.fromAyahId, input.toAyahId, now, (prev) =>
        scheduleReview(prev, input.rating, now),
      ),
    )
  }),

  memoTestStart: handle((fromAyahId: number, toAyahId: number) => {
    assertAyahRange(fromAyahId, toAyahId, AYAH_COUNT)
    const start = fromAyahId + Math.floor(Math.random() * (toAyahId - fromAyahId + 1))
    const now = nowSecs()
    return mutate('memo', (m) => {
      const test: MemoTest = {
        id: m.nextTestId,
        fromAyahId,
        toAyahId,
        startAyahId: Math.min(toAyahId, start),
        startedAt: now,
        finishedAt: null,
        reveals: null,
        mistakes: null,
        rating: null,
      }
      m.nextTestId += 1
      m.tests.push(test)
      return test
    })
  }),

  memoTestFinish: handle((result: MemoTestResult) => {
    checkRating(result.rating)
    assertRange('reveals', result.reveals, 0, 0xffff_ffff)
    assertRange('mistakes', result.mistakes, 0, 0xffff_ffff)
    const known = state.memo.value.tests.find((t) => t.id === result.id)
    if (!known) throw new MockError('not_found', `memo test ${result.id}`)
    if (known.finishedAt !== null) {
      throw new MockError('invalid_argument', `memo test ${result.id} is already finished`)
    }
    const now = nowSecs()
    return mutate('memo', (m) => {
      const t = m.tests.find((x) => x.id === result.id)
      if (!t) throw new MockError('not_found', `memo test ${result.id}`)
      t.finishedAt = now
      t.reveals = result.reveals
      t.mistakes = result.mistakes
      t.rating = result.rating
      return t
    })
  }),

  loopPresetList: handle(() => sortPresets(structuredClone(state.memo.value.presets))),

  loopPresetUpsert: handle((input: LoopPresetInput) => {
    const name = presetName(input.name)
    assertAyahRange(input.fromAyahId, input.toAyahId, AYAH_COUNT)
    const { min, max } = SETTING_LIMITS.repeat
    const values = {
      name,
      reciterId: input.reciterId,
      fromAyahId: input.fromAyahId,
      toAyahId: input.toAyahId,
      ayahRepeat: clamp(input.ayahRepeat, min, max),
      rangeRepeat: clamp(input.rangeRepeat, min, max),
      gap: clampGap(input.gap),
      speedPct: clampSpeed(input.speedPct),
    }
    if (input.id !== null && !state.memo.value.presets.some((p) => p.id === input.id)) {
      throw new MockError('not_found', `loop preset ${input.id}`)
    }
    const now = nowSecs()
    return mutate('presets', (m) => {
      if (input.id === null) {
        const preset: LoopPreset = { id: m.nextPresetId, ...values, createdAt: now, updatedAt: now }
        m.nextPresetId += 1
        m.presets.push(preset)
        return preset
      }
      const i = m.presets.findIndex((p) => p.id === input.id)
      const prev = m.presets[i]
      if (!prev) throw new MockError('not_found', `loop preset ${input.id}`)
      const preset: LoopPreset = { ...prev, ...values, updatedAt: now }
      m.presets[i] = preset
      return preset
    })
  }),

  loopPresetDelete: handle((id: number) => {
    if (!state.memo.value.presets.some((p) => p.id === id)) {
      throw new MockError('not_found', `loop preset ${id}`)
    }
    return mutate('presets', (m) => {
      m.presets = m.presets.filter((p) => p.id !== id)
      return null
    })
  }),
}
