/**
 * Visual sheets of the design-system primitives: every resting primitive in the five themes, and each floating or modal
 * primitive open, in English (LTR) and Arabic (RTL). The PNGs go to `artifacts/ui-gallery/` for the visual review; the
 * assertions here are layout sanity checks (nothing overflows the page, the open layer is on screen, RTL is applied).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import { settings } from '$lib/stores/settings.svelte'
import { ui } from '$lib/stores/ui.svelte'
import GalleryLayers from './testing/GalleryLayers.svelte'
import GalleryStatic from './testing/GalleryStatic.svelte'

const OUT = '../../../artifacts/ui-gallery'
const THEMES = ['paper', 'sepia', 'night', 'black', 'high_contrast'] as const
type Theme = (typeof THEMES)[number]

function setUi(theme: Theme, lang: 'en' | 'ar', options: { hcDark?: boolean; accent?: string } = {}): void {
  const html = document.documentElement
  html.dataset.theme = theme
  html.dataset.accent = options.accent ?? 'teal'
  html.dataset.motion = 'full'
  html.lang = lang
  html.dir = lang === 'ar' ? 'rtl' : 'ltr'
  if (options.hcDark) html.dataset.hc = 'dark'
  else delete html.dataset.hc
  settings.value = { ...settings.value, uiLanguage: lang }
}

async function settle(ms = 350): Promise<void> {
  await document.fonts.ready
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  await new Promise((resolve) => setTimeout(resolve, ms))
}

beforeAll(async () => {
  await page.viewport(1440, 1000)
  document.body.style.margin = '0'
})

afterEach(() => {
  ui.reset()
  setUi('paper', 'en')
})

describe('resting primitives', () => {
  const cases: { theme: Theme; lang: 'en' | 'ar'; hcDark?: boolean }[] = [
    ...THEMES.map((theme) => ({ theme, lang: 'en' as const })),
    { theme: 'high_contrast', lang: 'en', hcDark: true },
    { theme: 'paper', lang: 'ar' },
    { theme: 'night', lang: 'ar' },
  ]

  for (const c of cases) {
    const name = `static-${c.theme}${c.hcDark ? '-dark' : ''}-${c.lang}`
    it(name, async () => {
      setUi(c.theme, c.lang, { hcDark: c.hcDark })
      const screen = await render(GalleryStatic, { props: { arabic: c.lang === 'ar' } })
      await settle()
      const gallery = screen.container.querySelector<HTMLElement>('.gallery')
      expect(gallery).not.toBeNull()
      if (!gallery) return
      // Nothing spills sideways: every column keeps its content.
      for (const col of gallery.querySelectorAll<HTMLElement>('.col')) {
        expect(col.scrollWidth).toBeLessThanOrEqual(col.clientWidth + 1)
      }
      expect(getComputedStyle(gallery).direction).toBe(c.lang === 'ar' ? 'rtl' : 'ltr')
      await page.screenshot({ path: `${OUT}/${name}.png`, element: gallery })
    })
  }
})

describe('open layers', () => {
  const layers = [
    'menu',
    'context',
    'select',
    'combobox',
    'dialog',
    'sheet',
    'popover',
    'tooltip',
    'toast',
  ] as const
  const looks: { theme: Theme; lang: 'en' | 'ar' }[] = [
    { theme: 'paper', lang: 'en' },
    { theme: 'night', lang: 'ar' },
  ]

  for (const layer of layers) {
    for (const look of looks) {
      const name = `layer-${layer}-${look.theme}-${look.lang}`
      it(name, async () => {
        setUi(look.theme, look.lang)
        await render(GalleryLayers, { props: { show: layer, arabic: look.lang === 'ar' } })
        await settle(500)
        const surface = document.querySelector<HTMLElement>(
          {
            menu: '.qd-menu',
            context: '.qd-menu',
            select: '.qd-listbox',
            combobox: '.qd-listbox',
            dialog: '[role="dialog"]',
            sheet: '[role="dialog"]',
            popover: '[data-popover-content]',
            tooltip: '[data-tooltip-content]',
            toast: '[data-sonner-toast]',
          }[layer],
        )
        expect(surface, `${layer} is open`).not.toBeNull()
        if (!surface) return
        const box = surface.getBoundingClientRect()
        expect(box.width).toBeGreaterThan(0)
        expect(box.left).toBeGreaterThanOrEqual(0)
        expect(box.right).toBeLessThanOrEqual(window.innerWidth + 1)
        if (layer !== 'toast' && layer !== 'tooltip') expect(ui.floating).toBeGreaterThan(0)
        await page.screenshot({ path: `${OUT}/${name}.png` })
        if (layer === 'toast') {
          // Focus moves into the stack (F6): it expands and every timer pauses.
          expect(ui.focusToasts()).toBe(true)
          await settle(600)
          expect(document.querySelector('[data-sonner-toast][data-expanded="true"]')).not.toBeNull()
          await page.screenshot({ path: `${OUT}/${name}-expanded.png` })
        }
      })
    }
  }
})
