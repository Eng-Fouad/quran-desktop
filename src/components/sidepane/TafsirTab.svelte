<!--
  TafsirTab (§9.7, §9.8): the commentary of `settings.tafsirPackId` on the pane's subject. Owner: WP11b.

  - Entries come from `translations.tafsirFor` (cached per ayah, a range entry under every ayah it covers). For a
    range subject the tab walks the entries in order: each one starts after the last ayah the previous one covered, so
    a Quran.com entry over 2:253–255 is shown once. Revisits render from the cache at once.
  - Typography: Arabic-script tafsir in Naskh 18 px at leading 2.0, others in the reading font at 16 px; at most
    64ch wide. A range entry starts with "Covers 2:253–255". References in the text turn the page there (flash).
  - Footer: the source, and its date — "Saved 3 days ago" for fetched content, "Saved 9 days ago · refreshes when
    online" when `stale` (it is fetched again as soon as the app is online), or the installed version.
  - States (§9.8): loading → 6 skeleton lines at `--leading-naskh`; offline and the chapter not cached → "This tafsir
    needs a connection for Al-Kahf (≈180 KB)" [Retry] (retried by itself when the app comes online); a whole pack not
    on disk → Download (with progress, or Retry after a failure); an on-demand tafsir without commentary on the
    surah (`not_found`: upstream has none) → "Ibn Kathir has no commentary on Al-Fil", with no Retry; no tafsir chosen →
    the tafsir card.
  - The toolbar switches the tafsir (installed packs and those fetched as you read).
