<!--
  ReadingSetup (§9.7 onboarding step 2). Owner: WP12c.

  - **Mushaf style cards** (one radio group): Hafs (included, offline), the 1421 AH print (QCF V2; pages download as
    you read) and Tajweed (QCF V4, ≈ 48.5 MB on demand). Under the cards, the chosen style's option: "Ornate surah
    headers · 0.3 MB" (the `decor` pack, ticked) for Hafs, "Download all pages in the background (93.2 MB)" (off)
    for a QCF style. Without network use the two QCF cards are disabled with "Needs download — available when you're
    online" and the style stays Hafs.
  - **Translation**: every translation, plus whole-pack tafsir, grouped by language with the UI language first;
    preselected from the UI language (en → Saheeh International, ar → Al-Muyassar).
  - **Reciter** (default Mishary Alafasy) with a preview of Al-Fatihah 1:1 (online only), and the streaming note.
  Sizes come from the catalogue (`PackInfo.sizeKib`), in the UI language's units and digits.
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import CloudOff from '@lucide/svelte/icons/cloud-off'
  import Play from '@lucide/svelte/icons/play'
  import Radio from '@lucide/svelte/icons/radio'
  import Square from '@lucide/svelte/icons/square'
  import { Badge, Button, Select, type SelectItem } from '$components/ui'
  import type { PackInfo } from '$lib/ipc/bindings'
  import { i18n, packs, player } from '$lib/stores'
  import { languageOf, mushafPackId, reciterIdOf } from '$lib/stores/packs.svelte'
  import { flow, STYLE_CHOICES, type StyleChoice } from '../flow.svelte'
  import { languageName } from '../format'
  import OptionCheck from '../OptionCheck.svelte'
  import StepHeader from '../StepHeader.svelte'

  /** The Select value of "No translation" (pack ids never start with an underscore). */
  const NONE = '_none'

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
      return i18n.t('onboarding.reading.styles.qcf_v4.meta', { size: size(pageFonts(style)) })
    return i18n.t(`onboarding.reading.styles.${style}.meta`)
  }

  // --- translation ---------------------------------------------------------------------------------------------------

  const translationItems: SelectItem[] = $derived.by(() => {
    const candidates = packs.list.filter(
      (p) => p.kind === 'translation' || (p.kind === 'tafsir' && p.installMode === 'whole'),
    )
    const order = new Map(packs.list.map((p, i) => [p.id, i] as const))
    const key = (p: PackInfo) => {
      const lang = languageOf(p)
      return lang === i18n.locale ? '' : `1${languageName(lang, i18n.locale)}`
    }
    const sorted = [...candidates].sort(
      (a, b) =>
        key(a).localeCompare(key(b), i18n.locale) ||
        Number(a.kind === 'tafsir') - Number(b.kind === 'tafsir') ||
        (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    )
    const items: SelectItem[] = [{ value: NONE, label: i18n.t('onboarding.reading.noTranslation') }]
    for (const p of sorted) {
      items.push({
        value: p.id,
        label: packs.title(p),
        hint: p.kind === 'tafsir' ? `${i18n.t('onboarding.reading.tafsir')} · ${size(p)}` : size(p),
        group: languageName(languageOf(p), i18n.locale),
      })
    }
    return items
  })

  // --- reciter -------------------------------------------------------------------------------------------------------

  const reciterItems: SelectItem[] = $derived.by(() => {
    if (player.reciters.length > 0) {
      return player.reciters.map((r) => ({
        value: String(r.id),
        label: r.name[i18n.locale] || r.name.en,
        hint: r.style ? r.style[i18n.locale] || r.style.en : undefined,
      }))
    }
    return packs.list
      .filter((p) => p.kind === 'recitation')
      .map((p) => ({ value: String(reciterIdOf(p.id) ?? 0), label: packs.title(p) }))
  })
  const reciterName = $derived(reciterItems.find((r) => r.value === String(flow.reciterId))?.label ?? '')
  const previewing = $derived(flow.previewing !== null)

  // --- radio group ---------------------------------------------------------------------------------------------------

  let group: HTMLElement | null = $state(null)

  function onkeydown(e: KeyboardEvent): void {
    const enabled = STYLE_CHOICES.filter((s) => s === 'hafs' || flow.canDownload)
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

<div class="reading">
  <StepHeader title={i18n.t('onboarding.reading.title')} lede={i18n.t('onboarding.reading.lede')} />

  <section class="block" aria-labelledby="ob-mushaf">
    <h3 class="label" id="ob-mushaf">{i18n.t('onboarding.reading.mushaf')}</h3>
    <div
      class="styles"
      role="radiogroup"
      aria-labelledby="ob-mushaf"
      tabindex="-1"
      bind:this={group}
      {onkeydown}
    >
      {#each STYLE_CHOICES as style (style)}
        {@const on = effective === style}
        {@const locked = style !== 'hafs' && !flow.canDownload}
        <button
          type="button"
          role="radio"
          class={['style', { on, locked }]}
          aria-checked={on}
          aria-disabled={locked || undefined}
          aria-describedby="ob-style-{style}-body"
          tabindex={on ? 0 : -1}
          data-style-choice={style}
          onclick={() => flow.setStyle(style)}
        >
          <span class="head">
            <span class="name">{i18n.t(`onboarding.reading.styles.${style}.name`)}</span>
            {#if style === 'hafs'}
              <Badge tone="success" size="sm">{i18n.t('onboarding.reading.included')}</Badge>
            {/if}
            <span class="mark" aria-hidden="true"><Check size={12} strokeWidth={2.75} /></span>
          </span>
          <span class="body" id="ob-style-{style}-body"
            >{i18n.t(`onboarding.reading.styles.${style}.body`)}</span
          >
          {#if locked}
            <span class="meta offline"
              ><CloudOff size={14} strokeWidth={1.75} aria-hidden="true" /><span
                >{i18n.t('onboarding.reading.needsDownload')}</span
              ></span
            >
          {:else}
            <span class="meta">{meta(style)}</span>
          {/if}
        </button>
      {/each}
    </div>
    <!-- The chosen style's option (§9.7): the ornament fonts for Hafs, every page in the background for QCF. -->
    <div class="option">
      {#if effective === 'hafs'}
        <OptionCheck
          option="ornaments"
          checked={flow.ornaments}
          onchange={(v) => (flow.ornaments = v)}
          label={i18n.t('onboarding.reading.ornaments', { size: size(decor) })}
        />
      {:else}
        <OptionCheck
          option="all-pages"
          checked={flow.allPages}
          onchange={(v) => flow.setAllPages(effective, v)}
          label={i18n.t('onboarding.reading.allPages', { size: size(pageFonts(effective)) })}
        />
      {/if}
    </div>
  </section>

  <div class="pickers">
    <section class="block" aria-labelledby="ob-translation">
      <h3 class="label" id="ob-translation">{i18n.t('onboarding.reading.translation')}</h3>
      <Select
        items={translationItems}
        value={flow.translationId ?? NONE}
        onValueChange={(v) => (flow.translation = v === NONE ? null : v)}
        aria-labelledby="ob-translation"
        fullWidth
        class="ob-translation"
      />
    </section>
    <section class="block" aria-labelledby="ob-reciter">
      <h3 class="label" id="ob-reciter">{i18n.t('onboarding.reading.reciter')}</h3>
      <div class="reciter">
        <Select
          items={reciterItems}
          value={String(flow.reciterId)}
          onValueChange={(v) => flow.setReciter(Number(v))}
          aria-labelledby="ob-reciter"
          fullWidth
          class="ob-reciter"
        />
        <Button
          variant="secondary"
          disabled={!flow.canPreview && !previewing}
          loading={flow.previewStarting}
          aria-label={previewing
            ? i18n.t('onboarding.reading.stopPreview')
            : i18n.t('onboarding.reading.previewLabel', { reciter: reciterName })}
          aria-pressed={previewing}
          title={flow.canPreview ? undefined : i18n.t('onboarding.reading.previewOffline')}
          data-action="preview"
          onclick={() => void flow.togglePreview()}
        >
          {#snippet icon()}
            {#if previewing}<Square
                size={14}
                strokeWidth={2}
                fill="currentColor"
                aria-hidden="true"
              />{:else}<Play size={16} strokeWidth={2} aria-hidden="true" />{/if}
          {/snippet}
          {previewing ? i18n.t('onboarding.reading.stopPreview') : i18n.t('onboarding.reading.preview')}
        </Button>
      </div>
      <p class="note">
        <Radio size={14} strokeWidth={1.75} aria-hidden="true" />
        <span>{i18n.t('onboarding.reading.streams')}</span>
      </p>
    </section>
  </div>
</div>

<style>
  .reading {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-inline-size: 0;
  }

  .label {
    margin: 0;
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-title);
  }

  /* --- style cards ------------------------------------------------------------------------------------------------- */

  .styles {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-3);
    outline: none;
  }

  .style {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-inline-size: 0;
    padding: var(--space-3);
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

  .locked .name,
  .locked .body {
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

  .body {
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
  }

  .meta {
    display: flex;
    align-items: flex-start;
    gap: var(--space-1);
    margin-block-start: auto;
    padding-block-start: var(--space-1);
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: var(--weight-label);
    line-height: var(--leading-ui);
  }

  .meta.offline {
    color: var(--warning-text);
  }

  .meta.offline :global(svg) {
    flex: none;
    margin-block-start: 2px;
  }

  .option {
    padding-inline: var(--space-1);
  }

  /* --- translation and reciter ------------------------------------------------------------------------------------ */

  .pickers {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-4);
  }

  .reciter {
    display: flex;
    gap: var(--space-2);
  }

  .reciter :global(.ob-reciter) {
    flex: 1 1 auto;
    min-inline-size: 0;
  }

  .note {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
  }

  .note :global(svg) {
    flex: none;
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
