/**
 * The open-source licence helpers of the About screen: the committed `thirdparty.json` parses completely, a package's
 * text is its shared segments joined with a blank line, and the filter matches names, licences and authors.
 */
import { describe, expect, it } from 'vitest'
import raw from '$lib/about/thirdparty.json'
import {
  licenceText,
  matchesPackage,
  packageKey,
  parseThirdParty,
  type ThirdPartyPackage,
} from './thirdparty'

const pkg = (over: Partial<ThirdPartyPackage> = {}): ThirdPartyPackage => ({
  ecosystem: 'cargo',
  name: 'serde',
  version: '1.0.0',
  licence: 'MIT OR Apache-2.0',
  used: 'MIT',
  url: 'https://github.com/serde-rs/serde',
  authors: ['Erick Tryzelaar', 'David Tolnay'],
  texts: [0, 1],
  ...over,
})

describe('thirdparty.json', () => {
  it('parses every committed package', () => {
    const data = parseThirdParty(raw)
    expect(data.packages.length).toBe((raw as { packages: unknown[] }).packages.length)
    expect(data.packages.length).toBeGreaterThan(100)
    expect(data.packages.some((p) => p.ecosystem === 'npm' && p.name === 'svelte')).toBe(true)
    for (const p of data.packages) {
      expect(p.url).toMatch(/^https?:\/\//)
      for (const i of p.texts) expect(data.texts[i]).toBeTypeOf('string')
    }
  })

  it('carries licence text for every package (the xtask gate: nothing ships as "no licence file")', () => {
    const data = parseThirdParty(raw)
    const bare = data.packages.filter((p) => p.texts.length === 0 || licenceText(data, p).trim() === '')
    expect(bare.map(packageKey)).toEqual([])
  })

  it('drops malformed entries and out-of-range text indices', () => {
    const data = parseThirdParty({
      texts: ['A'],
      packages: [pkg({ texts: [0, 5] }), { ...pkg(), ecosystem: 'pip' }, { name: 'broken' }, null],
    })
    expect(data.packages).toHaveLength(1)
    expect(data.packages[0]?.texts).toEqual([0])
    expect(parseThirdParty(null)).toEqual({ packages: [], texts: [] })
  })
})

describe('helpers', () => {
  it('joins a package’s licence segments with a blank line', () => {
    const all = { packages: [], texts: ['Copyright (c) Serde', 'Permission is hereby granted…'] }
    expect(licenceText(all, pkg())).toBe('Copyright (c) Serde\n\nPermission is hereby granted…')
    expect(licenceText(all, pkg({ texts: [] }))).toBe('')
  })

  it('filters by name, licence and author, every word', () => {
    const p = pkg()
    expect(matchesPackage(p, '')).toBe(true)
    expect(matchesPackage(p, 'SERDE')).toBe(true)
    expect(matchesPackage(p, 'apache')).toBe(true)
    expect(matchesPackage(p, 'tolnay mit')).toBe(true)
    expect(matchesPackage(p, 'tolnay gpl')).toBe(false)
  })

  it('keys a package by ecosystem, name and version', () => {
    expect(packageKey(pkg())).toBe('cargo:serde@1.0.0')
  })
})
