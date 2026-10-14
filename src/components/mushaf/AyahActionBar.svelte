<!--
  AyahActionBar. The floating toolbar that makes the ayah actions discoverable for mouse users, mounted once by the
  Mushaf view; takes no props.

  - Appears 120 ms after a **pointer** click-selection (`interactions.ts` → `qd:action-bar`), never on hover or
    keyboard focus, and only with `settings.ayahActionBar`.
  - Anchors above the selection's first line (the selection ring the highlight layer draws), centred on it, and flips
    below the selection's last line near the top of the canvas, so it never covers the selected words. It stays inside
    the canvas and clear of the player dock.
  - 36 px tall, `radius-full`, `--surface-raised`, `shadow-2`; IconButtons of 32 px: Play from here · Repeat ▾ ·
    Bookmark (pressed) · Highlight (five swatches + remove, a floating popover) · Note · Copy · Translation and tafsir
    (opens the side pane) · More (the ayah context menu).
  - Dismissed on Escape (that Escape closes only the bar; the next one clears the selection), an outside press, a
    scroll, a page turn, a selection change (a new click re-shows it for the new selection), leaving the reader, or the
    context menu opening. No motion under reduced motion.
  - `role="toolbar"` with one tab stop; ←/→ (mirrored in RTL), Home and End move between its buttons. Being a toolbar,
    its plain keys never reach the reader shortcuts (the widget guard).
