<!--
  HeaderLine (§8.8). Owner: WP8c. A `surah_name` line of the 15-line grid, rendered by `GlyphLayer` inside its `.ln`:

  - the page's ornaments on (`MushafPageProps.ornaments`, else the `ornateHeaders` setting), decor installed (the
    `qd-surah-header` face loaded) and the surah has a `header_cp`: that one glyph (frame and name in the QCF
    surah-header font) at `--sh-scale`·qfs in --surah-header-ink;
  - otherwise the original `SurahCartouche` (the plain look: ornaments off, or decor not installed yet).
  - While the reader flips (§8.11), a header glyph not drawn before at this size shows the cartouche too: WebView2
    rasterises a QCF header (one colour glyph, 3.3 em wide) in ≈ 100 ms the first time at a size, which would stall the
    flip's frames (§8.18: none over 32 ms). The glyph replaces the cartouche once the flip has ended.

  On an interactive page a click opens `SurahInfoPopover` and hovering tints ayah 1 with the neutral hover highlight
  (`reader.setHover`), in step with the glyph layer's delegated interactions (WP8d), which leave header clicks to it.
-->
<script module lang="ts">
  import { SvelteSet } from 'svelte/reactivity'

  /** Header glyphs drawn at a size (`cp@px`): a flip shows only these (see above). */
  const painted = new SvelteSet<string>()
  /** At most this many remembered (the strike cache forgets old glyphs too). */
  const PAINTED_MAX = 64

  /** Forgets the drawn headers (tests). */
  export function resetPaintedHeaders(): void {
    painted.clear()
  }
</script>

<script lang="ts">
  import type { HeaderLineProps } from '$lib/contracts/components'
  import { getPageContext, isOpeningPage } from '$lib/mushaf/geometry'
  import { fonts, quran, reader, settings } from '$lib/stores'
  import SurahCartouche from './SurahCartouche.svelte'
  import { surahInfo } from './SurahInfoPopover.svelte'

  let { line, qfs, layout }: HeaderLineProps = $props()

  const page = getPageContext()
  const interactive = $derived(page?.interactive ?? false)
  const info = $derived(line.surah !== null ? quran.surah(line.surah) : undefined)
  const headerCp = $derived(info?.headerCp ?? null)
  /** The page draws the ornaments (its `ornaments` prop, else the `ornateHeaders` setting). */
  const ornate = $derived(page?.ornaments ?? settings.value.ornateHeaders)
  const decorReady = $derived(ornate && headerCp !== null && fonts.status.get('qd-surah-header') === 'ready')
  /** The glyph at this size; the opening pages draw it smaller (frame.css `--sh-scale`), hence their own key. */
  const glyphKey = $derived(`${headerCp}@${qfs}${page && isOpeningPage(page.page) ? 'o' : ''}`)
  const decor = $derived(decorReady && (!reader.flipping || painted.has(glyphKey)))

  // Once the glyph is on screen it is rasterised and cached: later flips may show it.
  $effect(() => {
    if (!decor) return
    const key = glyphKey
    if (painted.has(key)) return
    painted.add(key)
    if (painted.size > PAINTED_MAX) {
      const oldest = painted.values().next().value
      if (oldest !== undefined) painted.delete(oldest)
    }
  })
  const firstAyah = $derived(info?.firstAyahId ?? 0)

  let root: HTMLElement | undefined = $state()

  /**
   * Pointer handling of the header itself. The glyph layer's delegated word interactions (WP8d) leave header clicks
   * to this component and treat header lines as "not blank" (a click never clears the selection), and they tint ayah 1
   * on hover too; this keeps the behaviour of §8.8 wherever a header is mounted and stays idempotent with theirs.
   * Nothing is stopped: the word layer must still see the pointer arrive here to end a word's tooltip dwell.
   */
  $effect(() => {
    const el = root
    if (!el || !interactive || !info) return
    const surah = info.id
    const ayah = firstAyah
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return
      surahInfo.show(surah, el, layout)
    }
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || ayah <= 0) return
      if (reader.hover?.ayahId !== ayah) reader.setHover(ayah, quran.firstWordOf(ayah))
    }
    const onLeave = () => {
      if (reader.hover?.ayahId === ayah) reader.setHover(null, null)
    }
    el.addEventListener('click', onClick)
    el.addEventListener('pointerover', onOver)
    el.addEventListener('pointerleave', onLeave)
    return () => {
      el.removeEventListener('click', onClick)
      el.removeEventListener('pointerover', onOver)
      el.removeEventListener('pointerleave', onLeave)
    }
  })
</script>

<div
  bind:this={root}
  class="sh-line"
  data-qd-header=""
  data-surah={line.surah ?? undefined}
  data-decor={decor ? '' : undefined}
  data-layout={layout}
>
  {#if decor && headerCp !== null}
    <span class="sh" lang="ar">{String.fromCodePoint(headerCp)}</span>
  {:else if info}
    <SurahCartouche surah={info.id} {qfs} />
  {/if}
</div>
