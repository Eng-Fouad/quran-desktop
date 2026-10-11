<!--
  IdleState (§9.8 "Search, empty query"): recent searches plus example chips `الرحمن`, `mercy`, `2:255`. Recent
  searches (most recent first, at most six) show their query in its own direction and the scope they ran in; a click
  runs the search again in that scope. "Clear" forgets them. Without history the star, a title and a short guide lead
  the examples. `mercy` searches the translations (the install card appears when none is installed) and `2:255` shows
  the reference jump. Owner: WP10b. Used only inside `SearchPanel`.
-->
<script lang="ts">
  import BookOpenText from '@lucide/svelte/icons/book-open-text'
  import Clock from '@lucide/svelte/icons/clock'
  import Languages from '@lucide/svelte/icons/languages'
  import StickyNote from '@lucide/svelte/icons/sticky-note'
  import { Button, EmptyState } from '$components/ui'
  import type { SearchHistoryEntry, SearchScope } from '$lib/ipc/bindings'
  import { i18n, packs, search } from '$lib/stores'

  interface Props {
    /** After a recent search or an example was picked (the panel returns focus to the field). */
    onpick: () => void
  }

  let { onpick }: Props = $props()

  const RECENT_SHOWN = 6

  const recent = $derived(search.history.slice(0, RECENT_SHOWN))

  type ExampleKind = 'quran' | 'translation' | 'reference'

  /** The reference in UI digits ("٢:٢٥٥" with Arabic-Indic digits; the parser reads both), without its isolates. */
  const reference = $derived(i18n.ref(2, 255).replace(/[\u2066-\u2069]/gu, ''))

  /** §9.8: an Arabic word, a translation word and a reference, each captioned with what it shows. */
  const EXAMPLES: { query: string; lang?: string; kind: ExampleKind }[] = $derived([
    { query: 'الرحمن', lang: 'ar', kind: 'quran' },
    { query: 'mercy', lang: 'en', kind: 'translation' },
    { query: reference, kind: 'reference' },
  ])

  function kindLabel(kind: ExampleKind): string {
    if (kind === 'reference') return i18n.t('search.empty.reference')
    return i18n.t(kind === 'translation' ? 'search.scope.translation' : 'search.scope.quran')
  }

  function scopeName(scope: SearchScope): string {
    if (scope.type === 'translation') {
      const pack = packs.pack(scope.data.packId)
      return pack ? packs.title(pack) : i18n.t('search.scope.translation')
    }
    return i18n.t(scope.type === 'notes' ? 'search.scope.notes' : 'search.scope.quran')
  }

  function again(entry: SearchHistoryEntry): void {
    search.useHistory(entry)
    onpick()
  }

  function example(e: { query: string; kind: ExampleKind }): void {
    search.searchFor(
      e.query,
      e.kind === 'translation' ? { type: 'translation', data: { packId: '' } } : { type: 'quran' },
    )
    onpick()
  }
</script>

{#snippet examples()}
  <div class="examples" role="group" aria-label={i18n.t('search.empty.examples')}>
    {#each EXAMPLES as e (e.query)}
      <button type="button" class="example" onclick={() => example(e)}>
        <span class="example-text" lang={e.lang} dir={e.kind === 'quran' ? 'rtl' : 'ltr'}>{e.query}</span>
        <span class="example-kind">{kindLabel(e.kind)}</span>
      </button>
    {/each}
  </div>
{/snippet}

{#if recent.length > 0}
  <section class="recent" aria-labelledby="qd-search-recent">
    <header class="recent-head">
      <h3 id="qd-search-recent">{i18n.t('search.empty.recent')}</h3>
      <Button size="sm" variant="link" onclick={() => void search.clearHistory()}>
        {i18n.t('search.empty.clearRecent')}
      </Button>
    </header>
    <ul class="recent-list">
      {#each recent as entry (`${entry.query}|${JSON.stringify(entry.scope)}`)}
        {@const Icon =
          entry.scope.type === 'translation'
            ? Languages
            : entry.scope.type === 'notes'
              ? StickyNote
              : BookOpenText}
        <li>
          <button
            type="button"
            class="again"
            aria-label={i18n.t('search.empty.again', { query: entry.query, scope: scopeName(entry.scope) })}
            onclick={() => again(entry)}
          >
            <Clock size={14} strokeWidth={1.75} aria-hidden="true" />
            <span class="query"><bdi>{entry.query}</bdi></span>
            <span class="where">
              <Icon size={12} strokeWidth={2} aria-hidden="true" />
              <span class="where-text">{scopeName(entry.scope)}</span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
  </section>
  <section class="try">
    <h3>{i18n.t('search.empty.examples')}</h3>
    {@render examples()}
  </section>
{:else}
  <EmptyState
    compact
    title={i18n.t('search.empty.title')}
    body={i18n.t('search.empty.body', { ref: i18n.ref(2, 255) })}
    action={examples}
  />
{/if}

<style>
  .recent,
  .try {
    padding-inline: var(--space-2);
  }

  .recent {
    padding-block-start: var(--space-2);
  }

  .recent-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-inline: var(--space-2) 0;
  }

  h3 {
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: var(--weight-title);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  :global(html[lang='ar']) h3 {
    letter-spacing: 0;
    text-transform: none;
  }

  .try h3 {
    padding-block: var(--space-4) var(--space-2);
    padding-inline: var(--space-2);
  }

  .recent-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .again {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    inline-size: 100%;
    min-block-size: 34px;
    padding-inline: var(--space-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease-standard);
  }

  .again:hover {
    background-color: var(--surface-hover);
  }

  .again:focus-visible {
    outline-offset: -2px;
  }

  .query {
    flex: 1 1 auto;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text);
    font-size: var(--text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .where {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 4px;
    max-inline-size: 45%;
    font-size: var(--text-2xs);
  }

  .where-text {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .examples {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-2);
  }

  .try .examples {
    justify-content: flex-start;
    padding-inline: var(--space-2);
  }

  .example {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    min-inline-size: 76px;
    min-block-size: 50px;
    padding-block: var(--space-1);
    padding-inline: var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
    color: var(--text);
    font: inherit;
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      border-color var(--dur-fast) var(--ease-standard);
  }

  .example:hover {
    border-color: var(--border-input);
    background-color: color-mix(in srgb, var(--text) 4%, var(--surface-raised));
  }

  .example-text {
    font-size: var(--text-md);
    font-weight: var(--weight-label);
    line-height: 1.4;
  }

  .example-text:lang(ar) {
    font-family: var(--font-naskh);
    font-size: 17px;
    font-weight: 400;
    line-height: 1.3;
  }

  .example-kind {
    color: var(--text-muted);
    font-size: var(--text-2xs);
    line-height: 1.2;
  }
</style>
