<!--
  TranslationList (§9.7, `settings.translations`): the translations the reader shows, in order. Shown ones come first,
  in their order, each with a switch and move up / down buttons; then the other downloaded translations, off. At most
  five are shown (§5.11); the rest disable with the reason. A selected translation that is not downloaded (removed, or
  still downloading) stays in its place, marked. Without any downloaded translation the list offers Downloads.
-->
<script lang="ts">
  import { tick } from 'svelte'
  import ArrowDown from '@lucide/svelte/icons/arrow-down'
  import ArrowUp from '@lucide/svelte/icons/arrow-up'
  import Download from '@lucide/svelte/icons/download'
  import { languageName } from '$components/downloads/format'
  import { Badge, Button, IconButton, Switch } from '$components/ui'
  import { SETTING_LIMITS } from '$lib/contracts/settings'
  import type { PackInfo } from '$lib/ipc/bindings'
  import { i18n, packs, settings, translations, ui } from '$lib/stores'
  import { isInstalled, languageOf } from '$lib/stores/packs.svelte'
  import { save } from '../model'

  interface Props {
    labelledBy: string
  }

  let { labelledBy }: Props = $props()

  const MAX = SETTING_LIMITS.maxTranslations

  interface Entry {
    id: string
    title: string
    language: string
    installed: boolean
  }

  const selected = $derived(settings.value.translations)

  function entryOf(id: string, pack: PackInfo | undefined): Entry {
    return {
      id,
      title: pack ? packs.title(pack) : translations.packTitle(id),
      language: languageName(pack ? languageOf(pack) : translations.packMeta(id).language),
      installed: pack ? isInstalled(pack) : translations.packMeta(id).availability === 'installed',
    }
  }

  const shown: Entry[] = $derived(selected.map((id) => entryOf(id, packs.pack(id))))

  /** Downloaded translations not shown: the UI language first, then by language name and title. */
  const others: Entry[] = $derived(
    packs.list
      .filter((p) => p.kind === 'translation' && isInstalled(p) && !selected.includes(p.id))
      .map((p) => ({ entry: entryOf(p.id, p), first: languageOf(p) === i18n.locale }))
      .sort(
        (a, b) =>
          Number(b.first) - Number(a.first) ||
          a.entry.language.localeCompare(b.entry.language, i18n.locale) ||
          a.entry.title.localeCompare(b.entry.title, i18n.locale),
      )
      .map((x) => x.entry),
  )

  const full = $derived(selected.length >= MAX)

  function toggle(id: string, on: boolean): void {
    const next = on ? [...selected.filter((x) => x !== id), id] : selected.filter((x) => x !== id)
    void save('translations', next.slice(0, MAX))
  }

  let list: HTMLUListElement | null = $state(null)

  /**
   * Moves a shown translation one place. The keyed list moves the row's node, which drops the focus of the button
   * that was pressed: it goes back to that button in the moved row, or to the other arrow once the row reached an end
   * (that button is disabled there), so the keyboard can keep moving it.
   */
  async function move(index: number, delta: -1 | 1): Promise<void> {
    const target = index + delta
    if (target < 0 || target >= selected.length) return
    const next = [...selected]
    const [item] = next.splice(index, 1)
    if (item === undefined) return
    next.splice(target, 0, item)
    void save('translations', next)
    await tick()
    const row = list?.querySelector<HTMLElement>(`[data-pack-id="${CSS.escape(item)}"]`)
    const same = row?.querySelector<HTMLButtonElement>(`[data-move="${delta < 0 ? 'up' : 'down'}"]`)
    const other = row?.querySelector<HTMLButtonElement>(`[data-move="${delta < 0 ? 'down' : 'up'}"]`)
    ;(same && !same.disabled ? same : other)?.focus()
  }

  function getMore(): void {
    packs.filter = 'translation'
    ui.setView('downloads')
  }
</script>

{#snippet row(entry: Entry, index: number | null)}
  {@const on = index !== null}
  <li class={['entry', { on }]} data-pack-id={entry.id}>
    <Switch
      checked={on}
      onCheckedChange={(v) => toggle(entry.id, v)}
      disabled={!on && full}
      aria-label={entry.title}
    />
    <span class="names">
      <span class="title" dir="auto">{entry.title}</span>
      <span class="language">{entry.language}</span>
    </span>
    {#if !entry.installed}
      <Badge tone="warning" size="sm">{i18n.t('settings.translations.notDownloaded')}</Badge>
    {/if}
    {#if index !== null}
      <span class="order">
        <span class="position" aria-hidden="true">{i18n.num(index + 1)}</span>
        <IconButton
          size="sm"
          icon={ArrowUp}
          label={i18n.t('settings.controls.moveUp', { name: entry.title })}
          tooltip={false}
          disabled={index === 0}
          data-move="up"
          onclick={() => void move(index, -1)}
        />
        <IconButton
          size="sm"
          icon={ArrowDown}
          label={i18n.t('settings.controls.moveDown', { name: entry.title })}
          tooltip={false}
          disabled={index === selected.length - 1}
          data-move="down"
          onclick={() => void move(index, 1)}
        />
      </span>
    {/if}
  </li>
{/snippet}

<div class="translation-list">
  {#if shown.length === 0 && others.length === 0}
    <div class="empty">
      <p class="empty-title">{i18n.t('settings.translations.empty')}</p>
      <p class="empty-body">{i18n.t('settings.translations.emptyBody')}</p>
    </div>
  {:else}
    <ul class="list" aria-labelledby={labelledBy} bind:this={list}>
      {#each shown as entry, i (entry.id)}
        {@render row(entry, i)}
      {/each}
      {#each others as entry (entry.id)}
        {@render row(entry, null)}
      {/each}
    </ul>
  {/if}
  <div class="footer">
    <span class={['count', { full }]} aria-live="polite">
      {full
        ? i18n.t('settings.translations.limit', { max: MAX })
        : i18n.tp('settings.translations.selected', selected.length, { max: MAX })}
    </span>
    <Button size="sm" variant="secondary" onclick={getMore}>
      {#snippet icon()}<Download aria-hidden="true" />{/snippet}
      {i18n.t('settings.translations.getMore')}
    </Button>
  </div>
</div>

<style>
  .translation-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .list {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
  }

  .entry {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-block-size: 44px;
    padding-block: var(--space-1);
    padding-inline: var(--space-3) var(--space-2);
  }

  .entry + .entry {
    border-block-start: 1px solid var(--border);
  }

  /* The first switched-off row starts the "available" part of the list. */
  .entry.on + .entry:not(.on) {
    border-block-start-color: var(--border-strong);
  }

  .names {
    display: flex;
    flex: 1 1 auto;
    align-items: baseline;
    gap: var(--space-2);
    min-inline-size: 0;
  }

  .title {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text);
    font-size: var(--text-md);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .entry:not(.on) .title {
    color: var(--text-muted);
  }

  .language {
    flex: none;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .order {
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
  }

  .position {
    min-inline-size: 18px;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .empty {
    padding: var(--space-4);
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-md);
    text-align: center;
  }

  .empty-title {
    margin: 0;
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-label);
  }

  .empty-body {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2) var(--space-4);
  }

  .count {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .count.full {
    color: var(--warning-text);
  }
</style>
