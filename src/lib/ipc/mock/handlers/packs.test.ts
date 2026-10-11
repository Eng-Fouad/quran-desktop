/**
 * The packs mock handlers (§5.17; WP12a): the contract errors of the job runner (WP5b), items, the demo seed, scripted
 * failures and the restart of interrupted jobs.
 */
import { Channel } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { events, type DownloadEvent, type JobSnapshot } from '../../bindings'
import { installMockRuntime } from '../index'
import type { Result } from '../result'
import { state } from '../state'
import {
  INSTALL_MS,
  packsChannels,
  packsHandlers as h,
  packsMock,
  recordStreamCached,
  VERIFY_MS,
} from './packs'

function data<T>(r: Result<T>): T {
  if (r.status !== 'ok') throw new Error(`${r.error.kind}: ${r.error.message}`)
  return r.data
}

function kind<T>(r: Result<T>): string | null {
  return r.status === 'error' ? r.error.kind : null
}

/** Subscribes a channel and records every event. */
async function subscribe(): Promise<DownloadEvent[]> {
  const seen: DownloadEvent[] = []
  const channel = new Channel<DownloadEvent>()
  channel.onmessage = (e) => seen.push(e)
  data(await h.packsSubscribe(channel))
  return seen
}

async function run(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

function job(packId: string): JobSnapshot | undefined {
  return state.packs.value.jobs.find((j) => j.packId === packId)
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  localStorage.clear()
  history.replaceState(null, '', '/')
  await installMockRuntime()
  packsMock.reset()
  state.resetAll()
  state.loadAll()
})

