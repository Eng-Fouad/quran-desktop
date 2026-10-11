/** The window's drop guard (§6.4): files and outside links never navigate the webview; text drags are left alone. */
import { describe, expect, it } from 'vitest'
import { type DropLike, refuseDrop, wouldNavigate } from './dropGuard'

/** A drag event as the guard sees it; `defaultPrevented` is writable, so a test can pre-accept it. */
interface FakeDrag extends DropLike {
  defaultPrevented: boolean
  readonly dataTransfer: { types: string[]; dropEffect: DataTransfer['dropEffect'] }
}

function drag(
  type: 'dragover' | 'drop',
  types: string[],
  target: EventTarget | null = document.body,
): FakeDrag {
  return {
    type,
    defaultPrevented: false,
    target,
    dataTransfer: { types, dropEffect: 'copy' },
    preventDefault() {
      this.defaultPrevented = true
    },
  }
}

describe('drop guard', () => {
  it('refuses a dragged file anywhere, with a "not allowed" cursor', () => {
    const over = drag('dragover', ['Files'])
    refuseDrop(over)
    expect(over.defaultPrevented).toBe(true)
    expect(over.dataTransfer.dropEffect).toBe('none')
    const drop = drag('drop', ['Files'])
    refuseDrop(drop)
    expect(drop.defaultPrevented).toBe(true)
    // Even over a text field: a file is never inserted, the webview would open it.
    const field = document.createElement('textarea')
    document.body.append(field)
    expect(wouldNavigate(drag('drop', ['Files'], field))).toBe(true)
    field.remove()
  })

  it('refuses a link on the page but lets a text field take it as text', () => {
    const page = drag('drop', ['text/uri-list', 'text/plain'])
    refuseDrop(page)
    expect(page.defaultPrevented).toBe(true)
    const input = document.createElement('input')
    document.body.append(input)
    const intoField = drag('drop', ['text/uri-list', 'text/plain'], input)
    refuseDrop(intoField)
    expect(intoField.defaultPrevented).toBe(false)
    input.readOnly = true
    expect(wouldNavigate(drag('drop', ['text/uri-list'], input))).toBe(true)
    input.remove()
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    const inner = document.createElement('span')
    editor.append(inner)
    document.body.append(editor)
    expect(wouldNavigate(drag('drop', ['text/uri-list'], inner))).toBe(false)
    editor.remove()
  })

  it('leaves text dragged inside the app, and a drop a target already accepted', () => {
    const text = drag('drop', ['text/plain', 'text/html'])
    refuseDrop(text)
    expect(text.defaultPrevented).toBe(false)
    const over = drag('dragover', ['text/plain'])
    refuseDrop(over)
    expect(over.dataTransfer.dropEffect).toBe('copy')
    const accepted = drag('drop', ['Files'])
    accepted.defaultPrevented = true
    const before = accepted.dataTransfer.dropEffect
    refuseDrop(accepted)
    expect(accepted.dataTransfer.dropEffect).toBe(before)
    expect(wouldNavigate({ ...drag('drop', []), dataTransfer: null })).toBe(false)
  })
})
