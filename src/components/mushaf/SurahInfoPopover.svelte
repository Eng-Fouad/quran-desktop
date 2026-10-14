<!--
  SurahInfoPopover. What a click on a surah header opens: the surah's names, where and in which order it was revealed,
  its ayahs, pages and juz, and two actions, "Play surah" (from its first ayah to its last, with the current reciter)
  and "Download recitation" (that surah for the current reciter).

  Takes no props: `MushafView` renders one instance, and `HeaderLine` opens it through the exported controller,
  `surahInfo.show(surah, anchor, layout)`. It closes on Escape, an outside click, a page change, or when its header
  leaves the document (a page turn or a style swap).
-->
<script module lang="ts">
  import type { MushafLayout } from '$lib/ipc/bindings'

  /** A header click within this long after an outside-press close is the same gesture: it leaves the popover shut. */
  const TOGGLE_MS = 400

  /** The open surah info popover: which surah, anchored where, for which layout's page numbers. */
  class SurahInfoController {
    surah = $state(0)
    layout = $state<MushafLayout>('v2')
    anchor = $state.raw<HTMLElement | null>(null)
    open = $state(false)
    /** When and from which anchor it last closed: a click on the same header right after an outside-press close. */
    #closed = { at: 0, anchor: null as HTMLElement | null }

    /** Opens the popover for `surah` under `anchor` (a header line); a second click on the same header closes it. */
    show(surah: number, anchor: HTMLElement, layout: MushafLayout): void {
      const sameAnchor = this.anchor === anchor && this.surah === surah
      if (this.open && sameAnchor) {
        this.hide()
        return
      }
      // The popover closes itself on the press that starts this click (an outside press): that click toggles it shut.
      if (sameAnchor && this.#closed.anchor === anchor && performance.now() - this.#closed.at < TOGGLE_MS)
        return
      this.surah = surah
      this.layout = layout
      this.anchor = anchor
      this.open = true
    }

    hide(): void {
      if (!this.open) return
      this.open = false
      this.#closed = { at: performance.now(), anchor: this.anchor }
    }

    /** Back to closed and empty (tests, store resets). */
    reset(): void {
      this.open = false
      this.surah = 0
      this.anchor = null
      this.#closed = { at: 0, anchor: null }
    }
  }

  /** The single surah info popover's state, shared by every header line and the one popover instance. */
  export const surahInfo = new SurahInfoController()
</script>

<script lang="ts">
  import SuraName from '$components/index/SuraName.svelte'
  import { Button, Popover } from '$components/ui'
  import Check from '@lucide/svelte/icons/check'
  import Download from '@lucide/svelte/icons/download'
  import Play from '@lucide/svelte/icons/play'
  import { khatam } from '$lib/mushaf/ornaments'
  import { SURA_NAMES_FAMILY } from '$lib/mushaf/suraNames'
  import { app, fonts, i18n, packs, player, quran, reader, settings, ui } from '$lib/stores'

  const info = $derived(surahInfo.surah > 0 ? quran.surah(surahInfo.surah) : undefined)
  const range = $derived(quran.surahRange(surahInfo.surah))
  /** The page of the surah's first word and of its last word, in the layout of the header that opened it. */
  const pages = $derived.by(() => {
    if (!info) return null
    const layout = surahInfo.layout
    const nextFirstWord = quran.firstWordOf(range.to + 1)
    const from = quran.pageOfAyah(layout, range.from)
    const to =
      nextFirstWord > 0 ? quran.pageOfWord(layout, nextFirstWord - 1) : quran.pageCount(layout) || from
    return { from, to: Math.max(from, to) }
  })
  const juz = $derived(info ? { from: quran.juzOf(range.from), to: quran.juzOf(range.to) } : null)
  const reciter = $derived(player.reciters.find((r) => r.id === settings.value.reciterId) ?? null)
  const reciterName = $derived(reciter ? (i18n.locale === 'ar' ? reciter.name.ar : reciter.name.en) : '')
  const items = $derived(reciter ? packs.items.get(reciter.packId) : undefined)
  const item = $derived(items?.find((i) => i.item === surahInfo.surah))
  const downloaded = $derived(item?.pinned === true)
  const downloading = $derived(
    item?.queued === true ||
      (reciter !== null && packs.activeJobs.some((j) => j.packId === reciter.packId && j.phase !== 'paused')),
  )
  const canDownload = $derived(app.online && settings.value.networkAllowed && reciter !== null)
  /** The Arabic name in the decor calligraphy when installed (`qd-sura-names`), else Naskh text. */
  const glyphs = $derived(fonts.status.get(SURA_NAMES_FAMILY) === 'ready')
  const subtitle = $derived(info ? (i18n.locale === 'ar' ? info.nameSimple : info.nameEn) : '')

  // Load the reciter's per-surah state when the popover opens, so "Downloaded" is accurate.
  $effect(() => {
    if (!surahInfo.open || !reciter) return
    void packs.loadItems(reciter.packId).catch(() => {
      // The download button still works without the item state; the downloads view shows errors.
    })
  })

  // Close on a page change, and when the header that anchors the popover leaves the document.
  let openedOnPage = 0
  $effect(() => {
    const page = reader.page
    if (!surahInfo.open) {
      openedOnPage = page
      return
    }
    if (openedOnPage !== 0 && page !== openedOnPage) surahInfo.hide()
    openedOnPage = page
  })
  $effect(() => {
    const anchor = surahInfo.anchor
    if (!surahInfo.open || !anchor) return
    const check = () => {
      if (!anchor.isConnected) surahInfo.hide()
    }
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true })
    check()
    return () => observer.disconnect()
  })

  /** The whole surah, first ayah to last (inclusive), with the current reciter and the repeat/gap settings. */
  function play(): void {
    if (!info) return
    surahInfo.hide()
    player.playFrom({ ayahId: range.from }, { to: range.to }).catch((e: unknown) => ui.toastError(e))
  }

  function download(): void {
    if (!info || !reciter) return
    const surahName = quran.surahName(info.id)
    packs
      .install(reciter.packId, { type: 'items', data: { items: [info.id] } })
      .then(() =>
        ui.toast({
          message: i18n.t('furniture.surahInfo.downloadStarted', { surah: surahName, reciter: reciterName }),
        }),
      )
      .catch((e: unknown) => ui.toastError(e))
  }
