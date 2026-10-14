import { describe, expect, it } from 'vitest'
import { dropWoffFallbacks, woff2Only } from './woff2-only.ts'

const FONTSOURCE = `/* ibm-plex-sans-arabic-arabic-400-normal */
@font-face {
  font-family: 'IBM Plex Sans Arabic';
  font-weight: 400;
  src: url(./files/a-400.woff2) format('woff2'), url(./files/a-400.woff) format('woff');
  unicode-range: U+0600-06FF;
}
`

describe('dropWoffFallbacks', () => {
  it('keeps the WOFF2 source and drops the WOFF 1 fallback (formatted CSS)', () => {
    const { css, removed } = dropWoffFallbacks(FONTSOURCE)
    expect(removed).toEqual(['./files/a-400.woff'])
    expect(css).toBe(FONTSOURCE.replace(", url(./files/a-400.woff) format('woff')", ''))
  })

  it('handles minified CSS, inlined data: URIs (commas inside url()) and several faces', () => {
    const woff2 = 'url(data:font/woff2;base64,d09GMgABAAAAAAWo)format("woff2")'
    const woff = 'url(data:font/woff;base64,d09GRgABAAAAAAZ)format("woff")'
    const input =
      `a{color:red}@font-face{font-family:X;src:${woff2},${woff};unicode-range:U+0460-052F}` +
      '@font-face{font-family:Y;src:url(/assets/y-AbC.woff2)format("woff2"),url(/assets/y-DeF.woff)format("woff")}' +
      'b{src:url(keep.woff)format("woff")}'
    const { css, removed } = dropWoffFallbacks(input)
    expect(removed).toEqual(['data:font/woff;base64,d09GRgABAAAAAAZ', '/assets/y-DeF.woff'])
    expect(css).toBe(
      `a{color:red}@font-face{font-family:X;src:${woff2};unicode-range:U+0460-052F}` +
        '@font-face{font-family:Y;src:url(/assets/y-AbC.woff2)format("woff2")}' +
        'b{src:url(keep.woff)format("woff")}',
    )
  })

  it('leaves a face alone when WOFF 1 is its only source, and leaves other formats alone', () => {
    const only = '@font-face{font-family:Z;src:url(z.woff)format("woff")}'
    const hafs = "@font-face{font-family:'qd-hafs';src:url('/fonts/KFGQPC-Hafs-V30.ttf') format('truetype')}"
    expect(dropWoffFallbacks(only)).toEqual({ css: only, removed: [] })
    expect(dropWoffFallbacks(hafs)).toEqual({ css: hafs, removed: [] })
  })

  it('accepts quoted URLs and unquoted format names', () => {
    const input = `@font-face{src:url("a b.woff2") format(woff2), url('a b.woff') format(woff)}`
    expect(dropWoffFallbacks(input)).toEqual({
      css: '@font-face{src:url("a b.woff2") format(woff2)}',
      removed: ['a b.woff'],
    })
  })
})

describe('woff2Only plugin', () => {
  type Asset = { type: 'asset'; fileName: string; source: string | Uint8Array }
  type Chunk = { type: 'chunk'; fileName: string; code: string }

  /** Runs the plugin's generateBundle on a fake bundle. */
  function run(bundle: Record<string, Asset | Chunk>): string[] {
    const plugin = woff2Only()
    const logged: string[] = []
    const configResolved = plugin.configResolved as (config: unknown) => void
    configResolved({ logger: { info: (m: string) => logged.push(m) } })
    const generate = plugin.generateBundle as (options: unknown, bundle: unknown) => void
    generate({}, bundle)
    return logged
  }

  it('rewrites the stylesheet and deletes the orphaned .woff assets only', () => {
    const bundle: Record<string, Asset | Chunk> = {
      'assets/index-1.css': {
        type: 'asset',
        fileName: 'assets/index-1.css',
        source:
          '@font-face{src:url(/assets/a-1.woff2)format("woff2"),url(/assets/a-1.woff)format("woff")}' +
          '@font-face{src:url(/assets/b-2.woff2)format("woff2"),url(/assets/b-2.woff)format("woff")}',
      },
      'assets/a-1.woff2': { type: 'asset', fileName: 'assets/a-1.woff2', source: new Uint8Array(10) },
      'assets/a-1.woff': { type: 'asset', fileName: 'assets/a-1.woff', source: new Uint8Array(2048) },
      'assets/b-2.woff': { type: 'asset', fileName: 'assets/b-2.woff', source: new Uint8Array(1024) },
      // Still referenced by a script, so it stays.
      'assets/index-2.js': {
        type: 'chunk',
        fileName: 'assets/index-2.js',
        code: 'new URL("/assets/b-2.woff")',
      },
      'assets/other.woff': { type: 'asset', fileName: 'assets/other.woff', source: new Uint8Array(8) },
    }
    const logged = run(bundle)
    expect(Object.keys(bundle).sort()).toEqual([
      'assets/a-1.woff2',
      'assets/b-2.woff',
      'assets/index-1.css',
      'assets/index-2.js',
      'assets/other.woff',
    ])
    expect((bundle['assets/index-1.css'] as Asset).source).toBe(
      '@font-face{src:url(/assets/a-1.woff2)format("woff2")}@font-face{src:url(/assets/b-2.woff2)format("woff2")}',
    )
    expect(logged).toEqual(['[qd] woff2-only: dropped 1 WOFF 1 fallback font file(s), 2 KiB'])
  })

  it('applies to production builds only', () => {
    const plugin = woff2Only()
    expect(plugin.apply).toBe('build')
    expect(plugin.enforce).toBe('post')
  })
})
