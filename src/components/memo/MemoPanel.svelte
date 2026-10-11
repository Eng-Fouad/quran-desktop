<!--
  MemoPanel (§7.5, BRIEF §1.1.8). Owner: WP9b. The Memorize sidebar panel; the shell's `Sidebar` draws the heading, this
  is the body. Takes no props: it reads stores (§7.9).

  Sections, top to bottom:
  1. **Progress**: ayahs memorised and the share of the Quran, with the status bar (memorized · due · learning · not
     started). Before anything is started it teaches the loop: hide with E, recite, rate.
  2. **Practise**: the range (the selection, the page(s) on screen, the surah, the juz, or a typed range such as `67`,
     `2:255–260`, `j 30`), its status, and Hide (E) / Self-test (Shift+E) / Listen ×3, plus "Mark as" (memorized,
     learning, due for review, or reset after a confirmation).
  3. **Due for review**: runs of due ayahs, most overdue first, each with Test and Hide.
  4. **Mushaf map**: `ProgressHeatmap`, one square per page; a click opens the page.
  5. **Loop presets**: `PresetList`.

  It loads the whole Quran's progress when it first shows (`memo.loadAll`); the store keeps it current afterwards.
-->
<script module lang="ts">
  type Scope = 'selection' | 'page' | 'surah' | 'juz' | 'custom'
  /** The scope chosen last, kept while the app runs (switching sidebar tabs remounts the panel). */
  let lastScope: Scope | null = null
  let lastCustom = ''
</script>