afterEach(() => {
  packsMock.reset()
  history.replaceState(null, '', '/')
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('packs mock: the job runner contract', () => {
  it('rejects unknown packs, item scopes of whole packs and items out of range', async () => {
    expect(kind(await h.packsInstall('nope', { type: 'all' }))).toBe('not_found')
    expect(kind(await h.packsInstall('tr.en.saheeh', { type: 'items', data: { items: [1] } }))).toBe(
      'invalid_argument',
    )
    expect(kind(await h.packsInstall('audio.qdc.7', { type: 'items', data: { items: [115] } }))).toBe(
      'invalid_argument',
    )
    expect(kind(await h.packsRemoveItems('tr.en.saheeh', [1]))).toBe('invalid_argument')
  })

  it('answers conflict while a job of the pack is queued or running', async () => {
    data(await h.packsInstall('tr.en.saheeh', { type: 'all' }))
    expect(kind(await h.packsInstall('tr.en.saheeh', { type: 'all' }))).toBe('conflict')
  })

  it('pause, resume and cancel need a job; pause is idempotent; resume returns a running job’s id', async () => {
    expect(kind(await h.packsPause('tr.en.saheeh'))).toBe('not_found')
    expect(kind(await h.packsResume('tr.en.saheeh'))).toBe('not_found')
    expect(kind(await h.packsCancel('tr.en.saheeh'))).toBe('not_found')
    const id = data(await h.packsInstall('mushaf.v1', { type: 'all' }))
    expect(data(await h.packsResume('mushaf.v1'))).toBe(id)
    data(await h.packsPause('mushaf.v1'))
    data(await h.packsPause('mushaf.v1'))
    expect(job('mushaf.v1')?.phase).toBe('paused')
    const resumed = data(await h.packsResume('mushaf.v1'))
    expect(resumed).toBeGreaterThan(id)
  })

  it('emits queued, started, progress, verifying, installing and completed, then packs-changed', async () => {
    const seen = await subscribe()
    const changed: string[][] = []
    const stop = await events.packsChanged.listen((e) => changed.push(e.payload.packIds))
    const id = data(await h.packsInstall('tr.en.saheeh', { type: 'all' }))
    await run(1_000 + VERIFY_MS + INSTALL_MS)
    stop()
    const types = [...new Set(seen.map((e) => e.type))]
    expect(types).toEqual(['queued', 'started', 'progress', 'verifying', 'installing', 'completed'])
    expect(seen.every((e) => e.data.jobId === id)).toBe(true)
    expect(changed).toEqual([['tr.en.saheeh']])
    const p = data(await h.packsList()).find((x) => x.id === 'tr.en.saheeh')
    expect(p?.state.type).toBe('installed')
    expect(p?.job).toBeNull()
  })

  it('reports queued items of a recitation job, surah 1 included', async () => {
    data(await h.packsInstall('audio.qdc.7', { type: 'items', data: { items: [36] } }))
    const items = data(await h.packsItems('audio.qdc.7'))
    expect(items.map((i) => [i.item, i.queued, i.kib])).toEqual([
      [1, true, 0],
      [36, true, 0],
    ])
    expect(data(await h.packsItems('tr.en.saheeh'))).toEqual([])
  })

  it('keeps finished items of a paused per-item job and lists the rest as queued', async () => {
    data(await h.packsInstall('mushaf.v4', { type: 'all' }))
    await run(1_000)
    data(await h.packsPause('mushaf.v4'))
    const items = data(await h.packsItems('mushaf.v4'))
    const done = items.filter((i) => i.pinned)
    expect(done.length).toBeGreaterThan(0)
    expect(items.filter((i) => i.queued)).toHaveLength(604 - done.length)
    const p = data(await h.packsList()).find((x) => x.id === 'mushaf.v4')
    expect(p?.state).toEqual({ type: 'paused', data: { itemsPresent: done.length, itemsTotal: 604 } })
    expect(p?.job?.phase).toBe('paused')
  })

  it('keeps an installed version through a failed update', async () => {
    state.packs.update((v) => {
      const p = v.list.find((x) => x.id === 'tr.en.saheeh')
      if (p) p.state = { type: 'installed', data: { version: '0.1.0' } }
    })
    packsMock.failNext('tr.en.saheeh', 'network', 50)
    data(await h.packsInstall('tr.en.saheeh', { type: 'all' }))
    await run(1_000)
    const p = data(await h.packsList()).find((x) => x.id === 'tr.en.saheeh')
    expect(p?.job?.phase).toBe('failed')
    expect(p?.job?.error?.kind).toBe('network')
    expect(p?.state.type).toBe('update_available')
    expect(data(await h.packsCheckUpdates()).map((u) => u.packId)).toEqual(['tr.en.saheeh'])
  })
})

describe('packs mock: URL switches, restart and caches', () => {
  it('fails a pack once with ?mockPackFail, then lets Retry succeed', async () => {
    history.replaceState(null, '', '/?mockPackFail=tr.fr.rashid:integrity@30')
    data(await h.packsInstall('tr.fr.rashid', { type: 'all' }))
    await run(1_000)
    expect(job('tr.fr.rashid')?.phase).toBe('failed')
    expect(job('tr.fr.rashid')?.error?.kind).toBe('integrity')
    data(await h.packsResume('tr.fr.rashid'))
    await run(2_000)
    expect(job('tr.fr.rashid')).toBeUndefined()
    const p = data(await h.packsList()).find((x) => x.id === 'tr.fr.rashid')
    expect(p?.state.type).toBe('installed')
  })

  it('seeds a lived-in state with ?mockPacks=demo', async () => {
    history.replaceState(null, '', '/?mockPacks=demo')
    const list = data(await h.packsList())
    const stateOf = (id: string) => list.find((p) => p.id === id)?.state.type
    expect(stateOf('decor')).toBe('installed')
    expect(stateOf('tr.en.saheeh')).toBe('installed')
    expect(stateOf('tr.en.hilali_khan')).toBe('update_available')
    expect(stateOf('audio.qdc.7')).toBe('partial')
    const items = data(await h.packsItems('audio.qdc.7'))
    expect(items.some((i) => i.item === 18 && i.pinned)).toBe(true)
    expect(items.some((i) => i.item === 2 && !i.pinned)).toBe(true)
    const usage = data(await h.packsDiskUsage())
    expect(usage.audioPinnedKib).toBeGreaterThan(0)
    expect(usage.audioStreamKib).toBeGreaterThan(0)
    expect(usage.totalKib).toBe(
      usage.mushafKib +
        usage.decorKib +
        usage.translationKib +
        usage.tafsirKib +
        usage.audioPinnedKib +
        usage.audioStreamKib +
        usage.contentDbKib +
        usage.userDbKib,
    )
  })

  it('queues an interrupted job again after a reload, and keeps a paused one paused', async () => {
    data(await h.packsInstall('mushaf.v2', { type: 'all' }))
    data(await h.packsInstall('mushaf.v1', { type: 'all' }))
    await run(1_200)
    data(await h.packsPause('mushaf.v1'))
    const before = job('mushaf.v2')?.itemsDone ?? 0
    expect(before).toBeGreaterThan(0)
    // A reload: the slices come back from localStorage (a new value object), the simulation from nothing.
    packsChannels.events = null
    state.loadAll()
    const seen = await subscribe()
    await run(500)
    expect(job('mushaf.v1')?.phase).toBe('paused')
    expect(job('mushaf.v2')?.phase).toBe('downloading')
    // Restored before the new subscription (as at startup): its progress reaches the new channel.
    expect(seen.some((e) => e.type === 'progress' && e.data.packId === 'mushaf.v2')).toBe(true)
    const items = data(await h.packsItems('mushaf.v2'))
    expect(items.filter((i) => i.pinned).length).toBeGreaterThanOrEqual(before)
  })

  it('records stream-cached audio for the audio mock, and clears it (and only it)', async () => {
    const changed: string[][] = []
    const stop = await events.packsChanged.listen((e) => changed.push(e.payload.packIds))
    recordStreamCached(7, 67)
    recordStreamCached(7, 67) // already cached: no second event
    data(await h.packsInstall('audio.qdc.7', { type: 'items', data: { items: [112] } }))
    await run(1_000)
    await vi.advanceTimersByTimeAsync(0)
    stop()
    expect(changed[0]).toEqual(['audio.qdc.7'])
    expect(changed.filter((ids) => ids.includes('audio.qdc.7'))).toHaveLength(2) // the cache, then the job
    const freed = data(await h.packsClearStreamCache())
    expect(freed).toBe(packsMock.itemKib('audio.qdc.7', 67))
    expect(data(await h.packsItems('audio.qdc.7')).map((i) => i.item)).toEqual([1, 112])
  })

  it('clears the cache: unpinned audio and chapters go, page fonts and downloads stay', async () => {
    history.replaceState(null, '', '/?mockPacks=demo')
    data(await h.packsList())
    const freed = data(await h.cacheClear())
    expect(freed).toBeGreaterThan(0)
    expect(data(await h.packsItems('audio.qdc.7')).every((i) => i.pinned)).toBe(true)
    expect(data(await h.packsItems('wbw.en'))).toEqual([])
    expect(data(await h.packsItems('mushaf.v2')).length).toBeGreaterThan(0)
  })

  it('removes a pack, cancelling its job first', async () => {
    const seen = await subscribe()
    data(await h.packsInstall('mushaf.v1', { type: 'all' }))
    await run(500)
    data(await h.packsRemove('mushaf.v1'))
    expect(seen.at(-1)?.type).toBe('cancelled')
    expect(data(await h.packsItems('mushaf.v1'))).toEqual([])
    const p = data(await h.packsList()).find((x) => x.id === 'mushaf.v1')
    expect(p?.state.type).toBe('not_installed')
    expect(p?.job).toBeNull()
  })
})
