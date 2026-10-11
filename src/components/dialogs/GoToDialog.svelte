<!--
  GoToDialog (§10.1 Mod+G, §10.4): jump to an ayah, a range, a page, a juz, a hizb or a surah by typing a reference
  ("2:255", "2:255-257", "p 262", "j 15", "h 30", "18", "الكهف", "kahf 10"). A compact, chrome-less dialog at the
  palette's position (top 14 vh): the input, the candidates of `parseReference` (out-of-range ones disabled with their
  reason), and key hints. Empty, it offers example chips.

  - The input is a combobox over a listbox: ArrowUp/ArrowDown move between enabled candidates, Enter opens the active
    one, Escape closes. Pointer hover moves the active candidate; a click opens it.
  - A jump closes the dialog first; when it has closed, the reader opens the target and, for anything but a page, DOM
    focus moves to the target ayah instead of returning to where it was (§7.4, §8.15).
  - Opened by `ui.open('goto', { initial })` and rendered by `OverlayHost`; `open` follows its own overlay entry (`overlayOpen`).
  Owner: WP10a. Props: `OverlayComponentProps<'goto'>` (§7.9).
-->
<script lang="ts">
  import BookOpenText from '@lucide/svelte/icons/book-open-text'
  import CornerDownLeft from '@lucide/svelte/icons/corner-down-left'
  import FileText from '@lucide/svelte/icons/file-text'
  import Layers from '@lucide/svelte/icons/layers'
  import Layers2 from '@lucide/svelte/icons/layers-2'
  import Signpost from '@lucide/svelte/icons/signpost'
  import { onDestroy, untrack } from 'svelte'
  import { openTarget } from '$components/index/navigate'
  import Rosette from '$components/index/Rosette.svelte'
  import { Dialog, Kbd } from '$components/ui'
  import type { OverlayComponentProps } from '$lib/contracts/components'
  import { i18n, quran, reader, ui } from '$lib/stores'
  import { overlayOpen } from '../shell/overlay'
  import {
    describeTarget,
    type ParsedTarget,
    parseReference,
    type ParseResult,
    targetKey,
  } from '$lib/text/refparse'

  let { initial }: OverlayComponentProps<'goto'> = $props()

  /** Candidates shown at most. */
  const LIMIT = 8
  /** Surah-name candidates at most. */
  const NAME_LIMIT = 6
  /** If the dialog's close-focus hook never runs (it was torn down), the jump still happens after this. */
  const CLOSE_FALLBACK_MS = 450

  const uid = $props.id()
  const listId = `${uid}-list`
  const optionId = (i: number) => `${uid}-opt-${i}`

  let query = $state(untrack(() => initial ?? ''))
  /** The active candidate's key; `null` = the first enabled one. */
  let activeKey = $state<string | null>(null)
  let input: HTMLInputElement | null = $state(null)
  /** The target to open once the dialog has closed. */
  let pending: ParsedTarget | null = null
  let fallback: ReturnType<typeof setTimeout> | undefined

  const isOpen = overlayOpen('goto')
  const open = $derived(isOpen())
  const layout = $derived(reader.layout)

  interface Candidate {
    key: string
    result: ParseResult
    title: string
    detail: string
    enabled: boolean
  }

  const candidates: Candidate[] = $derived.by(() => {
    const out: Candidate[] = []
    for (const result of parseReference(query, { nameLimit: NAME_LIMIT })) {
      const key = targetKey(result.target)
      if (out.some((c) => c.key === key)) continue
      const d = describeTarget(result.target, layout)
      out.push({
        key,
        result,
        title: d.title,
        detail: result.disabledReason ?? d.detail,
        enabled: result.issue === undefined,
      })
      if (out.length >= LIMIT) break
    }
    return out
  })

  const activeIndex = $derived.by(() => {
    const byKey = activeKey === null ? -1 : candidates.findIndex((c) => c.key === activeKey && c.enabled)
    return byKey >= 0 ? byKey : candidates.findIndex((c) => c.enabled)
  })
  const active = $derived(activeIndex >= 0 ? candidates[activeIndex] : undefined)

  const examples = $derived([
    i18n.ref(2, 255),
    i18n.t('navigation.pageShort', { page: 262 }),
    i18n.t('navigation.juzShort', { juz: 15 }),
    i18n.t('navigation.hizbShort', { hizb: 30 }),
    quran.surahName(18),
  ])

  const placeholder = $derived(
    i18n.t('navigation.goto.placeholder', {
      ref: i18n.ref(2, 255),
      page: 262,
      juz: 15,
      hizb: 30,
      surah: quran.surahName(18),
    }),
  )

  function onInput(): void {
    activeKey = null
  }

  /** Moves the active candidate to the next enabled one in `delta`'s direction, wrapping around. */
  function move(delta: 1 | -1): void {
    const n = candidates.length
    if (n === 0) return
    for (let step = 1; step <= n; step++) {
      const i = ((((activeIndex < 0 ? (delta === 1 ? -1 : 0) : activeIndex) + delta * step) % n) + n) % n
      const c = candidates[i]
      if (c?.enabled) {
        activeKey = c.key
        document.getElementById(optionId(i))?.scrollIntoView({ block: 'nearest' })
        return
      }
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (active) go(active)
    }
  }

  function go(c: Candidate): void {
    if (!c.enabled || pending !== null) return
    pending = c.result.target
    ui.close('goto')
    fallback = setTimeout(() => flush(), CLOSE_FALLBACK_MS)
  }

  function useExample(text: string): void {
    // Examples carry bidi isolates for display; the parser ignores them, but the field should not hold them.
    query = text.replace(/[\u2066-\u2069]/gu, '')
    activeKey = null
    input?.focus()
  }

  /** Opens the pending target (once). A jump to an ayah moves focus there; a page keeps the usual focus return. */
  function flush(): boolean {
    clearTimeout(fallback)
    const target = pending
    pending = null
    if (target === null) return false
    const focus = target.type !== 'page'
    openTarget(target, { focus })
    return focus
  }

  function onCloseAutoFocus(e: Event): void {
    if (pending !== null && pending.type !== 'page') e.preventDefault()
    flush()
  }

  onDestroy(() => {
    flush()
  })

  const ICONS = { ayah: BookOpenText, page: FileText, juz: Layers, hizb: Layers2 } as const
  const KIND_KEYS = {
    ayah: 'common.ayah',
    page: 'common.page',
    juz: 'common.juz',
    hizb: 'common.hizb',
    surah: 'common.surah',
  } as const
