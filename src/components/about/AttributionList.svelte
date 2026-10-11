<!--
  AttributionList (§9.7 About and attribution). Owner: WP12c. The attribution groups (`attributionGroups()`): Quran text
  and layout, fonts, translations, tafsir, word by word, recitations. Each group is a heading over a card of entries;
  each entry shows its name, what the app takes from it (or the credit line it asks for), its licence and a link to the
  source, plus the installed version and language of a pack, and for the app itself the link to its source code. An entry with a bundled licence (the KFGQPC Hafs EULA)
  can show the full text, fetched on demand and rendered as plain text. Empty pack groups say what will appear there.
-->
<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ExternalLink from '@lucide/svelte/icons/external-link'
  import type { AttributionEntry, AttributionGroup, AttributionNotice } from '$lib/about/attributions'
  import { isOpenableUrl } from '$lib/about/attributions'
  import { i18n } from '$lib/stores'
  import { loadNotice, onExternalClick, siteLabel } from './links'

  interface Props {
    groups: readonly AttributionGroup[]
  }

  let { groups }: Props = $props()

  const uid = $props.id()

  type NoticeState = { status: 'loading' } | { status: 'ready'; text: string } | { status: 'error' }
  /** Open notices by entry id. */
  let notices = $state<Record<string, NoticeState>>({})

  function toggleNotice(entry: AttributionEntry, notice: AttributionNotice): void {
    if (notices[entry.id]) {
      delete notices[entry.id]
      return
    }
    notices[entry.id] = { status: 'loading' }
    loadNotice(notice).then(
      (text) => {
        if (notices[entry.id]) notices[entry.id] = { status: 'ready', text }
      },
      (e: unknown) => {
        console.warn('[qd] about: the licence text could not be loaded', e)
        if (notices[entry.id]) notices[entry.id] = { status: 'error' }
      },
    )
  }

  function emptyText(id: AttributionGroup['id']): string | null {
    if (id === 'translations') return i18n.t('about.empty.translations')
    if (id === 'tafsir') return i18n.t('about.empty.tafsir')
    return null
  }

  const displayNames = $derived.by(() => {
    try {
      return new Intl.DisplayNames([i18n.locale], { type: 'language' })
    } catch {
      return null
    }
  })

  function languageName(code: string): string {
    try {
      return displayNames?.of(code) ?? code
    } catch {
      return code
    }
  }

  /** "English · Version 1.1.2" under a pack entry. */
  function packLine(entry: AttributionEntry): string {
    const parts: string[] = []
    if (entry.language) parts.push(languageName(entry.language))
    if (entry.version) parts.push(i18n.t('about.entry.version', { version: entry.version }))
    return parts.join(' · ')
  }
</script>