-->
<script lang="ts">
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import CloudOff from '@lucide/svelte/icons/cloud-off'
  import BookX from '@lucide/svelte/icons/book-x'
  import Download from '@lucide/svelte/icons/download'
  import { untrack } from 'svelte'
  import SafeHtml from '$components/ui/SafeHtml.svelte'
  import { Button, Progress, Select, Skeleton } from '$components/ui'
  import type { SelectItem } from '$components/ui'
  import { toIpcError, type IpcError } from '$lib/ipc'
  import type { TafsirEntry } from '$lib/ipc/bindings'
  import { app, i18n, packs, quran, settings, translations, ui } from '$lib/stores'
  import { isInstalled } from '$lib/stores/packs.svelte'
  import PackPicker from './PackPicker.svelte'
  import PaneMessage from './PaneMessage.svelte'
  import { goToRef, jobLine, languageName, MAX_SPAN, type Subject } from './pane.svelte'
  import { packRows, type PickRow } from './picker'
  import TabBody from './TabBody.svelte'

  interface Props {
    subject: Subject
  }

  let { subject }: Props = $props()

  /** Skeleton lines while the first entry loads (§9.8). */
  const SKELETON_LINES = 6

  const packId = $derived(settings.value.tafsirPackId)
  const meta = $derived(packId === null ? null : translations.packMeta(packId))
  /** A whole pack that is not on disk cannot answer: say so (and offer the download) instead of asking. */
  const blocked = $derived.by((): 'missing' | 'downloading' | 'failed' | null => {
    if (meta === null || meta.onDemand) return null
    switch (meta.availability) {
      case 'not_installed':
        return 'missing'
      case 'downloading':
        return 'downloading'
      case 'failed':
        return 'failed'
      default:
        return null
    }
  })
  const end = $derived(Math.min(subject.to, subject.from + MAX_SPAN - 1))

  /** The cached entries covering the subject, in order, and the first ayah that still needs one. */
  const walk = $derived.by((): { entries: TafsirEntry[]; next: number | null } => {
    const id = packId
    if (id === null || blocked !== null) return { entries: [], next: null }
    const entries: TafsirEntry[] = []
    let a = subject.from
    while (a <= end) {
      const entry = translations.tafsirOf(id, a)
      if (!entry) return { entries, next: a }
      entries.push(entry)
      a = Math.max(a, entry.toAyahId) + 1
    }
    return { entries, next: null }
  })

  /** Failed requests by `pack:ayah` (kept until Retry, the app coming online, or the pack changing). */
  let failures = $state.raw<Readonly<Record<string, IpcError>>>({})
  /** Requests in flight by `pack:ayah` (bookkeeping only: the cache's `version` drives the view). */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- deliberately plain: never read reactively
  const inflight = new Set<string>()
  const failure = $derived(
    packId !== null && walk.next !== null ? (failures[`${packId}:${walk.next}`] ?? null) : null,
  )
  /** No catalogue knows the chosen pack (a stale setting): offer the choice again. */
  const unknownPack = $derived(failure?.kind === 'not_found' && meta?.availability === 'unknown')
  /** A whole pack the backend cannot open although the catalogue lists it: offer its download. */
  const missingPack = $derived(
    failure?.kind === 'not_found' && meta !== null && !meta.onDemand && meta.availability !== 'unknown',
  )
  /**
   * An on-demand tafsir that has no commentary here: upstream sent the chapter without any (Ibn Kathir on Al-Fil), and
   * the backend answers `not_found` from the stored, complete chapter. Retrying cannot change that.
   */
  const noCommentary = $derived(failure?.kind === 'not_found' && meta?.onDemand === true)
  const loading = $derived(walk.next !== null && failure === null)

  // Fetch the next entry the walk needs; its arrival bumps the cache and the walk moves on.
  $effect(() => {
    const id = packId
    const next = walk.next
    if (id === null || next === null) return
    const key = `${id}:${next}`
    if (key in failures || inflight.has(key)) return
    inflight.add(key)
    translations
      .tafsirFor(id, next)
      .catch((e: unknown) => {
        failures = { ...failures, [key]: toIpcError(e) }
      })
      .finally(() => inflight.delete(key))
  })

  /** Stale entries already asked for again while online (once each; cleared when the app goes offline). */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- deliberately plain: never read reactively
  const refreshed = new Set<string>()

  // Back online: what failed for lack of a connection is asked again, and stale entries are refreshed.
  $effect(() => {
    const online = app.online
    const id = packId
    const stale = walk.entries.filter((e) => e.stale)
    untrack(() => {
      if (!online) {
        refreshed.clear()
        return
      }
      if (Object.values(failures).some((e) => e.kind === 'offline')) {
        failures = Object.fromEntries(Object.entries(failures).filter(([, e]) => e.kind !== 'offline'))
      }
      if (id === null) return
      for (const e of stale) {
        const key = `${id}:${e.fromAyahId}`
        if (refreshed.has(key)) continue
        refreshed.add(key)
        translations.tafsirFor(id, Math.max(e.fromAyahId, subject.from)).catch(() => {
          // Still unreachable: the stale entry stays, with its footer.
        })
      }
    })
  })

  // Another pack, or the pack's state changed (installed, removed): earlier failures no longer apply.
  const availability = $derived(meta?.availability ?? null)
  $effect(() => {
    void packId
    void availability
    untrack(() => {
      if (Object.keys(failures).length > 0) failures = {}
    })
  })

  const osLanguage = $derived((app.info.osLocale ?? '').toLowerCase().split(/[-_]/)[0] ?? '')
  const catalogue = $derived(
    packs.list.filter((p) => p.kind === 'tafsir').map((p) => translations.packMeta(p.id)),
  )
  const rows = $derived(packRows('tafsir', catalogue, { uiLanguage: i18n.locale, osLanguage }, 5))

  /** The toolbar's choices: tafsir the pane can show (installed, or fetched as you read), plus the current one. */
  const items: SelectItem[] = $derived(
    packs.list
      .filter(
        (p) => p.kind === 'tafsir' && (p.installMode === 'on_demand' || isInstalled(p) || p.id === packId),
      )
      .map((p) => ({
        value: p.id,
        label: translations.packTitle(p.id),
        hint: languageName(p.language, i18n.locale),
      })),
  )

  const surahOfNext = $derived(walk.next === null ? 0 : quran.ayahRef(walk.next).surah)
  const connectionText = $derived.by(() => {
    const name = quran.surahName(surahOfNext)
    const info = packId === null ? undefined : packs.pack(packId)
    const kib = info && surahOfNext > 0 ? packs.itemKib(info, surahOfNext) : 0
    return kib > 0
      ? i18n.t('sidepane.tafsir.needsConnection', { surah: name, size: i18n.bytes(kib) })
      : i18n.t('sidepane.tafsir.needsConnectionPlain', { surah: name })
  })

  /** The footer's date: the oldest fetch among the entries (stale wins), else the installed version. */
  const footer = $derived.by((): string => {
    const fetched = walk.entries.filter((e) => e.fetchedAt !== null)
    const stale = fetched.filter((e) => e.stale)
    const pick = (list: TafsirEntry[]) => Math.min(...list.map((e) => e.fetchedAt ?? 0))
    if (stale.length > 0) return i18n.t('sidepane.tafsir.stale', { time: i18n.relTime(pick(stale)) })
    if (fetched.length > 0) return i18n.t('sidepane.tafsir.saved', { time: i18n.relTime(pick(fetched)) })
    const info = packId === null ? undefined : packs.pack(packId)
    const version = info?.state.type === 'installed' ? info.state.data.version : info?.version
    return version ? i18n.t('sidepane.tafsir.version', { version }) : ''
  })
  const attribution = $derived.by(() => {
    const info = packId === null ? undefined : packs.pack(packId)
    return info ? info.attribution.text[i18n.locale] || info.attribution.text.en : ''
  })
  const stale = $derived(walk.entries.some((e) => e.stale))

  /** The download of the chosen pack, while it is on its way. */
  const job = $derived(blocked === 'downloading' && packId !== null ? jobLine(packId) : null)
  const jobText = $derived.by(() => {
    if (job === null || packId === null) return ''
    const name = translations.packTitle(packId)
    switch (job.state) {
      case 'queued':
        return i18n.t('sidepane.tafsir.queued', { name })
      case 'installing':
        return i18n.t('sidepane.tafsir.installing', { name })
      case 'paused':
        return i18n.t('sidepane.tafsir.paused', { name, percent: job.label })
      default:
        return i18n.t('sidepane.tafsir.downloading', { name, percent: job.label })
    }
  })

  function covers(e: TafsirEntry): string {
    const a = quran.ayahRef(e.fromAyahId)
    const b = quran.ayahRef(e.toAyahId)
    return i18n.t('sidepane.tafsir.covers', { ref: i18n.ref(a.surah, a.ayah, b.ayah, b.surah) })
  }

  function entryLabel(e: TafsirEntry): string {
    const a = quran.ayahRef(e.fromAyahId)
    const b = quran.ayahRef(e.toAyahId)
    return i18n.t('sidepane.tafsir.label', {
      ref: e.toAyahId > e.fromAyahId ? i18n.ref(a.surah, a.ayah, b.ayah, b.surah) : i18n.ref(a.surah, a.ayah),
    })
  }

  function retry(): void {
    const id = packId
    const next = walk.next
    if (id === null || next === null) return
    const key = `${id}:${next}`
    failures = Object.fromEntries(Object.entries(failures).filter(([k]) => k !== key))
  }

  function install(id: string): void {
    packs.install(id).catch((e: unknown) => ui.toastError(e))
  }

  function retryDownload(id: string): void {
    packs.retry(id).catch((e: unknown) => ui.toastError(e))
  }

  function resumeDownload(id: string): void {
    packs.resume(id).catch((e: unknown) => ui.toastError(e))
  }

  function choose(id: string): void {
    if (id !== settings.value.tafsirPackId) void settings.update({ tafsirPackId: id })
  }

  function pick(row: PickRow): void {
    choose(row.meta.id)
    if (row.action === 'install') install(row.meta.id)
  }