<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import Eye from '@lucide/svelte/icons/eye'
  import Headphones from '@lucide/svelte/icons/headphones'
  import ListChecks from '@lucide/svelte/icons/list-checks'
  import { Button, IconButton, Kbd, Menu, Segmented, Skeleton, TextInput } from '$components/ui'
  import type { MemoStatus } from '$lib/ipc/bindings'
  import type { AyahSpan } from '$lib/stores/memo.svelte'
  import { summarize } from '$lib/stores/memo.svelte'
  import { parseReference, type ParsedTarget } from '$lib/text/refparse'
  import { i18n, memo, player, quran, reader, settings, ui } from '$lib/stores'
  import PresetList from './PresetList.svelte'
  import ProgressHeatmap from './ProgressHeatmap.svelte'
  import RangeStatus from './RangeStatus.svelte'
  import { keyLabel } from './keys'

  /** Due runs shown before "Show N more". */
  const DUE_SHOWN = 4

  let scope = $state<Scope>(lastScope ?? (reader.selection ? 'selection' : 'surah'))
  let custom = $state(lastCustom)
  let failed = $state(false)
  let allDue = $state(false)

  $effect(() => {
    lastScope = scope
    lastCustom = custom
  })

  async function load(): Promise<void> {
    failed = false
    const ok = await memo.loadAll()
    failed = !ok && !memo.loaded
  }

  $effect(() => {
    if (!memo.loaded && quran.ayahCount > 0) void load()
  })

  // --- the range being practised ----------------------------------------------------------------------------------

  function spanOf(t: ParsedTarget): AyahSpan | null {
    switch (t.type) {
      case 'ayah': {
        const from = quran.ayahId(t.surah, t.ayah)
        const to = quran.ayahId(t.surah, t.toAyah ?? t.ayah)
        return from > 0 && to >= from ? { from, to } : null
      }
      case 'page': {
        const r = quran.pageRange(reader.layout, t.page)
        return r.to >= r.from && r.from > 0 ? r : null
      }
      case 'juz': {
        const r = quran.juzRange(t.juz)
        return r.from > 0 ? r : null
      }
      case 'hizb': {
        const r = quran.hizbRange(t.hizb)
        return r.from > 0 ? r : null
      }
      case 'surah': {
        const r = quran.surahRange(t.surah)
        return r.from > 0 ? r : null
      }
    }
  }

  const parsed = $derived.by((): AyahSpan | null => {
    const text = custom.trim()
    if (text === '') return null
    const hit = parseReference(text, { names: true, nameLimit: 1 }).find((r) => r.issue === undefined)
    return hit ? spanOf(hit.target) : null
  })

  /** The selection scope falls back to the surah while nothing is selected. */
  const shownScope: Scope = $derived(scope === 'selection' && reader.selection === null ? 'surah' : scope)

  const target = $derived.by((): AyahSpan | null => {
    switch (shownScope) {
      case 'selection': {
        const sel = reader.selection
        return sel
          ? { from: Math.min(sel.fromAyahId, sel.toAyahId), to: Math.max(sel.fromAyahId, sel.toAyahId) }
          : null
      }
      case 'page': {
        const r = reader.visibleRange
        return r.from > 0 && r.to >= r.from ? { from: r.from, to: r.to } : null
      }
      case 'surah': {
        const r = quran.surahRange(quran.ayahRef(reader.actionTarget).surah)
        return r.from > 0 ? r : null
      }
      case 'juz': {
        const r = quran.juzRange(quran.juzOf(reader.actionTarget))
        return r.from > 0 ? r : null
      }
      case 'custom':
        return parsed
    }
  })

  const scopeOptions = $derived([
    { value: 'selection', label: i18n.t('memo.panel.scope.selection'), disabled: reader.selection === null },
    { value: 'page', label: i18n.t('memo.panel.scope.page') },
    { value: 'surah', label: i18n.t('memo.panel.scope.surah') },
    { value: 'juz', label: i18n.t('memo.panel.scope.juz') },
  ])

  function setScope(v: string): void {
    if (v === 'selection' || v === 'page' || v === 'surah' || v === 'juz') {
      scope = v
      custom = ''
    }
  }

  function onCustomInput(): void {
    if (custom.trim() !== '') scope = 'custom'
    else if (scope === 'custom') scope = reader.selection ? 'selection' : 'surah'
  }

  const targetSummary = $derived(target ? summarize(memo.progress, target.from, target.to, memo.clock) : null)
  const targetTitle = $derived.by(() => {
    if (!target) return ''
    const a = quran.ayahRef(target.from)
    const b = quran.ayahRef(target.to)
    const first = quran.surahName(a.surah)
    return a.surah === b.surah ? first : `${first} – ${quran.surahName(b.surah)}`
  })
  const targetRef = $derived.by(() => {
    if (!target) return ''
    const a = quran.ayahRef(target.from)
    const b = quran.ayahRef(target.to)
    return i18n.ref(a.surah, a.ayah, b.ayah, b.surah)
  })
  const targetPages = $derived.by(() => {
    if (!target) return ''
    const first = quran.pageOfAyah(reader.layout, target.from)
    const last = quran.pageOfAyah(reader.layout, target.to)
    return first === last
      ? i18n.t('common.pageNumber', { page: first })
      : `${i18n.t('common.pageNumber', { page: first })}–${i18n.num(last)}`
  })

  const hidingTarget = $derived(
    memo.active?.mode === 'hide' &&
      target !== null &&
      memo.active.from === target.from &&
      memo.active.to === target.to,
  )

  /** Brings the reader to a range (the Mushaf, its first ayah's page). */
  function showRange(span: AyahSpan): void {
    if (ui.view !== 'reader') ui.setView('reader')
    if (!reader.isVisible(span.from)) reader.goToAyah(span.from)
  }

  function hide(span: AyahSpan | null = target): void {
    if (!span) return
    if (hidingTarget && span === target) {
      memo.stop()
      return
    }
    showRange(span)
    memo.startHide(span.from, span.to)
  }

  function selfTest(span: AyahSpan | null = target): void {
    if (span) ui.open('self-test', { fromAyahId: span.from, toAyahId: span.to })
  }

  function listen(): void {
    const span = target
    if (!span) return
    showRange(span)
    void player.playRange(span.from, span.to, { ayahRepeat: 3 })
  }

  async function mark(status: MemoStatus): Promise<void> {
    const span = target
    if (!span) return
    if (status === 'new') {
      const ok = await ui.confirm({
        title: i18n.t('memo.panel.resetTitle'),
        body: i18n.t('memo.panel.resetBody', {
          range: memo.label(span.from, span.to),
          count: i18n.tp('common.ayahCount', span.to - span.from + 1),
        }),
        confirmLabel: i18n.t('memo.panel.resetConfirm'),
        danger: true,
      })
      if (!ok) return
    }
    await memo.setStatus(span.from, span.to, status)
  }

  const markItems = $derived(
    (['memorized', 'learning', 'review'] as const).map((s) => ({
      id: `mark-${s}`,
      label: i18n.t(`memo.panel.mark.${s}`),
      onSelect: () => void mark(s),
    })),
  )

  // --- overview ---------------------------------------------------------------------------------------------------

  const overview = $derived(memo.overview)
  const memorizedCount = $derived(overview.memorized + overview.review)
  const started = $derived(memorizedCount + overview.learning > 0)
  const pct = $derived(
    overview.total > 0
      ? new Intl.NumberFormat(i18n.intlLocale, { style: 'percent', maximumFractionDigits: 1 }).format(
          memorizedCount / overview.total,
        )
      : '',
  )

  // --- due ----------------------------------------------------------------------------------------------------------

  const due = $derived(memo.due)
  const dueShown = $derived(allDue ? due : due.slice(0, DUE_SHOWN))

  function dueWhen(at: number): string {
    return memo.clock - at < 45
      ? i18n.t('memo.panel.due.now')
      : i18n.t('memo.panel.due.when', { when: i18n.relTime(at) })
  }

  function openPage(page: number): void {
    if (ui.view !== 'reader') ui.setView('reader')
    if (settings.value.readingMode !== 'mushaf') reader.toggleReadingMode()
    reader.goToPage(page)
  }

  const hideKey = $derived(keyLabel('memo.hide'))
  const testKey = $derived(keyLabel('memo.selfTest'))
