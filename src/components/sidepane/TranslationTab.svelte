<!--
  TranslationTab: the subject's Arabic text and its translations in the reader's pack order.

  - Each ayah: the Arabic in qd-hafs (`.quran-text`, when `translationArabic` is on), then one block per active
    translation (`TranslationBlock`: translator label, the pack's language and direction, footnotes as
    popovers or inline per `footnotesInline`). Reading text is 16 px, scaled by `translationFontPct`.
  - A range lists each ayah under its reference (up to `MAX_SPAN`, then says how many were left out).
  - Text and translations come from the `translations` store (`ensureWindow`, shared with translation mode), so
    nothing is fetched twice; loading shows skeleton lines, a failure an inline Retry (plain text: one polite status
    for the tab says it, never an alert per ayah and pack).
  - With no translation to show, the "Add a translation" card (missing selected packs first, then installed
    ones, then the best matches for the UI language); selected packs that cannot be shown get a `PackNotice`.
  - A reference in a translation or a footnote turns the page there (flash); the pane stays.
-->
<script lang="ts">
  import KeyBadge from '$components/translation/KeyBadge.svelte'
  import PackNotice from '$components/translation/PackNotice.svelte'
  import TranslationBlock from '$components/translation/TranslationBlock.svelte'
  import { Button, Skeleton } from '$components/ui'
  import { app, i18n, packs, quran, settings, translations, ui } from '$lib/stores'
  import { MAX_PACKS } from '$lib/stores/translations.svelte'
  import PackPicker from './PackPicker.svelte'
  import { goToRef, listedAyahs, MAX_SPAN, type Subject } from './pane.svelte'
  import { translationRows, type PickRow } from './picker'
  import TabBody from './TabBody.svelte'
  import { bindEndMark } from '$lib/text/endmark'

  interface Props {
    subject: Subject
  }

  let { subject }: Props = $props()

  const ayahs = $derived(listedAyahs(subject))
  const total = $derived(subject.to - subject.from + 1)
  const showArabic = $derived(settings.value.translationArabic)
  const inline = $derived(settings.value.footnotesInline)
  const nastaliq = $derived(translations.packMeta('decor.nastaliq').availability === 'installed')
  const scale = $derived(settings.value.translationFontPct / 100)
  const active = $derived(
    translations.activePacks.map((id) => ({
      meta: translations.packMeta(id),
      title: translations.packTitle(id),
    })),
  )
  const empty = $derived(translations.activePacks.length === 0)
  const osLanguage = $derived((app.info.osLocale ?? '').toLowerCase().split(/[-_]/)[0] ?? '')
  const rows = $derived(
    translationRows(translations.missingPacks, translations.translationCatalog, translations.selectedPacks, {
      uiLanguage: i18n.locale,
      osLanguage,
    }),
  )
  const busy = $derived(ayahs.some((id) => translations.state(id).text === 'loading'))
  /** Some listed ayah failed to load: said once, politely, for the tab (each row shows its own Retry, silently). */
  const failed = $derived(
    ayahs.some((id) => {
      const st = translations.state(id)
      return st.text === 'error' || st.tr === 'error'
    }),
  )

  // Load what is missing. Only ayahs nobody asked for yet: a block in flight answers by itself, and a failed one is
  // retried from its Retry button (or by the store after a pause).
  $effect(() => {
    const ids = ayahs
    const first = ids[0]
    const last = ids.at(-1)
    if (empty || first === undefined || last === undefined) return
    const idle = ids.some((id) => {
      const st = translations.state(id)
      return st.text === 'idle' || st.tr === 'idle'
    })
    // A side load: the feed's remembered window stays the one a pack or layout change reloads.
    if (idle) void translations.ensureWindow(first, last, { remember: false })
  })

  // The catalogue behind the "Add a translation" card (sizes, recommendations).
  $effect(() => {
    if (empty) void translations.loadCatalog()
  })

  function lines(ayahId: number): { arabic: number; tr: number } {
    const words = Math.max(1, quran.firstWordOf(ayahId + 1) - quran.firstWordOf(ayahId) - 1)
    return {
      arabic: Math.min(6, Math.max(1, Math.ceil(words / 6))),
      tr: Math.min(8, Math.max(2, Math.ceil((words * 1.7) / 8))),
    }
  }

  async function pick(row: PickRow): Promise<void> {
    const selected = translations.selectedPacks
    if (!selected.includes(row.meta.id)) {
      await settings.update({ translations: [...selected, row.meta.id].slice(0, MAX_PACKS) })
    }
    if (row.action === 'install') await packs.install(row.meta.id).catch((e: unknown) => ui.toastError(e))
  }
</script>

