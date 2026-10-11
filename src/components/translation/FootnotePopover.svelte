<!--
  FootnotePopover (§9.7, §7.6): a translation footnote opened from its marker (`sup.fn[data-fn]`). The note is the
  pack's sanitised HTML, rendered through `SafeHtml` in the pack's language and direction; a reference inside it
  (`button[data-ref]`) goes to that ayah (`onref`). The heading names the marker and the translation ("Footnote 3 ·
  Saheeh International"); a general note (empty marker, WP5c) is titled "Translator's note". A marker the translation
  defines no note for (kept as published upstream) says so. Escape or a click outside closes it; Escape returns focus
  to the marker. Owner: WP11a.
-->
<script lang="ts">
  import type { Footnote, TextDir } from '$lib/ipc/bindings'
  import Popover from '$components/ui/Popover.svelte'
  import SafeHtml from '$components/ui/SafeHtml.svelte'
  import { i18n } from '$lib/stores'

  interface Props {
    open: boolean
    /** The marker the popover points at (or the general-note button). */
    anchor: HTMLElement | null
    /** The note, or `null` when the marker has none. */
    footnote: Footnote | null
    /** The marker text (`"3"`, `"৩"`; empty for a general note). */
    marker: string
    /** The translation's title in the UI language. */
    translator: string
    lang: string | null
    dir: TextDir
    onclose: () => void
    onref?: (ref: string) => void
  }

  let { open, anchor, footnote, marker, translator, lang, dir, onclose, onref }: Props = $props()

  const title = $derived(
    marker === '' ? i18n.t('content.footnote.note') : i18n.t('content.footnote.title', { marker }),
  )

  function onOpenChange(next: boolean): void {
    if (!next) onclose()
  }

  /** Back to the marker unless the user moved focus somewhere else (a click on another control). */
  function onCloseAutoFocus(e: Event): void {
    e.preventDefault()
    const active = document.activeElement
    if (anchor?.isConnected && (active === null || active === document.body || active.closest('.footnote')))
      anchor.focus({ preventScroll: true })
  }
</script>

<Popover
  {open}
  {onOpenChange}
  {anchor}
  side="bottom"
  align="start"
  arrow
  width={380}
  padding="none"
  label={`${title} · ${translator}`}
  {onCloseAutoFocus}
>
  <div class="footnote" data-qd-footnote={footnote?.id ?? ''}>
    <p class="head">
      <span class="title">{title}</span>
      <span class="sep" aria-hidden="true">{i18n.t('content.sep')}</span>
      <span class="translator">{translator}</span>
    </p>
    {#if footnote}
      <div class="body" lang={lang ?? undefined} {dir} data-dir={dir}>
        <SafeHtml html={footnote.html} {onref} />
      </div>
    {:else}
      <p class="body missing">{i18n.t('content.footnote.missing')}</p>
    {/if}
  </div>
</Popover>

<style>
  .footnote {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-block: var(--space-3) var(--space-4);
    padding-inline: var(--space-4);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 var(--space-1);
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
  }

  .title {
    color: var(--accent-text);
    font-weight: var(--weight-title);
  }

  .body {
    margin: 0;
    color: var(--text);
    font-family: var(--font-latin);
    font-size: 15px;
    line-height: 1.65;
    text-align: start;
    overflow-wrap: anywhere;
  }

  .body[data-dir='rtl'] {
    font-family: var(--font-naskh);
    font-size: 17px;
    line-height: 1.9;
  }

  .body[lang='ur'] {
    font-family: var(--font-nastaliq);
  }

  .missing {
    color: var(--text-muted);
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
  }

  .body :global(p) {
    margin: 0;
  }

  .body :global(p + p) {
    margin-block-start: var(--space-2);
  }
</style>
