<!--
  IndexPanel: the Index sidebar panel. The shell's `Sidebar` draws the heading; this is the body: the reading-bookmark
  `ContinueCard`, then tabs for Surahs, Juz, Hizb and Pages. Each list opens at the current position and keeps it in
  view while the user reads; clicking the open tab again brings it back. The open tab is remembered (`state.svelte.ts`).
  Takes no props: it reads stores.
-->
<script lang="ts">
  import { Tabs, type TabItem } from '$components/ui'
  import { i18n } from '$lib/stores'
  import ContinueCard from './ContinueCard.svelte'
  import HizbList from './HizbList.svelte'
  import JuzList from './JuzList.svelte'
  import PageGrid from './PageGrid.svelte'
  import { indexView, type IndexTab } from './state.svelte'
  import SurahList from './SurahList.svelte'

  interface Locatable {
    locate(): void
  }

  const tabs: TabItem[] = $derived([
    { value: 'surahs', label: i18n.t('navigation.index.tabs.surahs') },
    { value: 'juz', label: i18n.t('navigation.index.tabs.juz') },
    { value: 'hizb', label: i18n.t('navigation.index.tabs.hizb') },
    { value: 'pages', label: i18n.t('navigation.index.tabs.pages') },
  ])

  let surahList: Locatable | undefined = $state()
  let juzList: Locatable | undefined = $state()
  let hizbList: Locatable | undefined = $state()
  let pageGrid: Locatable | undefined = $state()

  function view(tab: IndexTab): Locatable | undefined {
    switch (tab) {
      case 'surahs':
        return surahList
      case 'juz':
        return juzList
      case 'hizb':
        return hizbList
      case 'pages':
        return pageGrid
    }
  }

  /** A click on the tab that is already open shows the current position again. */
  function onTabClick(e: MouseEvent): void {
    const tab = (e.target as HTMLElement | null)?.closest('[role="tab"]')
    if (tab?.getAttribute('data-state') === 'active') view(indexView.tab)?.locate()
  }
</script>

<div class="index">
  <ContinueCard />
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="tabs" onclick={onTabClick}>
    <Tabs
      {tabs}
      value={indexView.tab}
      onValueChange={(v) => indexView.setTab(v as IndexTab)}
      label={i18n.t('navigation.index.tabsLabel')}
      fill
      class="index-tabs"
    >
      {#snippet panel(value)}
        <div class="view">
          {#if value === 'surahs'}
            <SurahList bind:this={surahList} />
          {:else if value === 'juz'}
            <JuzList bind:this={juzList} />
          {:else if value === 'hizb'}
            <HizbList bind:this={hizbList} />
          {:else}
            <PageGrid bind:this={pageGrid} />
          {/if}
        </div>
      {/snippet}
    </Tabs>
  </div>
</div>

<style>
  .index {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-block-size: 0;
    block-size: 100%;
  }

  .tabs {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-block-size: 0;
  }

  .tabs :global(.index-tabs) {
    flex: 1 1 auto;
  }

  .tabs :global(.index-tabs > [role='tablist']) {
    margin-inline: var(--space-3);
  }

  .view {
    display: flex;
    flex-direction: column;
    block-size: 100%;
    min-block-size: 0;
  }
</style>
