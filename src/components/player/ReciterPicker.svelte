<!--
  ReciterPicker: the reciter popover opened from the dock's reciter cell.

  A search field over the reciters (Arabic and Latin names and the style, folded like every list filter), each row with
  its monogram, both names, the word-timing badge (`ReciterInfo.wordLevel`) and what is on disk (downloaded, else
  stream-cached surahs; the counts are refreshed when the picker opens and on `packs-changed`). Choosing one calls
  `player.setReciter`, which persists it and moves a loaded recitation over at the ayah being heard.

  Keyboard: the field is a combobox over the listbox (↑/↓, Home/End with Ctrl, Enter chooses, Escape closes and returns
  focus to the trigger). It is a floating layer, so typed letters never reach the reader.
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import type { Snippet } from 'svelte'
  import { Badge, foldForMatch, Popover, SearchInput } from '$components/ui'
  import type { Align, Side, TriggerProps } from '$components/ui/types'
  import type { ReciterInfo } from '$lib/ipc/bindings'
  import { i18n, player, settings, ui } from '$lib/stores'
  import { monogram, reciterName, reciterStyle } from './dock.svelte'

  interface Props {
    trigger: Snippet<[TriggerProps]>
    side?: Side
    align?: Align
    /** Distance from the trigger (the dock passes enough to clear its own edge). */
    sideOffset?: number
    /** Anchor the panel to this element instead of the trigger (the side card anchors to itself). */
    anchor?: HTMLElement | null
    open?: boolean
  }

  let {
    trigger,
    side = 'top',
    align = 'start',
    sideOffset = 10,
    anchor = null,
    open = $bindable(false),
  }: Props = $props()

  const uid = $props.id()
  const listId = `${uid}-reciters`
  let query = $state('')
  let activeIndex = $state(0)
  let input: HTMLInputElement | null = $state(null)
  let list: HTMLUListElement | null = $state(null)

  const currentId = $derived(settings.value.reciterId)
  const other = $derived(i18n.locale === 'ar' ? 'en' : 'ar')

  function haystack(r: ReciterInfo): string {
    return foldForMatch([r.name.en, r.name.ar, r.style?.en ?? '', r.style?.ar ?? ''].join(' '))
  }

  const filtered = $derived.by(() => {
    const tokens = foldForMatch(query).split(/\s+/u).filter(Boolean)
    if (tokens.length === 0) return player.reciters
    return player.reciters.filter((r) => {
      const text = haystack(r)
      return tokens.every((t) => text.includes(t))
    })
  })

  $effect(() => {
    if (!open) return
    query = ''
    void player.refreshReciters()
  })

  // Keep the active row valid and visible.
  $effect(() => {
    const n = filtered.length
    if (activeIndex >= n) activeIndex = Math.max(0, n - 1)
  })
  $effect(() => {
    const i = activeIndex
    if (!open) return
    list?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' })
  })

  function onOpenAutoFocus(e: Event): void {
    e.preventDefault()
    const i = player.reciters.findIndex((r) => r.id === currentId)
    activeIndex = Math.max(0, i)
    input?.focus()
  }

  function choose(r: ReciterInfo): void {
    open = false
    void player.setReciter(r.id)
  }

  function onkeydown(e: KeyboardEvent): void {
    const n = filtered.length
    if (n === 0) return
    switch (e.key) {
      case 'ArrowDown':
        activeIndex = (activeIndex + 1) % n
        break
      case 'ArrowUp':
        activeIndex = (activeIndex - 1 + n) % n
        break
      case 'Home':
        if (!e.ctrlKey && !e.metaKey) return
        activeIndex = 0
        break
      case 'End':
        if (!e.ctrlKey && !e.metaKey) return
        activeIndex = n - 1
        break
      case 'Enter': {
        const r = filtered[activeIndex]
        if (r) choose(r)
        break
      }
      default:
        return
    }
    e.preventDefault()
  }

  /** What is on disk for the reciter ("12 surahs downloaded"); nothing when it only streams. */
  function onDisk(r: ReciterInfo): string {
    if (r.downloadedSurahs > 0) return i18n.tp('player.picker.downloaded', r.downloadedSurahs)
    if (r.cachedSurahs > 0) return i18n.tp('player.picker.cached', r.cachedSurahs)
    return ''
  }

  function manage(): void {
    open = false
    ui.setView('downloads')
  }
</script>

<Popover
  bind:open
  {trigger}
  {side}
  {align}
  width={360}
  padding="none"
  {sideOffset}
  {anchor}
  label={i18n.t('player.picker.title')}
  {onOpenAutoFocus}
