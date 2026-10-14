<!--
  ReadingSetup (onboarding step 3, "Translation and recitation"). The Mushaf has its own step since the owner's
  2026-10-11 request (`MushafSetup`).

  - **Translation**: every translation, plus whole-pack tafsir, grouped by language with the UI language first;
    preselected from the UI language (en → Saheeh International, ar → Al-Muyassar).
  - **Reciter** (default Mishary Alafasy) with a preview of Al-Fatihah 1:1 (online only), and the streaming note.
  Sizes come from the catalogue (`PackInfo.sizeKib`), in the UI language's units and digits.
-->
<script lang="ts">
  import Play from '@lucide/svelte/icons/play'
  import Radio from '@lucide/svelte/icons/radio'
  import Square from '@lucide/svelte/icons/square'
  import { Button, Select, type SelectItem } from '$components/ui'
  import type { PackInfo } from '$lib/ipc/bindings'
  import { i18n, packs, player } from '$lib/stores'
  import { languageOf, reciterIdOf } from '$lib/stores/packs.svelte'
  import { flow } from '../flow.svelte'
  import { languageName } from '../format'
  import StepHeader from '../StepHeader.svelte'

  /** The Select value of "No translation" (pack ids never start with an underscore). */
  const NONE = '_none'

  function size(p: PackInfo | undefined): string {
    return p ? i18n.bytes(p.sizeKib) : ''
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
</script>

<div class="reading">
  <StepHeader title={i18n.t('onboarding.reading.title')} lede={i18n.t('onboarding.reading.lede')} />

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
</style>
