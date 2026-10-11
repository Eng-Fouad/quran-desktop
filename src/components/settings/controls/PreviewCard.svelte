<!--
  PreviewCard (§9.7): the live preview of Settings › Appearance and › Mushaf. A slice of Mushaf page 1 (the surah
  header, the basmala and the first ayahs) in the current theme, accent, ink brightness and style (`MushafPage
  interactive={false}`, faded above and below), beside 1:2 in the first translation the reader shows, at the
  translation text size. Everything follows the settings as they change: the page and text use the same tokens as the
  reader. The caption names the theme on screen (what "Match system" resolved to) and the style.

  The page is drawn at a fixed `qfs`, so changing the interface size or the theme never re-fits it; a style change
  swaps its glyphs in place (RenditionStack's cross-fade). Without a selected translation the card says how to add one.

  The onboarding's Mushaf step reuses it (owner 2026-10-11) with a `style` and `ornaments` of its own (the choices
  before they are saved), a smaller `qfs` and its own `label`. While a newly chosen style's page loads, the card keeps
  the page it showed, so a style change cross-fades instead of flashing the skeleton.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import MushafPage from '$components/mushaf/MushafPage.svelte'
  import { Button, Skeleton } from '$components/ui'
  import SafeHtml from '$components/ui/SafeHtml.svelte'
  import type { MushafStyle, PageData } from '$lib/ipc/bindings'
  import { BLOCK_TOP, LH, OPENING_TOP_LINES, PW } from '$lib/mushaf/geometry'
  import { i18n, pages, quran, settings, translations } from '$lib/stores'
  import { settingsView } from '../view.svelte'

  interface Props {
    /** Show the translation column (Appearance); the Mushaf section shows the page alone, wider. */
    translation?: boolean
    /** The style to draw (default: the `mushafStyle` setting). */
    style?: MushafStyle
    /** Draw the decor ornaments (default: the `ornateHeaders` setting, `MushafPageProps.ornaments`). */
    ornaments?: boolean
    /** The page's font size (default 17: large enough to read the glyphs). */
    qfs?: number
    /** The figure's accessible name (default: "Preview"). */
    label?: string
  }

  let { translation = true, style: styleProp, ornaments, qfs = 17, label }: Props = $props()

  /** Al-Fatihah: the opening page, and 1:2 for the translation line. */
  const PAGE = 1
  const AYAH = 2
  /**
   * The window shows a slice of the page from just above its first line (the surah header of the opening page, §8.2)
   * through about six lines; the paper above and below fades out.
   */
  const sliceTop = $derived((BLOCK_TOP + OPENING_TOP_LINES * LH - 1.4) * qfs)
  const sliceHeight = $derived((1.4 + 6.5 * LH) * qfs)

  const style = $derived(styleProp ?? settings.value.mushafStyle)
  /** The page in the style, else (while a newly chosen style's page loads) the page shown last. */
  let shown = $state.raw<PageData | undefined>(undefined)
  const data = $derived(pages.get(style, PAGE) ?? shown)
  $effect(() => {
    const next = pages.get(style, PAGE)
    if (next) shown = next
  })
  let failed = $state(false)

  $effect(() => {
    const s = style
    untrack(() => {
      failed = false
      pages.ensure(s, [PAGE]).catch((e: unknown) => {
        failed = true
        console.warn('[qd] settings preview: page', e)
      })
    })
  })

  $effect(() => {
    if (!translation) return
    void settings.value.translations
    untrack(() => void translations.ensureWindow(AYAH, AYAH))
  })

  const packId = $derived(translations.activePacks[0] ?? null)
  const row = $derived(translations.row(AYAH))
  const text = $derived(packId === null ? undefined : row?.tr.find((t) => t.packId === packId))
  const packMeta = $derived(packId === null ? null : translations.packMeta(packId))

  const themeName = $derived(i18n.t(`settings.options.theme.${settings.resolvedTheme}`))
  const styleName = $derived(i18n.t(`settings.options.mushafStyle.${style}`))
  const caption = $derived(
    i18n.t('settings.preview.caption', { theme: themeName, style: styleName, sep: i18n.t('settings.sep') }),
  )
  const surah = $derived(quran.surahName(1))

  function chooseTranslation(): void {
    settingsView.open('translations', 'translations')
  }
