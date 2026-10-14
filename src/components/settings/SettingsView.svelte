<!--
  SettingsView: the Settings view (`ui.view === 'settings'`), shown in the shell's Settings dialog over the reader
  (`SettingsDialog`, owner request 2026-10-11). Takes no props: it reads stores.

  A 200 px section navigation (the view title, a search field, the ten sections) beside one section at a time in a
  column of at most 720 px: its title, a lede and cards of 56 px rows whose labels and ranges come from `settingsMeta`.
  Every `Settings` field is bound to a control and saved at once through the settings store's optimistic `update`.

  Search: typing in the field shows the matching rows of every section, live controls included, grouped under their
  section and card; a section button then shows that section. The match runs on each row's label, description,
  options and keywords, in the UI language and in English. Under 880 px of width (a small window, a large interface
  size) the navigation folds into a strip above the column: the title and the search, then the sections in one row
  that scrolls sideways (the wheel too) and keeps the open section in view. The dialog sets what the view keeps free:
  `--qd-dock-reserve` at its end (where the player dock lies over it) and `--qd-close-room` in its top inline-end
  corner (the close button).
-->
<script lang="ts">
  import AudioLines from '@lucide/svelte/icons/audio-lines'
  import BookOpen from '@lucide/svelte/icons/book-open'
  import Brain from '@lucide/svelte/icons/brain'
  import HardDrive from '@lucide/svelte/icons/hard-drive'
  import Info from '@lucide/svelte/icons/info'
  import Keyboard from '@lucide/svelte/icons/keyboard'
  import Languages from '@lucide/svelte/icons/languages'
  import MonitorCog from '@lucide/svelte/icons/monitor-cog'
  import Palette from '@lucide/svelte/icons/palette'
  import ScrollText from '@lucide/svelte/icons/scroll-text'
  import type { LucideIcon } from '@lucide/svelte'
  import type { Component } from 'svelte'
  import { Button, EmptyState, ScrollArea, SearchInput } from '$components/ui'
  import { i18n } from '$lib/stores'
  import { provideSettingsSearch } from './controls/context'
  import { metaOf, type SettingsSection, SETTINGS_SECTIONS } from './meta'
  import About from './sections/About.svelte'
  import Appearance from './sections/Appearance.svelte'
  import Audio from './sections/Audio.svelte'
  import KeyboardSection from './sections/Keyboard.svelte'
  import Language from './sections/Language.svelte'
  import Memorization from './sections/Memorization.svelte'
  import Mushaf from './sections/Mushaf.svelte'
  import Storage from './sections/Storage.svelte'
  import System from './sections/System.svelte'
  import Translations from './sections/Translations.svelte'
  import { SETTINGS_TITLE_ID, settingsView } from './view.svelte'

  const SECTIONS: Readonly<Record<SettingsSection, { icon: LucideIcon; body: Component }>> = {
    appearance: { icon: Palette, body: Appearance },
    mushaf: { icon: BookOpen, body: Mushaf },
    translations: { icon: ScrollText, body: Translations },
    audio: { icon: AudioLines, body: Audio },
    memorization: { icon: Brain, body: Memorization },
    language: { icon: Languages, body: Language },
    keyboard: { icon: Keyboard, body: KeyboardSection },
    storage: { icon: HardDrive, body: Storage },
    system: { icon: MonitorCog, body: System },
    about: { icon: Info, body: About },
  }

  const uid = $props.id()

  const searching = $derived(settingsView.searching)
  const query = $derived(settingsView.query.trim())
  const matches = $derived(settingsView.matches(i18n.locale))

  provideSettingsSearch({
    get active() {
      return settingsView.searching
    },
    visible: (id) => !settingsView.searching || matches.has(id),
  })

  /** Matching rows per section while searching. */
  const counts: Readonly<Record<string, number>> = $derived.by(() => {
    const out: Record<string, number> = {}
    for (const id of matches) {
      const section = metaOf(id)?.section
      if (section) out[section] = (out[section] ?? 0) + 1
    }
    return out
  })

  let viewport: HTMLElement | null = $state(null)
  let strip: HTMLElement | null = $state(null)
  let stripWidth = $state(0)

  function show(section: SettingsSection): void {
    settingsView.open(section)
    viewport?.scrollTo({ top: 0 })
  }

  /** The strip scrolls sideways: its sections do not all fit in one row (narrow; never in the column layout). */
  function overflows(list: HTMLElement): boolean {
    return list.scrollWidth > list.clientWidth + 1
  }

  /** ↑/↓ (and Home/End) move between the section buttons; ←/→ too in the strip, in reading order. */
  function onNavKeydown(e: KeyboardEvent): void {
    const list = e.currentTarget as HTMLElement
    const row = getComputedStyle(list).flexDirection.startsWith('row')
    const forward = i18n.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight'
    const backward = i18n.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft'
    const step =
      e.key === 'ArrowDown' || (row && e.key === forward)
        ? 1
        : e.key === 'ArrowUp' || (row && e.key === backward)
          ? -1
          : 0
    if (step === 0 && e.key !== 'Home' && e.key !== 'End') return
    const buttons = [...list.querySelectorAll<HTMLButtonElement>('button[data-section]')]
    const index = buttons.findIndex((b) => b === document.activeElement)
    if (index < 0) return
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? buttons.length - 1
          : (index + step + buttons.length) % buttons.length
    e.preventDefault()
    buttons[next]?.focus()
  }

  // The strip keeps the open section in view (on a section change, and when the strip appears or resizes).
  $effect(() => {
    const list = strip
    void stripWidth
    void settingsView.section
    if (list === null) return
    const frame = requestAnimationFrame(() => {
      const current = list.querySelector<HTMLElement>('button[aria-current="page"]')
      if (current === null || !overflows(list)) return
      const box = list.getBoundingClientRect()
      const item = current.getBoundingClientRect()
      const pad = parseFloat(getComputedStyle(list).scrollPaddingInlineStart) || 0
      // Physical deltas: scrollBy moves the same way in both directions (scrollLeft is negative in RTL).
      if (item.left < box.left + pad) list.scrollBy({ left: item.left - box.left - pad })
      else if (item.right > box.right - pad) list.scrollBy({ left: item.right - box.right + pad })
    })
    return () => cancelAnimationFrame(frame)
  })

  // A vertical wheel over the strip scrolls it sideways while it can still move that way; at its ends the wheel goes on
  // to the page.
  $effect(() => {
    const list = strip
    if (list === null) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX) || !overflows(list)) return
      // Down moves towards the strip's end: right in LTR, left in RTL (where scrollLeft runs from 0 down to −max).
      const travelled = Math.abs(list.scrollLeft)
      const end = list.scrollWidth - list.clientWidth
      if (e.deltaY > 0 ? travelled >= end - 1 : travelled <= 0) return
      e.preventDefault()
      list.scrollBy({ left: i18n.dir === 'rtl' ? -e.deltaY : e.deltaY })
    }
    list.addEventListener('wheel', onWheel, { passive: false })
    return () => list.removeEventListener('wheel', onWheel)
  })
