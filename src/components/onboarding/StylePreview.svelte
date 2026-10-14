<!--
  StylePreview (onboarding, the Mushaf step; owner 2026-10-11). What the Mushaf will look like:
  Settings' `PreviewCard` (a faded slice of page 1: Al-Fatihah's header and first lines, in the current theme) at qfs 14, drawn in the flow's effective style and with or without the ornaments as they are ticked,
  before anything is saved. Under it: the style and header names, the sentence about the style, and a status line.

  - Online it fetches what the reader would: the chosen print's page-1 font (RenditionStack, the interactive lane; the
    Hafs rendition shows until it is in) and, while "Ornate surah headers" is ticked, the ornaments (`decor`, once per
    run: `flow.requestOrnaments`). The starter set then lists them as already downloaded.
  - Offline (Work offline, or no connection) it shows Hafs, the plain headers unless the ornaments are already on this
    computer, and says the ornaments show once they download. Nothing is fetched.
  - The status line is a polite live region; muted while something downloads, the warning colour when the page stays
    in Hafs.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import PreviewCard from '$components/settings/controls/PreviewCard.svelte'
  import { PW } from '$lib/mushaf/geometry'
  import { fonts, i18n } from '$lib/stores'
  import { flow } from './flow.svelte'

  /** The preview's font size: the slice (≈ 294 × 179 px) fits beside the cards in the 720 × 540 dialog. */
  const QFS = 14

  const style = $derived(flow.effectiveStyle)
  const caption = $derived(
    i18n.t('onboarding.mushaf.preview.caption', {
      style: i18n.t(`onboarding.mushaf.styles.${style}.name`),
      headers: i18n.t(
        flow.ornaments ? 'onboarding.mushaf.preview.ornate' : 'onboarding.mushaf.preview.plain',
      ),
    }),
  )

  /** What the preview is waiting for, if anything: the page font, then the ornaments. */
  const status = $derived.by((): { text: string; warn: boolean } | null => {
    if (style !== 'hafs') {
      const state = fonts.state(style, 1)
      if (state === null || state === 'loading')
        return { text: i18n.t('onboarding.mushaf.preview.loading'), warn: false }
      if (state === 'failed' || state === 'unavailable')
        return { text: i18n.t('onboarding.mushaf.preview.fallback'), warn: true }
    }
    if (flow.ornaments && !fonts.decorReady) {
      return flow.ornamentsRequest === 'loading'
        ? { text: i18n.t('onboarding.mushaf.preview.ornamentsLoading'), warn: false }
        : { text: i18n.t('onboarding.mushaf.preview.ornamentsLater'), warn: false }
    }
    return null
  })

  // Ticked and online: bring the ornaments in for the preview (once; never offline).
  $effect(() => {
    if (flow.ornaments && flow.canDownload && !fonts.decor.installed)
      untrack(() => void flow.requestOrnaments())
  })
</script>

<div
  class="ob-preview"
  data-ob-preview
  data-style={style}
  data-ornaments={flow.ornaments ? 'on' : 'off'}
  style:--_page-w="{PW * QFS}px"
>
  <PreviewCard
    translation={false}
    {style}
    ornaments={flow.ornaments}
    qfs={QFS}
    label={i18n.t('onboarding.mushaf.preview.label')}
  />
  <p class="caption">{caption}</p>
  <p class="body">{i18n.t(`onboarding.mushaf.styles.${style}.body`)}</p>
  <p class={['status', { warn: status?.warn }]} role="status">{status?.text ?? ''}</p>
</div>

<style>
  /* The page slice and the card's side padding (PreviewCard's `--space-6`) and border: the card's natural width. */
  .ob-preview {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    inline-size: calc(var(--_page-w) + 2 * var(--space-6) + 2px);
  }

  .caption {
    margin: 0;
    margin-block-start: var(--space-1);
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    line-height: var(--leading-ui);
  }

  .body,
  .status {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
  }

  /* One line kept for the status, so the step never shifts when it appears or clears. */
  .status {
    min-block-size: calc(var(--text-xs) * var(--leading-ui));
  }

  .status.warn {
    color: var(--warning-text);
  }
</style>
