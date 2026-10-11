<!--
  TitleBar (§7.5, §9.6): the 40 px bar on `--surface-chrome`. Owner: WP7c.

  [macOS: 78 px traffic-light inset] app icon · breadcrumb ─── command button (palette, Ctrl+K) ─── offline badge ·
  window controls (Windows)

  - Windows and macOS: the bar is the window's drag region (`data-tauri-drag-region="deep"`: any non-interactive part
    drags, a double-click maximises). Linux keeps native decorations, so the bar is a plain toolbar.
  - The breadcrumb reads "Al-Hijr · Juz 14 · Pages 261–262" in the reader ("الحجر، الجزء ١٤، ص ٢٦١–٢٦٢": the Arabic
    comma, since a middle dot next to Arabic-Indic digits reads as ٠) and opens Go to; in another view it is
    "← Reading / Settings" and returns to the reader. Its text is replaced as a whole when it changes (keyed), so a
    surah name of another width never moves the segments after it on a page turn (CLS 0, §8.1).
  - The command button sits in the true centre of the window (a three-column grid) and shrinks to its icon in
    narrow windows.
  - While the window is in the background (Tauri only), the bar's text and caption glyphs dim, as native ones do.
  - Windows: the native Snap Layouts target over the maximise button follows the caption buttons; while zen hides the
    bar or a modal's backdrop covers it (`ui.captionVisible`), Rust is told to stand it down (`window_set_caption`).
  Takes no props: it reads stores (§7.9).
-->
<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left'
  import Search from '@lucide/svelte/icons/search'
  import { onMount } from 'svelte'
  import appIcon from '../../assets/app-icon-small.svg'
  import { Kbd, Tooltip } from '$components/ui'
  import { api, call } from '$lib/ipc'
  import { app, i18n, quran, reader, settings, shortcuts, ui } from '$lib/stores'
  import { titleBarKind } from '$lib/util/platform'
  import OfflineBadge from './OfflineBadge.svelte'
  import WindowControls from './WindowControls.svelte'

  const kind = $derived(titleBarKind(app.platform))

  /** The label of a registered shortcut by id, if registered. */
  function keyOf(id: string): string | undefined {
    const def = shortcuts.defs.find((d) => d.id === id)
    const label = def ? shortcuts.format(def) : ''
    return label === '' ? undefined : label
  }

  const paletteKey = $derived(keyOf('app.palette'))
  const goToKey = $derived(keyOf('nav.goTo'))

  const surah = $derived(quran.surah(reader.headSurah))
  const surahName = $derived(surah ? (i18n.locale === 'ar' ? surah.nameAr : surah.nameSimple) : '')
  const pages = $derived(reader.visiblePages)
  const pageLabel = $derived.by(() => {
    if (settings.value.readingMode === 'mushaf' && pages.length === 2) {
      const [from = 1, to = 1] = pages
      return i18n.t('shell.titleBar.pages', { from: i18n.num(from), to: i18n.num(to) })
    }
    return i18n.t('common.pageNumber', { page: i18n.num(reader.page) })
  })
  const juzLabel = $derived(i18n.t('common.juzNumber', { juz: i18n.num(reader.juz) }))
  /** The Arabic UI separates with the Arabic comma, set against the segment before it. */
  const comma = $derived(i18n.locale === 'ar')
  const crumb = $derived(`${surahName}|${juzLabel}|${pageLabel}`)

  // §9.6 Snap Layouts: the native maximise target is only live while the caption buttons can be used.
  $effect(() => {
    if (!kind.windowControls) return
    const visible = ui.captionVisible
    call(api.windowSetCaption(visible)).catch((e: unknown) =>
      console.warn('[qd] the caption state could not be sent', e),
    )
  })

  /** Whether the window is the foreground window (only tracked in Tauri: a browser tab has no such notion). */
  let windowActive = $state(true)
  onMount(() => {
    if (__MOCK_IPC__) return
    const sync = () => (windowActive = document.hasFocus())
    sync()
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
    }
  })
</script>

<header
  class="titlebar"
  class:inactive={!windowActive}
  data-platform={app.platform}
  data-tauri-drag-region={kind.drag ? 'deep' : undefined}
  style:--traffic-inset="{kind.trafficLightInset}px"
