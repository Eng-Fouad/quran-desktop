/**
 * The packs store against the browser mock (§7.3, §5.17; WP12a acceptance): the job map, and install / pause / resume /
 * cancel / fail / retry / remove / update, items, the one-job-per-pack queue, connectivity, disk usage and the
 * onboarding starter set (§2.5.4).
 */
import { flushSync } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, call, initIpc } from '$lib/ipc'
import type { Bootstrap, JobPhase, PackInfo } from '$lib/ipc/bindings'
import {
  MAX_RUNNING,
  MOCK_RATE_KIB_S,
  packsChannels,
  packsMock,
  recordCachedItem,
  recordStreamCached,
} from '$lib/ipc/mock/handlers/packs'
import { state } from '$lib/ipc/mock/state'
import { app } from './app.svelte'
import { isActivePhase, packs, surahWords } from './packs.svelte'
import { quran } from './quran.svelte'
import { settings } from './settings.svelte'
import { ui } from './ui.svelte'

const RECITER = 'audio.qdc.7'

function stubMatchMedia(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

async function boot(): Promise<Bootstrap> {
  localStorage.clear()
  await initIpc()
  packsMock.reset()
  state.resetAll()
  state.loadAll()
  const b = await call(api.appBootstrap())
  app.init(b)
  settings.init(b)
  quran.init(b)
  ui.init(b)
  await packs.init(b)
  return b
}

/** Advances the fake clock in 100 ms steps (the mock's tick), flushing promises and effects in between. */
async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 100) {
    await vi.advanceTimersByTimeAsync(100)
    flushSync()
  }
}

/** Runs the clock until `done()` holds; fails after `maxMs` of simulated time. */
async function until(done: () => boolean, maxMs = 120_000): Promise<void> {
  for (let t = 0; t <= maxMs; t += 100) {
    flushSync()
    if (done()) return
    await vi.advanceTimersByTimeAsync(100)
  }
  throw new Error(`condition not met within ${maxMs} ms`)
}

/** Lets debounced refreshes (list, items, usage) land. */
async function settle(): Promise<void> {
  await run(600)
}

function pack(id: string): PackInfo {
  const p = packs.pack(id)
  if (!p) throw new Error(`no pack ${id}`)
  return p
}

function phaseOf(id: string): JobPhase | undefined {
  return packs.jobs.get(id)?.phase
}

/** Records every phase a pack's job goes through. */
function watchPhases(id: string): JobPhase[] {
  const seen: JobPhase[] = []
  const channel = packsChannels.events
  if (!channel) throw new Error('not subscribed')
  const forward = channel.onmessage
  channel.onmessage = (e) => {
    forward(e)
    if (e.data.packId !== id) return
    const phase: JobPhase = e.type === 'started' || e.type === 'progress' ? 'downloading' : e.type
    if (seen.at(-1) !== phase) seen.push(phase)
  }
  return seen
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  stubMatchMedia()
  await boot()
})

