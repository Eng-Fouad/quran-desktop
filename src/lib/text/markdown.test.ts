/**
 * The note-body Markdown subset: rendering vectors, escaping, references, the sanitiser's allowlist and the sanitiser
 * round trip, the depth and time bounds, plain text, and the editor's formatting commands.
 */
import { describe, expect, it } from 'vitest'
import { ALLOWED_TAGS, REF_PATTERN, sanitize } from './html'
import {
  applyEdit,
  ayahCount,
  continueList,
  digitsValue,
  escapeHtml,
  MARKDOWN_TAGS,
  markdownToText,
  MAX_DEPTH,
  orderedListStarts,
  parseMarkdown,
  renderMarkdown,
  type TextEdit,
  toggleInline,
  toggleLines,
} from './markdown'

const NBSP = String.fromCharCode(0xa0)
const r = (source: string) => renderMarkdown(source)

/** The HTML the browser would serialise for `html` (attribute quoting and entity choices normalised). */
function normalise(html: string): string {
  const t = document.createElement('template')
  t.innerHTML = html
  return t.innerHTML
}

describe('blocks', () => {
  it('renders nothing for an empty or blank body', () => {
    expect(r('')).toBe('')
    expect(r('  \n\t\n')).toBe('')
  })

  it('keeps line breaks inside a paragraph and separates paragraphs at blank lines', () => {
    expect(r('Hello')).toBe('<p>Hello</p>')
    expect(r('one\ntwo')).toBe('<p>one<br>two</p>')
    expect(r('one\r\ntwo\rthree')).toBe('<p>one<br>two<br>three</p>')
    expect(r('one\n\n\ntwo')).toBe('<p>one</p><p>two</p>')
    expect(r('  indented  \n  lines  ')).toBe('<p>indented<br>lines</p>')
  })

  it('maps three heading levels to h2–h4', () => {
    expect(r('# Title')).toBe('<h2>Title</h2>')
    expect(r('## Part')).toBe('<h3>Part</h3>')
    expect(r('### Point')).toBe('<h4>Point</h4>')
    expect(r('###### Deep')).toBe('<h4>Deep</h4>')
    expect(r('# Closed ##')).toBe('<h2>Closed</h2>')
    expect(r('# C#')).toBe('<h2>C#</h2>')
    expect(r('#hashtag')).toBe('<p>#hashtag</p>')
    expect(r('#')).toBe('')
    expect(r('text\n# Heading\nmore')).toBe('<p>text</p><h2>Heading</h2><p>more</p>')
  })

  it('renders bullet, numbered and nested lists, tight and loose', () => {
    expect(r('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>')
    expect(r('* a\n+ b')).toBe('<ul><li>a</li></ul><ul><li>b</li></ul>')
    expect(r('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>')
    expect(r('1) a\n2) b')).toBe('<ol><li>a</li><li>b</li></ol>')
    expect(r('- a\n\n- b')).toBe('<ul><li><p>a</p></li><li><p>b</p></li></ul>')
    expect(r('- a\n  - b\n- c')).toBe('<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>')
    expect(r('1. a\n  - b\n2. c')).toBe('<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>')
    expect(r('1. a\n   1. b')).toBe('<ol><li>a<ol><li>b</li></ol></li></ol>')
    expect(r('- item\n  more of it')).toBe('<ul><li>item<br>more of it</li></ul>')
    expect(r('- item\nlazy line')).toBe('<ul><li>item<br>lazy line</li></ul>')
    expect(r('- a\n\nafter')).toBe('<ul><li>a</li></ul><p>after</p>')
  })

  it('reads numbered lists in Arabic-Indic digits and keeps where a list starts', () => {
    expect(r('١. أول\n٢. ثان')).toBe('<ol><li>أول</li><li>ثان</li></ol>')
    const blocks = parseMarkdown('3. third\n4. fourth\n\n- x\n\n1. one')
    expect(orderedListStarts(blocks)).toEqual([3, 1])
  })

  it('only lets a bullet or a list from 1 interrupt a paragraph', () => {
    expect(r('The year\n1999. was long')).toBe('<p>The year<br>1999. was long</p>')
    expect(r('Steps:\n1. first')).toBe('<p>Steps:</p><ol><li>first</li></ol>')
    expect(r('Items:\n- one')).toBe('<p>Items:</p><ul><li>one</li></ul>')
  })

  it('shows task items as boxes', () => {
    expect(r('- [ ] memorise\n- [x] revise')).toBe(
      `<ul><li>☐${NBSP}memorise</li><li>☑${NBSP}revise</li></ul>`,
    )
    expect(r('- [ ] a\n\n- [X] b')).toBe(`<ul><li><p>☐${NBSP}a</p></li><li><p>☑${NBSP}b</p></li></ul>`)
  })

  it('renders quotes with any block inside, and lazy continuation', () => {
    expect(r('> a\n> b')).toBe('<blockquote><p>a<br>b</p></blockquote>')
    expect(r('> a\nb')).toBe('<blockquote><p>a<br>b</p></blockquote>')
    expect(r('> - a\n> - b')).toBe('<blockquote><ul><li>a</li><li>b</li></ul></blockquote>')
    expect(r('> # T\n>\n> body')).toBe('<blockquote><h2>T</h2><p>body</p></blockquote>')
    expect(r('> a\n\nb')).toBe('<blockquote><p>a</p></blockquote><p>b</p>')
  })

  it('caps nesting depth', () => {
    const html = r(`${'> '.repeat(40)}deep`)
    expect(html.match(/<blockquote>/g)?.length).toBe(MAX_DEPTH)
    expect(html).toContain('deep')
    const list = r(Array.from({ length: 30 }, (_, i) => `${'  '.repeat(i)}- level ${i}`).join('\n'))
    expect(list.match(/<ul>/g)?.length ?? 0).toBeLessThanOrEqual(MAX_DEPTH)
    expect(list).toContain('level 29')
  })
})

describe('inline', () => {
  it('renders strong, emphasis and highlight', () => {
    expect(r('**b** *i* __b__ _i_ ==m==')).toBe(
      '<p><strong>b</strong> <em>i</em> <strong>b</strong> <em>i</em> <mark>m</mark></p>',
    )
    expect(r('***both***')).toBe('<p><em><strong>both</strong></em></p>')
    expect(r('**bold *and italic***')).toBe('<p><strong>bold <em>and italic</em></strong></p>')
    expect(r('==**marked bold**==')).toBe('<p><mark><strong>marked bold</strong></mark></p>')
    expect(r('**الرحمن** الرحيم')).toBe('<p><strong>الرحمن</strong> الرحيم</p>')
  })

  it('follows the flanking rules: no emphasis inside words with _ or around spaces', () => {
    expect(r('snake_case_name')).toBe('<p>snake_case_name</p>')
    expect(r('2 * 3 * 4')).toBe('<p>2 * 3 * 4</p>')
    expect(r('a == b')).toBe('<p>a == b</p>')
    expect(r('x = y')).toBe('<p>x = y</p>')
    expect(r('in*side*word')).toBe('<p>in<em>side</em>word</p>')
    expect(r('**unclosed')).toBe('<p>**unclosed</p>')
    expect(r('***a**')).toBe('<p>*<strong>a</strong></p>')
  })

  it('treats backslash escapes and stray brackets as text', () => {
    expect(r('\\*not em\\*')).toBe('<p>*not em*</p>')
    expect(r('\\# not a heading')).toBe('<p># not a heading</p>')
    expect(r('a \\ b')).toBe('<p>a \\ b</p>')
    expect(r('[just brackets]')).toBe('<p>[just brackets]</p>')
    expect(r('[open (paren')).toBe('<p>[open (paren</p>')
  })

  it('escapes all HTML and never emits attributes other than data-ref', () => {
    expect(r('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
    expect(r('<img src=x onerror=alert(1)>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>')
    expect(r(`"q" & 'a'`)).toBe('<p>&quot;q&quot; &amp; &#39;a&#39;</p>')
    expect(r('&amp; stays')).toBe('<p>&amp;amp; stays</p>')
    expect(r('**<b>x</b>**')).toBe('<p><strong>&lt;b&gt;x&lt;/b&gt;</strong></p>')
    expect(escapeHtml(`<a href="x">'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&lt;/a&gt;')
  })
})

describe('references and links', () => {
  it('links bare references that exist, in any digit script', () => {
    expect(r('See 2:255.')).toBe('<p>See <a data-ref="2:255">2:255</a>.</p>')
    expect(r('2:255-257')).toBe('<p><a data-ref="2:255-257">2:255-257</a></p>')
    expect(r('2:255–257')).toBe('<p><a data-ref="2:255-257">2:255–257</a></p>')
    expect(r('آية ٢:٢٥٥')).toBe('<p>آية <a data-ref="2:255">٢:٢٥٥</a></p>')
    expect(r('۲:۲۵۵')).toBe('<p><a data-ref="2:255">۲:۲۵۵</a></p>')
    expect(r('(18:10)')).toBe('<p>(<a data-ref="18:10">18:10</a>)</p>')
    expect(r('**1:1**')).toBe('<p><strong><a data-ref="1:1">1:1</a></strong></p>')
  })

  it('leaves out references that do not exist and numbers that only look like one', () => {
    expect(r('1:8')).toBe('<p>1:8</p>')
    expect(r('115:1')).toBe('<p>115:1</p>')
    expect(r('2:0')).toBe('<p>2:0</p>')
    expect(r('2:257-255')).toBe('<p>2:257-255</p>')
    expect(r('2:280-300')).toBe('<p>2:280-300</p>')
    expect(r('12:30:45')).toBe('<p>12:30:45</p>')
    expect(r('v1.2:3')).toBe('<p>v1.2:3</p>')
    expect(r('a2:255')).toBe('<p>a2:255</p>')
    expect(r('2:255x')).toBe('<p>2:255x</p>')
    expect(renderMarkdown('2:255', { refs: false })).toBe('<p>2:255</p>')
  })

  it('links a label to a reference and keeps web links as text', () => {
    expect(r('[Ayat al-Kursi](2:255)')).toBe('<p><a data-ref="2:255">Ayat al-Kursi</a></p>')
    expect(r('[*The* Throne](2:255)')).toBe('<p><a data-ref="2:255"><em>The</em> Throne</a></p>')
    expect(r('[](2:255)')).toBe('<p><a data-ref="2:255">2:255</a></p>')
    expect(r('[x](2:999)')).toBe('<p>[x](2:999)</p>')
    expect(r('[site](https://example.com/a_(b))')).toBe('<p>site (https://example.com/a_(b))</p>')
    expect(r('<https://quran.com/2/255>')).toBe('<p>https://quran.com/2/255</p>')
    expect(r('[https://a.org](https://a.org)')).toBe('<p>https://a.org</p>')
    expect(r('[bad](javascript:alert(1))')).toBe('<p>[bad](javascript:alert(1))</p>')
    expect(r('[label 2:255 inside](https://a.org)')).toBe('<p>label 2:255 inside (https://a.org)</p>')
    expect(renderMarkdown('[Kursi](2:255)', { refs: false })).toBe('<p>Kursi</p>')
  })

  it('knows every surah’s ayah count (6,236 in all)', () => {
    let total = 0
    for (let s = 1; s <= 114; s++) total += ayahCount(s)
    expect(total).toBe(6236)
    expect(ayahCount(0)).toBe(0)
    expect(ayahCount(115)).toBe(0)
    expect(ayahCount(2)).toBe(286)
    expect(digitsValue('٢٥٥')).toBe(255)
    expect(digitsValue('12a')).toBeNaN()
  })
})

describe('safety', () => {
  const corpus = [
    '# Reflections on **2:255**\n\nThe *Throne* verse. ==Key point==: [read it](2:255).',
    '- [ ] memorise 18:1-10\n- [x] revise\n  1. first\n  2. second\n\n> A quote with <tags> & "quotes"',
    'Plain <b>html</b> and <a href="javascript:alert(1)">a link</a> and ![img](x.png)',
    '1. one\n\n   para in item\n2. two\n\n<https://example.com> [w](https://w.org)',
    '__strong__ _em_ ***both*** \\*escaped\\* `code` ~~strike~~',
    'سورة الكهف ١٨:١٠\n- **بسم الله**\n> ٱلْحَمْدُ لِلَّهِ',
  ]

  it('emits only tags of the sanitiser allowlist, and only data-ref attributes with valid references', () => {
    expect(MARKDOWN_TAGS.every((t) => (ALLOWED_TAGS as readonly string[]).includes(t))).toBe(true)
    for (const source of corpus) {
      const t = document.createElement('template')
      t.innerHTML = r(source)
      for (const el of t.content.querySelectorAll('*')) {
        expect(MARKDOWN_TAGS as readonly string[]).toContain(el.localName)
        for (const attr of el.attributes) {
          expect(attr.name).toBe('data-ref')
          expect(el.localName).toBe('a')
          expect(REF_PATTERN.test(attr.value)).toBe(true)
        }
      }
    }
  })

  it('survives the SafeHtml sanitiser unchanged', () => {
    for (const source of corpus) expect(sanitize(r(source))).toBe(normalise(r(source)))
  })

  it('renders a 100,000-character body and pathological inputs quickly', () => {
    const big = Array.from(
      { length: 1200 },
      (_, i) => `- **item ${i}** with *emphasis*, ==mark== and 2:${(i % 286) + 1}`,
    ).join('\n')
    expect(big.length).toBeGreaterThan(60_000)
    const cases = [
      big,
      '*a'.repeat(50_000),
      '['.repeat(50_000),
      '[a]('.repeat(25_000),
      '<'.repeat(100_000),
      '_'.repeat(100_000),
      '**'.repeat(50_000) + 'x',
      `# ${'# '.repeat(40_000)}x`,
      '> '.repeat(50_000),
    ]
    for (const source of cases) {
      const t0 = performance.now()
      renderMarkdown(source)
      expect(performance.now() - t0, source.slice(0, 12)).toBeLessThan(1500)
    }
  })
})

describe('plain text', () => {
  it('drops the markup and keeps one line per block', () => {
    expect(
      markdownToText('# Title\n\n**Bold** and _em_\n- [x] done\n> [Kursi](2:255)\n[w](https://w.org)'),
    ).toBe(`Title\nBold and em\n☑${NBSP}done\nKursi\nw (https://w.org)`)
    expect(markdownToText('')).toBe('')
  })
})

/** Applies an edit and marks the selection after it with [ and ] (or | for a caret). */
function show(text: string, edit: TextEdit): string {
  const next = applyEdit(text, edit)
  if (edit.selectionStart === edit.selectionEnd)
    return `${next.slice(0, edit.selectionStart)}|${next.slice(edit.selectionStart)}`
  return `${next.slice(0, edit.selectionStart)}[${next.slice(edit.selectionStart, edit.selectionEnd)}]${next.slice(edit.selectionEnd)}`
}

/** `text` with a selection written as [ and ] (or a caret |): the text and its offsets. */
function sel(marked: string): [string, number, number] {
  const caret = marked.indexOf('|')
  if (caret >= 0) return [marked.replace('|', ''), caret, caret]
  const a = marked.indexOf('[')
  const b = marked.indexOf(']') - 1
  return [marked.replace('[', '').replace(']', ''), a, b]
}

describe('editing: toggleInline', () => {
  const t = (marked: string, mark: 'strong' | 'em' | 'mark') => {
    const [text, a, b] = sel(marked)
    return show(text, toggleInline(text, a, b, mark))
  }

  it('wraps and unwraps a selection', () => {
    expect(t('say [hello] now', 'strong')).toBe('say **[hello]** now')
    expect(t('say **[hello]** now', 'strong')).toBe('say [hello] now')
    expect(t('say [**hello**] now', 'strong')).toBe('say [hello] now')
    expect(t('say [hello ]now', 'em')).toBe('say *[hello]* now')
    expect(t('a [b] c', 'mark')).toBe('a ==[b]== c')
    expect(t('a ==[b]== c', 'mark')).toBe('a [b] c')
  })

  it('tells emphasis from strong in runs of stars', () => {
    expect(t('**[x]**', 'em')).toBe('***[x]***')
    expect(t('***[x]***', 'em')).toBe('**[x]**')
    expect(t('***[x]***', 'strong')).toBe('*[x]*')
    expect(t('*[x]*', 'strong')).toBe('***[x]***')
  })

  it('uses the word at the caret, or inserts an empty pair', () => {
    expect(t('say hel|lo now', 'strong')).toBe('say **hel|lo** now')
    expect(t('say **hel|lo** now', 'strong')).toBe('say hel|lo now')
    expect(t('بسم ال|له', 'em')).toBe('بسم *ال|له*')
    expect(t('end |', 'strong')).toBe('end **|**')
    expect(t('end **|**', 'strong')).toBe('end |')
  })

  it('steps out of a span at its end, and removes the span from inside it', () => {
    expect(t('abc **Key p|**', 'strong')).toBe('abc **Key p**|')
    expect(t('abc **Key p|** more', 'strong')).toBe('abc **Key p**| more')
    expect(t('say *it|* now', 'em')).toBe('say *it*| now')
    expect(t('a ==hi|== b', 'mark')).toBe('a ==hi==| b')
    // Inside a span of several words: the whole span loses the mark.
    expect(t('abc **Ke|y p** x', 'strong')).toBe('abc Ke|y p x')
    expect(t('**a b|c**', 'strong')).toBe('a b|c')
    expect(t('***x|y***', 'strong')).toBe('*x|y*')
    // Spans pair from the line's start: after a closed span the caret is outside again.
    expect(t('**a** b|c', 'strong')).toBe('**a** **b|c**')
    expect(t('**a** **b|c**', 'strong')).toBe('**a** b|c')
    // Another mark's span is not this one's (italic inside bold is valid); a bullet's star never opens one.
    expect(t('**Key p|**', 'em')).toBe('**Key *p|***')
    expect(t('* ite|m', 'em')).toBe('* *ite|m*')
  })

  it('Mod+B, type, Mod+B, type: the second press ends the bold text (no nested markers)', () => {
    let text = 'abc '
    let caret = text.length
    const press = () => {
      const edit = toggleInline(text, caret, caret, 'strong')
      text = applyEdit(text, edit)
      caret = edit.selectionStart
    }
    const type = (s: string) => {
      text = text.slice(0, caret) + s + text.slice(caret)
      caret += s.length
    }
    press()
    expect(show(text, { from: 0, to: 0, insert: '', selectionStart: caret, selectionEnd: caret })).toBe(
      'abc **|**',
    )
    type('Key p')
    press()
    expect(text).toBe('abc **Key p**')
    expect(caret).toBe(text.length)
    type('oint')
    expect(text).toBe('abc **Key p**oint')
    // And on again: a new pair at the caret.
    type(' ')
    press()
    type('more')
    press()
    expect(text).toBe('abc **Key p**oint **more**')
  })
})

describe('editing: toggleLines', () => {
  const t = (marked: string, format: 'bullet' | 'ordered' | 'quote' | 'heading') => {
    const [text, a, b] = sel(marked)
    return show(text, toggleLines(text, a, b, format))
  }

  it('adds a format to every touched line and removes it when all have it', () => {
    expect(t('[one\ntwo]', 'bullet')).toBe('[- one\n- two]')
    expect(t('[- one\n- two]', 'bullet')).toBe('[one\ntwo]')
    expect(t('[one\n\ntwo]', 'ordered')).toBe('[1. one\n\n2. two]')
    expect(t('[- one\n- two]', 'ordered')).toBe('[1. one\n2. two]')
    expect(t('[1. one\n2. two]', 'bullet')).toBe('[- one\n- two]')
    expect(t('[a\nb]', 'quote')).toBe('[> a\n> b]')
    expect(t('[> a\n> b]', 'quote')).toBe('[a\nb]')
    expect(t('Ti|tle', 'heading')).toBe('## Ti|tle')
    expect(t('## Ti|tle', 'heading')).toBe('Ti|tle')
    expect(t('# Ti|tle', 'heading')).toBe('Ti|tle')
  })

  it('keeps the caret on its character and only touches the caret’s line', () => {
    expect(t('first\nsec|ond\nthird', 'bullet')).toBe('first\n- sec|ond\nthird')
    expect(t('first\n- sec|ond\nthird', 'bullet')).toBe('first\nsec|ond\nthird')
    expect(t('|', 'bullet')).toBe('- |')
  })
})

describe('editing: continueList', () => {
  const t = (marked: string) => {
    const [text, a] = sel(marked)
    const edit = continueList(text, a)
    return edit === null ? null : show(text, edit)
  }

  it('continues bullets, numbers, tasks and quotes', () => {
    expect(t('- one|')).toBe('- one\n- |')
    expect(t('  * nested|')).toBe('  * nested\n  * |')
    expect(t('1. one|')).toBe('1. one\n2. |')
    expect(t('9) nine|')).toBe('9) nine\n10) |')
    expect(t('١. أول|')).toBe('١. أول\n٢. |')
    expect(t('- [x] done|')).toBe('- [x] done\n- [ ] |')
    expect(t('> quote|')).toBe('> quote\n> |')
    expect(t('- sp|lit')).toBe('- sp\n- |lit')
  })

  it('ends the list on an empty item and leaves other lines alone', () => {
    expect(t('- one\n- |')).toBe('- one\n|')
    expect(t('1. |')).toBe('|')
    expect(t('plain text|')).toBeNull()
    expect(t('|- one')).toBeNull()
  })
})
