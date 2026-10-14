/**
 * The open state of one overlay instance. `OverlayHost` renders each `ui.overlays` entry in its own
 * keyed instance and keeps a closed one mounted for its exit transition. An overlay component's Dialog is open while
 * **its own entry** is the top overlay, not merely its kind: a closing instance must never open again because another
 * overlay of the same kind was pushed inside the exit window. If it did, bits-ui would take the body scroll lock for
 * the instance being replaced and never release it (`<body>` kept `pointer-events: none`).
 */
import { getContext, setContext } from 'svelte'
import type { OverlayEntry, OverlayKind } from '$lib/contracts/overlays'
import { ui } from '$lib/stores'

const ENTRY = Symbol('qd.overlay-entry')

/** `OverlayHost`: the entry the overlay rendered below this component belongs to (call during initialisation). */
export function setOverlayEntry(entry: OverlayEntry): void {
  setContext(ENTRY, entry)
}

/**
 * The `open` getter of an overlay component of `kind` (call during initialisation): its own entry is the top overlay.
 * Rendered outside `OverlayHost` (a component test), it follows `ui.isTop(kind)`.
 */
export function overlayOpen(kind: OverlayKind): () => boolean {
  const entry = getContext<OverlayEntry | undefined>(ENTRY)
  return entry?.kind === kind ? () => ui.topOverlay === entry : () => ui.isTop(kind)
}
