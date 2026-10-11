<!--
  SettingRow (§9.7): one row of a settings card. At least 56 px tall: the label (text-md 500) and description (text-sm
  muted) at the start, the control at the end; `stack` puts the control under the text (cards, lists). In a narrow
  card every row stacks. Texts come from `settingsMeta` (`meta.ts`) unless overridden.

  The control snippet receives the ids to wire: `labelId` (`aria-labelledby`), `descriptionId` (`aria-describedby`)
  and `controlId` (give it to the control when `labelFor` makes the label a `<label for>`, so a click on the label
  toggles a switch). The row hides itself while a search does not match it, and scrolls into view with a brief accent
  wash when it is the view's target (a search result that was opened, a deep link).
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import { Kbd } from '$components/ui'
  import type { ShortcutLabelKey } from '$lib/contracts/i18n'
  import { i18n, settings } from '$lib/stores'
  import { metaOf, type RowId } from '../meta'
  import { settingsView } from '../view.svelte'
  import { type RowIds, settingsSearch, shortcutLabel } from './context'

  interface Props {
    id: RowId
    layout?: 'inline' | 'stack'
    /** Overrides the label from `settingsMeta`. */
    label?: string
    /** Overrides the description from `settingsMeta`; `''` shows none. */
    description?: string
    /** One more line under the description (why a control is off, what a value does). */
    note?: string
    noteTone?: 'muted' | 'warning'
    /** Dims the texts (the control disables itself). */
    disabled?: boolean
    /** The label is a `<label for={controlId}>` (switches, selects). */
    labelFor?: boolean
    /** A shortcut (`shortcuts.*` label key) shown as keycaps after the description. */
    shortcut?: ShortcutLabelKey
    /** An icon or picture before the texts. */
    leading?: Snippet
    control?: Snippet<[RowIds]>
    /** Content under the row's text and control (facts, a table). */
    body?: Snippet<[RowIds]>
  }

  let {
    id,
    layout = 'inline',
    label,
    description,
    note,
    noteTone = 'muted',
    disabled = false,
    labelFor = false,
    shortcut,
    leading,
    control,
    body,
  }: Props = $props()

  const uid = $props.id()
  const search = settingsSearch()
  const meta = $derived(metaOf(id))

  const labelText = $derived(label ?? (meta ? i18n.t(meta.label) : id))
  const descriptionText = $derived(description ?? (meta?.description ? i18n.t(meta.description) : ''))
  const keys = $derived(shortcut ? shortcutLabel(shortcut) : '')
  const ids: RowIds = $derived({
    labelId: `${uid}-label`,
    // The description and the note both describe the control (a note says why it is off, or what a value does).
    descriptionId:
      [descriptionText || keys ? `${uid}-description` : '', note ? `${uid}-note` : '']
        .filter(Boolean)
        .join(' ') || undefined,
    controlId: `${uid}-control`,
  })
  const hidden = $derived(!search.visible(id))

  let row: HTMLElement | null = $state(null)
  let flash = $state(false)

  // Bring the target row into view once it renders, then wash it in the accent for a moment.
  $effect(() => {
    if (settingsView.target !== id || !row || hidden) return
    const el = row
    const frame = requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'center', behavior: settings.reducedMotion ? 'instant' : 'smooth' })
      flash = true
      settingsView.target = null
    })
    return () => cancelAnimationFrame(frame)
  })

  $effect(() => {
    if (!flash) return
    const timer = setTimeout(() => (flash = false), 1600)
    return () => clearTimeout(timer)
  })
</script>

<div
  bind:this={row}
  class={['row', layout, { disabled, flash, 'has-leading': leading }]}
  data-row={id}
  {hidden}
>
  {#if leading}<div class="leading">{@render leading()}</div>{/if}
  <div class="text">
    {#if labelFor}
      <label class="label" id={ids.labelId} for={ids.controlId}>{labelText}</label>
    {:else}
      <span class="label" id={ids.labelId}>{labelText}</span>
    {/if}
    {#if descriptionText || keys}
      <p class="description" id="{uid}-description">
        {descriptionText}{#if keys}<Kbd chord={keys} size="sm" class="kbd" />{/if}
      </p>
    {/if}
    {#if note}<p class={['note', noteTone]} id="{uid}-note">{note}</p>{/if}
  </div>
  {#if control}
    <div class="control">{@render control(ids)}</div>
  {/if}
  {#if body}
    <div class="body">{@render body(ids)}</div>
  {/if}
</div>

<style>
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'text control'
      'body body';
    align-items: center;
    column-gap: var(--space-6);
    min-block-size: 56px;
    padding-block: var(--space-3);
    padding-inline: var(--space-4);
    scroll-margin-block: var(--space-16);
    transition: background-color var(--dur-slow) var(--ease-standard);
  }

  .row[hidden] {
    display: none;
  }

  .row.has-leading {
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas:
      'leading text control'
      'leading body body';
  }

  .leading {
    grid-area: leading;
    align-self: start;
    margin-inline-end: calc(var(--space-4) - var(--space-6));
  }

  .row.stack {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      'text'
      'control'
      'body';
    row-gap: var(--space-3);
  }

  .row.flash {
    background-color: var(--accent-soft);
  }

  .text {
    grid-area: text;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }

  .label {
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-label);
    line-height: var(--leading-title);
  }

  label.label {
    cursor: pointer;
  }

  .description,
  .note {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
    text-wrap: pretty;
  }

  .description :global(.kbd) {
    margin-inline-start: var(--space-2);
    vertical-align: 1px;
  }

  .note.warning {
    color: var(--warning-text);
  }

  .disabled .label,
  .disabled .description {
    color: var(--text-faint);
  }

  .disabled label.label {
    cursor: default;
  }

  .control {
    grid-area: control;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    min-inline-size: 0;
  }

  /* A stacked control (cards, lists) takes the row's whole width. */
  .stack .control {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    justify-content: stretch;
  }

  .body {
    grid-area: body;
    min-inline-size: 0;
  }

  .row:not(.stack) .body {
    margin-block-start: var(--space-3);
  }

  /* A narrow card stacks every row: the control goes under its text, at the start. */
  @container settings-card (max-width: 480px) {
    .row {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas:
        'text'
        'control'
        'body';
      row-gap: var(--space-2);
    }

    .row.has-leading {
      grid-template-columns: auto minmax(0, 1fr);
      grid-template-areas:
        'leading text'
        'leading control'
        'leading body';
    }

    .control {
      justify-content: flex-start;
    }
  }

  @media (forced-colors: active) {
    .row.flash {
      outline: 2px solid Highlight;
      outline-offset: -2px;
    }
  }
</style>
