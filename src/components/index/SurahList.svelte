<!--
  SurahList (§9.7): the 114 surahs with a filter. Rows are 48 px: a 24 px rosette number; the name (text-sm 500) with
  the meaning beneath (text-xs muted); the Arabic name at the inline end (the sura-names glyph when decor is installed,
  else Naskh 18 px) above the meta "Meccan · 286 · p 2" (text-2xs, UI digits); the current surah carries an accent bar
  and a filled rosette; a dot marks surahs of the current reciter that are downloaded (filled) or cached (half-tone).
  In the Arabic UI the Arabic name leads and the transliteration sits beneath it.

  - The filter takes names in either script (`quran.surahMatches`), numbers and references: "18" shows Al-Kahf and
    "2:255", "p 262", "j 15" or "kahf 10" offer a jump above the list.
  - One Tab stop for the list; arrows, Home/End and PageUp/PageDown move inside it; ArrowDown in the filter enters
    the list and Enter opens the first result.
  - Right-click (or Shift+F10 / the Menu key) opens the surah menu of §10.3: Open · Play surah · Surah info ·
    Download recitation for this surah · Memorize ▸.
  Owner: WP10a. Used only inside `IndexPanel`.
-->
<script lang="ts">
  import Brain from '@lucide/svelte/icons/brain'
  import CornerDownRight from '@lucide/svelte/icons/corner-down-right'
  import Download from '@lucide/svelte/icons/download'
  import Info from '@lucide/svelte/icons/info'
  import Play from '@lucide/svelte/icons/play'
  import { tick, untrack } from 'svelte'
  import {
    Button,
    ContextMenu,
    EmptyState,
    type MenuEntry,
    Popover,
    type Point,
    SearchInput,
  } from '$components/ui'
  import type { SurahInfo } from '$lib/ipc/bindings'
  import { fonts, i18n, memo, packs, player, quran, reader, settings, ui } from '$lib/stores'
  import { asciiDigits } from '$lib/text/normalize'
  import { describeTarget, listSeparator, parseReference, type ParseResult } from '$lib/text/refparse'
  import { numRange } from './format'
  import { openTarget } from './navigate'
  import Rosette from './Rosette.svelte'
  import { centerInView, keepInView, rovingKeydown, typeIntoFilter } from './roving'
  import { indexView } from './state.svelte'

  const sep = $derived(listSeparator())
  /** The sura-names decor face (§9.7): the glyph of surah n is U+E000 + the zero-padded number read as hex. */
  const SURA_NAMES_FAMILY = 'qd-sura-names'
  const suraGlyph = (n: number) =>
    String.fromCodePoint(0xe000 + Number.parseInt(String(n).padStart(3, '0'), 16))

  let list: HTMLElement | null = $state(null)
  let filterInput: HTMLInputElement | null = $state(null)
  /** The row that is the list's Tab stop (the focused one, else the current surah, else the first). */
  let tabStop = $state<number | null>(null)

  const layout = $derived(reader.layout)
  const current = $derived(reader.headSurah)
  const arabicUi = $derived(i18n.locale === 'ar')
  const glyphs = $derived(fonts.status.get(SURA_NAMES_FAMILY) === 'ready')
  const query = $derived(indexView.surahQuery.trim())

  /** The filter parsed as references (one name match at most: "kahf 10" → 18:10). */
  const parsed: ParseResult[] = $derived(query === '' ? [] : parseReference(query, { nameLimit: 1 }))
  /** A reference that is more than a surah ("2:255", "p 262", "kahf 10") is offered as a jump above the list. */
  const jump: ParseResult | null = $derived(
    parsed.find((r) => r.target.type !== 'surah' && r.source !== 'name') ??
      parsed.find((r) => r.target.type === 'ayah') ??
      null,
  )

  const results: readonly SurahInfo[] = $derived.by(() => {
    if (query === '') return quran.index.surahs
    const digits = asciiDigits(query)
    if (/^\d+$/u.test(digits)) {
      const s = quran.surah(Number(digits))
      return s ? [s] : []
    }
    const out: SurahInfo[] = []
    const add = (s: SurahInfo | undefined) => {
      if (s && !out.some((x) => x.id === s.id)) out.push(s)
    }
    for (const r of parsed) {
      const id = r.target.type === 'surah' || r.target.type === 'ayah' ? r.target.surah : 0
      if (r.issue !== 'surah' && r.source !== 'name') add(quran.surah(id))
    }
    if (jump?.target.type === 'ayah' && jump.issue !== 'surah') add(quran.surah(jump.target.surah))
    for (const s of quran.surahMatches(query)) add(s)
    return out
  })

  const stopId = $derived(
    results.some((s) => s.id === tabStop)
      ? tabStop
      : (results.find((s) => s.id === current)?.id ?? results[0]?.id ?? null),
  )

  // --- recitation availability (§9.7 dot, §9.8) ----------------------------------------------------------------------

  const reciter = $derived(player.reciters.find((r) => r.id === settings.value.reciterId) ?? null)
  /** Present recitation items of the current reciter: surah → downloaded (pinned) or stream-cached. */
  const audio: ReadonlyMap<number, 'pinned' | 'cached'> = $derived(
    new Map(
      (reciter ? (packs.items.get(reciter.packId) ?? []) : [])
        .filter((item) => !item.queued)
        .map((item) => [item.item, item.pinned ? 'pinned' : 'cached'] as const),
    ),
  )

  $effect(() => {
    const packId = reciter?.packId
    if (packId === undefined || packs.items.has(packId)) return
    // The dots are a nicety: a failed load leaves the list without them (the Downloads view reports errors).
    untrack(
      () =>
        void packs.loadItems(packId).catch((e: unknown) => console.warn('[qd] index: recitation items', e)),
    )
  })

  // --- rows ----------------------------------------------------------------------------------------------------------

  const place = (s: SurahInfo) =>
    s.revelationPlace === 'makkah' ? i18n.t('common.meccan') : i18n.t('common.medinan')
  const startPage = (s: SurahInfo) => quran.pageOfAyah(layout, s.firstAyahId)

  /** "286 · p 2", after the revelation place ("مكية، ٢٨٦، ص ٢" in the Arabic UI). */
  function counts(s: SurahInfo): string {
    return [i18n.num(s.ayahCount), i18n.t('navigation.pageShort', { page: startPage(s) })].join(sep)
  }

  function rowLabel(s: SurahInfo): string {
    const label = i18n.t('navigation.surahs.rowLabel', {
      number: s.id,
      name: quran.surahName(s.id),
      meaning: s.nameEn,
      place: place(s),
      ayahs: i18n.tp('common.ayahCount', s.ayahCount),
      page: startPage(s),
    })
    const state = audio.get(s.id)
    if (state === undefined) return label
    return `${label}${i18n.t('navigation.labelSep')}${i18n.t(state === 'pinned' ? 'navigation.surahs.downloaded' : 'navigation.surahs.cached')}`
  }

  function open(s: SurahInfo): void {
    openTarget({ type: 'surah', surah: s.id })
  }

  function openJump(): void {
    if (jump && jump.issue === undefined) openTarget(jump.target)
  }

  function rowOf(id: number): HTMLElement | null {
    return list?.querySelector<HTMLElement>(`[data-surah="${id}"]`) ?? null
  }

  function focusFirst(): void {
    const first = list?.querySelector<HTMLElement>('[data-roving]')
    first?.focus()
  }

  function onFilterKeydown(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' && !e.isComposing) {
      e.preventDefault()
      focusFirst()
    }
  }

  function onSubmit(): void {
    if (jump && jump.issue === undefined) openJump()
    else if (results[0]) open(results[0])
  }

  function onListKeydown(e: KeyboardEvent): void {
    if (!list) return
    if (typeIntoFilter(e, filterInput, (ch) => (indexView.surahQuery += ch))) return
    rovingKeydown(e, list, { onBeforeFirst: () => filterInput?.focus() })
  }

  function onFocusIn(e: FocusEvent): void {
    const id = Number((e.target as HTMLElement | null)?.dataset.surah)
    if (Number.isInteger(id) && id > 0) tabStop = id
  }

  // Open at the current surah; afterwards keep it in view while the user reads, unless they are in the list.
  let placed = false
  $effect(() => {
    const id = current
    if (!list || query !== '') return
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

  /** Shows the current surah (the panel's "Show where I am"). */
  export function locate(): void {
    indexView.surahQuery = ''
    void tick().then(() => {
      const row = rowOf(current)
      if (row && list) {
        centerInView(list, row)
        row.focus({ preventScroll: true })
      }
    })
  }

  // --- the surah menu (§10.3) and the info popover -------------------------------------------------------------------

  let menuAt = $state<Point | null>(null)
  let menuSurah = $state<SurahInfo | null>(null)
  let infoSurah = $state<SurahInfo | null>(null)
  let infoOpen = $state(false)

  function openMenu(e: MouseEvent, s: SurahInfo): void {
    e.preventDefault()
    const row = e.currentTarget as HTMLElement
    let point: Point = { x: e.clientX, y: e.clientY }
    // The Menu key and Shift+F10 report no pointer position: anchor at the row's inline start.
    if (e.button !== 2 || (e.clientX === 0 && e.clientY === 0)) {
      const r = row.getBoundingClientRect()
      point = { x: i18n.dir === 'rtl' ? r.right - 24 : r.left + 24, y: r.bottom - 6 }
    }
    menuSurah = s
    menuAt = point
  }

  function showInfo(s: SurahInfo): void {
    infoSurah = s
    infoOpen = true
  }

  const menuItems: MenuEntry[] = $derived.by(() => {
    const s = menuSurah
    if (s === null) return []
    const range = quran.surahRange(s.id)
    const packId = reciter?.packId
    return [
      {
        id: 'open',
        label: i18n.t('common.open'),
        icon: CornerDownRight,
        onSelect: () => open(s),
      },
      {
        id: 'play',
        label: i18n.t('navigation.menu.play'),
        icon: Play,
        onSelect: () => void player.playRange(range.from, range.to).catch(ui.toastError),
      },
      {
        id: 'info',
        label: i18n.t('navigation.menu.info'),
        icon: Info,
        onSelect: () => showInfo(s),
      },
      {
        id: 'download',
        label: i18n.t('navigation.menu.download'),
        icon: Download,
        disabled: packId === undefined || audio.get(s.id) === 'pinned',
        onSelect: () => {
          if (packId === undefined) return
          void packs.install(packId, { type: 'items', data: { items: [s.id] } }).catch(ui.toastError)
        },
      },
      { type: 'separator', id: 'sep' },
      {
        type: 'submenu',
        id: 'memorize',
        label: i18n.t('navigation.menu.memorize'),
        icon: Brain,
        items: [
          {
            id: 'hide',
            label: i18n.t('navigation.menu.hide'),
            onSelect: () => {
              open(s)
              memo.startHide(range.from, range.to)
            },
          },
          {
            id: 'self-test',
            label: i18n.t('navigation.menu.selfTest'),
            onSelect: () => ui.open('self-test', { fromAyahId: range.from, toAyahId: range.to }),
          },
          { type: 'separator', id: 'memo-sep' },
          {
            id: 'memorized',
            label: i18n.t('navigation.menu.markMemorized'),
            onSelect: () => void memo.setStatus(range.from, range.to, 'memorized').catch(ui.toastError),
          },
          {
            id: 'learning',
            label: i18n.t('navigation.menu.markLearning'),
            onSelect: () => void memo.setStatus(range.from, range.to, 'learning').catch(ui.toastError),
          },
        ],
      },
    ]
  })

  const info = $derived.by(() => {
    const s = infoSurah
    if (s === null) return null
    const range = quran.surahRange(s.id)
    const firstPage = quran.pageOfAyah(layout, range.from)
    const lastPage = quran.pageOfAyah(layout, range.to)
    const firstJuz = quran.juzOf(range.from)
    const lastJuz = quran.juzOf(range.to)
    return {
      s,
      revelation: i18n.t('navigation.info.order', { place: place(s), order: s.revelationOrder }),
      pages: numRange(firstPage, lastPage),
      juz: numRange(firstJuz, lastJuz),
    }
  })

  function playInfo(): void {
    if (!info) return
    const range = quran.surahRange(info.s.id)
    infoOpen = false
    void player.playRange(range.from, range.to).catch(ui.toastError)
  }

  function openInfo(): void {
    if (!info) return
    infoOpen = false
    open(info.s)
  }
</script>

<div class="surahs">
  <div class="filter">
    <SearchInput
      bind:value={indexView.surahQuery}
      bind:ref={filterInput}
      size="sm"
      placeholder={i18n.t('navigation.surahs.filterPlaceholder', { ref: i18n.ref(2, 255) })}
      aria-label={i18n.t('navigation.surahs.filterLabel')}
      onkeydown={onFilterKeydown}
      {onSubmit}
    />
  </div>

  <div class="scroll" bind:this={list} onkeydown={onListKeydown} onfocusin={onFocusIn} role="presentation">
    {#if jump}
      {@const d = describeTarget(jump.target, layout)}
      <button
        type="button"
        class="jump"
        data-roving
        aria-disabled={jump.issue !== undefined}
        tabindex={results.length === 0 ? 0 : -1}
        onclick={openJump}
      >
        <span class="jump-icon" aria-hidden="true"
          ><CornerDownRight size={16} strokeWidth={1.75} class="icon-dir" /></span
        >
        <span class="names">
          <span class="name">{i18n.t('navigation.surahs.jumpTo', { target: d.title })}</span>
          <span class={['sub', { reason: jump.issue !== undefined }]}>{jump.disabledReason ?? d.detail}</span>
        </span>
      </button>
    {/if}

    {#if results.length > 0}
      <ol class="rows" aria-label={i18n.t('navigation.surahs.listLabel')}>
        {#each results as s (s.id)}
          {@const isCurrent = s.id === current}
          {@const state = audio.get(s.id)}
          <li>
            <button
              type="button"
              class={['row', { current: isCurrent }]}
              data-roving
              data-surah={s.id}
              tabindex={s.id === stopId ? 0 : -1}
              aria-current={isCurrent ? 'true' : undefined}
              aria-label={rowLabel(s)}
              onclick={() => open(s)}
              oncontextmenu={(e) => openMenu(e, s)}
            >
              <Rosette n={s.id} active={isCurrent} />
              <span class="names">
                {#if arabicUi}
                  <span class="name" lang="ar">{s.nameAr}</span>
                  <span class="sub"><bdi dir="ltr">{s.nameSimple}</bdi></span>
                {:else}
                  <span class="name">{s.nameSimple}</span>
                  <span class="sub">{s.nameEn}</span>
                {/if}
              </span>
              <span class="end">
                {#if glyphs}
                  <span class="glyph" lang="ar" dir="rtl" style:font-family={SURA_NAMES_FAMILY}
                    >{suraGlyph(s.id)}</span
                  >
                {:else if !arabicUi}
                  <span class="ar" lang="ar" dir="rtl">{s.nameAr}</span>
                {/if}
                <span class="meta">
                  <span class="meta-text"><span class="place">{place(s)}{sep}</span>{counts(s)}</span>
                  <!-- Always there (hidden without a state): a dot appearing as a recitation streams never moves the row. -->
                  <span class={['dot', state ?? 'none']}></span>
                </span>
              </span>
            </button>
          </li>
        {/each}
      </ol>
    {:else if !jump}
      <EmptyState
        compact
        title={i18n.t('navigation.surahs.empty', { query })}
        body={i18n.t('navigation.surahs.emptyBody', { number: 18, ref: i18n.ref(2, 255) })}
      />
    {/if}
  </div>
</div>

<ContextMenu
  at={menuAt}
  onClose={() => (menuAt = null)}
  items={menuItems}
  label={menuSurah ? i18n.t('navigation.menu.label', { name: quran.surahName(menuSurah.id) }) : undefined}
/>

{#if info}
  <Popover
    bind:open={infoOpen}
    anchor={rowOf(info.s.id)}
    side={i18n.dir === 'rtl' ? 'left' : 'right'}
    align="start"
    width={288}
    label={i18n.t('navigation.menu.info')}
  >
    <div class="info">
      <div class="info-head">
        <Rosette n={info.s.id} size={32} />
        <div class="info-names">
          <p class="info-title">{quran.surahName(info.s.id)}</p>
          <p class="info-sub">
            {#if arabicUi}<bdi dir="ltr">{info.s.nameSimple}</bdi>{:else}{info.s.nameEn}{/if}
          </p>
        </div>
        {#if !arabicUi}<span class="ar info-ar" lang="ar" dir="rtl">{info.s.nameAr}</span>{/if}
      </div>
      <dl class="facts">
        <div>
          <dt>{i18n.t('navigation.info.revelation')}</dt>
          <dd>{info.revelation}</dd>
        </div>
        <div>
          <dt>{i18n.t('navigation.info.ayahs')}</dt>
          <dd>{i18n.num(info.s.ayahCount)}</dd>
        </div>
        <div>
          <dt>{i18n.t('navigation.info.pages')}</dt>
          <dd>{info.pages}</dd>
        </div>
        <div>
          <dt>{i18n.t('navigation.info.juz')}</dt>
          <dd>{info.juz}</dd>
        </div>
      </dl>
      <div class="info-actions">
        <Button size="sm" variant="secondary" onclick={playInfo}>
          {#snippet icon()}<Play size={14} strokeWidth={2} aria-hidden="true" />{/snippet}
          {i18n.t('navigation.menu.play')}
        </Button>
        <Button size="sm" variant="primary" onclick={openInfo}>{i18n.t('common.open')}</Button>
      </div>
    </div>
  </Popover>
{/if}

<style>
  .surahs {
    display: flex;
    flex-direction: column;
    min-block-size: 0;
    block-size: 100%;
  }

  .filter {
    flex: none;
    padding-block: var(--space-3) var(--space-2);
    padding-inline: var(--space-2);
  }

  .scroll {
    flex: 1 1 auto;
    min-block-size: 0;
    overflow-x: hidden;
    overflow-y: auto;
    container-type: inline-size;
    padding-block: 0 var(--space-3);
    padding-inline: var(--space-1);
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }

  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /*
   * The name always shows in full: its column is at least as wide as the name, while the meaning (beneath it) and
   * the end column give way first. In a narrow sidebar the revelation place drops out of the meta.
   */
  .row,
  .jump {
    position: relative;
    display: grid;
    grid-template-columns: 24px minmax(min-content, 1fr) minmax(0, auto);
    align-items: center;
    column-gap: var(--space-3);
    inline-size: 100%;
    min-block-size: 48px;
    padding-block: var(--space-1);
    padding-inline: var(--space-2) var(--space-3);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease-standard);
  }

  .row:hover,
  .jump:hover:not([aria-disabled='true']) {
    background-color: var(--surface-hover);
  }

  .row:focus-visible,
  .jump:focus-visible {
    outline-offset: -2px;
  }

  /* The current surah: an accent bar on the inline-start edge. */
  .row.current::before {
    content: '';
    position: absolute;
    inset-block: 10px;
    inset-inline-start: 0;
    inline-size: 3px;
    border-radius: var(--radius-full);
    background-color: var(--accent);
  }

  .names {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-inline-size: 0;
  }

  .name {
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    line-height: 1.35;
    white-space: nowrap;
  }

  /* Takes the column's width without widening it. */
  .sub {
    inline-size: 0;
    min-inline-size: 100%;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.35;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .jump .name {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
  }

  .sub.reason {
    color: var(--danger-text);
  }

  .end {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    justify-content: center;
    gap: 2px;
    min-inline-size: 0;
    /* Clips a wide name glyph sideways; its Naskh ink (dots, marks) may pass the line box above and below. */
    overflow-x: clip;
    overflow-y: visible;
    /* The clip edge sits 7 px into the row's padding at the inline end, where the glyph aligns: Yusuf's glyph draws its
       first letter 6.4 px past its advance (0.25 em at 26 px; every other surah 0.2 px at most), which the edge cut. */
    margin-inline-end: -7px;
    padding-inline-end: 7px;
  }

  .ar {
    max-inline-size: 100%;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    font-family: var(--font-naskh);
    font-size: 18px;
    line-height: 1.25;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .glyph {
    font-size: 26px;
    line-height: 1;
    color: var(--text);
    white-space: nowrap;
  }

  .meta {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-inline-size: 100%;
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
    line-height: 1.3;
    white-space: nowrap;
  }

  .meta-text {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
  }

  @container (max-width: 270px) {
    .place {
      display: none;
    }
  }

  /* Recitation availability for the current reciter: downloaded (filled) or stream-cached (half-tone). */
  .dot {
    display: inline-block;
    inline-size: 6px;
    block-size: 6px;
    border-radius: var(--radius-full);
    background-color: var(--accent);
  }

  .dot.cached {
    background-color: color-mix(in srgb, var(--accent) 45%, transparent);
  }

  .dot.none {
    visibility: hidden;
  }

  .jump {
    grid-template-columns: 24px minmax(0, 1fr);
    margin-block-end: var(--space-1);
  }

  .jump[aria-disabled='true'] {
    cursor: default;
  }

  .jump[aria-disabled='true'] .name {
    color: var(--text-muted);
  }

  .jump-icon {
    display: grid;
    place-items: center;
    inline-size: 24px;
    block-size: 24px;
    border-radius: var(--radius-xs);
    background-color: var(--accent-soft);
    color: var(--accent-text);
  }

  .jump[aria-disabled='true'] .jump-icon {
    background-color: var(--surface-hover);
    color: var(--text-muted);
  }

  /* Surah info popover. */
  .info {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .info-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .info-names {
    flex: 1 1 auto;
    min-inline-size: 0;
  }

  .info-title {
    font-size: var(--text-md);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .info-sub {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .info-ar {
    font-size: 20px;
  }

  .facts {
    display: grid;
    gap: var(--space-1);
    margin: 0;
    padding-block-start: var(--space-3);
    border-block-start: 1px solid var(--border);
    font-size: var(--text-sm);
  }

  .facts > div {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .facts dt {
    color: var(--text-muted);
  }

  .facts dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
    text-align: end;
  }

  .info-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  @media (forced-colors: active) {
    .row.current::before,
    .dot {
      background-color: Highlight;
    }
  }
</style>
