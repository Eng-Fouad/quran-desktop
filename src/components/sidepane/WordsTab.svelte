<!--
  WordsTab (§9.7, §9.8): word by word for the pane's subject, from `settings.wbwPackId` (the pack the word tooltip
  uses, so both share one cache). Owner: WP11b.

  - A grid of cards in reading order (right to left in every UI language): the word in qd-hafs 24 px
    (`.quran-text`), its meaning in the pack's language, and its transliteration (italic, when
    `wbwShowTransliteration`). End markers have no card.
  - Clicking a card shows the word on the page with the search-hit layer (`reader.goToAyah(…, { highlightWords })`,
    turning the page when needed); clicking it again clears it. The word being recited is tinted.
  - A range groups its words by ayah (up to `MAX_SPAN` ayahs).
  - Toolbar: the word-by-word language and the transliteration switch (both are settings).
  - States (§9.8): no pack → the word-by-word card (the UI language first); loading → skeleton cards; offline and the
    chapter not cached → "Word-by-word meanings need a connection for Al-Kahf" [Retry] (retried when online).
-->
<script lang="ts">
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import CloudOff from '@lucide/svelte/icons/cloud-off'
  import { untrack } from 'svelte'
  import KeyBadge from '$components/translation/KeyBadge.svelte'
  import { Button, Select, Skeleton, Switch } from '$components/ui'
  import type { SelectItem } from '$components/ui'
  import { toIpcError, type IpcError } from '$lib/ipc'
  import type { WbwEntry } from '$lib/ipc/bindings'
  import { app, i18n, packs, player, quran, reader, settings, translations } from '$lib/stores'
  import PackPicker from './PackPicker.svelte'
  import PaneMessage from './PaneMessage.svelte'
  import { languageName, listedAyahs, MAX_SPAN, wordSpanOf, type Subject } from './pane.svelte'
  import { packRows, type PickRow } from './picker'
  import TabBody from './TabBody.svelte'

  interface Props {
    subject: Subject
  }

  let { subject }: Props = $props()

  const packId = $derived(settings.value.wbwPackId)
  const meta = $derived(packId === null ? null : translations.packMeta(packId))
  const ayahs = $derived(listedAyahs(subject))
  const spans = $derived(
    ayahs.flatMap((ayahId) => {
      const span = wordSpanOf(ayahId)
      return span ? [{ ayahId, ...span }] : []
    }),
  )
  const range = $derived.by(() => {
    const first = spans[0]
    const last = spans.at(-1)
    return first && last ? { from: first.first, to: last.last } : null
  })
  const key = $derived(packId === null || range === null ? '' : `${packId}|${range.from}-${range.to}`)
  const translit = $derived(settings.value.wbwShowTransliteration)

  /**
   * The entries straight from the store's cache when it holds every word of the range (a revisit renders at once);
   * `null` when something is missing.
   */
  const cached = $derived.by((): Readonly<Record<number, WbwEntry>> | null => {
    void translations.version
    if (packId === null || translations.wbwPackId !== packId) return null
    const out: Record<number, WbwEntry> = {}
    for (const s of spans) {
      for (let w = s.first; w <= s.last; w++) {
        const entry = translations.wbw.get(w)
        if (!entry) return null
        out[w] = entry
      }
    }
    return out
  })

  /** The answer of the last request: its key, the entries by word id, or the failure. */
  let loaded = $state.raw<{
    key: string
    entries: Readonly<Record<number, WbwEntry>> | null
    error: IpcError | null
  }>({
    key: '',
    entries: null,
    error: null,
  })
  let attempt = $state(0)

  const entries = $derived(cached ?? (loaded.key === key ? loaded.entries : null))
  const failure = $derived(cached === null && loaded.key === key ? loaded.error : null)
  const loading = $derived(key !== '' && entries === null && failure === null)

  $effect(() => {
    const k = key
    const id = packId
    const r = range
    void attempt
    if (k === '' || id === null || r === null || cached !== null) return
    let current = true
    translations.wbwForRange(id, r.from, r.to).then(
      (list) => {
        if (current) {
          loaded = { key: k, entries: Object.fromEntries(list.map((e) => [e.wordId, e])), error: null }
        }
      },
      (e: unknown) => {
        if (current) loaded = { key: k, entries: null, error: toIpcError(e) }
      },
    )
    return () => {
      current = false
    }
  })

  /** Asks again (Retry, or back online), showing the loading state meanwhile. */
  function retry(): void {
    loaded = { key: '', entries: null, error: null }
    attempt++
  }

  // Back online: a request that failed for lack of a connection is made again.
  $effect(() => {
    const online = app.online
    untrack(() => {
      if (online && failure?.kind === 'offline') retry()
    })
  })

  const recitedWord = $derived(player.activeWord?.wordId ?? null)
  const shownWords = $derived(reader.searchHit?.wordIds ?? [])
  const packLang = $derived(meta?.language ?? undefined)
  const packDir = $derived(meta?.dir ?? 'ltr')

  const osLanguage = $derived((app.info.osLocale ?? '').toLowerCase().split(/[-_]/)[0] ?? '')
  const catalogue = $derived(
    packs.list.filter((p) => p.kind === 'wbw').map((p) => translations.packMeta(p.id)),
  )
  const rows = $derived(packRows('wbw', catalogue, { uiLanguage: i18n.locale, osLanguage }, 3))
  const items: SelectItem[] = $derived(
    packs.list
      .filter((p) => p.kind === 'wbw')
      .map((p) => ({
        value: p.id,
        label: languageName(p.language, i18n.locale) || translations.packTitle(p.id),
        hint: p.language ?? undefined,
      })),
  )

  const failedSurah = $derived(quran.surahName(quran.ayahRef(subject.from).surah))

  function choose(id: string): void {
    if (id !== settings.value.wbwPackId) void settings.update({ wbwPackId: id })
  }

  function pick(row: PickRow): void {
    choose(row.meta.id)
  }

  /** Shows the word on the page (search-hit layer), or clears it when it is the one shown. */
  function show(ayahId: number, wordId: number): void {
    const hit = reader.searchHit
    if (hit && hit.wordIds.length === 1 && hit.wordIds[0] === wordId) {
      reader.searchHit = null
      return
    }
    reader.goToAyah(ayahId, { highlightWords: [wordId] })
  }

  function wordLabel(entry: WbwEntry): string {
    return entry.translation ? `${entry.text}: ${entry.translation}` : entry.text
  }
