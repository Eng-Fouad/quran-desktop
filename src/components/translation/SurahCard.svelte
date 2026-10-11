<!--
  SurahCard (§9.7): the opening of a surah in translation mode. The `SurahCartouche` (WP8c) at a reduced scale (its
  qfs fills ~62 % of the column), the surah's name and meaning (English UI), "Meccan · 7 ayahs · p 1" in UI digits, and
  the basmala line in `qd-hafs` (26 px × translationFontPct) for every surah except 1 (where the basmala is the first
  ayah) and 9 (which has none). A heading names the surah for screen-reader navigation. Owner: WP11a.
-->
<script lang="ts">
  import SurahCartouche from '$components/mushaf/SurahCartouche.svelte'
  import { i18n, quran, settings } from '$lib/stores'

  interface Props {
    surah: number
    /** Inner width of the reading column (px), for the cartouche's scale. */
    columnWidth: number
    /** The Mushaf layout page numbers refer to. */
    page: number
    /** The first card of the list (less room above it). */
    first?: boolean
    /** `aria-posinset` / `aria-setsize` in the verse feed. */
    position: number
    setSize: number
  }

  let { surah, columnWidth, page, first = false, position, setSize }: Props = $props()

  /** The basmala as a line of text (§8.8 fallback); never shown before Al-Fatihah (its ayah 1) and At-Tawbah. */
  const BASMALA = 'بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ'
  /** Cartouche geometry (§8.8): 16.5 × 1.55 qfs. */
  const CARTOUCHE_W = 16.5
  const CARTOUCHE_H = 1.55

  const info = $derived(quran.surah(surah))
  const qfs = $derived(Math.max(14, Math.min(28, (columnWidth * 0.62) / CARTOUCHE_W)))
  const english = $derived(i18n.locale !== 'ar')
  const place = $derived(
    info ? i18n.t(info.revelationPlace === 'madinah' ? 'common.medinan' : 'common.meccan') : '',
  )
  const meta = $derived(
    info
      ? [
          place,
          i18n.tp('common.ayahCount', info.ayahCount),
          i18n.t('content.surah.pageShort', { page: i18n.num(page) }),
        ]
      : [],
  )
  const heading = $derived(
    info
      ? i18n.t('content.surah.heading', {
          number: i18n.num(surah),
          name: quran.surahName(surah),
          meaning: info.nameEn,
        })
      : '',
  )
  const basmala = $derived(surah !== 1 && surah !== 9)
  const scale = $derived(settings.value.translationFontPct / 100)
</script>

<article
  class="card"
  class:first
  data-surah={surah}
  aria-labelledby="tv-s{surah}"
  aria-posinset={position}
  aria-setsize={setSize}
>
  <h2 class="sr-only" id="tv-s{surah}">{heading}</h2>
  <div
    class="cartouche"
    style:inline-size="{Math.round(qfs * CARTOUCHE_W)}px"
    style:block-size="{Math.round(qfs * CARTOUCHE_H)}px"
    aria-hidden="true"
  >
    <SurahCartouche {surah} {qfs} />
  </div>
  {#if info}
    {#if english}
      <p class="name" aria-hidden="true">
        <span class="simple">{info.nameSimple}</span>
        <span class="meaning">{info.nameEn}</span>
      </p>
    {/if}
    <p class="meta" aria-hidden="true">
      {#each meta as part, i (i)}
        {#if i > 0}<span class="sep">{i18n.t('content.sep')}</span>{/if}<span>{part}</span>
      {/each}
    </p>
  {/if}
  {#if basmala}
    <p class="basmala quran-text" lang="ar" dir="rtl" style:--_scale={scale}>{BASMALA}</p>
  {/if}
</article>

<style>
  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    padding-block: var(--space-12) var(--space-6);
    padding-inline: var(--space-4);
    text-align: center;
  }

  .first {
    padding-block-start: var(--space-8);
  }

  .cartouche {
    display: flex;
    max-inline-size: 100%;
    margin-block-end: var(--space-2);
  }

  .name {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: baseline;
    gap: 0 var(--space-2);
    margin: 0;
    line-height: var(--leading-title);
  }

  .simple {
    color: var(--text);
    font-size: var(--text-xl);
    font-weight: var(--weight-title);
  }

  .meaning {
    color: var(--text-muted);
    font-size: var(--text-md);
  }

  .meta {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    line-height: var(--leading-ui);
  }

  .sep {
    color: var(--text-faint);
  }

  .basmala {
    margin-block: var(--space-4) 0;
    margin-inline: 0;
    color: var(--ink);
    font-family: var(--font-quran);
    font-size: calc(26px * var(--_scale, 1));
    line-height: 1.9;
  }
</style>
