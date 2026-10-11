/**
 * The About screen's attribution data (§9.7): every static source is credited in both languages with an https link,
 * the groups come in the §9.7 order, and pack entries follow what is on disk (installed translations and tafsir with
 * their version, word-by-word packs with content, the Urdu Nastaliq font once installed).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PackInfo, PackState } from '$lib/ipc/bindings'
import {
  APP_GROUP,
  ATTRIBUTION_GROUPS,
  attributionGroups,
  attributions,
  hostOf,
  isOpenableUrl,
  NOTICE_PATHS,
  packAttribution,
  packLicence,
  QUL_PERMISSION,
  SOURCE_URL,
} from './attributions'

function pack(id: string, kind: PackInfo['kind'], state: PackState, extra: Partial<PackInfo> = {}): PackInfo {
  return {
    id,
    kind,
    title: { en: `${id} title`, ar: `عنوان ${id}` },
    description: { en: '', ar: '' },
    language: null,
    direction: null,
    version: '2026.10',
    installMode: 'whole',
    requires: [],
    sizeKib: 100,
    itemCount: 1,
    recommended: false,
    revalidateDays: null,
    attribution: {
      text: { en: 'QuranEnc.com — The Noble Qur’an Encyclopedia', ar: 'موسوعة القرآن الكريم — QuranEnc.com' },
      url: 'https://quranenc.com/en/browse/english_saheeh',
      licence: 'QuranEnc terms: republished unmodified, credited with its version, kept up to date',
    },
    state,
    installedKib: 0,
    job: null,
    ...extra,
  }
}

const installed = (version: string): PackState => ({ type: 'installed', data: { version } })
const none: PackState = { type: 'not_installed' }

const ids = (groups: ReturnType<typeof attributionGroups>, id: string) =>
  groups.find((g) => g.id === id)?.entries.map((e) => e.id) ?? []

describe('static sources', () => {
  const all = attributions.flatMap((g) => g.entries)

  it('credits each §9.7 source in both languages with an https link', () => {
    expect(all.map((e) => e.id)).toEqual([
      'qul',
      'kfgqpc',
      'tanzil',
      'kfgqpc-hafs',
      'qcf',
      'decor',
      'ui-fonts',
      'quranicaudio',
      'qf-timings',
    ])
    for (const e of all) {
      for (const field of [e.name, e.credit, e.licence]) {
        expect(field.en.trim()).not.toBe('')
        expect(field.ar.trim()).not.toBe('')
        expect(/[؀-ۿ]/u.test(field.ar) || /^[\x20-\x7e]+$/u.test(field.ar)).toBe(true)
      }
      expect(isOpenableUrl(e.url)).toBe(true)
      if (e.licenceUrl !== undefined) expect(isOpenableUrl(e.licenceUrl)).toBe(true)
    }
  })

  it('carries the exact credits the sources ask for', () => {
    const byId = new Map(all.map((e) => [e.id, e] as const))
    expect(byId.get('qcf')?.credit.en).toBe('Quran fonts provided by Quran Foundation')
    expect(byId.get('tanzil')?.licence.en).toContain('CC BY 3.0')
    expect(byId.get('tanzil')?.licenceUrl).toBe('https://creativecommons.org/licenses/by/3.0/')
    expect(byId.get('quranicaudio')?.licence.en).toMatch(/personal, non-commercial/)
    expect(byId.get('kfgqpc-hafs')?.notice).toBe('kfgqpc-hafs')
    expect(NOTICE_PATHS['kfgqpc-hafs']).toBe('fonts/KFGQPC-Hafs-V30.LICENSE.txt')
  })
})

describe('the app (LEAD.md item 16)', () => {
  const byId = new Map(APP_GROUP.entries.map((e) => [e.id, e] as const))

  it('is free software under GPL-3.0-or-later, with the full licence text', () => {
    const app = byId.get('app')
    expect(app?.name).toEqual({ en: 'Quran for Desktop', ar: 'قرآن لسطح المكتب' })
    expect(app?.credit.en).toContain('© Quran for Desktop contributors')
    expect(app?.licence.en).toContain('GPL-3.0-or-later')
    expect(app?.licence.ar).toContain('GPL-3.0-or-later')
    expect(app?.licenceUrl).toBe('https://www.gnu.org/licenses/gpl-3.0.html')
    expect(app?.notice).toBe('app-licence')
    // No website of its own: the link is to the source code.
    expect(isOpenableUrl(app?.url)).toBe(false)
  })

  it('links its source code (GPL-3.0 §6), the repository Cargo names', () => {
    const app = byId.get('app')
    expect(app?.sourceUrl).toBe(SOURCE_URL)
    expect(isOpenableUrl(SOURCE_URL)).toBe(true)
    const cargo = readFileSync(resolve(process.cwd(), 'Cargo.toml'), 'utf8')
    const repository = /^\[workspace\.package\][^[]*?^repository\s*=\s*"([^"]+)"/msu.exec(cargo)?.[1]
    expect(repository).toBe(SOURCE_URL)
  })

  it('credits its name and icon to Quran.com / quran_android (GPL-3.0)', () => {
    const icon = byId.get('app-icon')
    expect(icon?.credit.en).toContain('Quran.com / quran_android contributors')
    expect(icon?.credit.en).toContain('identity of the Quran.com project')
    expect(icon?.credit.ar).toContain('Quran.com')
    expect(icon?.licence.en).toBe('GPL-3.0')
    expect(icon?.url).toBe('https://github.com/quran/quran_android')
    expect(isOpenableUrl(icon?.licenceUrl)).toBe(true)
  })

  it('reads in both languages', () => {
    for (const e of APP_GROUP.entries) {
      for (const field of [e.name, e.credit, e.licence]) {
        expect(field.en.trim()).not.toBe('')
        expect(/[؀-ۿ]/u.test(field.ar)).toBe(true)
      }
    }
  })
})

describe('attributionGroups', () => {
  it('lists the groups in order and leaves word by word out until a pack has content', () => {
    const groups = attributionGroups({ packs: [], coreSource: 'qul' })
    expect(groups.map((g) => g.id)).toEqual(['app', 'text', 'fonts', 'translations', 'tafsir', 'recitations'])
    expect(ATTRIBUTION_GROUPS).toEqual([
      'app',
      'text',
      'fonts',
      'translations',
      'tafsir',
      'wbw',
      'recitations',
    ])
    expect(ids(groups, 'app')).toEqual(['app', 'app-icon'])
    expect(ids(groups, 'translations')).toEqual([])
    expect(ids(groups, 'text')).toEqual(['qul', 'kfgqpc', 'tanzil'])
  })

  it('credits the source core.db was built from: QUL for a release build, the Quran.com API for a qdc one', () => {
    expect(ids(attributionGroups({ packs: [], coreSource: 'qul' }), 'text')).toEqual([
      'qul',
      'kfgqpc',
      'tanzil',
    ])
    expect(ids(attributionGroups({ packs: [], coreSource: 'qdc' }), 'text')).toEqual([
      'qdc-dev',
      'kfgqpc',
      'tanzil',
    ])
    // Neither (the browser mock's synthetic data): only the sources every build uses.
    expect(ids(attributionGroups({ packs: [], coreSource: 'synthetic' }), 'text')).toEqual([
      'kfgqpc',
      'tanzil',
    ])
  })

  it('claims no licence for QUL until the written permission is recorded (FACT §8.1, R1)', () => {
    const qul = attributions.flatMap((g) => g.entries).find((e) => e.id === 'qul')
    if (QUL_PERMISSION === null) {
      expect(qul?.licence.en).toBe('QUL publishes no licence for this data')
      expect(qul?.licence.en).not.toMatch(/used with|licensed|permission of/i)
      expect(qul?.licence.ar).not.toContain('مستخدمة')
    } else {
      expect(qul?.licence).toEqual(QUL_PERMISSION)
    }
  })

  it('credits each installed translation and tafsir with its version, nothing that is not on disk', () => {
    const packs = [
      pack('tr.en.saheeh', 'translation', installed('1.1.2'), { language: 'en' }),
      pack('tr.fr.rashid', 'translation', none, { language: 'fr' }),
      pack('tr.en.hilali_khan', 'translation', {
        type: 'update_available',
        data: { installed: '1.1.1', latest: '1.1.2' },
      }),
      pack('tafsir.ar.muyassar', 'tafsir', installed('2025.03'), { language: 'ar' }),
      pack(
        'tafsir.en.ibn_kathir',
        'tafsir',
        { type: 'partial', data: { itemsPresent: 3, itemsTotal: 114 } },
        {
          installMode: 'on_demand',
          itemCount: 114,
        },
      ),
      pack('tafsir.ar.saadi', 'tafsir', none, { installMode: 'on_demand', itemCount: 114 }),
    ]
    const groups = attributionGroups({ packs, coreSource: 'qul' })
    expect(ids(groups, 'translations')).toEqual(['tr.en.saheeh', 'tr.en.hilali_khan'])
    expect(ids(groups, 'tafsir')).toEqual(['tafsir.ar.muyassar', 'tafsir.en.ibn_kathir'])
    const saheeh = groups.find((g) => g.id === 'translations')?.entries[0]
    expect(saheeh?.version).toBe('1.1.2')
    expect(saheeh?.language).toBe('en')
    expect(saheeh?.url).toBe('https://quranenc.com/en/browse/english_saheeh')
    // An update is offered, but the credited version is the one on disk.
    expect(groups.find((g) => g.id === 'translations')?.entries[1]?.version).toBe('1.1.1')
  })

  it('adds the word-by-word group and the Nastaliq font once they have content', () => {
    const packs = [
      pack('wbw.en', 'wbw', none, { installMode: 'on_demand', installedKib: 40, itemCount: 114 }),
      pack('wbw.ur', 'wbw', none, { installMode: 'on_demand', itemCount: 114 }),
      pack('decor.nastaliq', 'decor', installed('5.3.0'), {
        attribution: {
          text: { en: 'Noto Nastaliq Urdu by the Noto Project Authors', ar: 'خط نوتو نستعليق' },
          url: 'https://github.com/notofonts/nastaliq',
          licence: 'SIL Open Font License 1.1',
        },
      }),
      pack('decor', 'decor', installed('2026.10')),
    ]
    const groups = attributionGroups({ packs, coreSource: 'qul' })
    expect(groups.map((g) => g.id)).toEqual([
      'app',
      'text',
      'fonts',
      'translations',
      'tafsir',
      'wbw',
      'recitations',
    ])
    expect(ids(groups, 'wbw')).toEqual(['wbw.en'])
    // The ornaments are always credited as a source; the optional Nastaliq font only once installed.
    expect(ids(groups, 'fonts')).toEqual(['kfgqpc-hafs', 'qcf', 'decor', 'ui-fonts', 'decor.nastaliq'])
    const nastaliq = groups.find((g) => g.id === 'fonts')?.entries.at(-1)
    expect(nastaliq?.licence).toEqual({ en: 'SIL Open Font License 1.1', ar: 'رخصة SIL للخطوط المفتوحة 1.1' })
  })
})

describe('licence lines', () => {
  it('keeps the catalogue line in English and translates known sources for Arabic', () => {
    const p = pack('tr.en.saheeh', 'translation', installed('1.1.2'))
    expect(packLicence(p).en).toBe(p.attribution.licence)
    expect(packLicence(p).ar).toMatch(/موسوعة القرآن الكريم/)
  })

  it('falls back to the catalogue line for an unknown host', () => {
    const p = pack('tr.xx.test', 'translation', installed('1'), {
      attribution: { text: { en: 'X', ar: 'س' }, url: 'https://example.org/x', licence: 'Custom terms' },
    })
    expect(packLicence(p)).toEqual({ en: 'Custom terms', ar: 'Custom terms' })
    expect(packAttribution(p).credit).toEqual({ en: 'X', ar: 'س' })
  })

  it('opens https links only', () => {
    expect(hostOf('https://www.quranenc.com/en')).toBe('quranenc.com')
    expect(hostOf('http://tanzil.net')).toBeNull()
    expect(hostOf('javascript:alert(1)')).toBeNull()
    expect(isOpenableUrl(undefined)).toBe(false)
    expect(isOpenableUrl('not a url')).toBe(false)
  })
})
