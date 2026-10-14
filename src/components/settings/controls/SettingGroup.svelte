<!--
  SettingGroup: a titled card of setting rows inside a section, rows separated by hairlines. While a search
  runs, a group whose rows are all hidden hides too (CSS `:has`), so results read as short cards.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import { i18n } from '$lib/stores'
  import type { SettingsGroup } from '../meta'
  import { settingsSearch } from './context'

  interface Props {
    id: SettingsGroup
    /** No visible title (the section title says it all); the title still names the group for screen readers. */
    untitled?: boolean
    /** A line under the title. */
    hint?: string
    /** Content after the card (a note, a link). */
    footer?: Snippet
    children: Snippet
  }

  let { id, untitled = false, hint, footer, children }: Props = $props()

  const uid = $props.id()
  const search = settingsSearch()
</script>

<section
  class={['group', { searching: search.active }]}
  data-group={id}
  aria-labelledby={untitled ? undefined : `${uid}-title`}
  aria-label={untitled ? i18n.t(`settings.groups.${id}`) : undefined}
>
  {#if !untitled}
    <header class="head">
      <h3 id="{uid}-title" class="title">{i18n.t(`settings.groups.${id}`)}</h3>
      {#if hint}<p class="hint">{hint}</p>{/if}
    </header>
  {/if}
  <div class="card">
    {@render children()}
  </div>
  {#if footer}<div class="footer">{@render footer()}</div>{/if}
</section>

<style>
  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* While searching, a group with no visible row has nothing to show. */
  .group.searching:not(:has(:global([data-row]:not([hidden])))) {
    display: none;
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-inline: var(--space-1);
  }

  .title {
    margin: 0;
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .hint {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
  }

  .card {
    container: settings-card / inline-size;
    overflow: clip;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-1);
  }

  /* A hairline above every visible row but the first visible one (hidden rows leave no double lines). */
  .card > :global([data-row]:not([hidden]) ~ [data-row]:not([hidden])) {
    border-block-start: 1px solid var(--border);
  }

  .footer {
    padding-inline: var(--space-1);
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
  }
</style>