</script>

{#snippet toolbar()}
  <Select
    {items}
    value={packId ?? ''}
    onValueChange={choose}
    placeholder={packId === null ? '' : translations.packTitle(packId)}
    label={i18n.t('sidepane.tafsir.source')}
    size="sm"
    class="pane-source"
  />
{/snippet}

<TabBody
  resetKey="{packId}|{subject.from}-{subject.to}"
  busy={loading}
  toolbar={packId === null || unknownPack ? undefined : toolbar}
>
  {#if packId === null || meta === null || unknownPack}
    <PackPicker
      kind="tafsir"
      title={i18n.t('sidepane.tafsir.pickTitle')}
      body={i18n.t('sidepane.tafsir.pickBody')}
      offlineBody={i18n.t('sidepane.tafsir.pickOffline')}
      label={i18n.t('sidepane.tafsir.pickLabel')}
      {rows}
      onpick={pick}
    />
  {:else if blocked === 'downloading' && job !== null}
    <PaneMessage icon={Download} text={jobText}>
      <Progress
        value={job.percent}
        indeterminate={job.state === 'queued' || job.state === 'installing'}
        label={translations.packTitle(meta.id)}
      />
      {#if job.state === 'paused'}
        <Button size="sm" variant="secondary" disabled={!app.online} onclick={() => resumeDownload(meta.id)}
          >{i18n.t('common.resume')}</Button
        >
      {/if}
    </PaneMessage>
  {:else if blocked === 'failed'}
    <PaneMessage
      icon={CircleAlert}
      tone="danger"
      text={i18n.t('sidepane.tafsir.failed', { name: translations.packTitle(meta.id) })}
    >
      <Button size="sm" variant="secondary" disabled={!app.online} onclick={() => retryDownload(meta.id)}
        >{i18n.t('common.retry')}</Button
      >
    </PaneMessage>
  {:else if blocked === 'missing' || missingPack}
    <PaneMessage
      icon={Download}
      text={i18n.t('sidepane.tafsir.notInstalled', { name: translations.packTitle(meta.id) })}
      hint={app.online ? i18n.t('sidepane.tafsir.notInstalledBody') : i18n.t('sidepane.tafsir.pickOffline')}
    >
      <Button size="sm" variant="primary" disabled={!app.online} onclick={() => install(meta.id)}
        >{i18n.t('common.download')}</Button
      >
    </PaneMessage>
  {:else}
    {#if walk.entries.length > 0}
      <div class="entries">
        {#each walk.entries as entry (`${entry.packId}:${entry.fromAyahId}-${entry.toAyahId}`)}
          <article
            class="entry"
            class:rtl={entry.dir === 'rtl'}
            lang={entry.lang}
            dir={entry.dir}
            aria-label={entryLabel(entry)}
          >
            {#if entry.toAyahId > entry.fromAyahId}
              <p class="covers" lang={i18n.locale} dir={i18n.dir}>{covers(entry)}</p>
            {/if}
            {#if entry.html.trim() === ''}
              <p class="none" lang={i18n.locale} dir={i18n.dir}>{i18n.t('sidepane.tafsir.empty')}</p>
            {:else}
              <div class="text"><SafeHtml html={entry.html} onref={goToRef} /></div>
            {/if}
          </article>
        {/each}
      </div>
    {/if}

    {#if failure !== null}
      {#if failure.kind === 'offline'}
        <PaneMessage icon={CloudOff} text={connectionText} hint={i18n.t('sidepane.tafsir.offlineHint')}>
          <Button size="sm" variant="secondary" onclick={retry}>{i18n.t('common.retry')}</Button>
        </PaneMessage>
      {:else if noCommentary}
        <PaneMessage
          icon={BookX}
          text={i18n.t('sidepane.tafsir.noCommentary', {
            name: translations.packTitle(meta.id),
            surah: quran.surahName(surahOfNext),
          })}
          hint={i18n.t('sidepane.tafsir.noCommentaryHint')}
        />
      {:else}
        <PaneMessage
          icon={CircleAlert}
          tone="danger"
          text={i18n.t('sidepane.tafsir.error')}
          hint={i18n.t(`errors.${failure.kind}`)}
        >
          <Button size="sm" variant="secondary" onclick={retry}>{i18n.t('common.retry')}</Button>
        </PaneMessage>
      {/if}
    {:else if loading}
      <div class="skeleton" class:rtl={meta.dir === 'rtl'} dir={meta.dir} role="status">
        <span class="sr-only">{i18n.t('sidepane.tafsir.loading')}</span>
        {#each { length: walk.entries.length > 0 ? 3 : SKELETON_LINES }, i (i)}
          <span class="line" aria-hidden="true">
            <Skeleton
              h={12}
              w={i === SKELETON_LINES - 1 || (walk.entries.length > 0 && i === 2) ? '55%' : '100%'}
            />
          </span>
        {/each}
      </div>
    {/if}

    {#if walk.entries.length > 0 && !loading && failure === null}
      <footer class="source" class:stale>
        <span class="name">{translations.packTitle(meta.id)}</span>
        {#if attribution}<span class="credit">{attribution}</span>{/if}
        {#if footer}<span class="date">{footer}</span>{/if}
      </footer>
    {/if}
    {#if subject.to - subject.from + 1 > MAX_SPAN && walk.next === null}
      <p class="truncated">
        {i18n.tp('sidepane.truncated', subject.to - subject.from + 1, { shown: i18n.num(MAX_SPAN) })}
      </p>
    {/if}
  {/if}
</TabBody>

<style>
  .entries {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .entry {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-inline-size: 64ch;
  }

  .entry + .entry {
    padding-block-start: var(--space-5);
    border-block-start: 1px solid var(--border);
  }

  .covers {
    align-self: flex-start;
    margin: 0;
    padding-block: 2px;
    padding-inline: var(--space-2);
    border-radius: var(--radius-full);
    background-color: color-mix(in srgb, var(--frame-gold) 14%, transparent);
    color: var(--text-muted);
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    font-weight: var(--weight-title);
    line-height: 18px;
  }

  /* Latin and other left-to-right tafsir: the reading font at 16 px. */
  .text {
    color: var(--text);
    font-family: var(--font-latin);
    font-size: 16px;
    line-height: 1.7;
    overflow-wrap: break-word;
  }

  /* Arabic-script tafsir (§9.7): Naskh 18 px at leading 2.0. */
  .rtl .text {
    font-family: var(--font-naskh);
    font-size: 18px;
    line-height: var(--leading-naskh);
  }

  .text :global(:is(h1, h2, h3, h4)) {
    margin-block: 0 0.35em;
    color: var(--text);
    font-size: 1.05em;
    font-weight: var(--weight-title);
    line-height: inherit;
  }

  .text :global(p) {
    margin: 0;
  }

  .text :global(p + p),
  .text :global(:is(ul, ol, blockquote) + p),
  .text :global(p + :is(ul, ol, blockquote)) {
    margin-block-start: 0.7em;
  }

  .text :global(:is(ul, ol)) {
    margin-block: 0;
    padding-inline-start: 1.4em;
  }

  .text :global(blockquote) {
    margin-block: 0;
    margin-inline: 0;
    padding-inline-start: var(--space-3);
    border-inline-start: 3px solid var(--border-strong);
    color: var(--text-muted);
  }

  .none {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  /* §9.8: six skeleton lines spaced at the tafsir's leading (Naskh 18 px × 2.0 = 36 px a line). */
  .skeleton {
    display: flex;
    flex-direction: column;
    max-inline-size: 64ch;
    padding-block-start: var(--space-1);
  }

  .line {
    display: flex;
    align-items: center;
    block-size: calc(16px * 1.7);
  }

  .skeleton.rtl .line {
    block-size: calc(18px * var(--leading-naskh));
  }

  .entries + .skeleton {
    margin-block-start: var(--space-5);
  }

  .source {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-inline-size: 64ch;
    margin-block-start: var(--space-6);
    padding-block-start: var(--space-3);
    border-block-start: 1px solid var(--border);
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
  }

  .source .name {
    color: var(--text);
    font-weight: var(--weight-label);
  }

  .stale .date {
    color: var(--warning-text);
  }

  .truncated {
    margin-block: var(--space-3) 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-align: center;
  }
</style>
