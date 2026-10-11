# WP7b deviations (UI primitives)

Delivered in `src/components/ui/` (everything except the frozen `SafeHtml.svelte`):

- **Components (§9.5):** `Button`, `IconButton`, `Tooltip` (+ `TooltipProvider`), `Dialog`, `Sheet`, `Popover`, `Menu`,
  `ContextMenu`, `Slider`, `Segmented`, `Switch`, `Tabs`, `Toaster` (the §9.5 "Toast"), `Kbd`, `Badge`, `Progress`,
  `Skeleton`, `EmptyState`, `ScrollArea`, `Select`, `Combobox`, `TextInput`, `SearchInput`, `Field`, `Splitter`,
  `VirtualList`, `Card`, plus `Spinner`. Internal parts: `MenuItems.svelte` (rows shared by Menu/ContextMenu/submenus),
  `ListboxItems.svelte` (rows shared by Select/Combobox).
- **Modules:** `index.ts` (barrel: `import { Button, Dialog, type MenuEntry } from '$components/ui'`), `types.ts` (prop
  types: `MenuEntry`, `SelectItem`, `SegmentedOption`, `TabItem`, `FieldControlProps`, `Point`, `TriggerProps`, …),
  `floating.svelte.ts` (`trackFloating`, `resolveDir`), `focus.ts`, `kbd.ts` (`splitChord`), `splitter.ts` (px ↔ %
  adapter), `filter.ts` (combobox matching).
- **Tests:** `helpers.test.ts` (unit, 22) and five browser files (85 tests): `Dialog` (focus trap, initial focus,
  Escape/outside/close button, focus return, layer registration), `Menu` (arrows, Home/End, loop, typeahead, Enter,
  checkbox/radio rows, submenus LTR and RTL, disabled rows, Escape and focus return, programmatic context menu at a
  point incl. RTL), `Slider` (arrows, Shift ×10, PageUp/PageDown, Home/End, RTL mirroring, tick placement), `Select`
  (keyboard, typeahead while closed, Escape, **RTL**: direction, start-edge alignment, row layout; groups; Combobox
  filtering incl. Arabic folding and the empty state), `primitives` (the rest, incl. Badge contrast ≥ 4.5:1 in all six
  theme variants × five tones), and the three §7.7 widget-guard cases (Space on a focused `Button`, ArrowRight in the
  speed `Slider`, `b` in the open context menu) run against the real shortcut listeners.
- **Visual sheets:** `gallery.browser.test.ts` writes `artifacts/ui-gallery/*.png`: every resting primitive in paper,
  sepia, night, black, high contrast (light and dark) and the Arabic UI (paper, night), and every floating/modal
  primitive open in paper/English and night/Arabic. Fixtures live in `src/components/ui/testing/` (never imported by
  the app).

## Deviations from ARCHITECTURE.md

1. **No i18n domain.** §11.1 assigns WP7b no dictionary file. The primitives use only the frozen `common` keys
   (`common.close` for close buttons, `common.clear` for the search clear button, `common.search` as the default search
   placeholder); every other piece of copy is a prop: `Toaster label` (required: "Notifications"), `Select`/`Combobox`
   `emptyText`, placeholders, and the accessible names (`label`) of `IconButton`, `Segmented`, `Tabs`, `Slider`,
   `Splitter`, `Menu`, `ContextMenu`. Nothing was added to any dictionary.
2. **`Toast` is `Toaster.svelte`**, the region that renders `ui.toast(...)` (svelte-sonner in unstyled mode, styled with
   tokens). Props: `label`, `offset` (96 px above the dock bar), `placement: 'center' | 'end'` (`end` = above the side
   card; the left in RTL), `insetInlineEnd`, `visible`. svelte-sonner pauses timers only on hover; focus is bridged
   (focus entering the stack expands it, which pauses every timer; leaving it collapses unless the pointer is over it),
   so "paused while hovered or focused" holds. Its hotkey is set to `F6`, the §10.1 key, instead of sonner's Alt+T.
3. **Skeleton fill.** A tint of `--text` (8 %) with a lighter shine instead of `--surface-sunken`: sunken is darker
   than the page in night and equal to the page in black, where a sunken block is invisible (seen in the gallery). The
   shimmer runs along the inline direction; reduced motion shows a static block.
4. **Badge fills** are mixed opaquely from the tone (12 %, neutral: 9 % of `--text`) over `--surface-raised` rather
   than the translucent `--{tone}-soft`, so the text/fill pair has the same contrast on any surface. Text uses
   `--{tone}-text` (WP7a request). Verified ≥ 4.5:1 for every theme and tone in the browser test.
5. **`VirtualList overscan` is in pixels** (virtua 0.53 renamed its item-count `overscan` to the pixel `bufferSize`).
6. **`Select searchable`** renders `Combobox` (also exported on its own). The Select trigger carries
   `role="combobox"` (the APG select-only combobox: bits-ui already sets `aria-haspopup`/`aria-activedescendant`, and
   it makes `aria-invalid` valid). Listboxes align with the trigger's start edge (bits-ui defaults to centre), which is
   the right edge in RTL.
7. **Segmented** keeps one option selected (bits-ui ToggleGroup clears the value when the active item is clicked
   again). Arrow keys move focus and Space/Enter selects (ToggleGroup semantics) rather than selection following focus,
   so a segmented language or scope switch never fires while arrowing through it. The bold active label never shifts
   its neighbours (the bold width is reserved with an `aria-hidden` copy).
