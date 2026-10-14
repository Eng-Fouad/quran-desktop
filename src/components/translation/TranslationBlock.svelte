<!--
  TranslationBlock: one translation of a verse. An 11 px muted translator label, then the pack's sanitised
  HTML through `SafeHtml`, in the pack's language and direction (Urdu in Nastaliq when that font is installed).
  Footnotes, by `settings.footnotesInline`:
  - off (default): each marker (`sup.fn[data-fn]`) is a button that opens `FootnotePopover`;
  - on: the notes are listed under the text, and a marker moves focus to its note.
  A general note (empty marker) is a "Translator's note" button after the text (or the first inline note). A
  marker without a note upstream is plain, non-interactive text. References in the text or a note go to that ayah.
-->
<script lang="ts">
  import type { Footnote, TranslationText } from '$lib/ipc/bindings'
  import SafeHtml from '$components/ui/SafeHtml.svelte'
  import { i18n } from '$lib/stores'
  import type { PackMeta } from '$lib/stores/translations.svelte'
  import FootnotePopover from './FootnotePopover.svelte'

  interface Props {
    item: TranslationText
    meta: PackMeta
    /** The translator label in the UI language. */
    title: string
    /** List notes under the text instead of popovers. */
    inline: boolean
    /** The Urdu Nastaliq font is installed. */
    nastaliq: boolean
    onref: (ref: string) => void
  }

  let { item, meta, title, inline, nastaliq, onref }: Props = $props()

  let textEl: HTMLDivElement | undefined = $state()
  let openId: string | null = $state(null)
  let anchor: HTMLElement | null = $state(null)

  const general = $derived(item.footnotes.filter((f) => f.marker === ''))
  const numbered = $derived(item.footnotes.filter((f) => f.marker !== ''))
  const byId = $derived(new Map(item.footnotes.map((f) => [f.id, f] as const)))
  const open: Footnote | null = $derived.by(() => {
    const id = openId
    return id === null ? null : (byId.get(id) ?? null)
  })
  /** The open marker's text: the note's, else the last part of its id (`2:255:3` → `3`). */
  const openMarker = $derived.by(() => {
    const id = openId
    if (open) return open.marker
    return id === null ? '' : (id.split(':')[2] ?? '')
  })
  const domId = (f: Footnote) => `fn-${item.packId}-${f.id}`.replace(/[^\w-]/g, '_')

  // Footnote markers: interactive (with their accessible name and state) when the note exists, plain text otherwise.
  $effect(() => {
    const el = textEl
    const notes = byId
    const current = openId
    const label = (marker: string) => i18n.t('content.footnote.marker', { marker })
    if (!el) return
    for (const sup of el.querySelectorAll<HTMLElement>('sup.fn[data-fn]')) {
      const id = sup.dataset.fn ?? ''
      const note = notes.get(id)
      if (note) {
        sup.setAttribute('aria-label', label(note.marker))
        if (inline) {
          sup.removeAttribute('aria-haspopup')
          sup.removeAttribute('aria-expanded')
        } else {
          sup.setAttribute('aria-haspopup', 'dialog')
          sup.setAttribute('aria-expanded', String(current === id))
        }
        sup.classList.remove('orphan')
      } else {
        sup.removeAttribute('role')
        sup.removeAttribute('tabindex')
        sup.setAttribute('aria-hidden', 'true')
        sup.classList.add('orphan')
      }
    }
  })

  function onfootnote(id: string): void {
    const note = byId.get(id)
    if (!note || !textEl) return
    if (inline) {
      const target = document.getElementById(domId(note))
      if (target) {
        target.focus({ preventScroll: true })
        target.scrollIntoView({ block: 'nearest' })
        target.classList.remove('lit')
        void target.offsetWidth
        target.classList.add('lit')
      }
      return
    }
    const sup = [...textEl.querySelectorAll<HTMLElement>('sup.fn[data-fn]')].find((s) => s.dataset.fn === id)
    anchor = sup ?? null
    openId = openId === id ? null : id
  }

  function openGeneral(e: MouseEvent & { currentTarget: HTMLButtonElement }, note: Footnote): void {
    anchor = e.currentTarget
    openId = openId === note.id ? null : note.id
  }

  function close(): void {
    openId = null
  }
</script>

<section
  class="tr"
  class:nastaliq={nastaliq && meta.language === 'ur'}
  lang={meta.language ?? undefined}
  dir={meta.dir}
  data-pack={item.packId}
  aria-label={title}