-->
<script lang="ts">
  import Bookmark from '@lucide/svelte/icons/bookmark'
  import BookmarkCheck from '@lucide/svelte/icons/bookmark-check'
  import BookOpenText from '@lucide/svelte/icons/book-open-text'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import Copy from '@lucide/svelte/icons/copy'
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import Eraser from '@lucide/svelte/icons/eraser'
  import Highlighter from '@lucide/svelte/icons/highlighter'
  import NotebookPen from '@lucide/svelte/icons/notebook-pen'
  import Play from '@lucide/svelte/icons/play'
  import Repeat from '@lucide/svelte/icons/repeat'
  import { Portal } from 'bits-ui'
  import { tick, untrack } from 'svelte'
  import { fade, fly } from 'svelte/transition'
  import IconButton from '$components/ui/IconButton.svelte'
  import Menu from '$components/ui/Menu.svelte'
  import Popover from '$components/ui/Popover.svelte'
  import type { MenuEntry } from '$components/ui/types'
  import type { ShortcutDef } from '$lib/contracts/shortcuts'
  import type { HighlightColor } from '$lib/ipc/bindings'
  import { ACTION_BAR_EVENT, type ActionBarRequest, openAyahMenu } from '$lib/mushaf/interactions'
  import {
    app,
    i18n,
    library,
    player,
    quran,
    reader,
    settings,
    shortcuts,
    translations,
    ui,
  } from '$lib/stores'

  /** Bar height, the gap to the selection, and the margin kept to the canvas edges (CSS px). */
  const BAR_H = 36
  const GAP = 8
  const EDGE = 8
  const COLORS: readonly HighlightColor[] = ['yellow', 'green', 'blue', 'red', 'purple']

  let open = $state(false)
  /** The selection the bar was opened for: any other selection dismisses it. */
  let openFor: typeof reader.selection = null
  let place = $state.raw<{ left: number; top: number; side: 'above' | 'below' } | null>(null)
  let bar: HTMLDivElement | undefined = $state()
  let width = $state(0)
  let repeatOpen = $state(false)
  let swatchesOpen = $state(false)
  /** A layer the bar opened is showing: it handles its own Escape and outside clicks first. */
  const layerUp = $derived(repeatOpen || swatchesOpen)

  const selection = $derived(reader.selection)
  /** The action target: the selection's first ayah. */
  const target = $derived(selection?.fromAyahId ?? null)
  const refLabel = $derived(selection ? quran.refLabel(selection.fromAyahId, 'long', selection.toAyahId) : '')

  const bookmarked = $derived(target !== null && library.bookmarkedAyahs.has(target))
  const currentColor: HighlightColor | null = $derived.by(() => {
    if (target === null) return null
    return library.highlights.findLast((h) => target >= h.fromAyahId && target <= h.toAyahId)?.color ?? null
  })
  const note = $derived(
    target === null ? undefined : library.notes.find((n) => target >= n.fromAyahId && target <= n.toAyahId),
  )

  const duration = $derived(settings.reducedMotion ? 0 : 150)

  // --- open, place, dismiss ----------------------------------------------------------------------------------------

  function dismiss(): void {
    // Keyboard focus inside the bar returns to the ayah's roving item rather than falling to <body>.
    if (
      open &&
      bar &&
      document.activeElement instanceof HTMLElement &&
      bar.contains(document.activeElement)
    ) {
      const item =
        target === null ? null : document.querySelector<HTMLElement>(`.mp-a11y li[data-ayah="${target}"]`)
      ;(item ?? document.querySelector<HTMLElement>('main'))?.focus({ preventScroll: true })
    }
    open = false
    place = null
    openFor = null
    repeatOpen = false
    swatchesOpen = false
  }

  $effect(() => {
    const on = (e: CustomEvent<ActionBarRequest>) => {
      if (!e.detail.open) return dismiss()
      if (!settings.value.ayahActionBar || reader.selection === null || ui.view !== 'reader') return
      openFor = reader.selection
      open = true
      void tick().then(reposition)
    }
    window.addEventListener(ACTION_BAR_EVENT, on)
    return () => window.removeEventListener(ACTION_BAR_EVENT, on)
  })

  // A page turn, a zoom, another selection, another view, the context menu or the setting dismiss the bar.
  $effect(() => {
    const sel = reader.selection
    void reader.visiblePages
    const view = ui.view
    const menu = ui.contextMenu
    const enabled = settings.value.ayahActionBar
    untrack(() => {
      if (open && (sel !== openFor || view !== 'reader' || menu !== null || !enabled)) dismiss()
    })
  })

  // A new size of the pages (zoom, the side pane docking) moves the selection: follow it.
  $effect(() => {
    void reader.qfs
    void width
    if (untrack(() => open)) requestAnimationFrame(reposition)
  })

  $effect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || layerUp) return
      // This Escape is the bar's: the reader's own Escape (clear the selection) waits for the next one. The shortcut
      // store decides a capture Escape after propagation and skips one a handler consumed.
      e.preventDefault()
      dismiss()
    }
    const onPointerDown = (e: PointerEvent) => {
      if (layerUp) return
      if (bar && e.target instanceof Node && bar.contains(e.target)) return
      dismiss()
    }
    const onScroll = (e: Event) => {
      // Scrolling inside a menu or popover the bar opened is not a scroll of the page.
      if (layerUp || (bar && e.target instanceof Node && bar.contains(e.target))) return
      dismiss()
    }
    const onResize = () => requestAnimationFrame(reposition)
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  })

  interface Box {
    left: number
    top: number
    right: number
    bottom: number
  }

  const union = (rects: readonly Box[]): Box => ({
    left: Math.min(...rects.map((r) => r.left)),
    top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  })

  /** The selection's first and last line on the first page that shows it (the highlight layer's ring pills). */
  function selectionLines(): { first: Box; last: Box; page: Box | null } | null {
    const rings = [...document.querySelectorAll<HTMLElement>('.mp-hl .hl-selection-ring')]
      .map((ring) => ({
        page: Number(ring.closest<HTMLElement>('.mp-hl')?.dataset.page),
        rect: ring.getBoundingClientRect(),
      }))
      .filter((r) => Number.isInteger(r.page) && r.rect.width > 0)
    if (rings.length === 0) return null
    const firstPage = Math.min(...rings.map((r) => r.page))
    const rects = rings.filter((r) => r.page === firstPage).map((r) => r.rect)
    const top = Math.min(...rects.map((r) => r.top))
    const bottom = Math.max(...rects.map((r) => r.bottom))
    const section =
      document.querySelector(`section.mp[data-page="${firstPage}"]`)?.getBoundingClientRect() ?? null
    return {
      first: union(rects.filter((r) => r.top - top < 1)),
      last: union(rects.filter((r) => bottom - r.bottom < 1)),
      page: section,
    }
  }

  /** Places the bar above the selection's first line, else below its last line, inside the canvas and above the dock. */
  function reposition(): void {
    if (!open) return
    const lines = selectionLines()
    if (!lines) return dismiss()
    const canvas = document.querySelector('main')?.getBoundingClientRect()
    const area: Box = canvas ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
    let floor = area.bottom
    const dock = document
      .querySelector('[data-qd-region="dock"] [data-qd-dock-pill]')
      ?.getBoundingClientRect()
    if (dock && dock.height > 0 && dock.top > area.top) floor = Math.min(floor, dock.top)
    let side: 'above' | 'below' = 'above'
    let top = lines.first.top - GAP - BAR_H
    if (top < area.top + EDGE) {
      side = 'below'
      top = lines.last.bottom + GAP
      // No room below either (a selection taller than the canvas): keep it at the top edge.
      if (top + BAR_H > floor - EDGE) {
        side = 'above'
        top = area.top + EDGE
      }
    }
    const w = width > 0 ? width : 320
    // Centred on the first line, kept on its page when the page is wide enough, and always inside the canvas.
    const centre = (lines.first.left + lines.first.right) / 2
    const page = lines.page && lines.page.right - lines.page.left >= w + 2 * EDGE ? lines.page : area
    const lo = Math.max(area.left, page.left) + EDGE
    const hi = Math.min(area.right, page.right) - EDGE - w
    const left = Math.max(lo, Math.min(hi, centre - w / 2))
    place = { left: Math.round(left), top: Math.round(top), side }
  }

  // --- actions -------------------------------------------------------------------------------------------------------

  /** A synthetic shortcut definition for keycap hints (`shortcuts.format` reads only its keys). */
  const hint = (key: string): string =>
    shortcuts.format({
      id: 'interactions.hint',
      keys: [key],
      group: 'study',
      labelKey: 'shortcuts.study.bookmark',
      scope: 'reader',
      run: () => undefined,
    } satisfies ShortcutDef)

  /** "Ctrl+Click" / "⌘+Click": the page gesture that plays from an ayah. */
  const playHint = $derived(i18n.t('interactions.actionBar.playHint', { mod: app.isMac ? '⌘' : 'Ctrl' }))

  function play(): void {
    if (target === null) return
    dismiss()
    player.playFrom({ ayahId: target }).catch(ui.toastError)
  }

  function repeat(from: number, to: number, opts: { ayahRepeat?: number; rangeRepeat?: number }): void {
    dismiss()
    player.playRange(from, to, opts).catch(ui.toastError)
  }

  const repeatItems: MenuEntry[] = $derived.by(() => {
    const sel = selection
    if (!sel) return []
    const one = sel.fromAyahId
    const ayah: MenuEntry[] = [3, 5, 10].map((n) => ({
      id: `ayah-${n}`,
      label: i18n.t('interactions.actionBar.repeatAyah', { n: i18n.num(n) }),
      onSelect: () => repeat(one, one, { ayahRepeat: n }),
    }))
    ayah.push({
      id: 'ayah-forever',
      label: i18n.t('interactions.actionBar.repeatAyahForever'),
      onSelect: () => repeat(one, one, { ayahRepeat: 0 }),
    })
    if (sel.toAyahId === sel.fromAyahId) return ayah
    return [
      ...ayah,
      { type: 'separator', id: 'sep' },
      {
        id: 'range-3',
        label: i18n.t('interactions.actionBar.repeatSelection', { n: i18n.num(3) }),
        onSelect: () => repeat(sel.fromAyahId, sel.toAyahId, { rangeRepeat: 3 }),
      },
      {
        id: 'range-forever',
        label: i18n.t('interactions.actionBar.repeatSelectionForever'),
        onSelect: () => repeat(sel.fromAyahId, sel.toAyahId, { rangeRepeat: 0 }),
      },
    ]
  })

  function toggleBookmark(): void {
    if (target !== null) library.toggleBookmark(target).catch(ui.toastError)
  }

  function setColor(color: HighlightColor): void {
    swatchesOpen = false
    if (selection) library.setHighlight(selection.fromAyahId, selection.toAyahId, color).catch(ui.toastError)
  }

  function clearColor(): void {
    swatchesOpen = false
    if (selection) library.clearHighlight(selection.fromAyahId, selection.toAyahId).catch(ui.toastError)
  }

  function editNote(): void {
    if (!selection) return
    const { fromAyahId, toAyahId } = selection
    dismiss()
    ui.open('note-editor', note ? { noteId: note.id, fromAyahId, toAyahId } : { fromAyahId, toAyahId })
  }

  /** Copies the selection in the user's copy format (`settings.copy`) and names it in the toast. */
  async function copy(): Promise<void> {
    if (!selection) return
    const { fromAyahId, toAyahId } = selection
    const ref = refLabel
    dismiss()
    try {
      await translations.copyAyahs(fromAyahId, toAyahId)
      ui.toast({ message: i18n.t('interactions.actionBar.copied', { ref }), tone: 'success' })
    } catch (e) {
      console.warn('[qd] copy failed', e)
      ui.toast({ message: i18n.t('interactions.actionBar.copyFailed', { ref }), tone: 'danger' })
    }
  }

  function study(): void {
    const tab = settings.value.sidePane.tab
    dismiss()
    ui.openSidePane(tab === 'tafsir' ? 'tafsir' : 'translation')
  }

  function more(e: MouseEvent): void {
    if (target === null) return
    const button = e.currentTarget instanceof HTMLElement ? e.currentTarget.getBoundingClientRect() : null
    const x = button ? Math.round(button.left + button.width / 2) : e.clientX
    const y = button ? Math.round(button.bottom) : e.clientY
    const ayahId = target
    dismiss()
    openAyahMenu({ x, y, ayahId })
  }

  // --- toolbar keyboard (roving tab stop) --------------------------------------------------------------------------

  function buttons(): HTMLButtonElement[] {
    return bar ? [...bar.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')] : []
  }

  /** One tab stop: the button that last had focus (initially the first). */
  function rove(active: HTMLElement | null): void {
    const all = buttons()
    const current = active && all.includes(active as HTMLButtonElement) ? active : all[0]
    for (const b of all) b.tabIndex = b === current ? 0 : -1
  }

  $effect(() => {
    if (open && bar) rove(null)
  })

  function onkeydown(e: KeyboardEvent): void {
    const all = buttons()
    const i = all.findIndex((b) => b === document.activeElement)
    if (i < 0) return
    const forward = i18n.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight'
    const back = i18n.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft'
    let next = -1
    if (e.key === forward) next = (i + 1) % all.length
    else if (e.key === back) next = (i - 1 + all.length) % all.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = all.length - 1
    if (next < 0) return
    e.preventDefault()
    all[next]?.focus()
  }

  function onfocusin(e: FocusEvent): void {
    if (e.target instanceof HTMLElement) rove(e.target)
  }

  function swatchKey(e: KeyboardEvent): void {
    const group = e.currentTarget instanceof HTMLElement ? e.currentTarget : null
    const all = group ? [...group.querySelectorAll<HTMLButtonElement>('button')] : []
    const i = all.findIndex((b) => b === document.activeElement)
    if (i < 0) return
    const forward = i18n.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight'
    const back = i18n.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft'
    const step = e.key === forward ? 1 : e.key === back ? -1 : 0
    if (step === 0) return
    e.preventDefault()
    all[(i + step + all.length) % all.length]?.focus()
  }

  /** Initial focus in the swatch popover: the current colour, else the first swatch. */
  function focusSwatch(e: Event): void {
    e.preventDefault()
    const pick = currentColor ?? 'yellow'
    document.querySelector<HTMLButtonElement>(`.ab-swatches [data-color="${pick}"]`)?.focus()
  }
</script>

{#if open && selection}
  <Portal>
    <div
      bind:this={bar}
      bind:offsetWidth={width}
      class="ab"
      role="toolbar"
      aria-orientation="horizontal"
      aria-label={i18n.t('interactions.actionBar.label', { ref: refLabel })}
      data-side={place?.side ?? 'above'}
      data-qd-keep-selection
      style:translate={place ? `${place.left}px ${place.top}px` : undefined}
      style:visibility={place ? 'visible' : 'hidden'}
      tabindex="-1"
      {onkeydown}
      {onfocusin}
      in:fly={{ y: place?.side === 'below' ? -4 : 4, duration }}
      out:fade={{ duration: settings.reducedMotion ? 0 : 100 }}
    >
      <IconButton
        label={i18n.t('interactions.actionBar.play')}
        shortcut={playHint}
        icon={Play}
        onclick={play}
      />
      <Menu
        items={repeatItems}
        bind:open={repeatOpen}
        side={place?.side === 'below' ? 'bottom' : 'top'}
        align="center"
      >
        {#snippet trigger({ props })}
          <IconButton {...props} label={i18n.t('interactions.actionBar.repeat')} class="ab-wide">
            <Repeat size={18} strokeWidth={1.75} aria-hidden="true" />
            <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
          </IconButton>
        {/snippet}
      </Menu>

      <span class="ab-sep" aria-hidden="true"></span>

      <IconButton
        label={i18n.t(
          bookmarked ? 'interactions.actionBar.removeBookmark' : 'interactions.actionBar.bookmark',
        )}
        shortcut={hint('b')}
        pressed={bookmarked}
        icon={bookmarked ? BookmarkCheck : Bookmark}
        onclick={toggleBookmark}
      />
      <Popover
        bind:open={swatchesOpen}
        side={place?.side === 'below' ? 'bottom' : 'top'}
        padding="sm"
        label={i18n.t('interactions.actionBar.highlightColors')}
        onOpenAutoFocus={focusSwatch}
      >
        {#snippet trigger({ props })}
          <IconButton
            {...props}
            label={i18n.t('interactions.actionBar.highlight')}
            pressed={currentColor !== null}
            class="ab-highlight"
          >
            <Highlighter size={18} strokeWidth={1.75} aria-hidden="true" />
            <span class="ab-ink" data-color={currentColor ?? 'none'} aria-hidden="true"></span>
          </IconButton>
        {/snippet}
        <div class="ab-swatches">
          <div
            class="ab-colors"
            role="radiogroup"
            tabindex="-1"
            aria-label={i18n.t('interactions.actionBar.highlightColors')}
            onkeydown={swatchKey}
          >
            {#each COLORS as color, i (color)}
              {@const name = i18n.t(`interactions.colors.${color}`)}
              <button
                type="button"
                role="radio"
                class="ab-swatch"
                data-color={color}
                aria-label={i18n.t('interactions.actionBar.highlightColor', { color: name })}
                aria-checked={currentColor === color}
                tabindex={(currentColor ?? 'yellow') === color ? 0 : -1}
                title={`${name} · ${i18n.num(i + 1)}`}
                onclick={() => setColor(color)}
              ></button>
            {/each}
          </div>
          <span class="ab-sep" aria-hidden="true"></span>
          <button
            type="button"
            class="ab-erase"
            aria-label={i18n.t('interactions.actionBar.removeHighlight')}
            title={`${i18n.t('interactions.actionBar.removeHighlight')} · ${i18n.num(0)}`}
            disabled={currentColor === null}
            onclick={clearColor}
          >
            <Eraser size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </Popover>
      <IconButton
        label={i18n.t(note ? 'interactions.actionBar.editNote' : 'interactions.actionBar.addNote')}
        shortcut={hint('n')}
        icon={NotebookPen}
        onclick={editNote}
      />

      <span class="ab-sep" aria-hidden="true"></span>

      <IconButton
        label={i18n.t('interactions.actionBar.copy')}
        shortcut={hint('c')}
        icon={Copy}
        onclick={copy}
      />
      <IconButton
        label={i18n.t('interactions.actionBar.study')}
        shortcut={hint('Enter')}
        icon={BookOpenText}
        onclick={study}
      />
      <IconButton
        label={i18n.t('interactions.actionBar.more')}
        shortcut={hint('Shift+F10')}
        icon={Ellipsis}
        onclick={more}
      />
    </div>
  </Portal>
{/if}

<style>
  .ab {
    position: fixed;
    top: 0;
    left: 0; /* physical-ok: placed in viewport px with translate */
    z-index: var(--z-popover);
    display: flex;
    align-items: center;
    gap: 2px;
    block-size: 36px;
    padding: 2px;
    border-radius: var(--radius-full);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-2);
    color: var(--text-muted);
    outline: none;
  }

  /* The ends of the pill are round: the outer buttons follow its curve. */
  .ab > :global(.icon-button:first-child),
  .ab > :global(.icon-button:last-child) {
    border-radius: var(--radius-full);
  }

  .ab :global(.ab-wide) {
    inline-size: 44px;
    grid-auto-flow: column;
    gap: 1px;
  }

  .ab :global(.ab-highlight) {
    position: relative;
  }

  .ab-sep {
    flex: none;
    inline-size: 1px;
    block-size: 20px;
    margin-inline: 3px;
    background-color: var(--border);
  }

  /* The current highlight colour, as an ink line under the highlighter icon. */
  .ab-ink {
    position: absolute;
    inset-block-end: 4px;
    inset-inline: 9px;
    block-size: 3px;
    border-radius: var(--radius-full);
    background-color: transparent;
  }

  .ab-ink[data-color='yellow'],
  .ab-swatch[data-color='yellow'] {
    --swatch: var(--user-hl-yellow-solid);
  }

  .ab-ink[data-color='green'],
  .ab-swatch[data-color='green'] {
    --swatch: var(--user-hl-green-solid);
  }

  .ab-ink[data-color='blue'],
  .ab-swatch[data-color='blue'] {
    --swatch: var(--user-hl-blue-solid);
  }

  .ab-ink[data-color='red'],
  .ab-swatch[data-color='red'] {
    --swatch: var(--user-hl-red-solid);
  }

  .ab-ink[data-color='purple'],
  .ab-swatch[data-color='purple'] {
    --swatch: var(--user-hl-purple-solid);
  }

  .ab-ink:not([data-color='none']) {
    background-color: var(--swatch);
  }

  .ab-swatches,
  .ab-colors {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .ab-swatch,
  .ab-erase {
    display: grid;
    place-items: center;
    inline-size: 28px;
    block-size: 28px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }

  .ab-swatch::before {
    content: '';
    inline-size: 18px;
    block-size: 18px;
    border-radius: var(--radius-full);
    background-color: var(--swatch);
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.12);
    transition: scale var(--dur-fast) var(--ease-standard);
  }

  .ab-swatch:hover::before {
    scale: 1.12;
  }

  .ab-swatch[aria-checked='true'] {
    box-shadow: inset 0 0 0 2px var(--accent);
  }

  .ab-erase:hover:not(:disabled),
  .ab-swatch:hover {
    background-color: var(--surface-hover);
  }

  .ab-erase:disabled {
    opacity: 0.4;
    cursor: default;
  }

  @media (forced-colors: active) {
    .ab {
      border: 1px solid CanvasText;
    }

    .ab-swatch::before,
    .ab-ink:not([data-color='none']) {
      forced-color-adjust: none;
    }

    .ab-swatch[aria-checked='true'] {
      outline: 2px solid Highlight;
    }
  }
</style>
