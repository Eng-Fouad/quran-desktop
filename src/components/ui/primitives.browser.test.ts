/**
 * The remaining primitives in a real browser: Button (incl. the "Space on a focused Button" widget-guard
 * test), IconButton, Segmented, Switch, Tabs, Field, SearchInput, Popover, Tooltip, Toaster (focus pauses the timer),
 * Kbd, Badge contrast in every theme, Progress, VirtualList, Card and Splitter.
 */
import { createRawSnippet, flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import { ui } from '$lib/stores/ui.svelte'
import Badge from './Badge.svelte'
import Kbd from './Kbd.svelte'
import Progress from './Progress.svelte'
import { installShortcuts, resetUi, setUi, settle, spyShortcut } from './testing/harness'
import PaletteRow from '$components/palette/PaletteRow.svelte'
import Playground from './testing/Playground.svelte'
import Toaster from './Toaster.svelte'

const byId = (id: string) => document.getElementById(id)
const text = (t: string) => createRawSnippet(() => ({ render: () => `<span>${t}</span>` }))

afterEach(() => resetUi())

describe('Arabic ink in one-line labels (base.css .truncate)', () => {
  /** Every element on the page that truncates with an ellipsis. */
  const ellipsised = () =>
    [...document.querySelectorAll<HTMLElement>('body *')].filter(
      (el) => getComputedStyle(el).textOverflow === 'ellipsis',
    )

  it('clips only the inline axis, so the dots below the baseline of «التالي» stay, and still ellipsises', async () => {
    setUi('ar')
    const { Button } = await import('./index')
    await render(Button, { props: { variant: 'primary', children: text('التالي') } })
    await render(PaletteRow, {
      props: {
        item: {
          id: 'theme',
          label: 'الشريط الجانبي',
          detail: 'إظهار الشريط الجانبي أو إخفاؤه',
          badge: { kind: 'monogram', text: 'ب', arabic: true },
          run: () => {},
        },
      },
    })
    await document.fonts.ready
    await settle()
    const found = ellipsised()
    expect(found.length).toBeGreaterThanOrEqual(3) // the button label, the row's label and detail
    for (const el of found) {
      const cs = getComputedStyle(el)
      expect([cs.overflowX, cs.overflowY], el.className).toEqual(['clip', 'visible'])
    }
    // The case it guards: the label's box is shorter than the font's ink (ascent + descent ≈ 1.5 em).
    const label = document.querySelector<HTMLElement>('.btn .label') as HTMLElement
    const ctx = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D
    const cs = getComputedStyle(label)
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const m = ctx.measureText('التالي')
    expect(label.getBoundingClientRect().height).toBeLessThan(
      m.fontBoundingBoxAscent + m.fontBoundingBoxDescent,
    )
    // Truncation itself still works: a narrow button ends its label with an ellipsis instead of overflowing.
    label.closest('button')?.style.setProperty('inline-size', '48px')
    await settle()
    expect(label.scrollWidth).toBeGreaterThan(label.clientWidth)
    expect(label.getBoundingClientRect().right).toBeLessThanOrEqual(
      (label.closest('button') as HTMLElement).getBoundingClientRect().right,
    )
  })
})

describe('Button', () => {
  it('clicks on Space when focused, and Space never reaches the reader (widget guard)', async () => {
    const uninstall = installShortcuts()
    const playPause = spyShortcut(['Space'], { scope: 'reader', labelKey: 'shortcuts.audio.playPause' })
    const onEvent = vi.fn()
    await render(Playground, { props: { which: 'button', onEvent } })
    byId('target')?.focus()
    await userEvent.keyboard(' ')
    expect(onEvent).toHaveBeenCalledWith('click')
    expect(playPause).not.toHaveBeenCalled()
    // On the page itself Space is the reader's.
    byId('target')?.blur()
    await userEvent.keyboard(' ')
    expect(playPause).toHaveBeenCalledOnce()
    uninstall()
  })

  it('swallows clicks while loading but stays focusable and busy', async () => {
    const onEvent = vi.fn()
    await render(Playground, { props: { which: 'button', onEvent, loading: true } })
    const button = byId('target') as HTMLButtonElement
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.disabled).toBe(false)
    // aria-disabled: Playwright would refuse to click it, a user can (and nothing happens).
    button.click()
    expect(onEvent).not.toHaveBeenCalled()
    button.focus()
    expect(document.activeElement).toBe(button)
  })

  it('renders each variant and size at the specified height', async () => {
    const { Button } = await import('./index')
    for (const [size, height] of [
      ['sm', 28],
      ['md', 32],
      ['lg', 40],
    ] as const) {
      const screen = await render(Button, { props: { size, variant: 'primary', children: text('Go') } })
      expect(screen.container.querySelector('button')?.getBoundingClientRect().height).toBe(height)
      await screen.unmount()
    }
  })
})

