<!--
  DivisionChip (§8.12). Owner: WP8f. The juz / hizb arrival chip in the canvas overlay slot. Takes no props: it reads
  stores (§7.9).

  When reading or the follow-along first enters a new juz (or hizb), it shows `بداية الجزء الخامس عشر · Juz 15` for
  2.5 s and announces it politely ("Beginning of Juz 15"), just after the reader's own page announcement.
  - **Reading:** a forward turn to the next page or spread (not a jump, not flipping) that brings a division's first
    ayah onto the screen.
  - **Follow-along:** with `followAlong` on, the recitation moving on to the first ayah of a new division (the basmala
    between surahs does not break the step).
  - **First:** each division once per session; a hizb that opens a juz is announced as the juz.
  - **Rail:** while the page rail is open the chip steps aside without spending its 2.5 s, and an arrival waits to be
    greeted until the rail goes (dropped if its page is no longer shown).
  - The Arabic heading uses the genitive ordinal in every UI language (`الحادي والعشرين`); the English UI adds the
    short label ("Juz 15").
-->
<script module lang="ts">
  import type { Division } from '$lib/ipc/bindings'

  export type DivisionKind = 'juz' | 'hizb'

  export interface DivisionStart {
    kind: DivisionKind
    /** The juz (1–30) or hizb (1–60) number. */
    n: number
    /** Its first ayah. */
    ayahId: number
  }

  const UNITS = ['', 'الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع']
  /** Tens in the genitive (after «بداية الجزء»): العشرين, not العشرون. */
  const TENS = [
    '',
    'العاشر',
    'العشرين',
    'الثلاثين',
    'الأربعين',
    'الخمسين',
    'الستين',
    'السبعين',
    'الثمانين',
    'التسعين',
  ]

  /**
   * The masculine Arabic ordinal of 1–99 in the genitive, as it follows «بداية الجزء» / «بداية الحزب»: الأول, الحادي عشر,
   * الخامس عشر, العشرين, الحادي والعشرين, الستين. Other numbers come back as Arabic-Indic digits.
   */
  export function arabicOrdinal(n: number): string {
    if (!Number.isInteger(n) || n < 1 || n > 99) return new Intl.NumberFormat('ar-u-nu-arab').format(n)
    if (n === 10) return TENS[1] ?? ''
    const unit = n % 10
    const ten = Math.floor(n / 10)
    const unitWord = unit === 1 && n > 10 ? 'الحادي' : (UNITS[unit] ?? '')
    if (ten === 0) return unitWord
    if (ten === 1) return `${unitWord} عشر`
    const tenWord = TENS[ten] ?? ''
    return unit === 0 ? tenWord : `${unitWord} و${tenWord}`
  }

  /**
   * Every juz and hizb start with the page it falls on (in a layout), in Mushaf order. A hizb that opens a juz is left
   * out: the juz stands for it.
   */
  export function divisionStarts(
    juz: readonly Division[],
    hizb: readonly Division[],
    pageOf: (ayahId: number) => number,
  ): (DivisionStart & { page: number })[] {
    const juzFirst = new Set(juz.map((d) => d.firstAyahId))
    const out = [
      ...juz.map((d) => ({ kind: 'juz' as const, n: d.id, ayahId: d.firstAyahId })),
      ...hizb
        .filter((d) => !juzFirst.has(d.firstAyahId))
        .map((d) => ({ kind: 'hizb' as const, n: d.id, ayahId: d.firstAyahId })),
    ]
    return out.map((d) => ({ ...d, page: pageOf(d.ayahId) })).sort((a, b) => a.ayahId - b.ayahId)
  }

  /** A forward step to the next page or spread: the new pages start right after the old ones. */
  export function isForwardStep(before: readonly number[], after: readonly number[]): boolean {
    if (before.length === 0 || after.length === 0) return false
    return Math.min(...after) === Math.max(...before) + 1
  }

  /**
   * Divisions already greeted in this session ("first enters", §8.12), kept for the app's lifetime: leaving the
   * Mushaf for the translation view or Settings and coming back does not greet them again.
   */
  const greeted: Record<string, true | undefined> = {}
</script>

