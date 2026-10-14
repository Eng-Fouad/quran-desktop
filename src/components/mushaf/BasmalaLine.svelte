<!--
  BasmalaLine. A `basmallah` line of the 15-line grid, rendered by `GlyphLayer` inside its `.ln`:

  - the page's ornaments on (`MushafPageProps.ornaments`, else the `ornateHeaders` setting) and decor installed (the
    `qd-quran-common` face loaded): its basmala calligraphy, U+FDFD, at `--basmala-scale`·qfs;
  - otherwise the Unicode basmala in qd-hafs at 0.95·qfs, centred.

  While the recitation plays the basmala segment before this surah (`player.currentRef` = {surah, ayah: 0}), the line
  carries the audio highlight (--hl-audio) as a pill behind the text, like an ayah's. Glyph colours never change.
-->
<script lang="ts">
  import type { HeaderLineProps } from '$lib/contracts/components'
  import { getPageContext } from '$lib/mushaf/geometry'
  import { BASMALA_TEXT, DECOR_BASMALA } from '$lib/mushaf/ornaments'
  import { fonts, player, settings } from '$lib/stores'

  let { line, layout }: HeaderLineProps = $props()

  const page = getPageContext()
  const decor = $derived(
    (page?.ornaments ?? settings.value.ornateHeaders) && fonts.status.get('qd-quran-common') === 'ready',
  )
  const playing = $derived(
    line.surah !== null && player.currentRef?.surah === line.surah && player.currentRef.ayah === 0,
  )
</script>

<div
  class="bsm-line"
  data-surah={line.surah ?? undefined}
  data-decor={decor ? '' : undefined}
  data-playing={playing ? '' : undefined}
  data-layout={layout}
>
  <!-- Each rendition of the text is its own element (with its pill): a decor font arriving late replaces the text
       inside a line box that never moves, so nothing shifts (CLS 0). -->
  {#if decor}
    <span class="bsm bsm-decor" lang="ar"><span class="bsm-hl" aria-hidden="true"></span>{DECOR_BASMALA}</span
    >
  {:else}
    <span class="bsm quran-text" lang="ar"><span class="bsm-hl" aria-hidden="true"></span>{BASMALA_TEXT}</span
    >
  {/if}
</div>