afterEach(() => {
  packs.reset()
  packsMock.reset()
  ui.reset()
  quran.reset()
  settings.reset()
  app.reset()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('packs store: catalogue and job map', () => {
  it('loads the catalogue and subscribes to download events at init', () => {
    expect(packs.status).toBe('ready')
    expect(packs.list.length).toBeGreaterThan(20)
    expect(packs.list.every((p) => p.state.type === 'not_installed')).toBe(true)
    expect(packs.jobs.size).toBe(0)
    expect(packs.activeJobs).toEqual([])
    expect(packsChannels.events).not.toBeNull()
    expect(packs.byKind.recitation?.some((p) => p.id === RECITER)).toBe(true)
  })

  it('installs a whole pack: queued → downloading → verifying → installing → completed', async () => {
    const id = 'tr.en.saheeh'
    const phases = watchPhases(id)
    await packs.install(id)
    flushSync()
    expect(isActivePhase(phaseOf(id) ?? 'completed')).toBe(true)
    expect(packs.activeJobs.map((j) => j.packId)).toEqual([id])
    await until(() => !packs.jobs.has(id))
    await settle()
    expect(phases).toEqual(['queued', 'downloading', 'verifying', 'installing', 'completed'])
    expect(pack(id).state).toEqual({ type: 'installed', data: { version: pack(id).version } })
    expect(packs.installedTranslations.map((p) => p.id)).toEqual([id])
    expect(packs.activeJobs).toEqual([])
    // A translation downloaded in full joins the reading translations (§1.4).
    expect(settings.value.translations).toEqual([id])
  })

  it('puts a downloaded tafsir to use only when none is chosen, and never for an update', async () => {
    await packs.install('tafsir.ar.muyassar')
    await until(() => !packs.jobs.has('tafsir.ar.muyassar'))
    await settle()
    expect(settings.value.tafsirPackId).toBe('tafsir.ar.muyassar')
    await packs.install('tafsir.en.ibn_kathir')
    await until(() => !packs.jobs.has('tafsir.en.ibn_kathir'))
    await settle()
    expect(settings.value.tafsirPackId).toBe('tafsir.ar.muyassar')
  })

  it('reports progress at 2 MB/s with a rate and an ETA', async () => {
    const id = 'mushaf.v1'
    await packs.install(id)
    await run(3_000)
    const job = packs.jobs.get(id)
    expect(job?.phase).toBe('downloading')
    // 3 s at 2 MB/s ≈ 5.7 MiB (the rate wobbles ±6 %).
    expect(job?.receivedKib).toBeGreaterThan(MOCK_RATE_KIB_S * 2.6)
    expect(job?.receivedKib).toBeLessThan(MOCK_RATE_KIB_S * 3.4)
    expect(job?.rateKibS).toBeGreaterThan(0)
    expect(job?.etaS).toBeGreaterThan(0)
    expect(job?.itemsDone).toBeGreaterThan(10)
    expect(job?.itemsTotal).toBe(604)
  })

  it('never brings back a job that ended, even for late events', async () => {
    const id = 'decor'
    await packs.install(id)
    const jobId = packs.jobs.get(id)?.jobId ?? 0
    await until(() => !packs.jobs.has(id))
    packsChannels.events?.onmessage({
      type: 'progress',
      data: {
        jobId,
        packId: id,
        receivedKib: 1,
        totalKib: 2,
        itemsDone: 0,
        itemsTotal: 1,
        rateKibS: 1,
        etaS: 1,
      },
    })
    await packs.refresh()
    expect(packs.jobs.has(id)).toBe(false)
  })

  it('runs at most three jobs at once; the rest wait in the queue', async () => {
    const ids = ['tafsir.en.ibn_kathir', 'tafsir.en.maarif', 'tafsir.ar.saadi', 'wbw.en']
    for (const id of ids) await packs.install(id)
    await run(300)
    const running = ids.filter((id) => phaseOf(id) === 'downloading')
    expect(running).toEqual(ids.slice(0, MAX_RUNNING))
    expect(phaseOf('wbw.en')).toBe('queued')
    expect(packs.activeJobs).toHaveLength(ids.length)
    await packs.cancel('tafsir.en.maarif')
    await run(300)
    expect(phaseOf('wbw.en')).toBe('downloading')
  })

  it('brings what a full Mushaf requires (the ornaments) along', async () => {
    await packs.install('mushaf.v2')
    flushSync()
    expect(packs.jobs.has('decor')).toBe(true)
    await until(() => !packs.jobs.has('decor'))
    await settle()
    expect(pack('decor').state.type).toBe('installed')
  })
})

describe('packs store: pause, resume, cancel, failure and retry', () => {
  it('pauses and resumes a download where it stopped', async () => {
    const id = 'mushaf.v1'
    await packs.install(id)
    await run(1_500)
    await packs.pause(id)
    await settle()
    const paused = packs.jobs.get(id)
    expect(paused?.phase).toBe('paused')
    expect(pack(id).state.type).toBe('paused')
    expect(packs.activeJobs).toEqual([])
    const present = paused?.itemsDone ?? 0
    expect(present).toBeGreaterThan(0)

    await run(2_000)
    expect(packs.jobs.get(id)?.itemsDone).toBe(present) // nothing moves while paused

    await packs.resume(id)
    await run(300)
    const resumed = packs.jobs.get(id)
    expect(resumed?.phase).toBe('downloading')
    expect(resumed?.jobId).toBeGreaterThan(paused?.jobId ?? 0)
    // The resumed job fetches only what is missing.
    expect(resumed?.itemsTotal).toBe(604 - present)
  })

  it('cancels: a whole pack is discarded, a per-item pack keeps finished items', async () => {
    await packs.install('tafsir.ar.muyassar')
    await run(200)
    await packs.cancel('tafsir.ar.muyassar')
    await settle()
    expect(packs.jobs.has('tafsir.ar.muyassar')).toBe(false)
    expect(pack('tafsir.ar.muyassar').state.type).toBe('not_installed')

    await packs.install('mushaf.v4')
    await run(1_000)
    await packs.cancel('mushaf.v4')
    await settle()
    expect(packs.jobs.has('mushaf.v4')).toBe(false)
    const state4 = pack('mushaf.v4').state
    expect(state4.type).toBe('partial')
    if (state4.type === 'partial') expect(state4.data.itemsPresent).toBeGreaterThan(0)
  })

  it('fails a job (pack state and job error) and retries it', async () => {
    const id = 'tr.ur.junagarhi'
    packsMock.failNext(id, 'integrity', 40)
    await packs.install(id)
    await until(() => phaseOf(id) === 'failed')
    await settle()
    expect(packs.jobs.get(id)?.error?.kind).toBe('integrity')
    expect(pack(id).state.type).toBe('failed')
    expect(packs.activeJobs).toEqual([])

    await packs.retry(id)
    await until(() => !packs.jobs.has(id))
    await settle()
    expect(pack(id).state.type).toBe('installed')
  })

  it('toasts a failure with Retry outside the Downloads view, and stays quiet inside it', async () => {
    const toast = vi.spyOn(ui, 'toast')
    packsMock.failNext('tr.fr.rashid', 'network', 50)
    await packs.install('tr.fr.rashid')
    await until(() => phaseOf('tr.fr.rashid') === 'failed')
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'danger', action: expect.objectContaining({ label: 'Retry' }) }),
    )
    toast.mockClear()
    ui.setView('downloads')
    packsMock.failNext('tr.de.bubenheim', 'network', 50)
    await packs.install('tr.de.bubenheim')
    await until(() => phaseOf('tr.de.bubenheim') === 'failed')
    expect(toast).not.toHaveBeenCalled()
  })

  it('fails with `offline` while network use is off, and resumes when it is allowed again', async () => {
    const id = 'tr.es.garcia'
    settings.update({ networkAllowed: false })
    await run(200)
    expect(app.online).toBe(false)
    await packs.install(id)
    await until(() => phaseOf(id) === 'failed')
    expect(packs.jobs.get(id)?.error?.kind).toBe('offline')

    settings.update({ networkAllowed: true })
    await until(() => !packs.jobs.has(id))
    await settle()
    expect(pack(id).state.type).toBe('installed')
  })
})

