<!--
  SettingsView (§7.5, §9.7): the Settings view, shown in the canvas (`ui.view === 'settings'`). Takes no props: it
  reads stores (§7.9).

  A 200 px section navigation (the view title, a search field, the ten sections) beside one section at a time in a
  column of at most 720 px: its title, a lede and cards of 56 px rows whose labels and ranges come from `settingsMeta`.
  Every `Settings` field is bound to a control and saved at once through the settings store's optimistic `update`.

  Search: typing in the field shows the matching rows of every section, live controls included, grouped under their
  section and card; a section button then shows that section. The match runs on each row's label, description,
  options and keywords, in the UI language and in English. Narrow canvases (under 880 px, e.g. at a large interface
  size) fold the navigation into a scrolling strip above the column. The column keeps clear of the player dock.
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
  import { i18n, reader } from '$lib/stores'
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
  import { settingsView } from './view.svelte'

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

  /** Space kept free under the column for the player dock: the side card (120 px) or the bar, plus its margin. */
  const dockReserve = $derived(
    reader.dock === 'side' ? 120 + 34 : reader.dock === 'compact' ? 56 + 34 : 64 + 34,
  )

  let viewport: HTMLElement | null = $state(null)

  function show(section: SettingsSection): void {
    settingsView.open(section)
    viewport?.scrollTo({ top: 0 })
  }

  /** ↑/↓ (and Home/End) move between the section buttons. */
  function onNavKeydown(e: KeyboardEvent): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const buttons = [
      ...(e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button[data-section]'),
    ]
    const index = buttons.findIndex((b) => b === document.activeElement)
    if (index < 0) return
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? buttons.length - 1
          : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    e.preventDefault()
    buttons[next]?.focus()
  }
</script>

<div class="settings" data-qd-view="settings" style:--_reserve="{dockReserve}px">
  <ScrollArea class="scroll" bind:viewport>
    <div class="layout">
      <nav class="nav" aria-label={i18n.t('settings.nav.label')}>
        <h1 class="view-title">{i18n.t('settings.title')}</h1>
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
        <ul class="sections" onkeydown={onNavKeydown}>
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

  .layout {
    display: grid;
    grid-template-columns: 200px minmax(0, 720px);
    justify-content: center;
    column-gap: var(--space-10);
    padding-block: var(--space-8) calc(var(--_reserve) + var(--space-6));
    padding-inline: var(--space-8);
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

  /* The accent bar on the inline-start edge, as on the rail and the index (§9.7). */
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

  /* --- narrow: the navigation becomes a strip above the column ------------------------------------------------ */

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

    .search {
      grid-area: search;
      padding: 0;
    }

    .sections {
      grid-area: sections;
      flex-flow: row wrap;
      gap: var(--space-1);
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
