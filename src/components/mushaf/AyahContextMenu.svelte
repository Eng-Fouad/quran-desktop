<!--
  AyahContextMenu (§10.3, §7.4): the one ayah context menu of the app, opened by `ui.contextMenu = { x, y, ayahId }`
  (a right-click on the Mushaf or a verse row, the action bar's More, `Shift+F10` / the Menu key). Owner: WP11c.
  Takes no props: it reads stores (§7.9).

  - It applies to the selection when the clicked ayah lies inside it, else to that ayah (§10.3); a bookmark and the
    reading bookmark take the span's first ayah.
  - Rows (§10.3): Play from here (Ctrl/⌘+Click) · Play this ayah only · Repeat ▸ │ Bookmark (B) · Move reading bookmark
    here (Shift+B) · Highlight ▸ (1–5, Remove 0) · Add/Edit note… (N) · Add to collection ▸ │ Copy ▸ (C, Mod+Shift+C) ·
    Translation · Tafsir · Word by word │ Memorize ▸. Hints come from the shortcut registry, so they show the user's
    keyboard layout and platform. In Copy ▸, `C` marks the row that matches the user's copy format (what `C` copies).
  - It is a floating layer (§7.4): typeahead (`b` → "Bookmark") never reaches the reader shortcuts.
  - "Custom…" (repeat) and "New collection…" open small dialogs after the menu has closed.
  - It also registers the study shortcuts (`$lib/shortcuts/study`): it is the App's one always-mounted study surface.
-->
<script lang="ts">
  import Bookmark from '@lucide/svelte/icons/bookmark'
  import BookmarkMinus from '@lucide/svelte/icons/bookmark-minus'
  import BookOpenText from '@lucide/svelte/icons/book-open-text'
  import Brain from '@lucide/svelte/icons/brain'
  import Copy from '@lucide/svelte/icons/copy'
  import Eraser from '@lucide/svelte/icons/eraser'
  import FolderPlus from '@lucide/svelte/icons/folder-plus'
  import Highlighter from '@lucide/svelte/icons/highlighter'
  import Languages from '@lucide/svelte/icons/languages'
  import ListMusic from '@lucide/svelte/icons/list-music'
  import NotebookPen from '@lucide/svelte/icons/notebook-pen'
  import Play from '@lucide/svelte/icons/play'
  import Repeat from '@lucide/svelte/icons/repeat'
  import Ribbon from '@lucide/svelte/icons/ribbon'
  import WholeWord from '@lucide/svelte/icons/whole-word'
  import { onMount } from 'svelte'
  import PromptDialog from '$components/library/PromptDialog.svelte'
  import Button from '$components/ui/Button.svelte'
  import ContextMenu from '$components/ui/ContextMenu.svelte'
  import Dialog from '$components/ui/Dialog.svelte'
  import Segmented from '$components/ui/Segmented.svelte'
  import type { MenuEntry, SegmentedOption } from '$components/ui/types'
  import type { HighlightColor, SidePaneTab } from '$lib/ipc/bindings'
  import {
    clearHighlightSpan,
    copySpan,
    editNoteOn,
    highlightSpan,
    moveReadingBookmarkTo,
    openPaneFor,
    registerStudyShortcuts,
    spanAround,
    spanLabel,
    studyKey,
    toggleBookmarkAt,
    type AyahSpan,
  } from '$lib/shortcuts/study'
  import { HIGHLIGHT_COLORS } from '$lib/stores/library.svelte'
  import { app, i18n, library, memo, player, quran, settings, ui } from '$lib/stores'

  // Untracked (`onMount`): registering reads and writes the registry, which an effect would then depend on.
  onMount(() => registerStudyShortcuts())

  const target = $derived(ui.contextMenu)
  /** What the menu acts on (§10.3): the selection holding the clicked ayah, else the ayah. */
  const span: AyahSpan | null = $derived(target ? spanAround(target.ayahId) : null)
  const at = $derived(target ? { x: target.x, y: target.y } : null)

  // --- the dialogs the menu opens -----------------------------------------------------------------------------------

  /** The span a dialog works on (the menu itself has closed by then). */
  let dialogSpan = $state.raw<AyahSpan | null>(null)
  let repeatOpen = $state(false)
  let collectionOpen = $state(false)
  let ayahTimes = $state('3')
  let rangeTimes = $state('1')

  /** Opens a dialog once the menu has let go of focus (it restores focus as it closes). */
  function later(open: () => void): void {
    requestAnimationFrame(() => requestAnimationFrame(open))
  }

  function openRepeat(s: AyahSpan): void {
    dialogSpan = s
    // Start from the user's default repeat when it is one of the choices (and not "once"), else ×3.
    const preset = String(settings.value.ayahRepeat)
    ayahTimes = preset !== '1' && (TIMES as readonly string[]).includes(preset) ? preset : '3'
    rangeTimes = '1'
    later(() => (repeatOpen = true))
  }

  function openNewCollection(s: AyahSpan): void {
    dialogSpan = s
    later(() => (collectionOpen = true))
  }

  const TIMES = ['1', '2', '3', '5', '7', '10', '0'] as const
  const timesOptions: SegmentedOption[] = $derived(
    TIMES.map((v) => ({
      value: v,
      label: v === '0' ? '∞' : i18n.num(Number(v)),
    })),
  )

  function playRepeat(): void {
    const s = dialogSpan
    if (!s) return
    repeatOpen = false
    const ayahRepeat = Number(ayahTimes)
    const rangeRepeat = s.to > s.from ? Number(rangeTimes) : 1
    player.playRange(s.from, s.to, { ayahRepeat, rangeRepeat }).catch(ui.toastError)
  }

  async function createCollection(name: string): Promise<boolean> {
    const s = dialogSpan
    const created = await library.createCollection(name)
    if (!created) return false
    if (s) await library.toggleCollection(s.from, created.id)
    return true
  }

  // --- actions ---------------------------------------------------------------------------------------------------------

  function play(s: AyahSpan): void {
    player.playFrom({ ayahId: s.from }).catch(ui.toastError)
  }

  function playRange(s: AyahSpan, opts?: { ayahRepeat?: number; rangeRepeat?: number }): void {
    player.playRange(s.from, s.to, opts).catch(ui.toastError)
  }

  function pane(s: AyahSpan, tab: SidePaneTab): void {
    openPaneFor(s.from, tab)
  }

  /** "Hide from here" (§10.3): the selection, else from the ayah to the end of its surah. */
  function hideFrom(s: AyahSpan): void {
    const end = s.to > s.from ? s.to : quran.surahRange(quran.ayahRef(s.from).surah).to
    memo.startHide(s.from, end > 0 ? end : s.to)
  }

  function setStatus(s: AyahSpan, status: 'memorized' | 'learning'): void {
    memo.setStatus(s.from, s.to, status).catch(ui.toastError)
  }

  // --- rows --------------------------------------------------------------------------------------------------------------

  const playHint = $derived(i18n.t('library.menu.playHint', { mod: app.isMac ? '⌘' : 'Ctrl' }))

  function repeatItems(s: AyahSpan): MenuEntry[] {
    const one: AyahSpan = { from: s.from, to: s.from }
    const items: MenuEntry[] = [3, 5, 10].map((n) => ({
      id: `ayah-${n}`,
      label: i18n.t('library.menu.repeatAyah', { n }),
      onSelect: () => playRange(one, { ayahRepeat: n }),
    }))
    items.push({
      id: 'ayah-forever',
      label: i18n.t('library.menu.repeatAyahForever'),
      onSelect: () => playRange(one, { ayahRepeat: 0 }),
    })
    if (s.to > s.from) {
      items.push(
        { type: 'separator', id: 'repeat-sep' },
        {
          id: 'range-3',
          label: i18n.t('library.menu.repeatSelection', { n: 3 }),
          onSelect: () => playRange(s, { rangeRepeat: 3 }),
        },
        {
          id: 'range-forever',
          label: i18n.t('library.menu.repeatSelectionForever'),
          onSelect: () => playRange(s, { rangeRepeat: 0 }),
        },
      )
    }
    items.push(
      { type: 'separator', id: 'repeat-sep-2' },
      { id: 'repeat-custom', label: i18n.t('library.menu.repeatCustom'), onSelect: () => openRepeat(s) },
    )
    return items
  }

  function highlightItems(s: AyahSpan): MenuEntry[] {
    const current = library.highlightAt(s.from)
    const covered = library.highlights.some((h) => h.fromAyahId <= s.to && h.toAyahId >= s.from)
    return [
      {
        type: 'radio',
        id: 'highlight-colors',
        value: current && current.fromAyahId <= s.from && current.toAyahId >= s.to ? current.color : '',
        onValueChange: (v) => highlightSpan(s, v as HighlightColor),
        options: HIGHLIGHT_COLORS.map((color) => ({
          value: color,
          label: i18n.t(`library.colors.${color}`),
          swatch: `var(--user-hl-${color}-solid)`,
          kbd: studyKey(`study.highlight.${color}`),
        })),
      },
      { type: 'separator', id: 'highlight-sep' },
      {
        id: 'highlight-remove',
        label: i18n.t('library.menu.removeHighlight'),
        icon: Eraser,
        kbd: studyKey('study.removeHighlight'),
        disabled: !covered,
        onSelect: () => clearHighlightSpan(s),
      },
    ]
  }

  function collectionItems(s: AyahSpan): MenuEntry[] {
    const bookmark = library.bookmarkOf(s.from)
    const items: MenuEntry[] = library.collections.map((c) => ({
      type: 'checkbox',
      id: `collection-${c.id}`,
      label: c.name,
      checked: bookmark?.collectionIds.includes(c.id) ?? false,
      onCheckedChange: () => void library.toggleCollection(s.from, c.id),
    }))
    if (items.length > 0) items.push({ type: 'separator', id: 'collections-sep' })
    items.push({
      id: 'collection-new',
      label: i18n.t('library.menu.newCollection'),
      onSelect: () => openNewCollection(s),
    })
    return items
  }

  /**
   * The copy row that does exactly what `C` does: `C` copies in the user's copy format (Settings › Copy, §5.5), which is
   * "With translation" when a copy translation is set (then also `Mod+Shift+C`), else the Arabic with or without its
   * reference. Only that row carries the `C` hint.
   */
  const formatRow = $derived.by((): 'copy-reference' | 'copy-arabic' | 'copy-translation' => {
    const copy = settings.value.copy
    if (copy.translationPackId !== null) return 'copy-translation'
    return copy.includeReference ? 'copy-reference' : 'copy-arabic'
  })

  function copyItems(s: AyahSpan): MenuEntry[] {
    const ref = quran.refLabel(s.from, 'short', s.to !== s.from ? s.to : undefined)
    const copyKey = studyKey('study.copy')
    return [
      {
        id: 'copy-reference',
        label: i18n.t('library.menu.copyWithReference'),
        kbd: formatRow === 'copy-reference' ? copyKey : undefined,
        onSelect: () => void copySpan(s, 'withReference'),
      },
      {
        id: 'copy-arabic',
        label: i18n.t('library.menu.copyArabic'),
        kbd: formatRow === 'copy-arabic' ? copyKey : undefined,
        onSelect: () => void copySpan(s, 'arabic'),
      },
      {
        id: 'copy-translation',
        label: i18n.t('library.menu.copyWithTranslation'),
        kbd: formatRow === 'copy-translation' ? copyKey : studyKey('study.copyWithTranslation'),
        onSelect: () => void copySpan(s, 'withTranslation'),
      },
      {
        id: 'copy-ref-only',
        label: i18n.t('library.menu.copyReference', { ref }),
        onSelect: () => void copySpan(s, 'reference'),
      },
    ]
  }

  const items: MenuEntry[] = $derived.by(() => {
    const s = span
    if (s === null) return []
    const single = s.to === s.from
    const bookmarked = library.bookmarkedAyahs.has(s.from)
    const note = library.noteFor(s.from, s.to)
    return [
      { id: 'play', label: i18n.t('library.menu.play'), icon: Play, kbd: playHint, onSelect: () => play(s) },
      {
        id: 'play-only',
        label: i18n.t(single ? 'library.menu.playOnly' : 'library.menu.playSelection'),
        icon: ListMusic,
        onSelect: () => playRange(s),
      },
      {
        type: 'submenu',
        id: 'repeat',
        label: i18n.t('library.menu.repeat'),
        icon: Repeat,
        items: repeatItems(s),
      },
      { type: 'separator', id: 'sep-1' },
      {
        id: 'bookmark',
        label: i18n.t(bookmarked ? 'library.menu.removeBookmark' : 'library.menu.bookmark'),
        icon: bookmarked ? BookmarkMinus : Bookmark,
        kbd: studyKey('study.bookmark'),
        onSelect: () => toggleBookmarkAt(s.from),
      },
      {
        id: 'reading-bookmark',
        label: i18n.t('library.menu.readingBookmark'),
        icon: Ribbon,
        kbd: studyKey('study.readingBookmark'),
        onSelect: () => moveReadingBookmarkTo(s.from),
      },
      {
        type: 'submenu',
        id: 'highlight',
        label: i18n.t('library.menu.highlight'),
        icon: Highlighter,
        items: highlightItems(s),
      },
      {
        id: 'note',
        label: i18n.t(note ? 'library.menu.editNote' : 'library.menu.addNote'),
        icon: NotebookPen,
        kbd: studyKey('study.note'),
        onSelect: () => editNoteOn(s),
      },
      {
        type: 'submenu',
        id: 'collections',
        label: i18n.t('library.menu.addToCollection'),
        icon: FolderPlus,
        items: collectionItems(s),
      },
      { type: 'separator', id: 'sep-2' },
      { type: 'submenu', id: 'copy', label: i18n.t('library.menu.copy'), icon: Copy, items: copyItems(s) },
      {
        id: 'pane-translation',
        label: i18n.t('library.menu.translation'),
        icon: Languages,
        onSelect: () => pane(s, 'translation'),
      },
      {
        id: 'pane-tafsir',
        label: i18n.t('library.menu.tafsir'),
        icon: BookOpenText,
        onSelect: () => pane(s, 'tafsir'),
      },
      {
        id: 'pane-words',
        label: i18n.t('library.menu.words'),
        icon: WholeWord,
        onSelect: () => pane(s, 'words'),
      },
      { type: 'separator', id: 'sep-3' },
      {
        type: 'submenu',
        id: 'memorize',
        label: i18n.t('library.menu.memorize'),
        icon: Brain,
        items: [
          { id: 'memo-hide', label: i18n.t('library.menu.hideFromHere'), onSelect: () => hideFrom(s) },
          {
            id: 'memo-test',
            label: i18n.t('library.menu.selfTest'),
            onSelect: () => ui.open('self-test', { fromAyahId: s.from, toAyahId: s.to }),
          },
          { type: 'separator', id: 'memo-sep' },
          {
            id: 'memo-memorized',
            label: i18n.t('library.menu.markMemorized'),
            onSelect: () => setStatus(s, 'memorized'),
          },
          {
            id: 'memo-learning',
            label: i18n.t('library.menu.markLearning'),
            onSelect: () => setStatus(s, 'learning'),
          },
        ],
      },
    ]
  })

  const label = $derived(span ? i18n.t('library.menu.label', { ref: spanLabel(span) }) : undefined)
  const dialogRef = $derived(dialogSpan ? spanLabel(dialogSpan) : '')
</script>

<ContextMenu {at} onClose={() => ui.closeContextMenu()} {items} {label} />

<Dialog
  bind:open={repeatOpen}
  title={i18n.t('library.repeatDialog.title')}
  description={i18n.t('library.repeatDialog.description', { ref: dialogRef })}
  size="sm"
>
  <div class="repeat">
    <div class="repeat-row">
      <span class="repeat-label" id="qd-repeat-ayah">{i18n.t('library.repeatDialog.eachAyah')}</span>
      <Segmented
        options={timesOptions}
        bind:value={ayahTimes}
        label={i18n.t('library.repeatDialog.eachAyah')}
        size="sm"
        fullWidth
      />
    </div>
    {#if dialogSpan && dialogSpan.to > dialogSpan.from}
      <div class="repeat-row">
        <span class="repeat-label">{i18n.t('library.repeatDialog.wholeRange')}</span>
        <Segmented
          options={timesOptions}
          bind:value={rangeTimes}
          label={i18n.t('library.repeatDialog.wholeRange')}
          size="sm"
          fullWidth
        />
      </div>
    {/if}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (repeatOpen = false)}>{i18n.t('common.cancel')}</Button>
    <Button variant="primary" onclick={playRepeat}>
      {#snippet icon()}<Play size={16} strokeWidth={2} aria-hidden="true" />{/snippet}
      {i18n.t('common.play')}
    </Button>
  {/snippet}
</Dialog>

<PromptDialog
  bind:open={collectionOpen}
  title={i18n.t('library.collectionDialog.title')}
  description={i18n.t('library.collectionDialog.addsAyah', { ref: dialogRef })}
  label={i18n.t('library.collectionDialog.name')}
  placeholder={i18n.t('library.collectionDialog.placeholder')}
  confirmLabel={i18n.t('library.collectionDialog.createAndAdd')}
  maxLength={100}
  onsubmit={createCollection}
/>

<style>
  .repeat {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .repeat-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .repeat-label {
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
  }
</style>