describe('IconButton', () => {
  it('is named by its label, toggles aria-pressed and shows its tooltip with the shortcut on keyboard focus', async () => {
    await render(Playground, { props: { which: 'icon-button' } })
    const button = byId('target') as HTMLButtonElement
    expect(button.getAttribute('aria-label')).toBe('Bookmark')
    expect(button.getAttribute('aria-pressed')).toBe('false')
    await userEvent.click(button)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    byId('before')?.focus()
    await userEvent.tab()
    expect(document.activeElement).toBe(button)
    await settle(250)
    const tip = document.querySelector('[data-tooltip-content]')
    expect(tip?.textContent).toContain('Bookmark')
    expect(tip?.querySelector('kbd')?.textContent?.replace(/\s/g, '')).toBe('B')
  })
})

describe('Segmented', () => {
  it('selects on click, keeps the active option when it is clicked again, and moves with arrows', async () => {
    const onEvent = vi.fn()
    await render(Playground, { props: { which: 'segmented', onEvent } })
    const option = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('button[role="radio"]')].find((b) =>
        b.textContent?.includes(label),
      )
    expect(option('Quran')?.getAttribute('aria-checked')).toBe('true')
    await userEvent.click(option('Quran') as HTMLElement)
    expect(option('Quran')?.getAttribute('aria-checked')).toBe('true')
    expect(onEvent).not.toHaveBeenCalled()
    await userEvent.click(option('Translation') as HTMLElement)
    expect(onEvent).toHaveBeenLastCalledWith('change', 'translation')
    // Arrow keys move focus (skipping the disabled option); Space selects.
    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(option('Words'))
    await userEvent.keyboard(' ')
    expect(onEvent).toHaveBeenLastCalledWith('change', 'words')
    await settle(200)
    const pill = document.querySelector<HTMLElement>('.pill')?.getBoundingClientRect()
    const words = option('Words')?.getBoundingClientRect()
    expect(Math.abs((pill?.left ?? 0) - (words?.left ?? 1))).toBeLessThan(1)
  })

  for (const lang of ['en', 'ar'] as const) {
    it(`keeps four options inside a 240 px full-width group, never clipping a label (${lang})`, async () => {
      setUi(lang)
      await render(Playground, { props: { which: 'segmented-narrow', arabic: lang === 'ar' } })
      await document.fonts.ready
      await settle(100)
      const group = document.querySelector<HTMLElement>('#narrow .segmented') as HTMLElement
      const box = group.getBoundingClientRect()
      expect(Math.round(box.width)).toBe(240)
      // The 1 px border and the 2 px inset stay clear of every option.
      const inner = { left: box.left + 3, right: box.right - 3 }
      const options = [...group.querySelectorAll<HTMLElement>('button[role="radio"]')]
      expect(options).toHaveLength(4)
      for (const option of options) {
        const r = option.getBoundingClientRect()
        expect(r.left, option.textContent ?? '').toBeGreaterThanOrEqual(inner.left - 0.5)
        expect(r.right, option.textContent ?? '').toBeLessThanOrEqual(inner.right + 0.5)
        // The whole label shows: no ellipsis was needed at this width.
        const label = option.querySelector<HTMLElement>('.text > span') as HTMLElement
        expect(label.scrollWidth, option.textContent ?? '').toBeLessThanOrEqual(label.clientWidth)
      }
      expect(group.dataset.fit === undefined || group.dataset.fit === 'tight').toBe(true)
      // The pill sits on the selected option, inside the border.
      const pill = group.querySelector<HTMLElement>('.pill')?.getBoundingClientRect()
      const on = options.find((o) => o.getAttribute('aria-checked') === 'true')?.getBoundingClientRect()
      expect(Math.abs((pill?.left ?? 0) - (on?.left ?? 1))).toBeLessThan(1)
      expect(pill?.right ?? 999).toBeLessThanOrEqual(inner.right + 0.5)
    })
  }

  it('compacts when the group narrows and relaxes when it widens again', async () => {
    await render(Playground, { props: { which: 'segmented-narrow' } })
    await settle(100)
    const host = document.getElementById('narrow') as HTMLElement
    const group = host.querySelector<HTMLElement>('.segmented') as HTMLElement
    host.style.inlineSize = '600px'
    await settle(100)
    expect(group.dataset.fit).toBeUndefined()
    host.style.inlineSize = '200px'
    await settle(100)
    expect(group.dataset.fit).toBeDefined()
    const box = group.getBoundingClientRect()
    for (const option of group.querySelectorAll<HTMLElement>('button[role="radio"]')) {
      const r = option.getBoundingClientRect()
      expect(r.left).toBeGreaterThanOrEqual(box.left + 2.5)
      expect(r.right).toBeLessThanOrEqual(box.right - 2.5)
    }
    // Far too narrow for the labels: equal shares with an ellipsis, the label in the tooltip and the name whole.
    host.style.inlineSize = '120px'
    await settle(100)
    expect(group.dataset.fit).toBe('clip')
    const selection = group.querySelector<HTMLElement>('button[role="radio"]') as HTMLElement
    expect(selection.title).toBe('Selection')
    expect(selection.textContent?.trim()).toContain('Selection')
    expect(selection.getBoundingClientRect().right).toBeLessThanOrEqual(
      group.getBoundingClientRect().right - 2.5,
    )
    host.style.inlineSize = '600px'
    await settle(100)
    expect(group.dataset.fit).toBeUndefined()
    expect(selection.title).toBe('')
  })

  it('runs right to left in the Arabic UI', async () => {
    setUi('ar')
    await render(Playground, { props: { which: 'segmented' } })
    const radios = [...document.querySelectorAll<HTMLElement>('button[role="radio"]')]
    expect(
      (radios[0]?.getBoundingClientRect().left ?? 0) > (radios[1]?.getBoundingClientRect().left ?? 0),
    ).toBe(true)
    radios[0]?.focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(document.activeElement).toBe(radios[1])
  })
})

