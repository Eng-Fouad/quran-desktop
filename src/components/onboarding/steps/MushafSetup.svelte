<!--
  MushafSetup (onboarding step 2; owner 2026-10-11). The Mushaf, chosen while seeing it:

  - **Style cards** (one radio group, stacked at the inline start): Hafs (included, offline), the Madani print of
    1421 AH (QCF V2; pages download as you read; a first run preselects it) and Tajweed (QCF V4, ≈ 48.5 MB on demand).
    Each card names its style and where its fonts stand; the sentence about the style is read with the card
    (`aria-describedby`) and shown under the preview. Without network use the two QCF cards are disabled with "Needs
    download — available when you're online" and the style stays Hafs; a Tajweed card this webview cannot draw (the
    COLR probe failed) says so and cannot be chosen.
  - **Options** under the cards: "Ornate surah headers · 325 kB" (the `decor` pack, ticked by default, for every style;
    the `ornateHeaders` setting) and, for a QCF style, "Download all pages in the background (93.2 MB)" (off).
  - **Live preview** at the inline end (`StylePreview`): page 1 in the chosen style, with or without the ornaments.
  Sizes come from the catalogue (`PackInfo.sizeKib`), in the UI language's units and digits.
-->
<script lang="ts">
  import Ban from '@lucide/svelte/icons/ban'
  import Check from '@lucide/svelte/icons/check'
  import CloudOff from '@lucide/svelte/icons/cloud-off'
  import { Badge } from '$components/ui'
  import type { PackInfo } from '$lib/ipc/bindings'
  import { fonts, i18n, packs } from '$lib/stores'
  import { mushafPackId } from '$lib/stores/packs.svelte'
  import { flow, STYLE_CHOICES, type StyleChoice, styleUnsupported } from '../flow.svelte'
  import OptionCheck from '../OptionCheck.svelte'
  import StepHeader from '../StepHeader.svelte'
  import StylePreview from '../StylePreview.svelte'

  const decor = $derived(packs.pack('decor'))
  const effective = $derived(flow.effectiveStyle)

  function pageFonts(style: StyleChoice): PackInfo | undefined {
    const id = mushafPackId(style)
    return id === null ? undefined : packs.pack(id)
  }

  function size(p: PackInfo | undefined): string {
    return p ? i18n.bytes(p.sizeKib) : ''
  }

  function meta(style: StyleChoice): string {
    if (style === 'qcf_v4')
      return i18n.t('onboarding.mushaf.styles.qcf_v4.meta', { size: size(pageFonts(style)) })
    return i18n.t(`onboarding.mushaf.styles.${style}.meta`)
  }

  /** Why a card cannot be chosen: nothing can download (QCF), or Tajweed this webview cannot draw; `null` if it can be. */
  function lockReason(style: StyleChoice): 'offline' | 'unsupported' | null {
    if (style !== 'hafs' && !flow.canDownload) return 'offline'
    if (styleUnsupported(style)) return 'unsupported'
    return null
  }

  // --- radio group ---------------------------------------------------------------------------------------------------

  let group: HTMLElement | null = $state(null)

  function onkeydown(e: KeyboardEvent): void {
    const enabled = STYLE_CHOICES.filter((s) => lockReason(s) === null)
    const i = enabled.indexOf(effective)
    const last = enabled.length - 1
    const forward = i18n.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight'
    const backward = i18n.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft'
    let next: number
    if (e.key === forward || e.key === 'ArrowDown') next = i >= last ? 0 : i + 1
    else if (e.key === backward || e.key === 'ArrowUp') next = i <= 0 ? last : i - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    else return
    e.preventDefault()
    const style = enabled[next]
    if (!style) return
    flow.setStyle(style)
    group?.querySelector<HTMLElement>(`[data-style-choice="${style}"]`)?.focus()
  }
</script>