8. **Slider.** bits-ui has single steps only: Shift+arrows and PageUp/PageDown (`bigStep`, default 10 × step) are
   handled in a capture-phase handler that keeps the key from the thumb and the reader. Tick labels are `<bdi>` runs in
   the digits' direction (Latin digits LTR even in the Arabic UI). `thumbPositioning="exact"` with a 7 px inline gutter
   keeps ticks and thumb centres aligned.
9. **Dialog** additions: initial focus goes to `[data-autofocus]`, else the first body control, then the footer, else
   the dialog — never the header close button; `variant="bare"` (palette: no chrome, translucent `--glass-fill` +
   `--backdrop-palette`, title kept for screen readers), `placement="top"` (14 vh), `width`, `backdrop="faint"`
   (onboarding .18), `layer="palette"` (`--z-palette`), `dismissible={false}`. **Dialog and Sheet register as floating
   layers** while open, in addition to `ui.overlays` when opened through `OverlayHost`, so a dialog used directly (the
   side pane `Sheet`) also pauses reader shortcuts. Enter and exit animate through bits-ui's
   `data-starting-style`/`data-ending-style` with the duration tokens (0 under reduced motion).
10. **ContextMenu** has two modes: a trigger area (bits-ui ContextMenu, right-click/long-press) and a programmatic
    point (`at`, `onClose`; bits-ui DropdownMenu with a virtual anchor) for `ui.contextMenu`, `Shift+F10` and the
    `ContextMenu` key. It opens to the inline end of the point and returns focus to where it was once its exit
    transition ends (bits-ui would drop it on the body: there is no trigger).
11. **Tooltip** passes its trigger id to bits-ui (`triggerId`), so a tooltip opened programmatically (`open = true`)
    finds its anchor; without it the bits-ui tooltip never positions. Tooltips are not floating layers. `delay`
    defaults to the provider's.
12. **IconButton** icon sizes: sm 16 px, md and lg 20 px (§9.5: 16 in dense UI, 20 in toolbars). A consumer `id` wins
    over the tooltip's generated trigger id.
13. **Every wrapper also takes `dir`** (default `i18n.dir`) to override the UI direction for one instance (e.g. a
    control that must never mirror).
14. **Splitter** marks its handle `data-qd-keys="own"` (paneforge resizes with arrows; the widget guard of §7.7 does
    not list `role=separator`).
15. **Extra exports** beyond the §9.5 table: `Spinner`, `TooltipProvider`, `trackFloating` (for any custom floating
    layer), `resolveDir`, `focusInitial`/`firstTabbable`, `splitChord`/`isMacModifier`, `filterItems`/`foldForMatch`/
    `groupItems`, `panePct`/`pxToPct`/`pctToPx`.

## Bugs found and fixed on the way (recorded for other packages)

- An `$effect` that calls `ui.pushFloating()` re-runs forever: the method reads the counter it writes, so the effect
  depends on it (`effect_update_depth_exceeded`). `trackFloating` wraps push/pop in `untrack`. The same holds for
  `ui.toast()` called from an effect (it reads `ui.toasts`): it toasts in an endless loop.
- CSS generated content (`::after { content: attr(...) }`) becomes part of the accessible name in Chromium ("Quran
  Quran"); use an `aria-hidden` element instead.

## Requests

- **WP7c (shell):**
  - Wrap the app in `<TooltipProvider>` and mount `<Toaster label={…} />` once (placement from `reader.dock`:
    `placement="end"` above the side card, else the default bottom-centre 96 px offset).
  - `PaneLayout`: `PaneGroup`/`Pane` from paneforge with `<Splitter label=… onReset={() => ui.resetSidebarWidth()} />`;
    convert the pixel widths and limits with `panePct({ size, min, max }, groupPx)` and back with `pctToPx`.
  - `ui.toast()` and `ui.pushFloating()/popFloating()` read the state they write. Consider wrapping their bodies in
    `untrack` so a call from inside an `$effect` cannot loop (see above).
  - Use `Sheet` for the side pane when `ui.paneDocked` is false, and `Dialog` in `ConfirmDialog`
    (`dismissible`, footer with `Button variant="danger"` when `danger`).
- **WP10c (palette):** `<Dialog variant="bare" placement="top" width={640} layer="palette" title=…>`; the input is the
  first body control, so it gets focus.
- **WP11c (AyahContextMenu):** `<ContextMenu at={ui.contextMenu} onClose={() => ui.closeContextMenu()} label=… items=…/>`
  (`MenuEntry`: commands with `kbd` hints, `submenu`, `radio` with `swatch` colours for highlights, `checkbox`).
- **WP9a:** speed is `<Slider min={50} max={200} step={5} ticks={[75, 100, 125, 150, 200]} format=…/>` inside a
  `<Popover arrow>`; the buffering ring is `<Progress variant="ring" size={24} indeterminate />`.
- **WP0D / lead:** a failing vitest browser test writes its failure screenshot to `.vitest/attachments/` in the repo
  root (not to `artifacts/vitest-browser/` as the config intends), and `.vitest/` is not in `.gitignore`.
- **Lead:** fold deviations 1–15 into §9.5 (the table's props and the notes above).