describe('Switch', () => {
  it('toggles from the switch and from its label, as role=switch with a description', async () => {
    const onEvent = vi.fn()
    await render(Playground, { props: { which: 'switch', onEvent } })
    const sw = document.querySelector<HTMLElement>('[role="switch"]')
    expect(sw?.getAttribute('aria-checked')).toBe('false')
    expect(byId(sw?.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Turn pages with the reciter')
    await userEvent.click(sw as HTMLElement)
    expect(sw?.getAttribute('aria-checked')).toBe('true')
    await userEvent.click(document.querySelector('label') as HTMLElement)
    expect(sw?.getAttribute('aria-checked')).toBe('false')
    sw?.focus()
    await userEvent.keyboard(' ')
    expect(onEvent).toHaveBeenLastCalledWith('change', true)
  })

  it('puts the on thumb at the inline end (the left in RTL)', async () => {
    setUi('ar')
    await render(Playground, { props: { which: 'switch' } })
    const sw = document.querySelector<HTMLElement>('[role="switch"]') as HTMLElement
    await userEvent.click(sw)
    await settle(250)
    const track = sw.getBoundingClientRect()
    const thumb = sw.querySelector('span')?.getBoundingClientRect()
    expect((thumb?.left ?? 99) - track.left).toBeLessThan(6)
  })
})

describe('Tabs', () => {
  it('selects with arrows (mirrored in RTL) and mounts only the active panel', async () => {
    const onEvent = vi.fn()
    await render(Playground, { props: { which: 'tabs', onEvent } })
    const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
    expect(tabs).toHaveLength(3)
    expect(document.querySelectorAll('.panel-content')).toHaveLength(1)
    tabs[0]?.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(onEvent).toHaveBeenLastCalledWith('change', 'tafsir')
    expect(document.querySelector('.panel-content')?.getAttribute('data-panel')).toBe('tafsir')
    const panel = document.querySelector('[role="tabpanel"]:not([hidden])')
    expect(byId(panel?.getAttribute('aria-labelledby') ?? '')?.textContent).toContain('Tafsir')
  })

  it('moves the other way in the Arabic UI', async () => {
    setUi('ar')
    const onEvent = vi.fn()
    await render(Playground, { props: { which: 'tabs', onEvent } })
    document.querySelector<HTMLElement>('[role="tab"]')?.focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(onEvent).toHaveBeenLastCalledWith('change', 'tafsir')
  })
})

describe('Field and inputs', () => {
  it('labels the control and describes it by the hint, then by the error', async () => {
    const screen = await render(Playground, { props: { which: 'field' } })
    const input = document.querySelector('input') as HTMLInputElement
    const label = document.querySelector('label') as HTMLLabelElement
    expect(label.htmlFor).toBe(input.id)
    // Empty, the field takes the UI direction (its placeholder sits at the reading start); typed text is `dir="auto"`.
    expect(input.getAttribute('dir')).toBe('ltr')
    await userEvent.type(input, 'مريم')
    expect(input.getAttribute('dir')).toBe('auto')
    expect(getComputedStyle(input).direction).toBe('rtl')
    await userEvent.clear(input)
    expect(input.getAttribute('dir')).toBe('ltr')
    expect(input.required).toBe(true)
    expect(byId(input.getAttribute('aria-describedby') ?? '')?.textContent?.trim()).toBe(
      'Shown in the library',
    )
    await screen.rerender({ error: 'A name is required' })
    expect(byId(input.getAttribute('aria-describedby') ?? '')?.textContent?.trim()).toBe('A name is required')
    expect(input.getAttribute('aria-invalid')).toBe('true')
  })

  it('SearchInput: Escape clears first and is consumed; on an empty field it passes; Enter submits', async () => {
    const onEvent = vi.fn()
    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    await render(Playground, { props: { which: 'search', onEvent } })
    const input = byId('target') as HTMLInputElement
    expect(input.dataset.qdFocus).toBe('search')
    expect(input.placeholder).toBe('Search')
    await userEvent.type(input, 'mercy')
    await userEvent.keyboard('{Enter}')
    expect(onEvent).toHaveBeenCalledWith('submit', 'mercy')
    outer.mockClear()
    await userEvent.keyboard('{Escape}')
    expect(input.value).toBe('')
    expect(onEvent).toHaveBeenCalledWith('clear')
    expect(outer.mock.calls.some(([e]) => (e as KeyboardEvent).key === 'Escape')).toBe(false)
    await userEvent.keyboard('{Escape}')
    expect(outer.mock.calls.some(([e]) => (e as KeyboardEvent).key === 'Escape')).toBe(true)
    window.removeEventListener('keydown', outer)
  })

  it('SearchInput: the clear button empties the field and keeps focus in it', async () => {
    await render(Playground, { props: { which: 'search' } })
    const input = byId('target') as HTMLInputElement
    await userEvent.type(input, 'الرحمن')
    await userEvent.click(document.querySelector('button[aria-label="Clear"]') as HTMLElement)
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
  })
})

describe('Popover and Tooltip', () => {
  it('Popover opens from its trigger, traps nothing outside, counts as a layer and returns focus on Escape', async () => {
    await render(Playground, { props: { which: 'popover' } })
    await userEvent.click(byId('target') as HTMLElement)
    await settle(200)
    const content = document.querySelector<HTMLElement>('[data-popover-content]')
    expect(content?.getAttribute('aria-label')).toBe('Repeat')
    expect(content?.contains(document.activeElement)).toBe(true)
    expect(ui.floating).toBe(1)
    await userEvent.keyboard('{Escape}')
    await settle(200)
    expect(document.querySelector('[data-popover-content]')).toBeNull()
    expect(document.activeElement?.id).toBe('target')
    expect(ui.floating).toBe(0)
  })

  it('Tooltip shows its text and shortcut on keyboard focus, never counting as a layer', async () => {
    await render(Playground, { props: { which: 'tooltip' } })
    byId('before')?.focus()
    await userEvent.tab()
    await settle(250)
    const tip = document.querySelector('[data-tooltip-content]')
    expect(tip?.textContent).toContain('Search')
    expect(tip?.querySelector('bdi')?.getAttribute('dir')).toBe('ltr')
    expect(byId('target')?.getAttribute('aria-describedby')).toBeTruthy()
    expect(ui.floating).toBe(0)
    // Floating glass: blurred, so the page's text never shows through the tooltip's.
    expect(getComputedStyle(tip as HTMLElement).backdropFilter).toContain('blur')
    // On the page, Escape closes it (inside a dialog, the dialog's Escape comes first).
    await userEvent.keyboard('{Escape}')
    await settle(200)
    expect(document.querySelector('[data-tooltip-content]')).toBeNull()
  })
})

describe('Toaster', () => {
  it('pauses a toast while it has focus and lets it expire afterwards', async () => {
    await render(Toaster, { props: { label: 'Notifications' } })
    ui.toast({ message: 'Highlighted 2:255 yellow', durationMs: 600 })
    await settle(100)
    expect(document.querySelector('[data-sonner-toast]')?.textContent).toContain('Highlighted 2:255 yellow')
    expect(ui.focusToasts()).toBe(true)
    await settle(1200)
    expect(document.querySelector('[data-sonner-toast]')).not.toBeNull() // paused while focused
    byId('missing')?.focus()
    ;(document.activeElement as HTMLElement | null)?.blur()
    await settle(1600)
    expect(document.querySelector('[data-sonner-toast]')).toBeNull()
  })

  it('shows actions as link buttons and a localised close button', async () => {
    await render(Toaster, { props: { label: 'Notifications' } })
    const run = vi.fn()
    ui.toast({ message: 'Removed the bookmark', action: { label: 'Undo', run } })
    await settle(150)
    const action = document.querySelector<HTMLButtonElement>('.qd-toast-action')
    expect(action?.textContent).toBe('Undo')
    expect(getComputedStyle(action as HTMLElement).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(document.querySelector('.qd-toast-close')?.getAttribute('aria-label')).toBe('Close')
    await userEvent.click(action as HTMLElement)
    expect(run).toHaveBeenCalledOnce()
    expect(document.querySelector('section[aria-label^="Notifications"]')).not.toBeNull()
  })
})

describe('Kbd, Badge, Progress', () => {
  it('Kbd keeps chords left-to-right inside the Arabic UI and splits labels into caps', async () => {
    setUi('ar')
    const screen = await render(Kbd, { props: { chord: 'Ctrl+Shift+K' } })
    const bdi = screen.container.querySelector('bdi')
    expect(bdi?.getAttribute('dir')).toBe('ltr')
    const caps = [...screen.container.querySelectorAll('kbd kbd')].map((k) => k.textContent)
    expect(caps).toEqual(['Ctrl', 'Shift', 'K'])
    const boxes = [...screen.container.querySelectorAll('kbd kbd')].map((k) => k.getBoundingClientRect().left)
    expect(boxes).toEqual([...boxes].sort((a, b) => a - b)) // Ctrl leftmost even in RTL
    await screen.rerender({ chord: '⌘⇧K' })
    expect([...screen.container.querySelectorAll('kbd kbd')].map((k) => k.textContent)).toEqual([
      '⌘',
      '⇧',
      'K',
    ])
    expect(screen.container.querySelector('.plus')).toBeNull()
    // A key named in Arabic ("مسافة", Space) is set in the UI font, not spaced apart by a monospaced fallback.
    await screen.rerender({ chord: 'Ctrl+مسافة' })
    const [ctrl, space] = [...screen.container.querySelectorAll<HTMLElement>('kbd kbd')]
    expect(ctrl?.classList.contains('word')).toBe(false)
    expect(space?.classList.contains('word')).toBe(true)
    expect(getComputedStyle(space as HTMLElement).fontFamily).not.toBe(
      getComputedStyle(ctrl as HTMLElement).fontFamily,
    )
  })

  it('Badge text keeps ≥ 4.5:1 against its fill in every theme and tone', async () => {
    const themes: [string, string | undefined][] = [
      ['paper', undefined],
      ['sepia', undefined],
      ['night', undefined],
      ['black', undefined],
      ['high_contrast', undefined],
      ['high_contrast', 'dark'],
    ]
    const tones = ['neutral', 'accent', 'success', 'warning', 'danger'] as const
    const failures: string[] = []
    for (const [theme, hc] of themes) {
      setUi('en', theme)
      if (hc) document.documentElement.dataset.hc = hc
      else delete document.documentElement.dataset.hc
      for (const tone of tones) {
        const screen = await render(Badge, { props: { tone, children: text('Installed') } })
        const el = screen.container.querySelector<HTMLElement>('.badge') as HTMLElement
        const ratio = contrast(getComputedStyle(el).color, getComputedStyle(el).backgroundColor)
        if (ratio < 4.5) failures.push(`${theme}${hc ? '-' + hc : ''}/${tone}: ${ratio.toFixed(2)}`)
        await screen.unmount()
      }
    }
    delete document.documentElement.dataset.hc
    expect(failures).toEqual([])
  })

  it('Progress exposes its value (and none while indeterminate)', async () => {
    const screen = await render(Progress, {
      props: { value: 42, label: 'Downloading Al-Kahf', valueText: '42%' },
    })
    const bar = screen.container.querySelector('[role="progressbar"]')
    expect(bar?.getAttribute('aria-valuenow')).toBe('42')
    expect(bar?.getAttribute('aria-valuetext')).toBe('42%')
    expect(bar?.getAttribute('aria-label')).toBe('Downloading Al-Kahf')
    const fill = screen.container.querySelector<HTMLElement>('.fill')
    expect(fill?.style.inlineSize).toBe('42%')
    await screen.rerender({ indeterminate: true })
    expect(bar?.hasAttribute('aria-valuenow')).toBe(false)
  })
})

describe('VirtualList, Card, Splitter', () => {
  it('VirtualList mounts only the rows near the viewport and scrolls to an index', async () => {
    const screen = await render(Playground, { props: { which: 'virtual-list' } })
    await settle(50)
    const mounted = document.querySelectorAll('[data-row]').length
    expect(mounted).toBeGreaterThan(5)
    expect(mounted).toBeLessThan(60)
    flushSync(() => (screen.component as unknown as { scrollListTo: (i: number) => void }).scrollListTo(4321))
    await settle(150)
    const row = document.querySelector<HTMLElement>('[data-row="4321"]')
    expect(row).not.toBeNull()
    const list = document.querySelector<HTMLElement>('[aria-label="Rows"]')?.getBoundingClientRect()
    expect(Math.abs((row?.getBoundingClientRect().top ?? 0) - (list?.top ?? 1))).toBeLessThan(2)
  })

  it('an interactive Card is a toggle button', async () => {
    await render(Playground, { props: { which: 'card' } })
    const card = document.querySelector<HTMLButtonElement>('button[aria-label="Paper theme"]')
    expect(card?.getAttribute('aria-pressed')).toBe('false')
    await userEvent.click(card as HTMLElement)
    expect(card?.getAttribute('aria-pressed')).toBe('true')
  })

  it('Splitter is a named separator that owns its keys and resets on double-click', async () => {
    const onEvent = vi.fn()
    await render(Playground, { props: { which: 'splitter', onEvent } })
    const handle = document.querySelector<HTMLElement>('[role="separator"]')
    expect(handle?.getAttribute('aria-label')).toBe('Resize sidebar')
    expect(handle?.dataset.qdKeys).toBe('own')
    const box = handle?.getBoundingClientRect()
    expect(Math.round(box?.width ?? 0)).toBe(6)
    await userEvent.dblClick(handle as HTMLElement)
    expect(onEvent).toHaveBeenCalledWith('reset')
  })
})

/**
 * WCAG 2 contrast of two computed CSS colours: `rgb(…)` (0–255) or `color(srgb …)` (0–1, what `color-mix` computes
 * to). The badge fill is opaque.
 */
function contrast(fg: string, bg: string): number {
  const lum = (css: string) => {
    const unit = css.startsWith('color(') ? 1 : 255
    const [r, g, b] = (css.replace(/^color\(srgb/, '').match(/[\d.]+/g) ?? []).slice(0, 3).map(Number) as [
      number,
      number,
      number,
    ]
    const lin = (c: number) => {
      const s = c / unit
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  }
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x) as [number, number]
  return (a + 0.05) / (b + 0.05)
}
