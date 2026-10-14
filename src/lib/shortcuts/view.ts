/**
 * Reader view shortcuts: `T` (Mushaf ↔ translation), `D` (page mode), Mushaf zoom (`Mod+=`, `Mod+-`, `Mod+0`) and `Z`
 * (zen). Registered by the reader store in `init`; UI scale (`Mod+Shift+…`) is the app's (app.ts).
 *
 * Zoom keys repeat (held, they keep zooming) and zoom around the canvas centre. `Mod++` also zooms in, for the numeric
 * keypad and for layouts where `+` has its own key; on a US keyboard `Mod+Shift+=` types `+` too, and the app's exact
 * UI-scale chord wins there.
 */
import type { ShortcutDef } from '$lib/contracts/shortcuts'
import { reader } from '$lib/stores/reader.svelte'
import { ui } from '$lib/stores/ui.svelte'

export const viewShortcuts: readonly ShortcutDef[] = [
  {
    id: 'view.readingMode',
    keys: ['t'],
    group: 'view',
    labelKey: 'shortcuts.view.readingMode',
    scope: 'reader',
    run: () => reader.toggleReadingMode(),
  },
  {
    id: 'view.pageMode',
    keys: ['d'],
    group: 'view',
    labelKey: 'shortcuts.view.pageMode',
    scope: 'mushaf',
    run: () => reader.cyclePageMode(),
  },
  {
    id: 'view.zoomIn',
    keys: ['Mod+=', 'Mod++'],
    group: 'view',
    labelKey: 'shortcuts.view.zoomIn',
    scope: 'mushaf',
    repeat: true,
    run: () => reader.zoomIn(),
  },
  {
    id: 'view.zoomOut',
    keys: ['Mod+-'],
    group: 'view',
    labelKey: 'shortcuts.view.zoomOut',
    scope: 'mushaf',
    repeat: true,
    run: () => reader.zoomOut(),
  },
  {
    id: 'view.zoomFit',
    keys: ['Mod+Digit0'],
    group: 'view',
    labelKey: 'shortcuts.view.zoomFit',
    scope: 'mushaf',
    run: () => reader.zoomReset(),
  },
  {
    id: 'view.zen',
    keys: ['z'],
    group: 'view',
    labelKey: 'shortcuts.view.zen',
    scope: 'reader',
    run: () => ui.toggleZen(),
  },
]
