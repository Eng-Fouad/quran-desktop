/**
 * `notes` messages, English (§11.1). Owner: WP11d. The same keys live in `../ar/notes.ts`.
 * The note editor (dialog, sheet and the side pane's compact editor), the rendered note body, and the collections and
 * tag pickers.
 */
export const notes = {
  editor: {
    newTitle: 'New note',
    editTitle: 'Edit note',
    /** The dialog's description: the ayah or range the note is on ("Al-Baqarah 2:255"). */
    on: 'On {ref}',
    loading: 'Opening the note…',
    /** The note that was asked for has been deleted meanwhile. */
    missing: 'That note no longer exists, so this is a new one.',
    title: 'Title',
    titlePlaceholder: 'Title (optional)',
    body: 'Note',
    bodyPlaceholder: 'Write your reflection on {ref}…',
    /** The Write / Preview switch. */
    view: 'Editor view',
    write: 'Write',
    preview: 'Preview',
    previewEmpty: 'Nothing to preview yet.',
    /** The ayah the note is about, quoted above the editor. */
    context: 'The ayah this note is on',
    toolbar: 'Formatting',
    bold: 'Bold',
    italic: 'Italic',
    highlight: 'Highlight',
    heading: 'Heading',
    bullets: 'Bulleted list',
    numbers: 'Numbered list',
    quote: 'Quote',
    reference: 'Insert reference {ref}',
    help: 'Formatting help',
    helpTitle: 'Formatting',
    helpIntro: 'Notes understand a little Markdown:',
    helpBold: 'bold',
    helpItalic: 'italic',
    helpHighlight: 'highlight',
    helpHeading: 'Heading',
    helpList: 'List item',
    helpNumbered: 'Numbered item',
    helpTask: 'Task',
    helpQuote: 'Quote',
    helpRef: 'links to the ayah',
    helpRefLabel: 'Ayat al-Kursi',
    tags: 'Tags',
    addTags: 'Add tags',
    editTags: 'Edit tags',
    removeTag: 'Remove the tag {name}',
    delete: 'Delete note',
    save: 'Save note',
    /** The save shortcut, spoken ("Save note, Ctrl+Enter"). */
    saveHint: '{keys} to save',
    status: {
      draftSaved: 'Draft saved',
      restored: 'Unsaved draft restored',
      revert: 'Revert',
      revertHint: 'Back to the saved note',
      edited: 'Edited {time}',
      needsText: 'Write something to save it',
    },
    charsLeft: { one: '{count} character left', other: '{count} characters left' },
    tooLong: { one: '{count} character too long', other: '{count} characters too long' },
    discard: {
      title: 'Discard note?',
      body: 'Your changes to the note on {ref} haven’t been saved.',
      bodyNew: 'The note you started on {ref} hasn’t been saved.',
      confirm: 'Discard',
    },
  },
  /** The side pane's compact editor. */
  compact: {
    label: 'Note on {ref}',
    placeholder: 'Write a note on {ref}…',
    edit: 'Edit note',
    hint: 'Double-click to edit',
  },
  /** Rendered note bodies. */
  body: {
    link: 'Opens {host} in your browser',
  },
  collections: {
    filter: 'Find or create a collection',
    list: 'Collections',
    create: 'Create “{name}”',
    creating: 'Creating “{name}”…',
    empty: 'No collections yet.',
    emptyHint: 'Type a name to create the first one.',
    noMatch: 'No collection is called “{query}”.',
    count: { one: '{count} bookmark', other: '{count} bookmarks' },
  },
  tags: {
    filter: 'Find or create a tag',
    list: 'Tags',
    selected: 'Selected tags',
    create: 'Create the tag “{name}”',
    creating: 'Creating “{name}”…',
    empty: 'No tags yet.',
    emptyHint: 'Type a name to create the first one.',
    noMatch: 'No tag is called “{query}”.',
    remove: 'Remove {name}',
    count: { one: 'Used once', other: 'Used {count} times' },
  },
} as const
