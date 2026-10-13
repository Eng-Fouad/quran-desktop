<!--
  A11yLayer (§8.15). Owner: WP8d. The page's text for screen readers: every glyph layer is `aria-hidden` (QCF glyphs are
  PUA code points), so each interactive page carries this visually hidden ordered list with one item per ayah segment
  on the page, in reading order.

  - Each `li` (`lang="ar" dir="rtl"`, id `a11y-{page}-{ayahId}`) speaks `toSpeech` of the ayah's words on this page
    followed by its Arabic-Indic number, ` (٢٥٥)`, then a span in the UI language with the reference, whether the ayah
    continues across the page edge, and the margin markers that start there (juz, hizb, quarter, sajda): the margin
    draws them for the eye only, `aria-hidden` (§8.9).
  - The items are the reading cursor's roving targets: exactly one item in the view is a tab stop, the cursor's
    segment on the first visible page that holds it, else the first ayah of the first visible page. "Skip to Quran
    text" focuses it (`li[tabindex="0"]`, App.svelte). Arrow keys, Enter, Space and the study keys reach the reader
    shortcuts from here (§7.7: the widget guard exempts `.mp-a11y li`), and WP8e's cursor moves DOM focus between
    items. Focusing an item (Tab, a screen reader's focus mode) puts the reading cursor on its ayah.
-->
<script lang="ts">
  import type { A11yLayerProps } from '$lib/contracts/components'
  import { a11yItemId, divisionsOf, pageSegments, type A11ySegment, type Division } from '$lib/mushaf/a11y'
  import { i18n, quran, reader } from '$lib/stores'

  let { data }: A11yLayerProps = $props()

  const segments = $derived(pageSegments(data))

  /** The one roving tab stop of the view, if it is on this page (see the header comment). */
  const tabStop: number | null = $derived.by(() => {
    const visible = reader.visiblePages
    const cursor = reader.cursorAyahId
    if (cursor !== null) {
      const here = segments.find((s) => s.ayah.id === cursor)
      if (here) return here.continued && visible.includes(data.page - 1) ? null : cursor
      // The cursor's ayah starts on (or continues onto) another visible page: the tab stop is there.
      const start = quran.pageOfAyah(data.layout, cursor)
      if ((visible.includes(start) || visible.includes(start + 1)) && start !== data.page) return null
    }
    const first = visible.length > 0 ? Math.min(...visible) : data.page
    return first === data.page ? (segments[0]?.ayah.id ?? null) : null
  })

  function divisionText(d: Division): string {
    switch (d.kind) {
      case 'juz':
        return i18n.t('interactions.a11y.juz', { n: d.juz })
      case 'hizb':
        return i18n.t('interactions.a11y.hizb', { n: d.hizb })
      case 'quarter':
        return i18n.t(
          d.quarter === 1
            ? 'interactions.a11y.quarter'
            : d.quarter === 2
              ? 'interactions.a11y.half'
              : 'interactions.a11y.threeQuarters',
          { n: d.hizb },
        )
      case 'sajda':
        return i18n.t(d.obligatory ? 'interactions.a11y.sajdaObligatory' : 'interactions.a11y.sajda')
    }
  }

  /** The UI-language part of an item: reference, continuation and margin markers, comma-separated. */
  function context(s: A11ySegment): string {
    const parts = [
      i18n.t('interactions.a11y.ref', { surah: quran.surahName(s.ayah.surah), ayah: s.ayah.ayah }),
    ]
    if (s.continued) parts.push(i18n.t('interactions.a11y.continued'))
    if (s.continues) parts.push(i18n.t('interactions.a11y.continues'))
    for (const d of divisionsOf(s.ayah)) parts.push(divisionText(d))
    return parts.join(i18n.locale === 'ar' ? '، ' : ', ')
  }

  /** Focus on an item puts the reading cursor on its ayah (WP8e's cursor keys then continue from there). */
  function onfocusin(e: FocusEvent): void {
    if (!(e.target instanceof HTMLElement)) return
    const id = Number(e.target.closest<HTMLElement>('li[data-ayah]')?.dataset.ayah)
    if (Number.isInteger(id) && reader.cursorAyahId !== id) reader.cursorAyahId = id
  }
</script>

<ol class="mp-a11y sr-only" aria-label={i18n.t('interactions.a11y.list', { page: data.page })} {onfocusin}>
  {#each segments as s (s.ayah.id)}
    <!-- The reading cursor's roving focus target (§8.15): the reader's keyboard commands act on the focused ayah. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <li
      id={a11yItemId(data.page, s.ayah.id)}
      class="quran-text"
      lang="ar"
      dir="rtl"
      tabindex={tabStop === s.ayah.id ? 0 : -1}
      data-ayah={s.ayah.id}
    >
      {s.speech}<span lang={i18n.locale} dir={i18n.dir}>{i18n.locale === 'ar' ? '، ' : ', '}{context(s)}</span
      >
    </li>
  {/each}
</ol>

<style>
  /*
   * Unseen, but laid out: the ayah text takes the bundled Hafs face, which has every QPC Hafs code point, so no
   * Quranic mark falls back to a system font (a slow, synchronous lookup in WebView2: Segoe UI drew 1,124 glyphs of
   * each page's list before); the reference after it is UI text.
   */
  .mp-a11y li {
    font-family: var(--font-quran), var(--font-naskh);
  }

  .mp-a11y li > span {
    font-family: var(--font-ui);
  }

  /* The items are visually hidden; the highlight layer draws the reading cursor's ring (§8.7 layer 7). */
  .mp-a11y li:focus,
  .mp-a11y li:focus-visible {
    outline: none;
  }
</style>