</script>

{#snippet toolbar()}
  <Select
    {items}
    value={packId ?? ''}
    onValueChange={choose}
    placeholder={packId === null ? '' : translations.packTitle(packId)}
    label={i18n.t('sidepane.words.source')}
    size="sm"
    class="pane-source"
  />
  <span class="spacer"></span>
  <Switch
    checked={translit}
    label={i18n.t('sidepane.words.transliteration')}
    onCheckedChange={(on: boolean) => void settings.update({ wbwShowTransliteration: on })}
  />
{/snippet}

<TabBody
  resetKey="{packId}|{subject.from}-{subject.to}"
  busy={loading}
  toolbar={packId === null ? undefined : toolbar}
>
  {#if packId === null}
    <PackPicker
      kind="wbw"
      title={i18n.t('sidepane.words.pickTitle')}
      body={i18n.t('sidepane.words.pickBody')}
      offlineBody={i18n.t('sidepane.words.pickOffline')}
      label={i18n.t('sidepane.words.pickLabel')}
      {rows}
      onpick={pick}
    />
  {:else if failure !== null}
    {#if failure.kind === 'offline'}
      <PaneMessage
        icon={CloudOff}
        text={i18n.t('sidepane.words.needsConnection', { surah: failedSurah })}
        hint={i18n.t('sidepane.words.offlineHint')}
      >
        <Button size="sm" variant="secondary" onclick={retry}>{i18n.t('common.retry')}</Button>
      </PaneMessage>
    {:else}
      <PaneMessage
        icon={CircleAlert}
        tone="danger"
        text={i18n.t('sidepane.words.error')}
        hint={i18n.t(`errors.${failure.kind}`)}
      >
        <Button size="sm" variant="secondary" onclick={retry}>{i18n.t('common.retry')}</Button>
      </PaneMessage>
    {/if}
  {:else}
    <div class="groups" role={loading ? 'status' : undefined}>
      {#if loading}<span class="sr-only">{i18n.t('sidepane.words.loading')}</span>{/if}
      {#each spans as span (span.ayahId)}
        {@const ref = quran.ayahRef(span.ayahId)}
        <section
          class="group"
          aria-label={i18n.t('sidepane.words.grid', { ref: i18n.ref(ref.surah, ref.ayah) })}
        >
          {#if spans.length > 1}
            <header class="key"><KeyBadge surah={ref.surah} ayah={ref.ayah} /></header>
          {/if}
          <ul class="grid" dir="rtl">
            {#each { length: span.last - span.first + 1 }, i (i)}
              {@const wordId = span.first + i}
              {@const entry = entries?.[wordId]}
              <li>
                {#if entry}
                  <button
                    type="button"
                    class="card"
                    class:recited={recitedWord === wordId}
                    class:shown={shownWords.includes(wordId)}
                    aria-pressed={shownWords.includes(wordId)}
                    aria-label={wordLabel(entry)}
                    title={i18n.t('sidepane.words.show')}
                    data-word={wordId}
                    onclick={() => show(span.ayahId, wordId)}
                  >
                    <span class="word quran-text" lang="ar" dir="rtl">{entry.text}</span>
                    {#if entry.translation}
                      <span class="gloss" lang={packLang} dir={packDir}>{entry.translation}</span>
                    {:else}
                      <span class="gloss none" lang={i18n.locale} dir={i18n.dir}
                        >{i18n.t('sidepane.words.noGloss')}</span
                      >
                    {/if}
                    {#if translit && entry.transliteration}
                      <span class="translit" dir="ltr">{entry.transliteration}</span>
                    {/if}
                    {#if recitedWord === wordId}
                      <span class="sr-only">{i18n.t('sidepane.words.reciting')}</span>
                    {/if}
                  </button>
                {:else if entries === null}
                  <div class="card placeholder" aria-hidden="true">
                    <Skeleton w="62%" h={20} radius="sm" />
                    <Skeleton w="80%" h={10} radius="xs" />
                    {#if translit}<Skeleton w="52%" h={9} radius="xs" />{/if}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
    {#if subject.to - subject.from + 1 > MAX_SPAN}
      <p class="truncated">
        {i18n.tp('sidepane.truncated', subject.to - subject.from + 1, { shown: i18n.num(MAX_SPAN) })}
      </p>
    {/if}
  {/if}
</TabBody>

<style>
  .spacer {
    flex: 1 1 auto;
  }

  .groups {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .group + .group {
    padding-block-start: var(--space-4);
    border-block-start: 1px solid var(--border);
  }

  .key {
    display: flex;
    align-items: center;
  }

  /* Reading order is right to left whatever the UI language (dir="rtl" on the list). */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .grid > li {
    display: flex;
    min-inline-size: 0;
  }

  .card {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    min-inline-size: 0;
    min-block-size: 96px;
    padding-block: var(--space-2) var(--space-3);
    padding-inline: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background-color: var(--surface-page);
    color: var(--text);
    font-family: var(--font-ui);
    text-align: center;
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      border-color var(--dur-fast) var(--ease-standard);
  }

  button.card:hover {
    border-color: var(--border-strong);
    background-color: color-mix(in srgb, var(--surface-page) 92%, var(--text));
  }

  button.card:focus-visible {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  /* The word shown on the page with the search-hit layer (§8.7). */
  .card.shown {
    border-color: var(--hl-search-solid);
    background-color: color-mix(in srgb, var(--hl-search-solid) 14%, var(--surface-page));
  }

  /* The word being recited (§8.7 word glide colour). */
  .card.recited {
    border-color: var(--accent);
    background-color: var(--hl-word);
  }

  .placeholder {
    justify-content: center;
    gap: var(--space-2);
    cursor: default;
  }

  /* qd-hafs at 24 px (§9.7); the tall line box is trimmed so cards stay compact. */
  .word {
    color: var(--ink);
    font-family: var(--font-quran);
    font-size: 24px;
    line-height: 1.9;
    white-space: nowrap;
  }

  /* The meaning is in the pack's language, so its size follows its script, not the UI language. */
  .gloss {
    max-inline-size: 100%;
    color: var(--text);
    font-family: var(--font-latin);
    font-size: 13px;
    font-weight: var(--weight-label);
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .gloss[dir='rtl'] {
    font-family: var(--font-naskh);
    font-size: 15px;
    line-height: 1.6;
  }

  .gloss.none {
    color: var(--text-muted);
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    font-weight: var(--weight-body);
  }

  .translit {
    max-inline-size: 100%;
    color: var(--text-muted);
    font-family: var(--font-latin);
    font-size: 12px;
    font-style: italic;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .truncated {
    margin-block: var(--space-4) 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-align: center;
  }

  @media (forced-colors: active) {
    .card.shown,
    .card.recited {
      border: 2px solid Highlight;
    }
  }
</style>