>
  <div class="start">
    <img class="app-icon" src={appIcon} width="18" height="18" alt="" draggable="false" />
    <nav class="crumbs" aria-label={i18n.t('shell.titleBar.location')}>
      {#if ui.view === 'reader'}
        {#if surah}
          <Tooltip content={i18n.t('shell.titleBar.goTo')} kbd={goToKey} side="bottom">
            {#snippet children({ props })}
              <button {...props} type="button" class="crumb-button" onclick={() => ui.open('goto', {})}>
                {#key crumb}
                  <span class="surah">{surahName}</span>
                  <span class={['sep', { comma }]} aria-hidden="true">{comma ? '،' : '·'}</span>
                  <span class="meta">{juzLabel}</span>
                  <span class={['sep', { comma }]} aria-hidden="true">{comma ? '،' : '·'}</span>
                  <span class="meta">{pageLabel}</span>
                {/key}
              </button>
            {/snippet}
          </Tooltip>
        {/if}
      {:else}
        <button
          type="button"
          class="crumb-button back"
          aria-label={i18n.t('shell.titleBar.backToReading')}
          onclick={() => ui.setView('reader')}
        >
          <ArrowLeft size={14} strokeWidth={2} class="icon-dir" aria-hidden="true" />
          <span class="meta">{i18n.t('shell.views.reader')}</span>
        </button>
        <span class="sep" aria-hidden="true">/</span>
        <span class="surah current" aria-current="page">{i18n.t(`shell.views.${ui.view}`)}</span>
      {/if}
    </nav>
  </div>

  <div class="center">
    <button
      type="button"
      class="command"
      aria-label={i18n.t('shortcuts.app.palette')}
      aria-keyshortcuts={app.isMac ? 'Meta+K' : 'Control+K'}
      onclick={() => ui.open('palette', {})}
    >
      <Search size={14} strokeWidth={2} aria-hidden="true" />
      <span class="command-label">{i18n.t('shell.titleBar.search')}</span>
      {#if paletteKey}<Kbd chord={paletteKey} size="sm" class="command-kbd" />{/if}
    </button>
  </div>

  <div class="end">
    <OfflineBadge />
    {#if kind.windowControls}
      <WindowControls inactive={!windowActive} />
    {/if}
  </div>
</header>

<style>
  .titlebar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    column-gap: var(--space-3);
    block-size: 40px;
    /* The macOS traffic lights stay on the physical left in both UI directions. */
    padding-left: var(--traffic-inset, 0px); /* physical-ok */
    background-color: var(--surface-chrome);
    border-block-end: 1px solid var(--border);
    color: var(--text);
    white-space: nowrap;
    user-select: none;
    -webkit-user-select: none;
  }

  .start {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-inline-size: 0;
    padding-inline-start: var(--space-3);
  }

  .titlebar[data-platform='macos'] .start {
    padding-inline-start: var(--space-2);
  }

  .app-icon {
    flex: none;
    inline-size: 18px;
    block-size: 18px;
    border-radius: 4px;
    -webkit-user-drag: none;
  }

  .crumbs {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    min-inline-size: 0;
    font-size: var(--text-sm);
  }

  .crumb-button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-inline-size: 0;
    block-size: 28px;
    padding-inline: var(--space-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease-standard);
  }

  .crumb-button:hover {
    background-color: var(--surface-hover);
  }

  .back {
    gap: var(--space-1);
    color: var(--text-muted);
  }

  .back:hover {
    color: var(--text);
  }

  .surah {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text);
    font-weight: var(--weight-label);
    text-overflow: ellipsis;
  }

  .current {
    padding-inline: var(--space-2);
  }

  .meta {
    flex: none;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .sep {
    flex: none;
    color: var(--text-faint);
  }

  /* The Arabic comma follows its word directly (the button's gap would detach it). */
  .sep.comma {
    margin-inline-start: calc(-1 * var(--space-2));
  }

  .center {
    display: flex;
    justify-content: center;
  }

  .command {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    inline-size: clamp(240px, 30vw, 420px);
    block-size: 28px;
    padding-inline: var(--space-3) var(--space-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background-color: color-mix(in srgb, var(--surface-raised) 72%, transparent);
    color: var(--text-muted);
    font-size: var(--text-xs);
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      border-color var(--dur-fast) var(--ease-standard);
  }

  .command:hover {
    border-color: var(--border-strong);
    background-color: var(--surface-raised);
    color: var(--text);
  }

  .command-label {
    flex: 1 1 auto;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-align: start;
    text-overflow: ellipsis;
  }

  .end {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    align-self: stretch;
    min-inline-size: 0;
    padding-inline-end: var(--space-3);
  }

  .titlebar[data-platform='windows'] .end {
    padding-inline-end: 0;
  }

  .inactive .surah,
  .inactive .app-icon {
    opacity: 0.6;
  }

  /* Narrow windows: the command button keeps its icon only. */
  @media (max-width: 860px) {
    .command {
      inline-size: 32px;
      justify-content: center;
      padding: 0;
    }

    .command-label,
    .command :global(.command-kbd) {
      display: none;
    }
  }

  @media (max-width: 640px) {
    .meta,
    .sep {
      display: none;
    }
  }
</style>
