<!--
  VerseActions (§9.7 "ActionBar", §8.17): the ghost icon buttons at the top inline end of a verse row, shown on row
  hover or focus (and while the verse is selected): Play from here · Bookmark (pressed when bookmarked) · Highlight
  (five swatches and Remove, in a popover) · Note · Copy · Tafsir and word by word (the study pane) · More (the ayah
  context menu, §10.3; it selects the verse unless the selection holds it). Actions apply to the reader's selection
  when this verse is part of it, else to the verse (the context-menu rule, §10.3). Every result is toasted by the store
  that performs it; Copy toasts here. Owner: WP11a.
-->
<script lang="ts">
  import Bookmark from '@lucide/svelte/icons/bookmark'
  import BookmarkCheck from '@lucide/svelte/icons/bookmark-check'
  import BookOpenText from '@lucide/svelte/icons/book-open-text'
  import Copy from '@lucide/svelte/icons/copy'
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import Highlighter from '@lucide/svelte/icons/highlighter'
  import NotebookPen from '@lucide/svelte/icons/notebook-pen'
  import Play from '@lucide/svelte/icons/play'
  import X from '@lucide/svelte/icons/x'
  import type { HighlightColor } from '$lib/ipc/bindings'
  import IconButton from '$components/ui/IconButton.svelte'
  import Popover from '$components/ui/Popover.svelte'
  import { openAyahMenu } from '$lib/mushaf/interactions'
  import { i18n, library, player, quran, reader, translations, ui } from '$lib/stores'

  interface Props {
    ayahId: number
    /** The verse's current highlight colour, if any. */
    highlight: HighlightColor | null
    bookmarked: boolean
    /** The note on this verse, if any (edited instead of created). */
    noteId: string | null
  }

  let { ayahId, highlight, bookmarked, noteId }: Props = $props()

  const COLORS: readonly HighlightColor[] = ['yellow', 'green', 'blue', 'red', 'purple']

  let swatchesOpen = $state(false)

  const ref = $derived.by(() => {
    const { surah, ayah } = quran.ayahRef(ayahId)
    return i18n.ref(surah, ayah)
  })

  /** The selection when this verse is inside it, else the verse alone. */
  function target(): [number, number] {
    const s = reader.selection
    return s && ayahId >= s.fromAyahId && ayahId <= s.toAyahId ? [s.fromAyahId, s.toAyahId] : [ayahId, ayahId]
  }

  function play(): void {
    void player.playFrom({ ayahId })
  }

  function toggleBookmark(): void {
    void library.toggleBookmark(ayahId)
  }

  function setHighlight(color: HighlightColor): void {
    const [from, to] = target()
    swatchesOpen = false
    void library.setHighlight(from, to, color)
  }

  function clearHighlight(): void {
    const [from, to] = target()
    swatchesOpen = false
    void library.clearHighlight(from, to)
  }

  function note(): void {
    const [from, to] = target()
    ui.open(
      'note-editor',
      noteId ? { noteId, fromAyahId: from, toAyahId: to } : { fromAyahId: from, toAyahId: to },
    )
  }

  async function copy(): Promise<void> {
    const [from, to] = target()
    try {
      await translations.copyAyahs(from, to)
      ui.toast({ message: i18n.t('content.actions.copied', { ref: quran.refLabel(from, 'short', to) }) })
    } catch (e) {
      ui.toastError(e)
    }
  }

  function study(): void {
    const s = reader.selection
    if (!s || ayahId < s.fromAyahId || ayahId > s.toAyahId) reader.select(ayahId)
    ui.openSidePane('tafsir')
  }

  function more(e: MouseEvent & { currentTarget: HTMLButtonElement }): void {
    const r = e.currentTarget.getBoundingClientRect()
    const x = i18n.dir === 'rtl' ? r.right : r.left
    openAyahMenu({ x: Math.round(x), y: Math.round(r.bottom + 4), ayahId })
  }
</script>

<div class="actions" role="toolbar" aria-label={i18n.t('content.actions.label', { ref })}>
  <IconButton size="sm" icon={Play} label={i18n.t('content.actions.play')} onclick={play} />
  <IconButton
    size="sm"
    icon={bookmarked ? BookmarkCheck : Bookmark}
    label={i18n.t(bookmarked ? 'content.actions.unbookmark' : 'content.actions.bookmark')}
    pressed={bookmarked}
    onclick={toggleBookmark}
  />
  <Popover
    bind:open={swatchesOpen}
    side="bottom"
    align="end"
    label={i18n.t('content.highlight.label')}
    padding="sm"
  >
    {#snippet trigger({ props })}
      <IconButton
        {...props}
        size="sm"
        icon={Highlighter}
        label={i18n.t('content.actions.highlight')}
        class={highlight ? `hl hl-${highlight}` : undefined}
      />
    {/snippet}
    <div class="swatches" role="group" aria-label={i18n.t('content.highlight.label')}>
      {#each COLORS as color (color)}
        <button
          type="button"
          class="swatch"
          style:--_swatch="var(--user-hl-{color}-solid)"
          aria-label={i18n.t(`content.highlight.${color}`)}
          aria-pressed={highlight === color}
          onclick={() => setHighlight(color)}
        ></button>
      {/each}
      <span class="divider" aria-hidden="true"></span>
      <IconButton
        size="sm"
        icon={X}
        label={i18n.t('content.highlight.remove')}
        disabled={highlight === null}
        onclick={clearHighlight}
      />
    </div>
  </Popover>
  <IconButton
    size="sm"
    icon={NotebookPen}
    label={i18n.t(noteId ? 'content.actions.editNote' : 'content.actions.note')}
    onclick={note}
  />
  <IconButton size="sm" icon={Copy} label={i18n.t('content.actions.copy')} onclick={copy} />
  <IconButton size="sm" icon={BookOpenText} label={i18n.t('content.actions.study')} onclick={study} />
  <IconButton size="sm" icon={Ellipsis} label={i18n.t('content.actions.more')} onclick={more} />
</div>

<style>
  .actions {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  .actions :global(.hl) {
    color: var(--_hl, var(--text-muted));
  }

  .actions :global(.hl-yellow) {
    --_hl: var(--user-hl-yellow-solid);
  }

  .actions :global(.hl-green) {
    --_hl: var(--user-hl-green-solid);
  }

  .actions :global(.hl-blue) {
    --_hl: var(--user-hl-blue-solid);
  }

  .actions :global(.hl-red) {
    --_hl: var(--user-hl-red-solid);
  }

  .actions :global(.hl-purple) {
    --_hl: var(--user-hl-purple-solid);
  }

  .swatches {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .swatch {
    all: unset;
    box-sizing: border-box;
    inline-size: 24px;
    block-size: 24px;
    margin: 2px;
    border: 2px solid var(--surface-raised);
    border-radius: var(--radius-full);
    background-color: var(--_swatch);
    box-shadow: 0 0 0 1px var(--border-input);
    cursor: pointer;
    transition: scale var(--dur-fast) var(--ease-standard);
  }

  .swatch:hover {
    scale: 1.08;
  }

  .swatch[aria-pressed='true'] {
    box-shadow: 0 0 0 2px var(--text);
  }

  .swatch:focus-visible {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .divider {
    inline-size: 1px;
    block-size: 20px;
    margin-inline: var(--space-1);
    background-color: var(--border);
  }

  @media (forced-colors: active) {
    .swatch {
      forced-color-adjust: none;
    }
  }
</style>