</script>

<Dialog
  {open}
  onOpenChange={(o) => {
    if (!o) ui.close('goto')
  }}
  title={i18n.t('navigation.goto.title')}
  description={i18n.t('navigation.goto.description', { ref: i18n.ref(2, 255) })}
  variant="bare"
  placement="top"
  width={520}
  backdrop="faint"
  {onCloseAutoFocus}
>
  <div class="goto">
    <div class="field">
      <span class="lead" aria-hidden="true">
        <Signpost size={18} strokeWidth={1.75} />
      </span>
      <input
        bind:this={input}
        bind:value={query}
        class="input"
        type="text"
        dir={query === '' ? i18n.dir : 'auto'}
        role="combobox"
        autocomplete="off"
        spellcheck="false"
        data-autofocus
        aria-label={i18n.t('navigation.goto.title')}
        aria-expanded={candidates.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
        {placeholder}
        oninput={onInput}
        onkeydown={onKeydown}
      />
      <span class="esc" aria-hidden="true">
        <Kbd keys={[i18n.t('shortcuts.keys.escape')]} size="sm" />
        <span>{i18n.t('common.close')}</span>
      </span>
    </div>

    {#if query.trim() === ''}
      <div class="examples">
        <span class="examples-label">{i18n.t('navigation.goto.examples')}</span>
        {#each examples as text (text)}
          <button type="button" class="chip" onclick={() => useExample(text)}>{text}</button>
        {/each}
      </div>
    {:else if candidates.length === 0}
      <div class="none" role="status">
        <p class="none-title">{i18n.t('navigation.goto.noMatch', { query: query.trim() })}</p>
        <p class="none-hint">
          {i18n.t('navigation.goto.noMatchHint', { ref: i18n.ref(2, 255), page: 262, juz: 15 })}
        </p>
      </div>
    {/if}

    <ul
      class="list"
      id={listId}
      role="listbox"
      aria-label={i18n.t('navigation.goto.results')}
      hidden={candidates.length === 0}
    >
      {#each candidates as c, i (c.key)}
        {@const t = c.result.target}
        {@const Icon = t.type === 'surah' ? null : ICONS[t.type]}
        <!-- Options are chosen through the input (aria-activedescendant); the pointer can click them too. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id={optionId(i)}
          class={['option', { active: i === activeIndex, disabled: !c.enabled }]}
          role="option"
          aria-selected={i === activeIndex}
          aria-disabled={!c.enabled}
          onpointermove={() => {
            if (c.enabled && activeKey !== c.key) activeKey = c.key
          }}
          onpointerdown={(e) => e.preventDefault()}
          onclick={() => go(c)}
        >
          <span class={['badge', { tile: Icon !== null }]} aria-hidden="true">
            {#if t.type === 'surah'}
              <Rosette n={t.surah} size={26} active={c.enabled && i === activeIndex} />
            {:else if Icon}
              <Icon size={16} strokeWidth={1.75} />
            {/if}
          </span>
          <span class="text">
            <span class="title">{c.title}</span>
            {#if c.detail}<span class={['detail', { reason: !c.enabled }]}>{c.detail}</span>{/if}
          </span>
          {#if t.type === 'surah' && c.enabled && i18n.locale === 'en'}
            <span class="ar" lang="ar" dir="rtl">{quran.surah(t.surah)?.nameAr}</span>
          {:else if t.type === 'surah' && c.enabled}
            <span class="kind" dir="ltr">{quran.surah(t.surah)?.nameSimple}</span>
          {:else}
            <span class="kind">{i18n.t(KIND_KEYS[t.type])}</span>
          {/if}
          <!-- The Enter key's glyph: a key, never mirrored. -->
          <span class="enter" aria-hidden="true"><CornerDownLeft size={14} strokeWidth={1.75} /></span>
        </li>
      {/each}
    </ul>

    <div class="hints" aria-hidden="true">
      <span class="hint">
        <Kbd keys={['↑']} size="sm" /><Kbd keys={['↓']} size="sm" />{i18n.t('navigation.goto.hintChoose')}
      </span>
      <span class="hint"><Kbd keys={['↵']} size="sm" />{i18n.t('navigation.goto.hintGo')}</span>
    </div>
  </div>
</Dialog>

<style>
  .goto {
    display: flex;
    flex-direction: column;
    min-block-size: 0;
    max-block-size: min(560px, 72vh);
  }

  .field {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-3);
    block-size: 52px;
    padding-inline: var(--space-4);
    border-block-end: 1px solid var(--border);
  }

  .lead {
    display: grid;
    flex: none;
    place-items: center;
    color: var(--accent-text);
  }

  .input {
    flex: 1 1 auto;
    min-inline-size: 0;
    /* Stretched by the flex row, not `block-size: 100%`: Blink resets a fixed- or percent-height input's line box to
       `normal`, which for IBM Plex Sans Arabic is shorter than its dots (the field drew «ابحث فى» for «ابحث في»). */
    align-self: stretch;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: var(--text-lg);
    outline: none;
    unicode-bidi: plaintext;
  }

  .input::placeholder {
    color: var(--text-muted);
  }

  .esc {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: calc(var(--space-1) * 1.5);
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .examples {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    padding-block: var(--space-3);
    padding-inline: var(--space-4);
  }

  .examples-label {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .chip {
    block-size: 26px;
    padding-inline: var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      border-color var(--dur-fast) var(--ease-standard);
  }

  .chip:hover {
    border-color: var(--border-input);
    background-color: var(--surface-hover);
  }

  .none {
    padding-block: var(--space-5);
    padding-inline: var(--space-4);
    text-align: center;
  }

  .none-title {
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
  }

  .none-hint {
    margin-block-start: var(--space-1);
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .list {
    flex: 1 1 auto;
    min-block-size: 0;
    margin: 0;
    padding: var(--space-2);
    overflow-y: auto;
    list-style: none;
    overscroll-behavior: contain;
  }

  .list[hidden] {
    display: none;
  }

  .option {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr) auto 16px;
    align-items: center;
    column-gap: var(--space-3);
    min-block-size: 44px;
    padding-block: var(--space-1);
    padding-inline: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .option.active {
    background-color: var(--surface-hover);
  }

  .option.disabled {
    cursor: default;
  }

  .badge {
    display: grid;
    place-items: center;
    inline-size: 28px;
    block-size: 28px;
  }

  .badge.tile {
    border-radius: var(--radius-sm);
    background-color: var(--accent-soft);
    color: var(--accent-text);
  }

  .disabled .badge.tile {
    background-color: var(--surface-hover);
    color: var(--text-muted);
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-inline-size: 0;
  }

  .title,
  .detail {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .title {
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    line-height: 1.35;
  }

  .disabled .title {
    color: var(--text-muted);
  }

  .detail {
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.35;
  }

  .detail.reason {
    color: var(--danger-text);
  }

  .kind {
    color: var(--text-muted);
    font-size: var(--text-2xs);
    white-space: nowrap;
  }

  .ar {
    font-family: var(--font-naskh);
    font-size: 17px;
    line-height: 1.2;
    white-space: nowrap;
  }

  .enter {
    display: grid;
    place-items: center;
    color: var(--text-muted);
    visibility: hidden;
  }

  .option.active .enter {
    visibility: visible;
  }

  .hints {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--space-4);
    padding-block: var(--space-2);
    padding-inline: var(--space-4);
    border-block-start: 1px solid var(--border);
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .hint {
    display: inline-flex;
    align-items: center;
    gap: calc(var(--space-1) * 1.5);
  }

  @media (forced-colors: active) {
    .option.active {
      outline: 2px solid Highlight;
      outline-offset: -2px;
    }
  }
</style>