<TabBody resetKey="{subject.from}-{subject.to}" {busy}>
  {#if empty}
    <PackPicker
      kind="translation"
      title={i18n.t('sidepane.translation.pickTitle')}
      body={i18n.t('sidepane.translation.pickBody')}
      offlineBody={i18n.t('sidepane.translation.pickOffline')}
      label={i18n.t('sidepane.translation.pickLabel')}
      {rows}
      onpick={(row) => void pick(row)}
    />
  {:else}
    <div class="notices"><PackNotice /></div>
    <p class="sr-only" role="status">{failed ? i18n.t('sidepane.translation.error') : ''}</p>
    <div class="ayahs" style:--tv-scale={scale}>
      {#each ayahs as ayahId (ayahId)}
        {@const row = translations.row(ayahId)}
        {@const load = translations.state(ayahId)}
        {@const ref = quran.ayahRef(ayahId)}
        {@const items = new Map((row?.tr ?? []).map((t) => [t.packId, t] as const))}
        {@const size = lines(ayahId)}
        <article
          class="ayah"
          data-ayah={ayahId}
          aria-label={i18n.t('sidepane.header.title', {
            surah: quran.surahName(ref.surah),
            ref: i18n.ref(ref.surah, ref.ayah),
          })}
        >
          {#if ayahs.length > 1}
            <header class="key"><KeyBadge surah={ref.surah} ayah={ref.ayah} /></header>
          {/if}

          {#if showArabic}
            {#if row}
              <p class="arabic quran-text" lang="ar" dir="rtl">{bindEndMark(row.ayah.textHafs)}</p>
            {:else if load.text === 'error'}
              <p class="error">
                {i18n.t('sidepane.translation.textError')}
                <Button size="sm" variant="link" onclick={() => void translations.retry(ayahId)}
                  >{i18n.t('common.retry')}</Button
                >
              </p>
            {:else}
              <div class="skeleton arabic-skeleton" dir="rtl" aria-hidden="true">
                {#each { length: size.arabic }, i (i)}
                  <Skeleton
                    h={18}
                    w={i === size.arabic - 1 && size.arabic > 1 ? '60%' : '100%'}
                    radius="sm"
                  />
                {/each}
              </div>
            {/if}
          {/if}

          {#each active as { meta, title } (meta.id)}
            {@const item = items.get(meta.id)}
            {#if item}
              <TranslationBlock {item} {meta} {title} {inline} {nastaliq} onref={goToRef} />
            {:else if load.tr === 'error'}
              <p class="error">
                {i18n.t('sidepane.translation.error')}
                <Button size="sm" variant="link" onclick={() => void translations.retry(ayahId)}
                  >{i18n.t('common.retry')}</Button
                >
              </p>
            {:else if row && load.tr === 'ready'}
              <!-- The pack has no text for this ayah (rare in QuranEnc exports): nothing to show. -->
            {:else}
              <div class="skeleton tr-skeleton" dir={meta.dir} aria-hidden="true">
                <Skeleton h={9} w={110} radius="xs" />
                {#each { length: size.tr }, i (i)}
                  <Skeleton h={12} w={i === size.tr - 1 ? '58%' : '100%'} radius="xs" />
                {/each}
              </div>
            {/if}
          {/each}
        </article>
      {/each}
    </div>
    {#if total > ayahs.length}
      <p class="truncated">
        {i18n.tp('sidepane.truncated', total, { shown: i18n.num(MAX_SPAN) })}
      </p>
    {/if}
  {/if}
</TabBody>

<style>
  .notices:empty {
    display: none;
  }

  .notices {
    margin-block-end: var(--space-4);
  }

  /* The pane reads at 16 px, scaled like translation mode by `translationFontPct`. */
  .ayahs {
    --text-reading: 16px;
    display: flex;
    flex-direction: column;
  }

  .ayah {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding-block: var(--space-4);
  }

  .ayah:first-child {
    padding-block-start: 0;
  }

  .ayah + .ayah {
    border-block-start: 1px solid var(--border);
  }

  .key {
    display: flex;
    align-items: center;
  }

  /* qd-hafs at 24 px (×translationFontPct); its tall line box is pulled in a little so the text reads as one block. */
  .arabic {
    margin-block: -0.2em -0.1em;
    margin-inline: 0;
    color: var(--ink);
    font-family: var(--font-quran);
    font-size: calc(24px * var(--tv-scale, 1));
    line-height: 2.1;
    text-align: start;
    overflow-wrap: break-word;
  }

  .skeleton {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .arabic-skeleton {
    gap: calc(50px * var(--tv-scale, 1) - 18px);
    padding-block: calc(14px * var(--tv-scale, 1));
  }

  .tr-skeleton {
    gap: calc(27px * var(--tv-scale, 1) - 12px);
    padding-block-start: 3px;
  }

  .error {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    color: var(--danger-text);
    font-size: var(--text-sm);
  }

  .truncated {
    margin-block: var(--space-2) 0;
    padding-block-start: var(--space-3);
    border-block-start: 1px solid var(--border);
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-align: center;
  }
</style>