>
  <div class="picker">
    <div class="head">
      <SearchInput
        bind:value={query}
        bind:ref={input}
        size="sm"
        placeholder={i18n.t('player.picker.search')}
        aria-label={i18n.t('player.picker.search')}
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={filtered[activeIndex] ? `${listId}-${filtered[activeIndex]?.id}` : undefined}
        {onkeydown}
      />
    </div>
    {#if filtered.length === 0}
      <p class="empty">{i18n.t('player.picker.noMatch', { query })}</p>
    {:else}
      <ul class="list" id={listId} role="listbox" aria-label={i18n.t('player.picker.title')} bind:this={list}>
        {#each filtered as r, i (r.id)}
          {@const selected = r.id === currentId}
          <!-- svelte-ignore a11y_click_events_have_key_events (the combobox field handles the keys) -->
          <li
            id="{listId}-{r.id}"
            role="option"
            aria-selected={selected}
            class:active={i === activeIndex}
            class:selected
            data-index={i}
            onclick={() => choose(r)}
            onpointermove={() => (activeIndex = i)}
          >
            <span class="mono" lang={i18n.locale} aria-hidden="true">{monogram(r, i18n.locale)}</span>
            <span class="names">
              <span class="name">{reciterName(r)}</span>
              <span class="alt">
                <bdi lang={other} class:naskh={other === 'ar'}>{r.name[other]}</bdi>{#if reciterStyle(r)}<span
                    class="sep"
                    aria-hidden="true">·</span
                  ><span>{reciterStyle(r)}</span>{/if}
              </span>
            </span>
            <span class="meta">
              <span
                title={i18n.t(r.wordLevel ? 'player.picker.wordLevelHint' : 'player.picker.ayahLevelHint')}
              >
                <Badge size="sm" tone="neutral">
                  {i18n.t(r.wordLevel ? 'player.picker.wordLevel' : 'player.picker.ayahLevel')}
                </Badge>
              </span>
              {#if onDisk(r)}<span class="disk">{onDisk(r)}</span>{/if}
            </span>
            <span class="check" aria-hidden="true">
              {#if selected}<Check size={16} strokeWidth={2} />{/if}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="foot">
      <span class="foot-hint">{i18n.t('player.picker.streams')}</span>
      <button type="button" class="link" onclick={manage}>{i18n.t('player.picker.manage')}</button>
    </div>
  </div>
</Popover>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    max-block-size: min(480px, 70vh);
  }

  .head {
    padding: var(--space-3);
    padding-block-end: var(--space-2);
  }

  .list {
    flex: 1 1 auto;
    min-block-size: 0;
    margin: 0;
    padding-block: 0 var(--space-1);
    padding-inline: var(--space-1);
    overflow-y: auto;
    overscroll-behavior: contain;
    list-style: none;
  }

  li {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr) auto 16px;
    align-items: center;
    gap: var(--space-3);
    min-block-size: 52px;
    padding-block: var(--space-2);
    padding-inline: var(--space-2);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  li.active {
    background-color: var(--surface-hover);
  }

  .mono {
    display: grid;
    place-items: center;
    inline-size: 32px;
    block-size: 32px;
    border-radius: var(--radius-full);
    background-color: var(--accent-soft);
    color: var(--accent-text);
    font-size: var(--text-xs);
    font-weight: var(--weight-title);
    line-height: 1;
  }

  .mono:lang(ar) {
    font-family: var(--font-naskh);
    font-size: 17px;
    font-weight: 600;
  }

  .selected .mono {
    background-color: var(--accent);
    color: var(--accent-ink);
  }

  .names {
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
    line-height: 1.3;
  }

  .name {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .alt {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .naskh {
    font-family: var(--font-naskh);
  }

  .sep {
    margin-inline: var(--space-1);
  }

  .disk {
    color: var(--text-muted);
    font-size: var(--text-2xs);
    white-space: nowrap;
  }

  .meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
  }

  .check {
    display: inline-grid;
    place-items: center;
    inline-size: 16px;
    color: var(--accent-text);
  }

  .empty {
    margin: 0;
    padding-block: var(--space-4) var(--space-5);
    padding-inline: var(--space-4);
    color: var(--text-muted);
    font-size: var(--text-sm);
    text-align: center;
  }

  .foot-hint {
    color: var(--text-muted);
    font-size: var(--text-2xs);
  }

  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding-block: var(--space-2);
    padding-inline: var(--space-3);
    border-block-start: 1px solid var(--border);
  }

  .link {
    padding: var(--space-1);
    border: none;
    border-radius: var(--radius-xs);
    background: none;
    color: var(--accent-text);
    font: inherit;
    font-size: var(--text-xs);
    font-weight: var(--weight-label);
    cursor: pointer;
  }

  .link:hover {
    text-decoration: underline;
  }

  @media (forced-colors: active) {
    li.active {
      outline: 1px solid Highlight;
    }
  }
</style>