<div class="groups">
  {#each groups as group (group.id)}
    {@const empty = emptyText(group.id)}
    <section class="group" aria-labelledby="{uid}-{group.id}" data-group={group.id}>
      <h3 class="group-title" id="{uid}-{group.id}">{i18n.t(`about.groups.${group.id}`)}</h3>
      {#if group.entries.length === 0}
        {#if empty}<p class="empty">{empty}</p>{/if}
      {:else}
        <ul class="card">
          {#each group.entries as entry (entry.id)}
            {@const line = packLine(entry)}
            {@const notice = notices[entry.id]}
            <li class="entry" data-entry={entry.id}>
              <div class="entry-head">
                <span class="name">{entry.name[i18n.locale] || entry.name.en}</span>
                {#if line}<span class="pack-line">{line}</span>{/if}
              </div>
              <p class="credit">{entry.credit[i18n.locale] || entry.credit.en}</p>
              <div class="facts">
                <span class="licence">
                  <span class="fact-label">{i18n.t('about.entry.licence')}</span>
                  {#if isOpenableUrl(entry.licenceUrl)}
                    {@const licenceUrl = entry.licenceUrl}
                    <a class="link" href={licenceUrl} onclick={(e) => onExternalClick(e, licenceUrl)}
                      >{entry.licence[i18n.locale] || entry.licence.en}<ExternalLink
                        size={12}
                        strokeWidth={2}
                        aria-hidden="true"
                      /></a
                    >
                  {:else}
                    <span class="licence-text">{entry.licence[i18n.locale] || entry.licence.en}</span>
                  {/if}
                </span>
                {#if isOpenableUrl(entry.url)}
                  {@const url = entry.url}
                  <a
                    class="link site"
                    href={url}
                    onclick={(e) => onExternalClick(e, url)}
                    aria-label="{i18n.t('about.entry.site')}: {siteLabel(url)}"
                    ><bdi dir="ltr">{siteLabel(url)}</bdi><ExternalLink
                      size={12}
                      strokeWidth={2}
                      aria-hidden="true"
                    /></a
                  >
                {/if}
                {#if isOpenableUrl(entry.sourceUrl)}
                  {@const sourceUrl = entry.sourceUrl}
                  <a
                    class="link source"
                    href={sourceUrl}
                    onclick={(e) => onExternalClick(e, sourceUrl)}
                    aria-label="{i18n.t('about.entry.source')}: {siteLabel(sourceUrl)}"
                    >{i18n.t('about.entry.source')}<ExternalLink
                      size={12}
                      strokeWidth={2}
                      aria-hidden="true"
                    /></a
                  >
                {/if}
                {#if entry.notice}
                  {@const which = entry.notice}
                  <button
                    type="button"
                    class="notice-toggle"
                    aria-expanded={notice !== undefined}
                    aria-controls="{uid}-notice-{entry.id}"
                    onclick={() => toggleNotice(entry, which)}
                  >
                    {notice ? i18n.t('about.entry.hideNotice') : i18n.t('about.entry.showNotice')}
                    <ChevronDown
                      class={['chevron', { open: notice !== undefined }]}
                      size={14}
                      aria-hidden="true"
                    />
                  </button>
                {/if}
              </div>
              {#if notice}
                <div class="notice" id="{uid}-notice-{entry.id}">
                  {#if notice.status === 'loading'}
                    <p class="notice-state" aria-busy="true">{i18n.t('about.entry.noticeLoading')}</p>
                  {:else if notice.status === 'error'}
                    <p class="notice-state error" role="alert">{i18n.t('about.entry.noticeFailed')}</p>
                  {:else}
                    <!-- A scrollable region must be reachable by keyboard (it scrolls with the arrow keys). -->
                    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                    <pre
                      class="notice-text"
                      dir="ltr"
                      lang="en"
                      tabindex="0"
                      aria-label={i18n.t('about.entry.licenceText')}>{notice.text}</pre>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/each}
</div>

<style>
  .groups {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .group-title {
    margin: 0;
    padding-inline: var(--space-1);
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: var(--weight-title);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  /* §9.7: no letter-spacing or capitals in the Arabic UI. */
  :global(:root[lang='ar']) .group-title {
    letter-spacing: 0;
    text-transform: none;
    font-size: var(--text-sm);
  }

  .empty {
    margin: 0;
    padding: var(--space-3) var(--space-4);
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-lg);
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .card {
    margin: 0;
    padding: 0;
    list-style: none;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-1);
  }

  .entry {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding-block: var(--space-3);
    padding-inline: var(--space-4);
  }

  .entry + .entry {
    border-block-start: 1px solid var(--border);
  }

  .entry-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-3);
  }

  .name {
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .pack-line {
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .credit {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
  }

  .facts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-4);
    margin-block-start: 2px;
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
  }

  .licence {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1);
    min-inline-size: 0;
  }

  .fact-label {
    color: var(--text-muted);
    font-weight: var(--weight-label);
  }

  .fact-label::after {
    content: ':';
  }

  .licence-text {
    color: var(--text);
  }

  .link {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    border-radius: var(--radius-xs);
    color: var(--accent-text);
    text-decoration: none;
  }

  .link:hover {
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .notice-toggle {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-xs);
    background: none;
    color: var(--accent-text);
    font: inherit;
    cursor: pointer;
  }

  .notice-toggle:hover {
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .notice-toggle :global(.chevron) {
    transition: rotate var(--dur-quick) var(--ease-standard);
  }

  .notice-toggle :global(.chevron.open) {
    rotate: 180deg;
  }

  .notice {
    margin-block-start: var(--space-2);
  }

  .notice-state {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .notice-state.error {
    color: var(--danger-text);
  }

  .notice-text {
    max-block-size: 260px;
    margin: 0;
    padding: var(--space-3);
    overflow: auto;
    border-radius: var(--radius-sm);
    background-color: var(--surface-sunken);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    line-height: 1.6;
    text-align: start;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