>
  <p class="label"><span lang={i18n.locale} dir={i18n.dir}>{title}</span></p>
  <div class="text" bind:this={textEl}>
    <SafeHtml html={item.html} {onfootnote} {onref} />
    {#if !inline}
      {#each general as note (note.id)}
        <button
          type="button"
          class="general"
          aria-haspopup="dialog"
          aria-expanded={openId === note.id}
          lang={i18n.locale}
          dir={i18n.dir}
          onclick={(e) => openGeneral(e, note)}>{i18n.t('content.footnote.note')}</button
        >
      {/each}
    {/if}
  </div>
  {#if inline && item.footnotes.length > 0}
    <ol class="notes" aria-label={i18n.t('content.footnote.notes')}>
      {#each [...general, ...numbered] as note (note.id)}
        <li id={domId(note)} tabindex="-1">
          <span class="marker" lang={i18n.locale} dir={i18n.dir}
            >{note.marker === '' ? i18n.t('content.footnote.note') : note.marker}</span
          >
          <div class="note"><SafeHtml html={note.html} {onref} /></div>
        </li>
      {/each}
    </ol>
  {/if}
</section>

{#if !inline && openId !== null}
  <FootnotePopover
    open={true}
    {anchor}
    footnote={open}
    marker={openMarker}
    translator={title}
    lang={meta.language}
    dir={meta.dir}
    onclose={close}
    {onref}
  />
{/if}

<style>
  .tr {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    text-align: start;
  }

  .label {
    margin: 0;
    color: var(--text-muted);
    font-family: var(--font-ui);
    font-size: 11px;
    font-weight: var(--weight-label);
    line-height: 16px;
  }

  .text {
    color: var(--text);
    font-family: var(--font-latin);
    font-size: calc(var(--text-reading) * var(--tv-scale, 1));
    line-height: 1.7;
    overflow-wrap: break-word;
    hyphens: auto;
  }

  /* Arabic-script translations (Urdu, Persian): Naskh, taller lines; Urdu in Nastaliq when installed. */
  .tr[dir='rtl'] .text {
    font-family: var(--font-naskh);
    font-size: calc((var(--text-reading) + 2px) * var(--tv-scale, 1));
    line-height: 2;
  }

  .tr.nastaliq .text {
    font-family: var(--font-nastaliq);
    line-height: var(--leading-nastaliq);
  }

  /* Scripts with tall stacks (Bengali, Devanagari, Tamil) need a little more room than Latin. */
  .tr:is([lang='bn'], [lang='hi'], [lang='ta']) .text {
    line-height: 1.85;
  }

  .text :global(p) {
    margin: 0;
  }

  .text :global(p + p) {
    margin-block-start: 0.6em;
  }

  .text :global(sup.fn) {
    position: relative;
    inset-block-start: -0.1em;
    padding-inline: 0.18em;
    margin-inline: 0.05em;
    border-radius: var(--radius-xs);
    color: var(--accent-text);
    font-family: var(--font-latin);
    font-size: 0.66em;
    font-weight: var(--weight-title);
    line-height: 0;
    vertical-align: super;
    transition: background-color var(--dur-fast) var(--ease-standard);
  }

  .text :global(sup.fn[role='button']:hover),
  .text :global(sup.fn[aria-expanded='true']) {
    background-color: var(--accent-soft);
  }

  .text :global(sup.fn.orphan) {
    color: var(--text-faint);
    cursor: default;
  }

  .general {
    all: unset;
    display: inline-block;
    margin-inline-start: var(--space-2);
    padding-inline: var(--space-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-full);
    color: var(--accent-text);
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    font-weight: var(--weight-label);
    line-height: 18px;
    vertical-align: 0.15em;
    cursor: pointer;
  }

  .general:hover,
  .general[aria-expanded='true'] {
    background-color: var(--accent-soft);
  }

  .general:focus-visible {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .notes {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin: var(--space-2) 0 0;
    padding: var(--space-2) 0 0;
    border-block-start: 1px solid var(--border);
    list-style: none;
  }

  .notes li {
    display: flex;
    gap: var(--space-2);
    padding-block: var(--space-1);
    padding-inline: var(--space-2);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: calc(14px * var(--tv-scale, 1));
    line-height: 1.6;
    outline: none;
  }

  .notes li:focus-visible {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: -2px;
  }

  .notes li:global(.lit) {
    animation: lit 1.6s var(--ease-standard);
  }

  .marker {
    flex: none;
    min-inline-size: 1.4em;
    color: var(--accent-text);
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    font-weight: var(--weight-title);
    line-height: inherit;
  }

  .note {
    min-inline-size: 0;
  }

  .note :global(p) {
    margin: 0;
  }

  @keyframes lit {
    from {
      background-color: var(--accent-soft);
    }
    to {
      background-color: transparent;
    }
  }

  @media (forced-colors: active) {
    .text :global(sup.fn[role='button']) {
      color: LinkText;
    }
  }
</style>