<script lang="ts">
  import { untrack } from 'svelte'
  import { fly } from 'svelte/transition'
  import { translate } from '$lib/i18n'
  import { khatam } from '$lib/mushaf/ornaments'
  import { i18n, player, quran, reader, settings, ui } from '$lib/stores'
  import { railState } from './PageRail.svelte'

  const OUTER_STAR = khatam(12, 12, 10.5)
  const INNER_STAR = khatam(12, 12, 4.2)

  /** §8.12: how long the chip stays. */
  const SHOW_MS = 2500
  /** The announcement waits for the reader's own "Pages 281 and 282", so a screen reader speaks both. */
  const ANNOUNCE_AFTER_MS = 900

  /** The division starts of the current layout, with their pages. */
  const starts = $derived.by(() => {
    const layout = reader.layout
    const { juz, hizb } = quran.index
    return divisionStarts(juz, hizb, (id) => quran.pageOfAyah(layout, id))
  })

  let current = $state.raw<DivisionStart | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let announceTimer: ReturnType<typeof setTimeout> | undefined

  /** A division the open page rail hides: greeted (or shown again) once the rail goes, if its page is still shown. */
  let deferred: DivisionStart | null = null

  function show(division: DivisionStart): void {
    current = division
    clearTimeout(timer)
    timer = setTimeout(() => (current = null), SHOW_MS)
  }

  function arrive(division: DivisionStart): void {
    const key = `${division.kind}:${division.n}`
    if (greeted[key]) return
    if (railState.open) {
      deferred = division
      return
    }
    greeted[key] = true
    show(division)
    const text = i18n.t(`pagenav.division.${division.kind}`, {
      n: division.n,
      ordinal: arabicOrdinal(division.n),
    })
    clearTimeout(announceTimer)
    announceTimer = setTimeout(() => ui.announce(text), ANNOUNCE_AFTER_MS)
  }

  // The open rail hides the chip: a chip on screen waits with its time unspent, an arrival waits to be greeted. When
  // the rail goes, either shows for its full time if its page is still on screen, else it is dropped (an arrival not
  // greeted is greeted on a later visit).
  $effect(() => {
    const open = railState.open
    untrack(() => {
      if (open) {
        if (current) {
          deferred = current
          current = null
          clearTimeout(timer)
        }
        return
      }
      const d = deferred
      deferred = null
      if (!d) return
      const page = starts.find((s) => s.kind === d.kind && s.n === d.n)?.page
      if (page === undefined || !reader.visiblePages.includes(page)) return
      if (greeted[`${d.kind}:${d.n}`]) show(d)
      else arrive(d)
    })
  })

  // Reading: a forward turn to the next page or spread brings a division's start onto the screen.
  let before = untrack(() => reader.visiblePages)
  $effect(() => {
    const after = reader.visiblePages
    const flipping = reader.flipping
    untrack(() => {
      const previous = before
      before = after
      if (flipping || settings.value.readingMode !== 'mushaf' || !isForwardStep(previous, after)) return
      const lo = Math.min(...after)
      const hi = Math.max(...after)
      const start = starts.find((d) => d.page >= lo && d.page <= hi && !greeted[`${d.kind}:${d.n}`])
      if (start) arrive(start)
    })
  })

  // Follow-along: the recitation steps on to the first ayah of a new division.
  let heardBefore: number | null = untrack(() => player.currentAyahId)
  $effect(() => {
    const ayah = player.currentAyahId
    untrack(() => {
      if (ayah === null) return // the basmala between two surahs keeps the last ayah
      const previous = heardBefore
      heardBefore = ayah
      if (!settings.value.followAlong || !player.isActive || previous === null || ayah !== previous + 1)
        return
      const start = starts.find((d) => d.ayahId === ayah)
      if (start) arrive(start)
    })
  })

  $effect(() => () => {
    clearTimeout(timer)
    clearTimeout(announceTimer)
  })

  const heading = $derived(
    current
      ? translate('ar', `pagenav.division.${current.kind}`, {
          n: current.n,
          ordinal: arabicOrdinal(current.n),
        })
      : '',
  )
  const short = $derived(
    current === null || i18n.locale === 'ar'
      ? ''
      : current.kind === 'juz'
        ? i18n.t('common.juzNumber', { juz: current.n })
        : i18n.t('common.hizbNumber', { hizb: current.n }),
  )
  const motion = $derived(settings.reducedMotion ? 0 : 200)
</script>

{#if current && !railState.open}
  <!-- Announced through the live region (ui.announce), so the chip itself stays out of the accessibility tree. -->
  <div
    class="division"
    data-qd-pagenav="division"
    data-qd-keep-selection=""
    data-kind={current.kind}
    aria-hidden="true"
    transition:fly={{ y: 8, duration: motion }}
  >
    <!-- The eight-point khatam of the page frame's corners (§8.9), outlined, with a solid khatam at its heart. -->
    <svg class="star" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path class="star-line" d={OUTER_STAR} />
      <path class="star-core" d={INNER_STAR} />
    </svg>
    <span class="heading" lang="ar" dir="rtl">{heading}</span>
    {#if short !== ''}
      <span class="short">{short}</span>
    {/if}
  </div>
{/if}

<style>
  .division {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    inline-size: fit-content;
    min-block-size: 40px;
    padding-block: 2px;
    padding-inline: var(--space-3) var(--space-4);
    border: 1px solid color-mix(in srgb, var(--frame-gold) 45%, var(--border));
    border-radius: var(--radius-full);
    background-color: var(--glass-fill);
    backdrop-filter: var(--backdrop-dock);
    box-shadow: var(--shadow-2);
    color: var(--text);
    white-space: nowrap;
    cursor: default;
  }

  .star {
    flex: none;
    color: var(--frame-gold);
  }

  .star-line {
    fill: color-mix(in srgb, currentColor 10%, transparent);
    stroke: currentColor;
    stroke-width: 1.25;
    stroke-linejoin: miter;
  }

  .star-core {
    fill: currentColor;
  }

  .heading {
    font-family: var(--font-naskh);
    font-size: 18px;
    line-height: 1.6;
    color: var(--surah-header-ink);
  }

  .short {
    padding-inline-start: var(--space-2);
    border-inline-start: 1px solid var(--border-strong);
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    font-variant-numeric: tabular-nums;
    line-height: var(--leading-ui);
  }

  @media (forced-colors: active) {
    .division {
      border-color: CanvasText;
    }

    .star {
      color: CanvasText;
    }
  }
</style>