</script>

<div class="settings" data-qd-view="settings">
  <ScrollArea class="scroll" bind:viewport>
    <div class="layout">
      <nav class="nav" aria-label={i18n.t('settings.nav.label')}>
        <h1 class="view-title" id={SETTINGS_TITLE_ID}>{i18n.t('settings.title')}</h1>
        <div class="search">
          <SearchInput
            size="sm"
            bind:value={settingsView.query}
            placeholder={i18n.t('settings.nav.search')}
            aria-label={i18n.t('settings.nav.search')}
            aria-controls="{uid}-content"
            data-settings-search
          />
        </div>
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <ul class="sections" onkeydown={onNavKeydown} bind:this={strip} bind:clientWidth={stripWidth}>
          {#each SETTINGS_SECTIONS as id (id)}
            {@const Icon = SECTIONS[id].icon}
            {@const current = !searching && settingsView.section === id}
            {@const count = counts[id] ?? 0}
            <li>
              <button
                type="button"
                class={['section-link', { current, dim: searching && count === 0 }]}
                aria-current={current ? 'page' : undefined}
                data-section={id}
                onclick={() => show(id)}
              >
                <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
                <span class="name">{i18n.t(`settings.sections.${id}.title`)}</span>
                {#if searching && count > 0}<span class="count">{i18n.num(count)}</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      </nav>

      <div class="content" id="{uid}-content">
        {#if searching}
          <header class="head">
            <h2 class="title">{i18n.t('settings.search.heading')}</h2>
            <p class="lede" role="status">
              {matches.size > 0 ? i18n.tp('settings.search.count', matches.size, { query }) : ''}
            </p>
          </header>
          {#if matches.size === 0}
            <EmptyState
              title={i18n.t('settings.search.empty', { query })}
              body={i18n.t('settings.search.emptyBody')}
            >
              {#snippet action()}
                <Button variant="secondary" onclick={() => (settingsView.query = '')}>
                  {i18n.t('settings.search.clear')}
                </Button>
              {/snippet}
            </EmptyState>
          {/if}
          {#each SETTINGS_SECTIONS as id (id)}
            {@const Body = SECTIONS[id].body}
            <section
              class="section result"
              data-section={id}
              hidden={!counts[id]}
              aria-labelledby="{uid}-{id}"
            >
              <h2 class="result-title" id="{uid}-{id}">
                <button type="button" class="result-link" onclick={() => show(id)}>
                  {i18n.t(`settings.sections.${id}.title`)}
                </button>
              </h2>
              <Body />
            </section>
          {/each}
        {:else}
          {@const id = settingsView.section}
          {@const Body = SECTIONS[id].body}
          {#key id}
            <section class="section" data-section={id} aria-labelledby="{uid}-{id}">
              <header class="head">
                <h2 class="title" id="{uid}-{id}">{i18n.t(`settings.sections.${id}.title`)}</h2>
                <p class="lede">{i18n.t(`settings.sections.${id}.lede`)}</p>
              </header>
              <Body />
            </section>
          {/key}
        {/if}
      </div>
    </div>
  </ScrollArea>
</div>

<style>
  .settings {
    position: relative;
    block-size: 100%;
    min-block-size: 0;
    container: settings-view / inline-size;
    background-color: var(--surface-app);
  }

  .settings > :global(.scroll) {
    block-size: 100%;
  }

  /* The scrollbar stays above the sticky navigation (the strip spans the whole width). */
  .settings > :global(.scroll > .scrollbar) {
    z-index: 3;
  }

  .layout {
    display: grid;
    grid-template-columns: 200px minmax(0, 720px);
    justify-content: center;
    column-gap: var(--space-10);
    padding-block: var(--space-8) calc(var(--qd-dock-reserve, 0px) + var(--space-6));
    padding-inline: var(--space-8) max(var(--space-8), var(--qd-close-room, 0px));
  }

  /* --- navigation --------------------------------------------------------------------------------------------- */

  .nav {
    position: sticky;
    inset-block-start: var(--space-8);
    z-index: 2;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    align-self: start;
  }

  .view-title {
    margin: 0;
    padding-inline: var(--space-2);
    color: var(--text);
    font-size: var(--text-xl);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .search {
    padding-block-end: var(--space-1);
  }

  .sections {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .section-link {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    inline-size: 100%;
    block-size: 34px;
    padding-inline: var(--space-3) var(--space-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-muted);
    font-family: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    text-align: start;
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      color var(--dur-fast) var(--ease-standard);
  }

  .section-link:hover {
    background-color: var(--surface-hover);
    color: var(--text);
  }

  .section-link.current {
    background-color: var(--accent-soft);
    color: var(--accent-text);
    font-weight: var(--weight-title);
  }

  /* The accent bar on the inline-start edge, as on the rail and the index. */
  .section-link.current::before {
    content: '';
    position: absolute;
    inset-block: 8px;
    inset-inline-start: 0;
    inline-size: 3px;
    border-radius: var(--radius-full);
    background-color: var(--accent);
  }

  .section-link.dim {
    color: var(--text-muted);
  }

  .name {
    flex: 1 1 auto;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .count {
    flex: none;
    min-inline-size: 20px;
    padding-inline: 6px;
    border-radius: var(--radius-full);
    background-color: var(--accent-soft);
    color: var(--accent-text);
    font-size: var(--text-2xs);
    font-weight: var(--weight-title);
    font-variant-numeric: tabular-nums;
    line-height: 18px;
    text-align: center;
  }

  /* --- content ------------------------------------------------------------------------------------------------ */

  .content {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    min-inline-size: 0;
    container: settings-column / inline-size;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    animation: section-in var(--dur-normal) var(--ease-decelerate);
  }

  .section[hidden] {
    display: none;
  }

  .section.result {
    gap: var(--space-4);
    animation: none;
  }

  .section.result + .section.result {
    padding-block-start: var(--space-4);
    border-block-start: 1px solid var(--border);
  }

  @keyframes section-in {
    from {
      opacity: 0;
      translate: 0 6px;
    }
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding-inline: var(--space-1);
  }

  .title {
    margin: 0;
    color: var(--text);
    font-size: var(--text-2xl);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .lede {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-md);
    line-height: var(--leading-ui);
  }

  .lede:empty {
    display: none;
  }

  .result-title {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: var(--weight-title);
  }

  .result-link {
    padding: 2px var(--space-1);
    border: 0;
    border-radius: var(--radius-xs);
    background: none;
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }

  .result-link:hover {
    color: var(--accent-text);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  /* --- narrow: the navigation becomes a strip above the column, its sections in one scrolling row -------------- */

  @container settings-view (max-width: 880px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
      row-gap: var(--space-6);
      padding-block-start: var(--space-5);
      padding-inline: var(--space-5);
    }

    .nav {
      inset-block-start: 0;
      display: grid;
      grid-template-columns: auto minmax(160px, 260px);
      grid-template-areas:
        'title search'
        'sections sections';
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2) var(--space-4);
      margin-inline: calc(-1 * var(--space-5));
      padding-block: var(--space-2);
      padding-inline: var(--space-5);
      border-block-end: 1px solid var(--border);
      background-color: var(--surface-app);
    }

    .view-title {
      grid-area: title;
      padding-inline: 0;
      font-size: var(--text-lg);
    }

    /* The close button sits at the end of this row. */
    .search {
      grid-area: search;
      padding: 0;
      margin-inline-end: max(0px, var(--qd-close-room, 0px) - var(--space-5));
    }

    /* Edge to edge of the strip; the block padding keeps the focus ring inside the scroller. */
    .sections {
      grid-area: sections;
      flex-flow: row nowrap;
      gap: var(--space-1);
      margin-block: -4px;
      margin-inline: calc(-1 * var(--space-5));
      padding-block: 4px;
      padding-inline: var(--space-5);
      overflow-x: auto;
      overscroll-behavior-x: contain;
      scroll-padding-inline: var(--space-5);
      scrollbar-width: none;
    }

    .sections > li {
      flex: none;
    }

    .section-link {
      inline-size: auto;
      block-size: 30px;
      padding-inline: var(--space-2) var(--space-3);
      white-space: nowrap;
    }

    .section-link.current::before {
      inset-block: auto 0;
      inset-inline: var(--space-2);
      inline-size: auto;
      block-size: 2px;
    }

    .name {
      overflow: visible;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .section {
      animation: none;
    }
  }

  :global(html[data-motion='reduce']) .section {
    animation: none;
  }

  @media (forced-colors: active) {
    .section-link.current {
      outline: 2px solid Highlight;
    }
  }
</style>
