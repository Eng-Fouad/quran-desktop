/**
 * The COLR probe on the real QCF fonts in a real browser: the V4 (COLRv0 + CPAL) ayah-end glyph shows palette
 * colour, the monochrome V2 glyph does not. Needs `data/dev-packs` (`cargo xtask fetch-dev-packs`); skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fixtures } from '$lib/ipc/mock/fixtures'
import { firstEndGlyph, probeColr } from './colrProbe'

const added: FontFace[] = []

async function face(family: string, url: string): Promise<boolean> {
  try {
    const res = await fetch(url)
    const bytes = await res.arrayBuffer()
    if (!res.ok || String.fromCharCode(...new Uint8Array(bytes).slice(0, 4)) !== 'wOF2') return false
    const f = new FontFace(family, bytes)
    document.fonts.add(f)
    await f.load()
    added.push(f)
    return true
  } catch {
    return false
  }
}

let available = false

beforeAll(async () => {
  const v4 = await face('qcf-v4-p50', '/data/dev-packs/mushaf/v4/p50.woff2')
  const v2 = await face('qcf-v2-p50', '/data/dev-packs/mushaf/v2/p50.woff2')
  available = v4 && v2 && fixtures.hasPage('qcf_v4', 50) && fixtures.hasPage('qcf_v2', 50)
})

afterAll(() => {
  for (const f of added) document.fonts.delete(f)
})

describe('probeColr on real QCF fonts', () => {
  it('sees palette colour in the V4 ayah-end glyph and none in the V2 one', async (ctx) => {
    if (!available) ctx.skip()
    const v4 = firstEndGlyph(await fixtures.page('qcf_v4', 50))
    const v2 = firstEndGlyph(await fixtures.page('qcf_v2', 50))
    expect(v4).not.toBeNull()
    expect(v2).not.toBeNull()
    await expect(probeColr('qcf-v4-p50', v4 ?? '')).resolves.toBe(true)
    await expect(probeColr('qcf-v2-p50', v2 ?? '')).resolves.toBe(false)
  })
})
