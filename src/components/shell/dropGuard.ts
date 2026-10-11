/**
 * The app accepts no drop (§6.4). A file, or a link dragged in from outside, dropped on the webview would otherwise be
 * the webview's navigation away from the app. Rust refuses such navigations (`window::guard`) and, on Windows, turns
 * WebView2's external drops off; WKWebView (macOS) and WebKitGTK (Linux) have no such switch, so the page refuses them
 * itself: the drag shows "not allowed" and the drop does nothing.
 *
 * Text dragged inside the app (a selection moved within a note) is left alone, and a link may still be dropped into a
 * text field as its text. A drop target that accepts something (none does today) cancels the event first and keeps it.
 */

/** The part of a `DragEvent` the guard reads (jsdom has no `DragEvent`). */
export interface DropLike {
  readonly type: string
  readonly defaultPrevented: boolean
  readonly target: EventTarget | null
  readonly dataTransfer: Pick<DataTransfer, 'types' | 'dropEffect'> | null
  preventDefault(): void
}

/** Whether the drag would make the webview navigate when dropped on `target`. */
export function wouldNavigate(e: DropLike): boolean {
  const types = e.dataTransfer?.types ?? []
  if (types.includes('Files')) return true
  return types.includes('text/uri-list') && !isEditable(e.target)
}

/** `dragover`/`drop` on the window: refuses a drag that would navigate (see the module comment). */
export function refuseDrop(e: DropLike): void {
  if (e.defaultPrevented || !wouldNavigate(e)) return
  e.preventDefault()
  if (e.type === 'dragover' && e.dataTransfer) e.dataTransfer.dropEffect = 'none'
}

function isEditable(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false
  const field = target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')
  if (field === null) return false
  if (field instanceof HTMLInputElement) return !field.readOnly && !field.disabled
  if (field instanceof HTMLTextAreaElement) return !field.readOnly && !field.disabled
  return true
}
