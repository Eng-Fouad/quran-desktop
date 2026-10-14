<!--
  NoteBody: a note body rendered from its Markdown subset (`$lib/text/markdown`). The HTML comes
  from the escaping renderer and is shown through `SafeHtml` (DOMPurify again), never with a raw `{@html}`.

  After each render the blocks are finished in the DOM, with nothing taken from the note but validated values:
  - every paragraph, heading and list item takes the direction of its own text (`dir="auto"`), and every list and
    quote the direction of the text it starts with, so an Arabic paragraph in the English UI (or an English one in the
    Arabic UI) runs, aligns and indents in its own direction;
  - numbered lists get back their first number (`<ol start>`; the sanitiser keeps no attributes);
  - `https://` addresses become links that open in the system browser (`system_open_external`); the webview never
    navigates.

  Ayah references (`2:255`) are buttons: `onref` gets the ayah id and the range end, or by default the reader shows
  the ayah (flashing it) without moving the selection or the focus.
-->
<script lang="ts">
  import SafeHtml from '$components/ui/SafeHtml.svelte'
  import { api, call } from '$lib/ipc'
  import { i18n, quran, reader, ui } from '$lib/stores'
  import { parseRef } from '$lib/text/html'
  import { orderedListStarts, parseMarkdown, renderBlocks } from '$lib/text/markdown'

  interface Props {
    body: string
    /** A reference was activated (default: show the ayah in the reader). */
    onref?: (fromAyahId: number, toAyahId: number) => void
    /** `sm` for the side pane, `md` for the editor preview. */
    size?: 'sm' | 'md'
    class?: string
  }

  let { body, onref, size = 'md', class: className }: Props = $props()

  const blocks = $derived(parseMarkdown(body))
  const html = $derived(renderBlocks(blocks))
  const starts = $derived(orderedListStarts(blocks))

  let root: HTMLDivElement | undefined = $state()

  /** An https address in running text (closing punctuation stays outside). */
  const URL_RE = /https:\/\/[^\s<>"'()[\]]*[^\s<>"'()[\].,;:!?،؛]/gu
  /** Blocks whose own text decides their direction. */
  const LEAVES = 'p, li, h2, h3, h4'
  /** Blocks that hold other blocks: `dir=auto` would skip the children's text, so their direction is set from it. */
  const CONTAINERS = 'ul, ol, blockquote'
  const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u
  const LETTER = /\p{L}/u

  /** The direction of the first strong character of a text, or `null` when it has none. */
  function firstStrong(text: string): 'ltr' | 'rtl' | null {
    for (const ch of text) {
      if (RTL_LETTER.test(ch)) return 'rtl'
      if (LETTER.test(ch)) return 'ltr'
    }
    return null
  }

  $effect(() => {
    const el = root
    void html
    if (!el) return
    decorate(el, starts)
  })

  function decorate(el: HTMLElement, olStarts: readonly number[]): void {
    for (const block of el.querySelectorAll<HTMLElement>(LEAVES)) block.dir = 'auto'
    for (const block of el.querySelectorAll<HTMLElement>(CONTAINERS)) {
      const dir = firstStrong(block.textContent ?? '')
      if (dir) block.dir = dir
    }
    el.querySelectorAll('ol').forEach((ol, i) => {
      const start = olStarts[i] ?? 1
      if (start !== 1) ol.start = start
    })
    linkify(el)
  }

  function linkify(el: HTMLElement): void {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const texts: Text[] = []
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n instanceof Text && n.data.includes('https://') && !n.parentElement?.closest('a, button'))
        texts.push(n)
    }
    for (const text of texts) {
      const parts: Node[] = []
      let last = 0
      for (const m of text.data.matchAll(URL_RE)) {
        const url = m[0]
        let host: string
        try {
          host = new URL(url).host
        } catch {
          continue
        }
        if (m.index > last) parts.push(document.createTextNode(text.data.slice(last, m.index)))
        const a = document.createElement('a')
        a.href = url
        a.className = 'note-link'
        a.rel = 'noopener noreferrer'
        a.title = i18n.t('notes.body.link', { host })
        a.textContent = url
        parts.push(a)
        last = m.index + url.length
      }
      if (parts.length === 0) continue
      if (last < text.data.length) parts.push(document.createTextNode(text.data.slice(last)))
      text.replaceWith(...parts)
    }
  }

  function onclick(e: MouseEvent): void {
    const link = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a.note-link') : null
    if (!link || !root?.contains(link)) return
    e.preventDefault()
    call(api.systemOpenExternal(link.href)).catch((err: unknown) => ui.toastError(err))
  }

  function openRef(ref: string): void {
    const parsed = parseRef(ref)
    if (!parsed) return
    const from = quran.ayahId(parsed.surah, parsed.fromAyah)
    const to = quran.ayahId(parsed.surah, parsed.toAyah)
    if (from === 0) return
    if (onref) {
      onref(from, to === 0 ? from : to)
      return
    }
    ui.setView('reader')
    reader.goToAyah(from, { flash: true })
  }
