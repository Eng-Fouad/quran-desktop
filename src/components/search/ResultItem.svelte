<!--
  ResultItem (§9.7): one search hit, a row of at least 56 px. Owner: WP10b. Used only inside `SearchResults`.

  - A meta line: the key badge "2:255" (UI digits, bidi-isolated), "Note" for a note hit, the page "p 42", and at the
    inline end the chip "+2 more in this ayah" when matches lie outside the shown words.
  - Quran hits: the ayah in `--font-quran` (`.quran-text`) at 22 px, line-height 2.1, built from `SearchHit.words`: a
    window of whole words around the first matched word (`hitWindow`: ±12 words, fitted to three lines when the line
    width is known), matched words in `<mark class="hit">` (`--hl-search` fill, `--hl-search-solid` underline,
    radius 3). Where words were cut off, the edge word fades over 24 px (never an ellipsis inside a word, §9.3).
  - Translation and note hits: the snippet (escaped HTML with `<mark>` only) through `SafeHtml`, text-sm, in the
    pack's language and direction, at most three lines.
  - States: hover `--surface-hover`; the active hit (open in the reader) has a 2 px accent bar on the inline-start
    edge and an accent key badge. The row is a button: click opens it, middle click (and `Mod+Enter`, handled by the
    list) opens it in the side pane, right click opens the hit menu.
-->
<script lang="ts">
  import StickyNote from '@lucide/svelte/icons/sticky-note'
  import SafeHtml from '$components/ui/SafeHtml.svelte'
  import type { SearchHit } from '$lib/ipc/bindings'
  import { i18n, quran } from '$lib/stores'
  import { hitWindow, type LineFit, matchedIndices } from './window'
  import { bindsToPrevious, NBSP } from '$lib/text/endmark'

  interface Props {
    hit: SearchHit
    /** Index of the hit in `search.flatHits`. */
    index: number
    active: boolean
    /** The list's single Tab stop. */
    tabStop: boolean
    /** How to fit Quran words into lines (null: the plain ±12-word window). */
    fit: LineFit | null
    /** Language and direction of a translation snippet (notes: the user's text, `auto`). */
    textLang?: string | null
    textDir?: 'ltr' | 'rtl' | 'auto'
    /** A note hit's title (from the library), shown above its snippet. */
    noteTitle?: string | null
    onopen: (hit: SearchHit, e: MouseEvent) => void
    onpane: (hit: SearchHit) => void
    onmenu: (hit: SearchHit, e: MouseEvent) => void
  }

  let {
    hit,
    index,
    active,
    tabStop,
    fit,
    textLang = null,
    textDir = 'auto',
    noteTitle = null,
    onopen,
    onpane,
    onmenu,
  }: Props = $props()

  const textId = $derived(`qd-hit-${index}`)
  const matched = $derived(matchedIndices(hit.firstWordId, hit.words.length, hit.matchedWordIds))
  const win = $derived(hit.words.length > 0 ? hitWindow(hit.words, matched, fit) : null)

  /** The shown words: text, matched, and which edge fades (`start` / `end` of the window). */
  const shown = $derived.by(() => {
    if (!win) return []
    const marks = new Set(matched)
    const out: { text: string; mark: boolean; edge: 'cut-start' | 'cut-end' | null; space: string }[] = []
    for (let i = win.start; i < win.end; i++) {
      out.push({
        text: hit.words[i] ?? '',
        mark: marks.has(i),
        edge:
          i === win.start && win.cutBefore
            ? 'cut-start'
            : i === win.end - 1 && win.cutAfter
              ? 'cut-end'
              : null,
        // The end mark (۝N) stays on the line of the ayah's last word.
        space: i < win.end - 1 ? (bindsToPrevious(hit.words[i + 1]) ? NBSP : ' ') : '',
      })
    }
    return out
  })

  const hidden = $derived(win?.hiddenMatches ?? 0)
  /** The title above a note's snippet, unless the snippet is the title itself (only the title matched). */
  const showTitle = $derived.by(() => {
    if (!noteTitle || !hit.snippet) return false
    const text = new DOMParser().parseFromString(hit.snippet, 'text/html').body.textContent ?? ''
    return text.replace(/[…\s]+/gu, ' ').trim() !== noteTitle.replace(/\s+/gu, ' ').trim()
  })
  const label = $derived(
    i18n.t('search.hit.label', { ref: quran.refLabel(hit.ayahId, 'long'), page: hit.page }),
  )

  function onauxclick(e: MouseEvent): void {
    if (e.button !== 1) return
    e.preventDefault()
    onpane(hit)
  }

  function onmousedown(e: MouseEvent): void {
    // No autoscroll cursor on a middle click (it opens the side pane instead).
    if (e.button === 1) e.preventDefault()
  }
</script>

