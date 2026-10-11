/**
 * Cross-checks the token harness against a real browser (WP7a). The unit tests in tokens.test.ts trust
 * ./token-harness to compute what the browser computes; this test loads tokens.css into the page, sets the same <html>
 * attributes and inline custom properties, reads every colour token back through `getComputedStyle` and requires
 * the harness to agree. A harness bug (cascade layers, specificity, var(), calc(), color-mix()) fails here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import tokensCss from './tokens.css?raw'
import { hex, parseColor, parseTokens, sameColor, type TokenContext } from './token-harness'

const tokens = parseTokens(tokensCss)
const html = document.documentElement
let style: HTMLStyleElement
let probe: HTMLElement

beforeAll(() => {
  style = document.createElement('style')
  style.textContent = tokensCss
  document.head.append(style)
  probe = document.createElement('div')
  document.body.append(probe)
})

afterAll(() => {
  style.remove()
  probe.remove()
})

/** Applies a harness context to the live <html> (attributes and inline custom properties). */
function apply(ctx: TokenContext): void {
  for (const attr of [
    'data-theme',
    'data-hc',
    'data-accent',
    'data-chrome',
    'data-motion',
    'data-platform',
    'lang',
  ])
    html.removeAttribute(attr)
  for (const [k, v] of Object.entries(ctx.attrs ?? {})) html.setAttribute(k, v)
  html.style.removeProperty('--ink-alpha')
  for (const [k, v] of Object.entries(ctx.inline ?? {})) html.style.setProperty(k, v)
}

/** The browser's computed value of a colour token, read through `color` on a probe element. */
function browserColor(name: string): string {
  probe.style.color = `var(${name})`
  return getComputedStyle(probe).color
}

const COLOURS = [
  '--surface-app',
  '--surface-chrome',
  '--surface-page',
  '--surface-raised',
  '--surface-sunken',
  '--surface-hover',
  '--surface-overlay',
  '--ink',
  '--text',
  '--text-muted',
  '--text-faint',
  '--border-input',
  '--marker-ink',
  '--accent',
  '--accent-text',
  '--accent-strong',
  '--accent-ink',
  '--accent-soft',
  '--focus-ring',
  '--danger-text',
  '--warning-soft',
  '--glass-fill',
  '--hl-hover',
  '--hl-selection',
  '--hl-audio',
  '--hl-word',
  '--hl-search',
  '--user-hl-yellow',
  '--user-hl-purple',
]

const CONTEXTS: [string, TokenContext][] = [
  ['before init', {}],
  ...(['paper', 'sepia', 'night', 'black'] as const).flatMap((theme) =>
    (['teal', 'amber', 'indigo'] as const).map(
      (accent) =>
        [
          `${theme} × ${accent}`,
          { attrs: { 'data-theme': theme, 'data-accent': accent }, inline: { '--ink-alpha': '0.88' } },
        ] as [string, TokenContext],
    ),
  ),
  [
    'night, ink 65 %',
    { attrs: { 'data-theme': 'night', 'data-accent': 'rose' }, inline: { '--ink-alpha': '0.65' } },
  ],
  [
    'black, ink 100 %',
    { attrs: { 'data-theme': 'black', 'data-accent': 'blue' }, inline: { '--ink-alpha': '1' } },
  ],
  ['paper, vibrant chrome', { attrs: { 'data-theme': 'paper', 'data-chrome': 'vibrant' } }],
  ['night, vibrant chrome', { attrs: { 'data-theme': 'night', 'data-chrome': 'vibrant' } }],
  ['sepia, vibrant (stays opaque)', { attrs: { 'data-theme': 'sepia', 'data-chrome': 'vibrant' } }],
  [
    'high contrast light',
    { attrs: { 'data-theme': 'high_contrast', 'data-hc': 'light', 'data-accent': 'rose' } },
  ],
  [
    'high contrast dark',
    { attrs: { 'data-theme': 'high_contrast', 'data-hc': 'dark', 'data-accent': 'rose' } },
  ],
  ['linux', { attrs: { 'data-theme': 'night', 'data-platform': 'linux' } }],
]

describe('token harness agrees with the browser', () => {
  it.each(CONTEXTS)('%s', (_label, ctx) => {
    apply(ctx)
    const resolved = tokens.resolve(ctx)
    const mismatches = COLOURS.flatMap((name) => {
      const browser = browserColor(name)
      const harness = resolved.color(name)
      return sameColor(parseColor(browser), harness)
        ? []
        : [`${name}: browser ${browser}, harness ${hex(harness)}`]
    })
    expect(mismatches).toEqual([])
    expect(getComputedStyle(html).colorScheme).toBe(resolved.value('color-scheme'))
  })

  it('agrees on durations under data-motion="reduce" and on the Arabic type column', () => {
    apply({ attrs: { 'data-theme': 'paper', 'data-motion': 'reduce', lang: 'ar' } })
    const resolved = tokens.resolve({ attrs: { 'data-theme': 'paper', 'data-motion': 'reduce', lang: 'ar' } })
    const css = getComputedStyle(html)
    for (const name of ['--dur-normal', '--dur-page', '--text-md', '--text-xl', '--leading-ui'])
      expect(css.getPropertyValue(name).trim(), name).toBe(resolved.value(name))
  })
})