</script>

<div class="panel" data-qd-memo-panel="">
  <div class="scroll">
    <!-- 1. Progress -->
    <section class="card overview" aria-labelledby="memo-overview">
      <h3 class="head" id="memo-overview">{i18n.t('memo.panel.overview')}</h3>
      {#if !memo.loaded && !failed}
        <div class="skeleton" aria-hidden="true">
          <Skeleton w="55%" h={18} />
          <Skeleton w="35%" h={11} />
          <Skeleton w="100%" h={6} radius="full" />
        </div>
      {:else if failed}
        <p class="note">{i18n.t('memo.panel.loadError')}</p>
        <Button size="sm" variant="secondary" onclick={() => void load()}>{i18n.t('common.retry')}</Button>
      {:else if !started}
        <p class="big"><span class="big-num">{i18n.t('memo.panel.startTitle')}</span></p>
        <p class="note teach">
          {i18n.t('memo.panel.overviewEmpty')}
          {#if hideKey}<Kbd chord={hideKey} size="sm" />{/if}
        </p>
      {:else}
        <p class="big">
          <span class="big-num">{i18n.tp('memo.panel.memorizedAyahs', memorizedCount)}</span>
          <span class="big-pct">{i18n.t('memo.panel.ofQuran', { pct })}</span>
        </p>
        <RangeStatus summary={overview} />
      {/if}
    </section>

    <!-- 2. Practise -->
    <section class="card practise" aria-labelledby="memo-practise">
      <h3 class="head" id="memo-practise">{i18n.t('memo.panel.practise')}</h3>
      <Segmented
        label={i18n.t('memo.panel.scope.label')}
        size="sm"
        fullWidth
        options={scopeOptions}
        value={shownScope === 'custom' ? '' : shownScope}
        onValueChange={setScope}
      />
      <TextInput
        bind:value={custom}
        size="sm"
        placeholder={i18n.t('memo.panel.customPlaceholder')}
        aria-label={i18n.t('memo.panel.customLabel')}
        invalid={scope === 'custom' && custom.trim() !== '' && parsed === null}
        oninput={onCustomInput}
        class="custom"
      />

      {#if target && targetSummary}
        <div class="target" data-qd-memo-target="">
          <div class="target-head">
            <span class="target-title">{targetTitle}</span>
            <span class="target-ref">{targetRef}</span>
          </div>
          <span class="target-meta">
            {i18n.tp('common.ayahCount', target.to - target.from + 1)} · {targetPages}
          </span>
          <RangeStatus summary={targetSummary} />
        </div>
        <div class="buttons">
          <Button
            size="sm"
            variant={hidingTarget ? 'secondary' : 'primary'}
            onclick={() => hide()}
            title={hideKey ? `${i18n.t('memo.panel.hide')} (${hideKey})` : undefined}
            data-qd-memo-action="hide"
          >
            {#snippet icon()}
              {#if hidingTarget}<Eye size={16} strokeWidth={1.75} />{:else}<EyeOff
                  size={16}
                  strokeWidth={1.75}
                />{/if}
            {/snippet}
            {hidingTarget ? i18n.t('memo.panel.stopHiding') : i18n.t('memo.panel.hide')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onclick={() => selfTest()}
            title={testKey ? `${i18n.t('memo.panel.selfTest')} (${testKey})` : undefined}
            data-qd-memo-action="test"
          >
            {#snippet icon()}<ListChecks size={16} strokeWidth={1.75} />{/snippet}
            {i18n.t('memo.panel.selfTest')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onclick={listen}
            title={i18n.t('memo.panel.listenHint')}
            data-qd-memo-action="listen"
          >
            {#snippet icon()}<Headphones size={16} strokeWidth={1.75} />{/snippet}
            {i18n.t('memo.panel.listen', { n: 3 })}
          </Button>
          <Menu
            label={i18n.t('memo.panel.markAs')}
            align="end"
            items={[
              ...markItems,
              { type: 'separator', id: 'mark-sep' },
              {
                id: 'mark-new',
                label: i18n.t('memo.panel.mark.new'),
                danger: true,
                onSelect: () => void mark('new'),
              },
            ]}
          >
            {#snippet trigger({ props })}
              <Button {...props} size="sm" variant="ghost" data-qd-memo-action="mark">
                {i18n.t('memo.panel.markAs')}
                {#snippet iconEnd()}<ChevronDown size={14} strokeWidth={1.75} />{/snippet}
              </Button>
            {/snippet}
          </Menu>
        </div>
      {:else if scope === 'custom' && custom.trim() !== ''}
        <p class="note invalid">{i18n.t('memo.panel.customInvalid')}</p>
      {/if}
    </section>

    <!-- 3. Due for review -->
    {#if memo.loaded}
      <section class="card due" aria-labelledby="memo-due">
        <h3 class="head" id="memo-due">
          {i18n.t('memo.panel.due.title')}
          {#if due.length > 0}<span class="count">{i18n.num(due.length)}</span>{/if}
        </h3>
        {#if due.length === 0}
          <p class="note">{i18n.t('memo.panel.due.empty')}</p>
        {:else}
          <ul class="due-list">
            {#each dueShown as d (d.from)}
              <li class="due-row" data-due={d.from}>
                <button type="button" class="due-main" onclick={() => showRange(d)}>
                  <span class="due-title">{memo.label(d.from, d.to)}</span>
                  <span class="due-meta">
                    {i18n.tp('common.ayahCount', d.count)} · <span class="due-when">{dueWhen(d.dueAt)}</span>
                  </span>
                </button>
                <IconButton
                  label={i18n.t('memo.panel.due.hide')}
                  icon={EyeOff}
                  size="sm"
                  onclick={() => hide(d)}
                />
                <Button size="sm" variant="secondary" onclick={() => selfTest(d)}>
                  {i18n.t('memo.panel.due.test')}
                </Button>
              </li>
            {/each}
          </ul>
          {#if due.length > DUE_SHOWN}
            <Button size="sm" variant="link" onclick={() => (allDue = !allDue)}>
              {allDue
                ? i18n.t('memo.panel.due.less')
                : i18n.tp('memo.panel.due.more', due.length - DUE_SHOWN)}
            </Button>
          {/if}
        {/if}
      </section>
    {/if}

    <!-- 4. Mushaf map -->
    <section class="card map" aria-labelledby="memo-map">
      <h3 class="head" id="memo-map">{i18n.t('memo.panel.map.title')}</h3>
      {#if memo.loaded}
        <ProgressHeatmap
          progress={memo.progress}
          now={memo.clock}
          layout={reader.layout}
          current={reader.visiblePages}
          onopen={openPage}
        />
        <ul class="legend" aria-hidden="true">
          <li><span class="sw sw-new"></span>{i18n.t('memo.panel.map.legendNew')}</li>
          <li><span class="sw sw-learning"></span>{i18n.t('memo.panel.map.legendLearning')}</li>
          <li><span class="sw sw-memorized"></span>{i18n.t('memo.panel.map.legendMemorized')}</li>
          <li><span class="sw sw-due"></span>{i18n.t('memo.panel.map.legendDue')}</li>
        </ul>
      {:else}
        <Skeleton w="100%" h={240} radius="sm" />
      {/if}
    </section>

    <!-- 5. Loop presets -->
    <section class="card presets" aria-labelledby="memo-presets">
      <h3 class="head" id="memo-presets">{i18n.t('memo.panel.presets.title')}</h3>
      <PresetList {target} />
    </section>
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    block-size: 100%;
    min-block-size: 0;
  }

  .scroll {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: var(--space-3);
    min-block-size: 0;
    overflow-x: hidden;
    overflow-y: auto;
    padding-block: 0 var(--space-4);
    padding-inline: var(--space-3);
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-1);
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: var(--weight-title);
    letter-spacing: 0.06em;
    line-height: 1.2;
    text-transform: uppercase;
  }

  .head:lang(ar) {
    letter-spacing: 0;
    text-transform: none;
  }

  .count {
    display: inline-grid;
    place-items: center;
    min-inline-size: 18px;
    block-size: 18px;
    padding-inline: 5px;
    border-radius: var(--radius-full);
    background-color: var(--warning-soft);
    color: var(--warning-text);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
  }

  .note {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
  }

  .note.invalid {
    color: var(--danger-text);
  }

  .note.teach :global(.kbd) {
    margin-inline-start: 2px;
  }

  .skeleton {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* --- overview --------------------------------------------------------------------------------------------------- */

  .big {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
  }

  .big-num {
    color: var(--text);
    font-size: var(--text-xl);
    font-weight: var(--weight-title);
    font-variant-numeric: tabular-nums;
    line-height: var(--leading-title);
  }

  .big-pct {
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }

  /* --- practise --------------------------------------------------------------------------------------------------- */

  .practise :global(.custom) {
    inline-size: 100%;
  }

  .target {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: var(--space-3);
    border-radius: var(--radius-sm);
    background-color: color-mix(in srgb, var(--surface-sunken) 55%, var(--surface-raised));
  }

  .target-head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 2px var(--space-2);
  }

  .target-title {
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-title);
    line-height: 1.3;
  }

  .target-ref {
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }

  .target-meta {
    margin-block-end: 4px;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .buttons {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2);
  }

  .buttons :global(.btn) {
    inline-size: 100%;
    min-inline-size: 0;
  }

  /* --- due ------------------------------------------------------------------------------------------------------ */

  .due-list {
    display: flex;
    flex-direction: column;
    margin: 0 calc(var(--space-2) * -1);
    padding: 0;
    list-style: none;
  }

  .due-row {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding-block: 2px;
    padding-inline: var(--space-2);
    border-radius: var(--radius-sm);
  }

  .due-row:hover {
    background-color: var(--surface-hover);
  }

  .due-main {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 1px;
    min-inline-size: 0;
    padding-block: 6px;
    padding-inline: 0;
    border: none;
    background: none;
    color: var(--text);
    font: inherit;
    text-align: start;
    cursor: pointer;
  }

  .due-main:focus-visible {
    border-radius: var(--radius-xs);
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .due-title {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .due-meta {
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .due-when {
    color: var(--warning-text);
  }

  .due :global(.btn.v-link) {
    align-self: flex-start;
  }

  /* --- map -------------------------------------------------------------------------------------------------------- */

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    margin: 0;
    padding: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    list-style: none;
  }

  .legend li {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .sw {
    position: relative;
    inline-size: 10px;
    block-size: 10px;
    border-radius: 2px;
  }

  .sw-new {
    background-color: color-mix(in srgb, var(--border-input) 20%, transparent);
  }

  .sw-learning {
    background-color: color-mix(in srgb, var(--accent) 46%, transparent);
  }

  .sw-memorized {
    background-color: var(--accent);
  }

  .sw-due {
    background-color: color-mix(in srgb, var(--border-input) 20%, transparent);
  }

  .sw-due::after {
    content: '';
    position: absolute;
    inset: 28%;
    border-radius: var(--radius-full);
    background-color: var(--warning);
  }

  @media (forced-colors: active) {
    .sw {
      forced-color-adjust: none;
      outline: 1px solid CanvasText;
    }

    .sw-learning,
    .sw-memorized {
      background-color: Highlight;
    }

    .sw-due::after {
      background-color: Mark;
    }
  }
</style>