</script>

<!-- Delegation container for the web links added after rendering (they are real anchors with their own semantics). -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class={['note-body', `s-${size}`, className]} bind:this={root} {onclick}>
  <SafeHtml {html} onref={openRef} />
</div>

<style>
  .note-body {
    --_size: var(--text-md);
    color: var(--text);
    font-size: var(--_size);
    line-height: 1.65;
    overflow-wrap: anywhere;
  }

  .s-sm {
    --_size: var(--text-sm);
  }

  .note-body :global(:is(p, li, h2, h3, h4, blockquote)) {
    unicode-bidi: plaintext;
    text-align: start;
  }

  .note-body :global(:is(p, ul, ol, blockquote, h2, h3, h4)) {
    margin: 0;
  }

  .note-body :global(:is(p, ul, ol, blockquote, h2, h3, h4) + :is(p, ul, ol, blockquote, h2, h3, h4)) {
    margin-block-start: 0.7em;
  }

  .note-body :global(h2) {
    font-size: calc(var(--_size) * 1.3);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .note-body :global(h3) {
    font-size: calc(var(--_size) * 1.12);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .note-body :global(h4) {
    font-size: var(--_size);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .note-body :global(:is(ul, ol)) {
    padding-inline-start: 1.5em;
  }

  .note-body :global(li + li),
  .note-body :global(li > :is(ul, ol)) {
    margin-block-start: 0.2em;
  }

  .note-body :global(li::marker) {
    color: var(--text-muted);
  }

  .note-body :global(blockquote) {
    padding-inline-start: 0.9em;
    border-inline-start: 3px solid var(--border-strong);
    color: var(--text-muted);
  }

  .note-body :global(strong) {
    font-weight: var(--weight-title);
  }

  .note-body :global(mark) {
    padding-inline: 0.12em;
    border-radius: 3px;
    background-color: var(--user-hl-yellow);
    color: inherit;
    box-decoration-break: clone;
  }

  .note-body :global(button.ref) {
    border-radius: 3px;
    text-decoration-color: color-mix(in srgb, var(--accent-text) 45%, transparent);
    text-decoration-thickness: 1px;
    unicode-bidi: isolate;
    transition: text-decoration-color var(--dur-fast) var(--ease-standard);
  }

  .note-body :global(button.ref:hover) {
    text-decoration-color: currentColor;
  }

  .note-body :global(a.note-link) {
    color: var(--accent-text);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--accent-text) 45%, transparent);
    text-underline-offset: 0.2em;
    word-break: break-all;
  }

  .note-body :global(a.note-link:hover) {
    text-decoration-color: currentColor;
  }

  .note-body :global(a.note-link:focus-visible) {
    border-radius: 2px;
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  @media (forced-colors: active) {
    .note-body :global(mark) {
      outline: 1px solid CanvasText;
    }
  }
</style>