<div class="mushaf">
  <StepHeader title={i18n.t('onboarding.mushaf.title')} lede={i18n.t('onboarding.mushaf.lede')} />

  <div class="layout">
    <div class="choices">
      <div
        class="styles"
        role="radiogroup"
        aria-label={i18n.t('onboarding.mushaf.label')}
        tabindex="-1"
        bind:this={group}
        {onkeydown}
      >
        {#each STYLE_CHOICES as style (style)}
          {@const on = effective === style}
          {@const reason = lockReason(style)}
          <button
            type="button"
            role="radio"
            class={['style', { on, locked: reason !== null }]}
            aria-checked={on}
            aria-disabled={reason !== null || undefined}
            aria-describedby="ob-style-{style}-body"
            tabindex={on ? 0 : -1}
            data-style-choice={style}
            onclick={() => flow.setStyle(style)}
          >
            <span class="head">
              <span class="name">{i18n.t(`onboarding.mushaf.styles.${style}.name`)}</span>
              {#if style === 'hafs'}
                <Badge tone="success" size="sm">{i18n.t('onboarding.mushaf.included')}</Badge>
              {/if}
              <span class="mark" aria-hidden="true"><Check size={12} strokeWidth={2.75} /></span>
            </span>
            <span class="sr-only" id="ob-style-{style}-body"
              >{i18n.t(`onboarding.mushaf.styles.${style}.body`)}</span
            >
            {#if reason === 'offline'}
              <span class="meta locked-reason"
                ><CloudOff size={14} strokeWidth={1.75} aria-hidden="true" /><span
                  >{i18n.t('onboarding.mushaf.needsDownload')}</span
                ></span
              >
            {:else if reason === 'unsupported'}
              <span class="meta locked-reason"
                ><Ban size={14} strokeWidth={1.75} aria-hidden="true" /><span
                  >{i18n.t('onboarding.mushaf.unsupported')}</span
                ></span
              >
            {:else}
              <span class="meta">{meta(style)}</span>
            {/if}
          </button>
        {/each}
      </div>
      <!-- The options: the ornament fonts for every style; every page in the background for a QCF style. -->
      <div class="options">
        <OptionCheck
          option="ornaments"
          checked={flow.ornaments}
          onchange={(v) => flow.setOrnaments(v)}
          label={fonts.decor.installed
            ? i18n.t('onboarding.mushaf.ornamentsReady')
            : i18n.t('onboarding.mushaf.ornaments', { size: size(decor) })}
        />
        {#if effective !== 'hafs'}
          <OptionCheck
            option="all-pages"
            checked={flow.allPages}
            onchange={(v) => flow.setAllPages(effective, v)}
            label={i18n.t('onboarding.mushaf.allPages', { size: size(pageFonts(effective)) })}
          />
        {/if}
      </div>
    </div>
    <StylePreview />
  </div>
</div>

<style>
  .mushaf {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  /* The cards and options at the inline start, the preview at its natural width at the end. */
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: var(--space-4);
  }

  .choices {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-inline-size: 0;
  }

  /* --- style cards ------------------------------------------------------------------------------------------------- */

  .styles {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    outline: none;
  }

  .style {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
    padding-block: var(--space-2);
    padding-inline: var(--space-3);
    border: 0;
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-1);
    color: var(--text);
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition: box-shadow var(--dur-quick) var(--ease-standard);
  }

  .style:hover:not(.locked, .on) {
    box-shadow: var(--shadow-2);
  }

  .style.on {
    box-shadow:
      0 0 0 2px var(--accent),
      var(--shadow-2);
  }

  .style.locked {
    cursor: not-allowed;
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .name {
    flex: 0 1 auto;
    min-inline-size: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .on .name {
    color: var(--accent-text);
  }

  .locked .name {
    color: var(--text-faint);
  }

  .mark {
    display: grid;
    flex: none;
    place-items: center;
    inline-size: 18px;
    block-size: 18px;
    margin-inline-start: auto;
    border: 1px solid var(--border-input);
    border-radius: var(--radius-full);
    color: transparent;
    transition:
      background-color var(--dur-quick) var(--ease-standard),
      border-color var(--dur-quick) var(--ease-standard);
  }

  .on .mark {
    border-color: var(--accent);
    background-color: var(--accent);
    color: var(--accent-ink);
  }

  .locked .mark {
    border-color: var(--text-faint);
    opacity: 0.6;
  }

  .meta {
    display: flex;
    align-items: flex-start;
    gap: var(--space-1);
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: var(--weight-label);
    line-height: var(--leading-ui);
  }

  .meta.locked-reason {
    color: var(--warning-text);
  }

  .meta.locked-reason :global(svg) {
    flex: none;
    margin-block-start: 2px;
  }

  .options {
    display: flex;
    flex-direction: column;
    padding-inline: var(--space-1);
  }

  @media (forced-colors: active) {
    .style {
      border: 1px solid CanvasText;
    }

    .style.locked {
      border-color: GrayText;
    }

    .style.on {
      outline: 3px solid Highlight;
      outline-offset: 1px;
    }
  }
</style>
