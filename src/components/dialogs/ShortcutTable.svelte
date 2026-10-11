<!--
  ShortcutTable (§7.9, §10.1): every registered shortcut, grouped, with the keys this platform and keyboard layout show
  (`shortcuts.formatAll`: `Ctrl+K` / `⌘K`, the layout map's labels). Owner: WP7c. Embedded by the shortcut sheet and by
  Settings › Keyboard (WP12b).

  - Props: `groups` (which groups, in this order; default all, `SHORTCUT_GROUPS` order) and, beyond the §7.9 contract,
    an optional `query` that filters rows by label or key (the sheet's filter field).
  - Definitions that share a label (one action, two definitions) merge into one row; alternatives read "← or Page Down".
    Groups with nothing registered are left out. Definitions with no chord on this platform are skipped.
  - Wide containers (≥ 640 px) flow the groups into two balanced columns (a container query, so the sheet and the
    settings column both get the right layout).
-->
<script lang="ts">
  import { foldForMatch, Kbd } from '$components/ui'
  import type { ShortcutTableProps } from '$lib/contracts/components'
  import { SHORTCUT_GROUPS, type ShortcutGroup } from '$lib/contracts/shortcuts'
  import { i18n, shortcuts } from '$lib/stores'

  interface Props extends ShortcutTableProps {
    /** Filters rows by their label or keys (case- and accent-insensitive). */
    query?: string
  }

  let { groups, query = '' }: Props = $props()

  interface Row {
    id: string
    label: string
    keys: string[]
  }

  interface GroupRows {
    group: ShortcutGroup
    title: string
    rows: Row[]
  }

  const uid = $props.id()

  const all: GroupRows[] = $derived.by(() => {
    const order = groups ?? [...SHORTCUT_GROUPS]
    return order.map((group) => {
      const rows: Row[] = []
      for (const def of shortcuts.byGroup[group]) {
        if (!shortcuts.isAvailable(def)) continue
        const keys = shortcuts.formatAll(def)
        if (keys.length === 0) continue
        const label = i18n.t(def.labelKey)
        const existing = rows.find((r) => r.label === label)
        if (existing) {
          for (const k of keys) if (!existing.keys.includes(k)) existing.keys.push(k)
          continue
        }
        rows.push({ id: def.id, label, keys: [...keys] })
      }
      return { group, title: i18n.t(`shortcuts.groups.${group}`), rows }
    })
  })

  const needle = $derived(foldForMatch(query.trim()))

  const shown: GroupRows[] = $derived(
    all
      .map((g) => ({
        ...g,
        rows:
          needle === ''
            ? g.rows
            : g.rows.filter(
                (r) =>
                  foldForMatch(r.label).includes(needle) ||
                  foldForMatch(g.title).includes(needle) ||
                  r.keys.some((k) => foldForMatch(k).includes(needle)),
              ),
      }))
      .filter((g) => g.rows.length > 0),
  )
</script>

<div class="shortcut-table" data-empty={shown.length === 0 ? '' : undefined}>
  {#if shown.length === 0}
    <p class="empty" role="status">
      {needle === ''
        ? i18n.t('shell.shortcutTable.empty')
        : i18n.t('shell.shortcutSheet.noMatches', { query })}
    </p>
  {:else}
    <div class="groups">
      {#each shown as g (g.group)}
        <section class="group" aria-labelledby="{uid}-{g.group}" data-group={g.group}>
          <h3 class="heading" id="{uid}-{g.group}">{g.title}</h3>
          <dl class="rows">
            {#each g.rows as row (row.id)}
              <div class="row" data-shortcut={row.id}>
                <dt class="label">{row.label}</dt>
                <dd class="keys">
                  {#each row.keys as chord, i (chord)}
                    {#if i > 0}<span class="or">{i18n.t('shortcuts.or')}</span>{/if}
                    <Kbd {chord} size="sm" />
                  {/each}
                </dd>
              </div>
            {/each}
          </dl>
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .shortcut-table {
    container-type: inline-size;
  }

  .groups {
    column-gap: var(--space-8);
  }

  @container (min-width: 640px) {
    .groups {
      columns: 2;
    }
  }

  .group {
    break-inside: avoid;
    padding-block-end: var(--space-5);
  }

  .heading {
    margin-block-end: var(--space-1);
    padding-block-end: var(--space-1);
    border-block-end: 1px solid var(--border);
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: var(--weight-title);
    letter-spacing: 0.06em;
    line-height: var(--leading-ui);
    text-transform: uppercase;
  }

  /* Never uppercase or track Arabic (§9.7, §11.3). */
  :global(:root[lang='ar']) .heading {
    letter-spacing: 0;
    text-transform: none;
  }

  .rows {
    margin: 0;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    min-block-size: 30px;
    padding-block: var(--space-0_5);
    border-radius: var(--radius-xs);
  }

  .label {
    min-inline-size: 0;
    color: var(--text);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
  }

  .keys {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-1);
    margin: 0;
    max-inline-size: 60%;
  }

  .or {
    color: var(--text-muted);
    font-size: var(--text-2xs);
  }

  .empty {
    padding-block: var(--space-6);
    color: var(--text-muted);
    font-size: var(--text-sm);
    text-align: center;
  }
</style>
