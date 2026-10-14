<!--
  HizbList: the 60 hizb grouped under their juz. Each 48 px row shows the hizb number in a rosette,
  "Hizb 30" with its first ayah and page beneath, and three quarter chips (the rub' starts the Mushaf marks with ۞) at
  the inline end, in UI digits like every number here (`i18n.fraction`): ¼ ½ ¾ with Western Arabic numbers,
  ١/٤ ١/٢ ٣/٤ with Eastern Arabic numbers. The hizb and quarter on screen are highlighted.

  Keyboard: one Tab stop; ArrowUp/ArrowDown, Home/End and PageUp/PageDown move between hizb rows; the inline-end arrow
  enters a row's quarter chips and moves along them, the inline-start arrow moves back towards the row.
  Used only inside `IndexPanel`.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { i18n, quran, reader } from '$lib/stores'
  import { listSeparator } from '$lib/text/refparse'
  import { numRange } from './format'
  import { openTarget } from './navigate'
  import Rosette from './Rosette.svelte'
  import { centerInView, keepInView, rovingKeydown } from './roving'

  /** The three quarter chips as fractions of the hizb. */
  const QUARTERS = [
    [1, 4],
    [1, 2],
    [3, 4],
  ] as const
  const QUARTER_KEYS = [
    'navigation.hizb.quarter1',
    'navigation.hizb.quarter2',
    'navigation.hizb.quarter3',
  ] as const

  const uid = $props.id()

  let list: HTMLElement | null = $state(null)
  let tabStop = $state<number | null>(null)

  const layout = $derived(reader.layout)
  const here = $derived(reader.currentAyahId)
  const currentHizb = $derived(quran.hizbOf(here))
  const currentRub = $derived(quran.rubOf(here))
  const stopId = $derived(tabStop ?? (currentHizb > 0 ? currentHizb : 1))

  interface Quarter {
    rub: number
    ayahId: number
    start: string
    page: number
  }

  interface HizbRow {
    hizb: number
    ayahId: number
    start: string
    page: number
    quarters: Quarter[]
  }

  interface JuzGroup {
    juz: number
    range: string
    hizbs: HizbRow[]
  }

  const groups: JuzGroup[] = $derived.by(() => {
    const out: JuzGroup[] = []
    for (const h of quran.index.hizb) {
      const juz = quran.juzOf(h.firstAyahId)
      const quarters: Quarter[] = []
      for (let q = 1; q <= 3; q++) {
        const rub = (h.id - 1) * 4 + 1 + q
        const ayahId = quran.rubRange(rub).from
        if (ayahId > 0) {
          quarters.push({
            rub,
            ayahId,
            start: quran.refLabel(ayahId, 'long'),
            page: quran.pageOfAyah(layout, ayahId),
          })
        }
      }
      const row: HizbRow = {
        hizb: h.id,
        ayahId: h.firstAyahId,
        start: quran.refLabel(h.firstAyahId, 'long'),
        page: quran.pageOfAyah(layout, h.firstAyahId),
        quarters,
      }
      const group = out.at(-1)
      if (group?.juz === juz) group.hizbs.push(row)
      else out.push({ juz, range: '', hizbs: [row] })
    }
    for (const g of out) {
      const range = quran.juzRange(g.juz)
      const from = quran.pageOfAyah(layout, range.from)
      g.range = numRange(from, Math.max(from, quran.pageOfAyah(layout, range.to)))
    }
    return out
  })

  function rowOf(id: number): HTMLElement | null {
    return list?.querySelector<HTMLElement>(`[data-hizb="${id}"]`) ?? null
  }

  let placed = false
  $effect(() => {
    const id = currentHizb
    if (!list) return
    untrack(() => {
      const row = rowOf(id)
      if (!row || !list) return
      if (!placed) {
        placed = true
        centerInView(list, row)
      } else if (!list.contains(document.activeElement) && !list.matches(':hover')) {
        keepInView(list, row)
      }
    })
  })

  /** Shows the current hizb (the panel's "Show where I am"). */
  export function locate(): void {
    const row = rowOf(currentHizb)
    if (row && list) {
      centerInView(list, row)
      row.focus({ preventScroll: true })
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!list || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    const active = document.activeElement as HTMLElement | null
    const item = active?.closest<HTMLElement>('.item')
    const row = item?.querySelector<HTMLElement>('.row') ?? null
    const chips = item ? [...item.querySelectorAll<HTMLElement>('.q')] : []
    const end = i18n.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight'
    const start = i18n.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft'
    const chipIndex = active ? chips.indexOf(active) : -1
    if (e.key === end || e.key === start) {
      const next =
        e.key === end
          ? (chips[chipIndex + 1] ?? null)
          : chipIndex > 0
            ? (chips[chipIndex - 1] ?? null)
            : chipIndex === 0
              ? row
              : null
      if (next) {
        e.preventDefault()
        next.focus()
      }
      return
    }
    // From a chip, the vertical keys continue from its row.
    if (chipIndex >= 0 && row) row.focus({ preventScroll: true })
    rovingKeydown(e, list)
  }

  function onFocusIn(e: FocusEvent): void {
    const id = Number((e.target as HTMLElement | null)?.dataset.hizb)
    if (Number.isInteger(id) && id > 0) tabStop = id
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="scroll" bind:this={list} onkeydown={onKeydown} onfocusin={onFocusIn}>
  {#each groups as g (g.juz)}
    <section class="group" aria-labelledby="{uid}-juz-{g.juz}">
      <h3 class="head" id="{uid}-juz-{g.juz}">
        <span>{i18n.t('common.juzNumber', { juz: g.juz })}</span>
        <span class="head-pages">{i18n.t('navigation.pageRangeShort', { range: g.range })}</span>
      </h3>
      <ol class="rows">
        {#each g.hizbs as h (h.hizb)}
          {@const isCurrent = h.hizb === currentHizb}
          <li class={['item', { current: isCurrent }]}>
            <button
              type="button"
              class="row"
              data-roving
              data-hizb={h.hizb}
              tabindex={h.hizb === stopId ? 0 : -1}
              aria-current={isCurrent ? 'true' : undefined}
              aria-label={i18n.t('navigation.hizb.rowLabel', { hizb: h.hizb, start: h.start, page: h.page })}
              onclick={() => openTarget({ type: 'hizb', hizb: h.hizb })}
            >
              <Rosette n={h.hizb} active={isCurrent} />
              <span class="names">
                <span class="name">{i18n.t('common.hizbNumber', { hizb: h.hizb })}</span>
                <span class="sub"
                  >{h.start}{listSeparator()}{i18n.t('navigation.pageShort', { page: h.page })}</span
                >
              </span>
            </button>
            <div
              class="quarters"
              role="group"
              aria-label={i18n.t('navigation.hizb.quarters', { hizb: h.hizb })}
            >
              {#each h.quarters as q, i (q.rub)}
                {@const key = QUARTER_KEYS[i] ?? QUARTER_KEYS[0]}
                {@const [numerator, denominator] = QUARTERS[i] ?? QUARTERS[0]}
                <button
                  type="button"
                  class={['q', { on: q.rub === currentRub }]}
                  tabindex="-1"
                  aria-current={q.rub === currentRub ? 'true' : undefined}
                  aria-label={i18n.t(key, { hizb: h.hizb, start: q.start, page: q.page })}
                  title={`${q.start}${listSeparator()}${i18n.t('navigation.pageShort', { page: q.page })}`}
                  onclick={() => {
                    const r = quran.ayahRef(q.ayahId)
                    openTarget({ type: 'ayah', surah: r.surah, ayah: r.ayah })
                  }}
                >
                  {i18n.fraction(numerator, denominator)}
                </button>
              {/each}
            </div>
          </li>
        {/each}
      </ol>
    </section>
  {/each}
</div>

<style>
  .scroll {
    flex: 1 1 auto;
    min-block-size: 0;
    overflow-y: auto;
    padding-block: 0 var(--space-3);
    padding-inline: var(--space-1);
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    padding-block: var(--space-4) var(--space-1);
    padding-inline: var(--space-2) var(--space-3);
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: var(--weight-title);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  :global(html[lang='ar']) .head {
    letter-spacing: 0;
    text-transform: none;
  }

  .head-pages {
    font-weight: var(--weight-body);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
    text-transform: none;
  }

  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .item {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding-inline-end: var(--space-2);
    border-radius: var(--radius-sm);
    transition: background-color var(--dur-fast) var(--ease-standard);
  }

  .item:hover {
    background-color: var(--surface-hover);
  }

  .item.current::before {
    content: '';
    position: absolute;
    inset-block: 10px;
    inset-inline-start: 0;
    inline-size: 3px;
    border-radius: var(--radius-full);
    background-color: var(--accent);
  }

  .row {
    display: grid;
    flex: 1 1 auto;
    grid-template-columns: 24px minmax(0, 1fr);
    align-items: center;
    column-gap: var(--space-3);
    min-inline-size: 0;
    min-block-size: 48px;
    padding-block: var(--space-1);
    padding-inline: var(--space-2) 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: start;
    cursor: pointer;
  }

  .row:focus-visible {
    outline-offset: -2px;
  }

  .names {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-inline-size: 0;
  }

  .name,
  .sub {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    white-space: nowrap;
    text-overflow: ellipsis;
    line-height: 1.35;
  }

  .name {
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
  }

  .sub {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .quarters {
    display: flex;
    flex: none;
    gap: 2px;
  }

  /*
   * No `diagonal-fractions`: ¼ ½ ¾ are precomposed, and a font's `frac` feature could shrink the solidus of ١/٤ into a
   * fraction slash between full-size Eastern Arabic digits.
   */
  .q {
    display: grid;
    place-items: center;
    inline-size: 28px;
    block-size: 26px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--text-sm);
    line-height: 1;
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      border-color var(--dur-fast) var(--ease-standard),
      color var(--dur-fast) var(--ease-standard);
  }

  .q:hover {
    border-color: var(--border-strong);
    background-color: var(--surface-raised);
    color: var(--text);
  }

  .q:focus-visible {
    outline-offset: 1px;
  }

  .q.on {
    border-color: var(--accent);
    background-color: var(--accent-soft);
    color: var(--accent-text);
  }

  @media (forced-colors: active) {
    .item.current::before {
      background-color: Highlight;
    }

    .q.on {
      border-color: Highlight;
    }
  }
</style>