describe('packs store: "Download when online" (a request that waits, never a failure)', () => {
  const SURAH = 18

  it('waits for a connection while network use is off, then downloads by itself, with no failure on the way', async () => {
    const toast = vi.spyOn(ui, 'toast')
    const install = vi.spyOn(api, 'packsInstall')
    settings.update({ networkAllowed: false })
    await run(200)
    expect(packs.canDownload).toBe(false)
    await packs.loadItems(RECITER)

    expect(await packs.installWhenOnline(RECITER, { type: 'items', data: { items: [SURAH] } })).toBe(
      'waiting',
    )
    await settle()
    expect(install).not.toHaveBeenCalled()
    expect(packs.jobs.has(RECITER)).toBe(false)
    expect(packs.isWaiting(RECITER)).toBe(true)
    expect(packs.waiting.get(RECITER)).toEqual({ type: 'items', data: { items: [SURAH] } })
    // A second request merges into the one that waits.
    await packs.installWhenOnline(RECITER, { type: 'items', data: { items: [2] } })
    expect(packs.waiting.get(RECITER)).toEqual({ type: 'items', data: { items: [2, SURAH] } })

    settings.update({ networkAllowed: true })
    await until(() => !packs.isWaiting(RECITER))
    expect(install).toHaveBeenCalledWith(RECITER, { type: 'items', data: { items: [2, SURAH] } })
    expect(isActivePhase(phaseOf(RECITER) ?? 'failed')).toBe(true)
    await until(() => !packs.jobs.has(RECITER))
    await settle()
    const pinned = (packs.items.get(RECITER) ?? []).filter((i) => i.pinned).map((i) => i.item)
    expect(pinned).toEqual([1, 2, SURAH])
    expect(toast.mock.calls.some(([t]) => t.tone === 'danger')).toBe(false)
  })

  it('starts at once when downloads can run; an offline failure of it waits again, quietly', async () => {
    const toast = vi.spyOn(ui, 'toast')
    packsMock.failNext(RECITER, 'offline', 0)
    expect(await packs.installWhenOnline(RECITER, { type: 'items', data: { items: [SURAH] } })).toBe(
      'started',
    )
    await until(() => packs.isWaiting(RECITER))
    expect(packs.jobs.has(RECITER)).toBe(false) // no Failed row, no Retry
    expect(toast.mock.calls.some(([t]) => t.tone === 'danger')).toBe(false)
    // Cancel drops the request (there is no job to cancel).
    const cancel = vi.spyOn(api, 'packsCancel')
    await packs.cancel(RECITER)
    expect(packs.isWaiting(RECITER)).toBe(false)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('a plain download that fails offline still reports it, and shows as waiting while offline', async () => {
    const id = 'tr.es.garcia'
    const toast = vi.spyOn(ui, 'toast')
    settings.update({ networkAllowed: false })
    await run(200)
    await packs.install(id)
    await until(() => phaseOf(id) === 'failed')
    expect(packs.isWaiting(id)).toBe(true)
    expect(toast.mock.calls.some(([t]) => t.tone === 'danger')).toBe(true)
  })
})

describe('packs store: what the rail flyout lists (owner request 2026-10-11)', () => {
  it('keeps the jobs that completed, newest first, one per pack, at most five', async () => {
    expect(packs.recent).toEqual([])
    await packs.install('tr.en.saheeh')
    await until(() => !packs.jobs.has('tr.en.saheeh'))
    expect(packs.recent).toEqual([
      expect.objectContaining({ packId: 'tr.en.saheeh', update: false, items: null }),
    ])
    expect(packs.recent[0]?.kib).toBe(pack('tr.en.saheeh').sizeKib)

    await packs.install(RECITER, { type: 'items', data: { items: [114] } })
    await until(() => !packs.jobs.has(RECITER))
    expect(packs.recent.map((f) => [f.packId, f.items])).toEqual([
      [RECITER, [114]],
      ['tr.en.saheeh', null],
    ])
    // The same pack again moves up instead of repeating.
    await packs.install(RECITER, { type: 'items', data: { items: [113] } })
    await until(() => !packs.jobs.has(RECITER))
    expect(packs.recent.map((f) => f.packId)).toEqual([RECITER, 'tr.en.saheeh'])

    for (const id of ['tr.fr.rashid', 'tr.es.garcia', 'tr.ur.junagarhi', 'wbw.en']) {
      await packs.install(id)
      await until(() => !packs.jobs.has(id))
    }
    expect(packs.recent.map((f) => f.packId)).toEqual([
      'wbw.en',
      'tr.ur.junagarhi',
      'tr.es.garcia',
      'tr.fr.rashid',
      RECITER,
    ])
    // A cancelled job finished nothing.
    packsMock.setRate(100)
    await packs.install('mushaf.v1')
    await run(300)
    await packs.cancel('mushaf.v1')
    await until(() => !packs.jobs.has('mushaf.v1'))
    expect(packs.recent[0]?.packId).toBe('wbw.en')
    packs.reset()
    expect(packs.recent).toEqual([])
  })

  it('lists what waits for a connection apart from the failed jobs', async () => {
    settings.update({ networkAllowed: false })
    await run(200)
    await packs.installWhenOnline(RECITER, { type: 'items', data: { items: [18] } })
    await packs.install('tr.es.garcia')
    await until(() => phaseOf('tr.es.garcia') === 'failed')
    expect(packs.waitingIds).toEqual([RECITER, 'tr.es.garcia'])
    expect(packs.failedJobs).toEqual([])

    settings.update({ networkAllowed: true })
    await until(() => packs.waitingIds.length === 0)
    packsMock.failNext('tr.fr.rashid', 'integrity', 0)
    await packs.install('tr.fr.rashid')
    await until(() => phaseOf('tr.fr.rashid') === 'failed')
    expect(packs.failedJobs.map((j) => j.packId)).toEqual(['tr.fr.rashid'])
    expect(packs.waitingIds).toEqual([])
  })
})

describe('packs store: items, remove and update', () => {
  it('downloads one surah with surah 1 (its basmala) and shows the queued items first', async () => {
    await packs.loadItems(RECITER)
    expect(packs.items.get(RECITER)).toEqual([])
    await packs.install(RECITER, { type: 'items', data: { items: [112] } })
    await settle()
    const queued = packs.items.get(RECITER) ?? []
    expect(queued.filter((i) => i.queued).map((i) => i.item)).toEqual([1, 112])
    await until(() => !packs.jobs.has(RECITER))
    await settle()
    const items = packs.items.get(RECITER) ?? []
    expect(items.map((i) => [i.item, i.pinned, i.queued])).toEqual([
      [1, true, false],
      [112, true, false],
    ])
    expect(items.every((i) => i.kib > 0)).toBe(true)
    expect(pack(RECITER).state).toEqual({ type: 'partial', data: { itemsPresent: 2, itemsTotal: 114 } })
  })

  it('queues items asked for while the pack downloads, and starts them as its next job', async () => {
    await packs.loadItems(RECITER)
    packsMock.setRate(100) // slow enough to click twice during the first job
    await packs.install(RECITER, { type: 'items', data: { items: [114] } })
    await packs.install(RECITER, { type: 'items', data: { items: [113] } })
    await packs.install(RECITER, { type: 'items', data: { items: [112] } })
    expect(packs.pending.get(RECITER)).toEqual({ type: 'items', data: { items: [112, 113] } })
    packsMock.setRate(null)
    await until(() => !packs.jobs.has(RECITER) && !packs.pending.has(RECITER))
    await settle()
    const pinned = (packs.items.get(RECITER) ?? []).filter((i) => i.pinned).map((i) => i.item)
    expect(pinned).toEqual([1, 112, 113, 114])
  })

  it('removes items but keeps surah 1 while another surah is downloaded', async () => {
    await packs.loadItems(RECITER)
    await packs.install(RECITER, { type: 'items', data: { items: [113, 114] } })
    await until(() => !packs.jobs.has(RECITER))
    const freed = await packs.removeItems(RECITER, [1, 114])
    await settle()
    expect(freed).toBeGreaterThan(0)
    expect((packs.items.get(RECITER) ?? []).map((i) => i.item)).toEqual([1, 113])
    await packs.removeItems(RECITER, [1, 113])
    await settle()
    expect(packs.items.get(RECITER)).toEqual([])
    expect(pack(RECITER).state.type).toBe('not_installed')
  })

  it('removes a pack and frees its space', async () => {
    await packs.install('tr.en.saheeh')
    await until(() => !packs.jobs.has('tr.en.saheeh'))
    await packs.loadUsage()
    expect(packs.usage?.translationKib).toBe(pack('tr.en.saheeh').sizeKib)
    await packs.remove('tr.en.saheeh')
    await settle()
    expect(pack('tr.en.saheeh').state.type).toBe('not_installed')
    expect(packs.usage?.translationKib).toBe(0)
  })

  it('updates an outdated pack (check, Update, installed at the catalogue version)', async () => {
    const id = 'tr.en.hilali_khan'
    state.packs.update((v) => {
      const p = v.list.find((x) => x.id === id)
      if (p) {
        p.state = { type: 'installed', data: { version: '0.9.0' } }
        p.installedKib = p.sizeKib
      }
    })
    await packs.refresh()
    await packs.checkUpdates()
    expect(pack(id).state).toEqual({
      type: 'update_available',
      data: { installed: '0.9.0', latest: pack(id).version },
    })
    expect(packs.updates.map((u) => u.packId)).toEqual([id])
    expect(packs.updatable.map((p) => p.id)).toEqual([id])
    const toast = vi.spyOn(ui, 'toast')
    await packs.update(id)
    await until(() => !packs.jobs.has(id))
    await settle()
    expect(pack(id).state).toEqual({ type: 'installed', data: { version: pack(id).version } })
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: `Updated ${pack(id).title.en}` }))
  })

  it('clears the streaming cache but keeps downloaded surahs', async () => {
    await packs.loadItems(RECITER)
    recordStreamCached(7, 36)
    recordStreamCached(7, 67)
    await packs.install(RECITER, { type: 'items', data: { items: [114] } })
    await until(() => !packs.jobs.has(RECITER))
    await settle()
    expect((packs.items.get(RECITER) ?? []).filter((i) => !i.pinned).map((i) => i.item)).toEqual([36, 67])
    await packs.loadUsage()
    expect(packs.usage?.audioStreamKib).toBeGreaterThan(0)
    const freed = await packs.clearStreamCache()
    await settle()
    expect(freed).toBe(packsMock.itemKib(RECITER, 36) + packsMock.itemKib(RECITER, 67))
    expect((packs.items.get(RECITER) ?? []).map((i) => i.item)).toEqual([1, 114])
    expect(packs.usage?.audioStreamKib).toBe(0)
  })

  it('joins concurrent item loads', async () => {
    const spy = vi.spyOn(api, 'packsItems')
    await Promise.all([packs.loadItems('mushaf.v2'), packs.loadItems('mushaf.v2')])
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('packs store: starter set (§2.5.4)', () => {
  it('is the exact set for the English UI in the hafs style', () => {
    const set = packs.starterSetFor({ uiLanguage: 'en', style: 'hafs', reciterId: 7 })
    expect(set.items.map((i) => [i.pack.id, i.fetch])).toEqual([
      ['decor', 'now'],
      ['tr.en.saheeh', 'now'],
      ['wbw.en', 'on_demand'],
      ['audio.qdc.7', 'timings_on_first_play'],
    ])
    expect(set.nowKib).toBe(pack('decor').sizeKib + pack('tr.en.saheeh').sizeKib)
  })

  it('defaults the Arabic UI to Al-Muyassar without word by word', () => {
    const set = packs.starterSetFor({ uiLanguage: 'ar', style: 'hafs', reciterId: 7 })
    expect(set.items.map((i) => i.pack.id)).toEqual(['decor', 'tafsir.ar.muyassar', 'audio.qdc.7'])
    expect(set.nowKib).toBe(pack('decor').sizeKib + pack('tafsir.ar.muyassar').sizeKib)
  })

  it('adds the style’s pages on demand, or now with “Download all pages”', () => {
    const lazy = packs.starterSetFor({ uiLanguage: 'en', style: 'qcf_v2', reciterId: 7 })
    expect(lazy.items.find((i) => i.pack.id === 'mushaf.v2')?.fetch).toBe('on_demand')
    const all = packs.starterSetFor({
      uiLanguage: 'en',
      style: 'qcf_v2',
      reciterId: 7,
      downloadAllPages: true,
      translation: null,
    })
    expect(all.items.map((i) => [i.pack.id, i.fetch])).toEqual([
      ['decor', 'now'],
      ['mushaf.v2', 'now'],
      ['wbw.en', 'on_demand'],
      ['audio.qdc.7', 'timings_on_first_play'],
    ])
    expect(all.nowKib).toBe(pack('decor').sizeKib + pack('mushaf.v2').sizeKib)
  })

  it('follows the settings in `starterSet`, and installs its `now` packs', async () => {
    expect(packs.starterSet.items.map((i) => i.pack.id)).toEqual([
      'decor',
      'tr.en.saheeh',
      'wbw.en',
      'audio.qdc.7',
    ])
    await packs.installStarter(packs.starterSet)
    await until(() => packs.activeJobs.length === 0)
    await settle()
    expect(pack('decor').state.type).toBe('installed')
    expect(pack('tr.en.saheeh').state.type).toBe('installed')
    expect(pack('wbw.en').state.type).toBe('not_installed')
    expect(packs.starterSet.nowKib).toBe(0)
  })
})

describe('packs store: estimates', () => {
  it('weighs surahs by their words', () => {
    const words = surahWords(quran.index)
    expect(words).toHaveLength(114)
    const p = pack(RECITER)
    expect(packs.itemKib(p, 2)).toBeGreaterThan(packs.itemKib(p, 108) * 50)
    expect(packs.remainingKib(p)).toBeGreaterThan(p.sizeKib * 0.98)
  })

  it('"the rest" leaves out what was fetched as you read, not only what was downloaded', async () => {
    for (const [id, fetched] of [
      ['mushaf.v2', 86],
      ['wbw.en', 30],
    ] as const) {
      const p = pack(id)
      expect(packs.remainingKib(p)).toBeGreaterThan(p.sizeKib * 0.98)
      for (let n = 1; n <= fetched; n++) recordCachedItem(id, n)
      await packs.loadItems(id)
      const items = packs.items.get(id) ?? []
      expect(items.length).toBe(fetched)
      expect(items.some((i) => i.pinned)).toBe(false)
      // Only the missing items are estimated: their share of the pack, never its full size.
      let missing = 0
      for (let n = fetched + 1; n <= p.itemCount; n++) missing += packs.itemKib(pack(id), n)
      expect(packs.remainingKib(pack(id))).toBe(missing)
      expect(packs.remainingKib(pack(id))).toBeLessThan(p.sizeKib * 0.95)
    }
  })
})
