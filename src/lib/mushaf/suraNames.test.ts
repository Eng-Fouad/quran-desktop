import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SURA_NAMES_INK, SURA_NAMES_SHA256, suraNameGlyph, suraNameInk } from './suraNames'

describe('sura-names face', () => {
  it('maps a surah to its glyph (§9.7: the padded number read as hex)', () => {
    expect(suraNameGlyph(1).codePointAt(0)).toBe(0xe001)
    expect(suraNameGlyph(10).codePointAt(0)).toBe(0xe010)
    expect(suraNameGlyph(99).codePointAt(0)).toBe(0xe099)
    expect(suraNameGlyph(114).codePointAt(0)).toBe(0xe114)
  })

  it('was measured on the file the catalog pins (a new file needs scripts/sura_names_ink.py again)', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src-tauri/resources/catalog.json'), 'utf8'),
    ) as {
      packs: { id: string; source: { files?: { path: string; sha256?: string }[] } }[]
    }
    const file = catalog.packs
      .find((p) => p.id === 'decor')
      ?.source.files?.find((f) => f.path === 'sura-names.woff2')
    expect(file?.sha256).toBe(SURA_NAMES_SHA256)
  })

  it('boxes each name by its ink: Yusuf past its advance on the right, every name short of it on the left', () => {
    expect(SURA_NAMES_INK).toHaveLength(114)
    const yusuf = suraNameInk(12)
    expect(yusuf?.left).toBeCloseTo(0.27, 2)
    expect(yusuf?.right).toBeCloseTo(1518 / 1024 + 0.246, 3)
    for (const [i, [advance]] of SURA_NAMES_INK.entries()) {
      const n = i + 1
      const ink = suraNameInk(n)
      if (!ink) throw new Error(`surah ${n}: no ink`)
      expect(ink.left, `surah ${n}`).toBeGreaterThan(0.16)
      expect(ink.left, `surah ${n}`).toBeLessThan(0.41)
      if (n !== 12) expect(Math.abs(advance / 1024 - ink.right), `surah ${n}`).toBeLessThan(0.05)
    }
    expect(suraNameInk(0)).toBeNull()
    expect(suraNameInk(115)).toBeNull()
  })
})
