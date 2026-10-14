/**
 * Overlay contract. Every overlay is a bits-ui Dialog with a focus trap, opened through `ui.open(kind, props)` and
 * rendered by `OverlayHost`.
 */

/** Options of the shared confirmation dialog (`ui.confirm(opts)` resolves `true` on confirm). Strings are already localised. */
export interface ConfirmOptions {
  title: string
  body: string
  confirmLabel: string
  /** Styles the confirm button as destructive. */
  danger?: boolean
}

/** Props of each overlay kind; the overlay component of kind `K` takes exactly `OverlayProps[K]`. */
export type OverlayProps = {
  palette: { query?: string }
  goto: { initial?: string }
  shortcuts: Record<string, never>
  onboarding: Record<string, never>
  confirm: ConfirmOptions
  'note-editor': { noteId?: string; fromAyahId: number; toAyahId: number }
  'self-test': { fromAyahId: number; toAyahId: number }
}

export type OverlayKind = keyof OverlayProps

/** Every overlay kind, in no particular order (the stack order lives in `ui.overlays`). */
export const OVERLAY_KINDS = [
  'palette',
  'goto',
  'shortcuts',
  'onboarding',
  'confirm',
  'note-editor',
  'self-test',
] as const satisfies readonly OverlayKind[]

/** One entry of the `ui.overlays` stack: a kind with its props, discriminated by `kind`. */
export type OverlayEntry = { [K in OverlayKind]: { kind: K; props: OverlayProps[K] } }[OverlayKind]

/** The signature of `ui.open`. */
export type OpenOverlay = <K extends OverlayKind>(kind: K, props: OverlayProps[K]) => void