<button
  type="button"
  class={['result', { active }]}
  data-hit={index}
  data-ayah={hit.ayahId}
  tabindex={tabStop ? 0 : -1}
  aria-label={label}
  aria-describedby={win || hit.snippet ? textId : undefined}
  aria-current={active ? 'true' : undefined}
  onclick={(e) => onopen(hit, e)}
  {onauxclick}
  {onmousedown}
  oncontextmenu={(e) => onmenu(hit, e)}
>
  <span class="meta">
    <span class="key tabular-nums">{i18n.ref(hit.surah, hit.ayah)}</span>
    {#if hit.noteId !== null}
      <span class="kind"
        ><StickyNote size={12} strokeWidth={2} aria-hidden="true" />{i18n.t('search.hit.note')}</span
      >
    {/if}
    <span class="page tabular-nums">{i18n.t('search.hit.page', { page: hit.page })}</span>
    {#if hidden > 0}
      <span class="more tabular-nums">
        <span class="more-long">{i18n.tp('search.hit.more', hidden)}</span>
        <span class="more-short" aria-hidden="true">{i18n.t('search.hit.moreShort', { count: hidden })}</span>
      </span>
    {/if}
  </span>
  {#if win}
    <span class="ayah quran-text" lang="ar" dir="rtl" id={textId}
      >{#each shown as w, i (i)}{#if w.mark}<mark class={['hit', w.edge]}>{w.text}</mark
          >{:else if w.edge}<span class={w.edge}>{w.text}</span>{:else}{w.text}{/if}{w.space}{/each}</span
    >
  {:else if hit.snippet}
    {#if showTitle}<span class="note-title"><bdi>{noteTitle}</bdi></span>{/if}
    <span class="snippet" id={textId} lang={textLang ?? undefined} dir={textDir}>
      <SafeHtml html={hit.snippet} />
    </span>
  {/if}
</button>

<style>
  .result {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 2px;
    inline-size: 100%;
    min-block-size: 56px;
    padding-block: var(--space-2) var(--space-1);
    padding-inline: var(--qd-search-pad-start, 12px) var(--qd-search-pad-end, 10px);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease-standard);
  }

  .result:hover {
    background-color: var(--surface-hover);
  }

  .result:focus-visible {
    outline-offset: -2px;
  }

  /* The hit open in the reader: a 2 px accent bar on the inline-start edge (§9.7). */
  .result.active::before {
    content: '';
    position: absolute;
    inset-block: var(--space-2);
    inset-inline-start: 0;
    inline-size: 2px;
    border-radius: var(--radius-full);
    background-color: var(--accent);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-block-size: 18px;
    color: var(--text-muted);
    font-size: var(--text-2xs);
    line-height: 1;
    white-space: nowrap;
    container-type: inline-size;
  }

  .key {
    display: inline-flex;
    align-items: center;
    block-size: 18px;
    padding-inline: 6px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-full);
    color: var(--text-muted);
    font-weight: var(--weight-title);
  }

  .active .key {
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
    background-color: var(--accent-soft);
    color: var(--accent-text);
  }

  .kind {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-weight: var(--weight-label);
  }

  .more {
    margin-inline-start: auto;
    padding-inline: 6px;
    block-size: 18px;
    display: inline-flex;
    align-items: center;
    border-radius: var(--radius-full);
    background-color: var(--hl-search);
    color: var(--text);
    font-weight: var(--weight-label);
  }

  .more-short {
    display: none;
  }

  @container (max-width: 210px) {
    .more-long {
      display: none;
    }

    .more-short {
      display: inline;
    }
  }

  /* §9.7: 22 px Quran text, line-height 2.1, whole words. */
  .ayah {
    display: block;
    color: var(--text);
    font-family: var(--font-quran);
    font-size: 22px;
    line-height: 2.1;
    text-align: start;
    overflow-wrap: normal;
  }

  .ayah mark.hit {
    border-radius: 3px;
    background-color: var(--hl-search);
    box-shadow: inset 0 -2px 0 var(--hl-search-solid);
    color: inherit;
  }

  /* The word at a cut edge fades out over 24 px at its outer side (the text is always right to left). */
  .ayah .cut-start,
  .ayah .cut-end {
    display: inline-block;
    line-height: inherit;
  }

  .ayah .cut-start {
    mask-image: linear-gradient(to left, transparent, #000 min(24px, 70%));
  }

  .ayah .cut-end {
    mask-image: linear-gradient(to right, transparent, #000 min(24px, 70%));
  }

  .note-title {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-title);
    line-height: var(--leading-ui);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .snippet {
    display: -webkit-box;
    overflow: hidden;
    color: var(--text);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
    unicode-bidi: plaintext;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }

  .snippet :global(mark) {
    border-radius: 3px;
    background-color: var(--hl-search);
    box-shadow: inset 0 -2px 0 var(--hl-search-solid);
    color: inherit;
  }

  @media (forced-colors: active) {
    .result.active::before {
      background-color: Highlight;
    }

    .ayah mark.hit,
    .snippet :global(mark) {
      outline: 1px solid Mark;
    }
  }
</style>