</script>

<figure
  class={['preview', { solo: !translation }]}
  aria-label={label ?? i18n.t('settings.preview.label')}
  data-preview
>
  <div
    class="page-window"
    style:--_page-w="{PW * qfs}px"
    style:--_slice-top="{sliceTop}px"
    style:--_slice-h="{sliceHeight}px"
  >
    {#if data}
      <div class="page" aria-hidden="true">
        <MushafPage {data} {qfs} side="right" interactive={false} {ornaments} />
      </div>
    {:else if !failed}
      <div class="page-loading" aria-busy="true" aria-label={i18n.t('settings.preview.loading')}>
        <Skeleton h="100%" radius="sm" />
      </div>
    {/if}
  </div>
  {#if translation}
    <div class="reading">
      <p class="ref">
        <span class="surah">{surah}</span>
        <span class="key">{i18n.ref(1, AYAH)}</span>
      </p>
      {#if text && packMeta}
        <div
          class="translation"
          lang={packMeta.language ?? undefined}
          dir={packMeta.dir}
          style:--_pct={settings.value.translationFontPct / 100}
        >
          <SafeHtml html={text.html} />
        </div>
        <p class="translator">{translations.packTitle(text.packId)}</p>
      {:else if packId === null}
        <p class="missing">{i18n.t('settings.preview.translationMissing')}</p>
        <div>
          <Button size="sm" variant="secondary" onclick={chooseTranslation}>
            {i18n.t('settings.preview.chooseTranslation')}
          </Button>
        </div>
      {:else}
        <div class="lines" aria-hidden="true">
          <Skeleton h={12} w="92%" />
          <Skeleton h={12} w="70%" />
        </div>
      {/if}
      <p class="caption">{caption}</p>
    </div>
  {/if}
</figure>

<style>
  .preview {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    margin: 0;
    overflow: clip;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background-color: var(--surface-app);
    box-shadow: var(--shadow-1);
  }

  .preview.solo {
    grid-template-columns: minmax(0, 1fr);
  }

  /* A slice of the page on the app surface, as in the reader: its first lines, faded out above and below. */
  .page-window {
    position: relative;
    display: flex;
    justify-content: center;
    inline-size: calc(var(--_page-w) + 2 * var(--space-6));
    block-size: var(--_slice-h);
    padding-inline: var(--space-6);
    overflow: hidden;
    mask-image: linear-gradient(to bottom, transparent, black 14%, black 76%, transparent);
  }

  .solo .page-window {
    inline-size: 100%;
  }

  .page {
    flex: none;
    margin-block-start: calc(-1 * var(--_slice-top));
    pointer-events: none;
  }

  .page-loading {
    inline-size: var(--_page-w);
    block-size: 100%;
  }

  .reading {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-inline-size: 0;
    padding-block: var(--space-5);
    padding-inline: var(--space-5) var(--space-6);
    border-inline-start: 1px solid var(--border);
    background-color: var(--surface-raised);
  }

  .ref {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: var(--weight-label);
  }

  .key {
    color: var(--accent-text);
    font-variant-numeric: tabular-nums;
  }

  .translation {
    color: var(--text);
    font-size: calc(var(--text-reading) * var(--_pct, 1));
    line-height: var(--leading-reading);
    unicode-bidi: plaintext;
  }

  .translation:lang(ur) {
    font-family: var(--font-nastaliq);
    line-height: var(--leading-nastaliq);
  }

  .translation :global(sup) {
    color: var(--accent-text);
    font-size: 0.65em;
  }

  .translator {
    margin: 0;
    color: var(--text-muted);
    font-size: 11px;
  }

  .missing {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
  }

  .lines {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-block: var(--space-1);
  }

  .caption {
    margin-block-start: auto;
    padding-block-start: var(--space-3);
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: var(--weight-label);
  }

  @container settings-column (max-width: 640px) {
    .preview {
      grid-template-columns: minmax(0, 1fr);
    }

    .page-window {
      inline-size: 100%;
    }

    .reading {
      border-inline-start: 0;
      border-block-start: 1px solid var(--border);
    }
  }
</style>