</script>

<Popover
  open={surahInfo.open && info !== undefined}
  onOpenChange={(open) => {
    if (!open) surahInfo.hide()
  }}
  anchor={surahInfo.anchor}
  side="bottom"
  align="center"
  arrow
  width={328}
  padding="none"
  label={info ? i18n.t('furniture.surahInfo.label', { name: quran.surahName(info.id) }) : undefined}
  onCloseAutoFocus={(e) => e.preventDefault()}
>
  {#if info && pages && juz}
    <div class="si" dir={i18n.dir} data-surah={info.id}>
      <header class="si-head">
        <span class="si-badge" aria-hidden="true">
          <svg viewBox="0 0 36 36" focusable="false">
            <path d={khatam(18, 18, 16.5)} />
          </svg>
          <span class="si-num">{i18n.num(info.id)}</span>
        </span>
        <span class="si-names">
          <span class="si-title">{quran.surahName(info.id)}</span>
          {#if subtitle}
            <span class="si-subtitle" dir="auto">{subtitle}</span>
          {/if}
        </span>
        {#if i18n.locale !== 'ar'}
          {#if glyphs}
            <SuraName n={info.id} size={30} />
          {:else}
            <span class="si-arabic" lang="ar" dir="rtl">{info.nameAr}</span>
          {/if}
        {/if}
      </header>
      <dl class="si-facts">
        <div class="si-fact">
          <dt>{i18n.t('furniture.surahInfo.revealed')}</dt>
          <dd>
            {i18n.t(
              info.revelationPlace === 'makkah'
                ? 'furniture.surahInfo.meccan'
                : 'furniture.surahInfo.medinan',
            )}
            <span class="si-dim"
              >· {i18n.t('furniture.surahInfo.revelationOrder', { order: info.revelationOrder })}</span
            >
          </dd>
        </div>
        <div class="si-fact">
          <dt>{i18n.t('furniture.surahInfo.ayahs')}</dt>
          <dd>{i18n.num(info.ayahCount)}</dd>
        </div>
        <div class="si-fact">
          <dt>{i18n.t('furniture.surahInfo.pages')}</dt>
          <dd>
            {pages.from === pages.to
              ? i18n.num(pages.from)
              : i18n.t('furniture.surahInfo.range', { from: pages.from, to: pages.to })}
          </dd>
        </div>
        <div class="si-fact">
          <dt>{i18n.t('furniture.surahInfo.juz')}</dt>
          <dd>
            {juz.from === juz.to
              ? i18n.num(juz.from)
              : i18n.t('furniture.surahInfo.range', { from: juz.from, to: juz.to })}
          </dd>
        </div>
      </dl>
      <footer class="si-actions">
        <Button variant="primary" size="sm" onclick={play} disabled={!reciter}>
          {#snippet icon()}<Play size={16} strokeWidth={1.75} aria-hidden="true" />{/snippet}
          {i18n.t('furniture.surahInfo.play')}
        </Button>
        {#if downloaded}
          <Button variant="secondary" size="sm" disabled>
            {#snippet icon()}<Check size={16} strokeWidth={1.75} aria-hidden="true" />{/snippet}
            {i18n.t('furniture.surahInfo.downloaded')}
          </Button>
        {:else}
          <Button
            variant="secondary"
            size="sm"
            onclick={download}
            disabled={!canDownload || downloading}
            loading={downloading}
          >
            {#snippet icon()}<Download size={16} strokeWidth={1.75} aria-hidden="true" />{/snippet}
            {downloading ? i18n.t('furniture.surahInfo.downloading') : i18n.t('furniture.surahInfo.download')}
          </Button>
        {/if}
      </footer>
      {#if reciterName || !canDownload}
        <p class="si-note">
          {#if !canDownload && !downloaded && reciter}
            {i18n.t('furniture.surahInfo.offline')}
          {:else}
            {i18n.t('furniture.surahInfo.reciter', { reciter: reciterName })}
          {/if}
        </p>
      {/if}
    </div>
  {/if}
</Popover>

<style>
  .si {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    font-family: var(--font-ui);
  }

  .si-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .si-badge {
    position: relative;
    display: grid;
    place-items: center;
    flex: none;
    inline-size: 36px;
    block-size: 36px;
  }

  .si-badge svg {
    position: absolute;
    inset: 0;
    inline-size: 100%;
    block-size: 100%;
    fill: color-mix(in srgb, var(--frame-gold) 14%, transparent);
    stroke: var(--frame-gold);
    stroke-width: 1.25;
    stroke-linejoin: round;
  }

  .si-num {
    position: relative;
    color: var(--text);
    font-size: var(--text-xs);
    font-weight: var(--weight-title);
    font-variant-numeric: tabular-nums;
  }

  .si-names {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-inline-size: 0;
  }

  .si-title {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text);
    font-size: var(--text-lg);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .si-subtitle {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .si-arabic {
    flex: none;
    color: var(--text);
    font-family: var(--font-naskh);
    font-size: 22px;
    line-height: 1.2;
  }

  .si-facts {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-2) var(--space-4);
    margin: 0;
    padding-block: var(--space-3);
    border-block: 1px solid var(--border);
  }

  .si-fact {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }

  .si-fact:first-child {
    grid-column: 1 / -1;
  }

  .si-fact dt {
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: var(--weight-label);
    line-height: var(--leading-ui);
  }

  .si-fact dd {
    margin: 0;
    color: var(--text);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    line-height: var(--leading-ui);
  }

  .si-dim {
    color: var(--text-muted);
  }

  .si-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .si-note {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
  }
</style>
