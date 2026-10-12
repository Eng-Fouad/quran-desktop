/**
 * base.css behaviour in a real browser (WP7a): the guards that must hold against component styles (Svelte's scoped
 * styles are unlayered, so they beat every layer unless a guard uses `!important`), RTL icon mirroring by the nearest
 * `dir` attribute, reduced motion and the transparent root under translucent chrome.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import baseCss from './base.css?raw'
import tokensCss from './tokens.css?raw'

const html = document.documentElement
const sheets: HTMLStyleElement[] = []
let host: HTMLElement

function addStyle(css: string): HTMLStyleElement {
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)
  sheets.push(style)
  return style
}

beforeAll(() => {
  addStyle(tokensCss)
  addStyle(baseCss)
  // A component's scoped rules are unlayered: the strongest normal declarations on the page.
  addStyle(`
    .component-ayah { font-weight: 700; font-style: italic; letter-spacing: 3px; text-transform: uppercase; }
    .component-heading { letter-spacing: 0.06em; }
    .component-flex { display: flex; }
    .component-anim { transition: opacity 300ms linear; animation: spin 2s linear infinite; }
    @keyframes spin { to { rotate: 1turn; } }
  `)
  html.setAttribute('dir', 'ltr')
  html.setAttribute('lang', 'en')
  html.dataset.theme = 'paper'
})

afterAll(() => {
  for (const s of sheets) s.remove()
  for (const attr of ['dir', 'data-theme', 'data-motion', 'data-chrome']) html.removeAttribute(attr)
})

afterEach(() => host?.remove())

function mount(markup: string): HTMLElement {
  host = document.createElement('div')
  host.innerHTML = markup
  document.body.append(host)
  return host
}
const style = (selector: string): CSSStyleDeclaration => {
  const el = host.querySelector(selector)
  if (!el) throw new Error(`no ${selector}`)
  return getComputedStyle(el)
}

describe('base.css in the browser', () => {
  it('mirrors .icon-dir by the nearest dir attribute (§9.5), not by language', () => {
    mount(`
      <div dir="rtl"><svg class="icon-dir" id="rtl"></svg>
        <div dir="ltr"><svg class="icon-dir" id="island"></svg></div>
      </div>
      <div lang="ar"><svg class="icon-dir" id="arabic-in-ltr"></svg></div>
      <svg class="icon-dir" id="ltr"></svg>
      <div dir="rtl"><svg id="plain"></svg></div>`)
    expect(style('#rtl').scale).toBe('-1 1')
    expect(style('#island').scale).toBe('none')
    expect(style('#arabic-in-ltr').scale).toBe('none')
    expect(style('#ltr').scale).toBe('none')
    expect(style('#plain').scale).toBe('none')
  })

  it('keeps .quran-text neutral against a component rule on the same element (§9.3)', () => {
    mount(
      `<span class="component-ayah quran-text" id="q">بِسۡمِ ٱللَّهِ</span><span class="component-ayah" id="c">x</span>`,
    )
    const q = style('#q')
    expect([q.fontWeight, q.fontStyle, q.textTransform]).toEqual(['400', 'normal', 'none'])
    expect(['normal', '0px']).toContain(q.letterSpacing)
    expect(style('#c').fontWeight).toBe('700') // the component rule itself still applies elsewhere
  })

  it('never letter-spaces Arabic (§11.3), even when a component asks for it', () => {
    mount(
      `<h3 class="component-heading" lang="ar" id="ar">السور</h3><h3 class="component-heading" id="en">Surahs</h3>`,
    )
    expect(['normal', '0px']).toContain(style('#ar').letterSpacing)
    expect(style('#en').letterSpacing).not.toBe('normal')
  })

  it('hides [hidden] even when a component sets display', () => {
    mount(`<div class="component-flex" hidden id="h"></div><div class="component-flex" id="v"></div>`)
    expect(style('#h').display).toBe('none')
    expect(style('#v').display).toBe('flex')
  })

  it('stops CSS motion under data-motion="reduce" (§9.4) and leaves it alone under "full"', () => {
    mount(`<div class="component-anim" id="a"></div>`)
    html.dataset.motion = 'full'
    expect(style('#a').transitionDuration).toBe('0.3s')
    html.dataset.motion = 'reduce'
    const reduced = style('#a')
    expect(parseFloat(reduced.transitionDuration)).toBeLessThan(0.001)
    expect(parseFloat(reduced.animationDuration)).toBeLessThan(0.001)
    expect(reduced.animationIterationCount).toBe('1')
    expect(getComputedStyle(html).getPropertyValue('--dur-normal').trim()).toBe('0ms')
    delete html.dataset.motion
  })

  it('paints the root with --surface-app, and leaves it transparent under translucent chrome (§9.6)', () => {
    expect(getComputedStyle(html).backgroundColor).toBe('rgb(243, 239, 230)')
    html.dataset.chrome = 'vibrant'
    expect(getComputedStyle(html).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    delete html.dataset.chrome
  })

  it('uses the UI type tokens on the body and the focus ring on :focus-visible', () => {
    // The family list without quotes: Chromium serialises `"IBM Plex Sans Arabic"`, WebKit `IBM Plex Sans Arabic`.
    const families = () => getComputedStyle(document.body).fontFamily.replace(/["']/gu, '')
    const body = getComputedStyle(document.body)
    expect(body.fontSize).toBe('14px')
    expect(families()).toMatch(/^Inter Variable,/u)
    html.lang = 'ar'
    expect(getComputedStyle(document.body).fontSize).toBe('16px')
    expect(families()).toMatch(/^IBM Plex Sans Arabic,/u)
    html.lang = 'en'
    mount(`<button id="b">Undo</button>`)
    const button = host.querySelector('button')
    button?.focus()
    expect(button?.matches(':focus-visible')).toBe(true)
    const focused = style('#b')
    expect([focused.outlineStyle, focused.outlineWidth, focused.outlineOffset]).toEqual([
      'solid',
      '2px',
      '2px',
    ])
    expect(focused.outlineColor).toBe('rgb(31, 122, 109)')
  })
})
