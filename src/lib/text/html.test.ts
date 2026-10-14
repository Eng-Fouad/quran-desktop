import { fireEvent, render } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import SafeHtml from '$components/ui/SafeHtml.svelte'
import { parseRef, renderSafeHtml, sanitize } from './html'

describe('sanitize()', () => {
  it('keeps the allowed tags and drops dangerous markup with its content', () => {
    const out = sanitize(
      '<p>a<b>b</b><i class="s">c</i><script>alert(1)</script><style>p{}</style><img src=x onerror=alert(1)><iframe></iframe></p>',
    )
    expect(out).toBe('<p>a<b>b</b><i class="s">c</i></p>')
  })

  it('unwraps unknown tags but keeps their text', () => {
    expect(sanitize('<div><h1>Title</h1><table><tr><td>cell</td></tr></table></div>')).toBe('Titlecell')
  })

  it('filters classes per tag', () => {
    expect(sanitize('<span class="h evil arabic">x</span>')).toBe('<span class="h arabic">x</span>')
    expect(sanitize('<span class="evil">x</span>')).toBe('<span>x</span>')
    expect(sanitize('<p class="h">x</p>')).toBe('<p>x</p>')
    expect(sanitize('<sup class="fn">1</sup>')).toBe('<sup class="fn">1</sup>')
  })

  it('drops href, style, event handlers and unknown data attributes', () => {
    expect(sanitize('<a href="javascript:alert(1)" style="color:red" onclick="x()" data-x="1">t</a>')).toBe(
      '<a>t</a>',
    )
    expect(sanitize('<p data-ref="2:255" title="t">x</p>')).toBe('<p>x</p>')
  })

  it('keeps valid data-ref on a and data-fn on sup only', () => {
    expect(sanitize('<a data-ref="2:255-257">r</a>')).toBe('<a data-ref="2:255-257">r</a>')
    expect(sanitize('<a data-ref="javascript:1">r</a>')).toBe('<a>r</a>')
    expect(sanitize('<sup class="fn" data-fn="2:255:1">1</sup>')).toBe(
      '<sup class="fn" data-fn="2:255:1">1</sup>',
    )
    expect(sanitize('<sup class="fn" data-fn="2:255:১">১</sup>')).toContain('data-fn="2:255:১"')
    expect(sanitize('<span data-fn="2:255:1">x</span>')).toBe('<span>x</span>')
  })

  it('keeps mark for search snippets', () => {
    expect(sanitize('the <mark>mercy</mark> of')).toBe('the <mark>mercy</mark> of')
  })
})

describe('renderSafeHtml()', () => {
  it('turns references into buttons and unwraps other links', () => {
    expect(renderSafeHtml('see <a data-ref="2:255">2:255</a> and <a href="https://x">x</a>')).toBe(
      'see <button type="button" class="ref" data-ref="2:255">2:255</button> and x',
    )
  })

  it('makes footnote markers keyboard reachable', () => {
    expect(renderSafeHtml('a<sup class="fn" data-fn="1:1:1">1</sup>')).toBe(
      'a<sup class="fn" data-fn="1:1:1" role="button" tabindex="0">1</sup>',
    )
  })

  it('returns an empty string for empty input', () => {
    expect(renderSafeHtml('')).toBe('')
  })
})

describe('parseRef()', () => {
  it('parses single ayahs and ranges', () => {
    expect(parseRef('2:255')).toEqual({ surah: 2, fromAyah: 255, toAyah: 255 })
    expect(parseRef('2:255-257')).toEqual({ surah: 2, fromAyah: 255, toAyah: 257 })
    expect(parseRef('115:1')).toBeNull()
    expect(parseRef('2:257-255')).toBeNull()
    expect(parseRef('x')).toBeNull()
  })
})

describe('SafeHtml.svelte', () => {
  it('renders sanitised HTML and delegates references and footnotes', async () => {
    const onref = vi.fn()
    const onfootnote = vi.fn()
    const { container } = render(SafeHtml, {
      html: 'Read <a data-ref="2:255">this</a><sup class="fn" data-fn="2:255:1">1</sup><script>bad()</script>',
      onref,
      onfootnote,
    })
    expect(container.querySelector('script')).toBeNull()
    const button = container.querySelector('button[data-ref]')
    const sup = container.querySelector('sup.fn')
    expect(button).not.toBeNull()
    expect(sup?.getAttribute('role')).toBe('button')
    await fireEvent.click(button as Element)
    expect(onref).toHaveBeenCalledWith('2:255')
    await fireEvent.keyDown(sup as Element, { key: 'Enter' })
    expect(onfootnote).toHaveBeenCalledWith('2:255:1')
    await fireEvent.click(sup as Element)
    expect(onfootnote).toHaveBeenCalledTimes(2)
  })
})
