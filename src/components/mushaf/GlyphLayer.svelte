<!--
  GlyphLayer (§8.3, §8.4). Owner: WP8a. One `.mp-glyphs` rendition of a page: the 15-line grid (8 on the opening pages)
  with every word as a plain span, keyed by word id. There is no per-word component and no per-word derivation (§8.3).

  - `rendition="qcf"` draws each word's style glyph (`code_v1`/`code_v2`, or `text_hafs` for the hafs style) in the page
    font; `rendition="fallback"` draws its Unicode `text` in the bundled Hafs font, in the same line boxes (§8.5 c).
  - Header lines hold the surah header and the basmala (`HeaderLine`/`BasmalaLine`, WP8c); ayah lines hold `.lw > .w`.
  - Mounted by `RenditionStack` (WP8b), which runs `fitLines` and `measure` on `element` once the font is ready.
  - Hooks for other packages: pointer delegation via `use:interactions` (WP8d) when the page is interactive; the memo
    class map `.w-hid` (WP9b, §8.16); `.e` on end markers; `.w-sajda` on the word carrying ۩ (WP8c, §8.9 overline).
-->
<script module lang="ts">
  /** A rendition serial (`data-r`): tells stacked renditions of one page apart (tests, the font cross-fade). */
  let serial = 0

  /** U+06E9 ARABIC PLACE OF SAJDAH, carried by the sajda word's text (e.g. `وَأَنَابَ ۩`). */
  const SAJDA_SIGN = '۩'
</script>

<script lang="ts">
  import type { GlyphLayerProps } from '$lib/contracts/components'
  import type { PageWord } from '$lib/ipc/bindings'
  import { getPageContext } from '$lib/mushaf/geometry'
  import { interactions } from '$lib/mushaf/interactions'
  import { renditionFontFamily } from '$lib/mushaf/warmup'
  import { memo } from '$lib/stores'
  import BasmalaLine from './BasmalaLine.svelte'
  import HeaderLine from './HeaderLine.svelte'

  let {
    data,
    rendition,
    family,
    glyphScale,
    centerGap,
    // No fallback value: a parent may bind a slot that starts out undefined (`bind:element={layers[i]}`).
    element = $bindable(),
  }: GlyphLayerProps = $props()

  const page = getPageContext()
  serial += 1
  const r = serial

  /** qfs outside a MushafPage (a standalone rendition): read once from the inherited `--qfs`. */
  let inheritedQfs = $state(0)
  const qfs = $derived(page?.qfs ?? inheritedQfs)
  const interactive = $derived(page?.interactive ?? false)
  /** The fallback rendition draws each word's Unicode text instead of its style glyph (§8.5 c). */
  const unicode = $derived(rendition === 'fallback')
  const familyName = $derived(family.replace(/[^\w -]/g, ''))
  /** Unicode text in the bundled Hafs face: the hafs style, and every fallback rendition. */
  const hafsFont = $derived(unicode || familyName === 'qd-hafs')
  /** The Hafs face falls back to Naskh (Unicode text stays legible); a QCF page font has no fallback (PUA codes). */
  const fontFamily = $derived(renditionFontFamily(family, unicode))

  function wordClass(w: PageWord): string {
    if (w.isEnd) return 'w e'
    return w.text.includes(SAJDA_SIGN) ? 'w w-sajda' : 'w'
  }

  /** `use:interactions` (WP8d) only while the page is interactive; thumbnails and previews get none. */
  function pointer(node: HTMLElement, enabled: boolean) {
    let handle = enabled ? interactions(node) : null
    return {
      update(next: boolean) {
        if (next && !handle) handle = interactions(node)
        else if (!next && handle) {
          handle.destroy()
          handle = null
        }
      },
      destroy() {
        handle?.destroy()
        handle = null
      },
    }
  }

  $effect(() => {
    if (page || !element) return
    const value = Number.parseFloat(getComputedStyle(element).getPropertyValue('--qfs'))
    inheritedQfs = Number.isFinite(value) ? value : 0
  })

  /**
   * The memo class map (§8.16): one effect per rendition toggles `.w-hid` on the word spans whenever the memo session,
   * the reveal position or peeking changes, or the words change. No per-word derivation.
   */
  let hiddenApplied = false
  $effect(() => {
    const el = element
    void data.lines
    const session = memo.active
    void memo.revealedThrough
    void memo.peeking
    if (!el) return
    const spans = el.getElementsByClassName('w')
    if (!session) {
      if (hiddenApplied) for (const span of spans) span.classList.remove('w-hid')
      hiddenApplied = false
      return
    }
    for (const span of spans) {
      const id = Number((span as HTMLElement).dataset.w)
      span.classList.toggle('w-hid', memo.isHidden(id))
    }
    hiddenApplied = true
  })
</script>

<div
  bind:this={element}
  use:pointer={interactive}
  class="mp-glyphs quran-text"
  data-rendition={rendition}
  data-r={r}
  data-interactive={interactive ? '' : undefined}
  data-unicode={hafsFont ? '' : undefined}
  aria-hidden="true"
  dir="rtl"
  lang="ar"
  style:--glyph-family={fontFamily}
  style:--glyph-scale={glyphScale}
  style:--center-gap={centerGap}
>
  {#each data.lines as line (line.line)}
    <div
      class="ln"
      data-l={line.line}
      data-k={line.kind}
      data-c={line.centered ? '' : undefined}
      style:--l={line.line}
    >
      {#if line.kind === 'surah_name'}
        <HeaderLine {line} {qfs} layout={data.layout} />
      {:else if line.kind === 'basmallah'}
        <BasmalaLine {line} {qfs} layout={data.layout} />
      {:else}
        <div class="lw">
          {#each line.words as w (w.id)}
            <span class={wordClass(w)} data-w={w.id} data-a={w.ayahId}>{unicode ? w.text : w.glyph}</span>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</div>
