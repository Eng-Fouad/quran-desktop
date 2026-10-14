<!--
  CollectionsPicker: the collections of a bookmark, as a filterable checklist (the Bookmarks panel's "Collections and
  tags…" popover). Collections are listed in their own order with their bookmark counts; typing a name that does not
  exist offers to create it (`library.createCollection`), and the new collection is checked at once.

  Controlled (`CollectionsPickerProps`): every change is reported through `onchange` with the full list of
  collection ids; the caller applies it (`library.setCollections`, which toasts and records the undo entry).
-->
<script lang="ts">
  import type { CollectionsPickerProps } from '$lib/contracts/components'
  import { i18n, library } from '$lib/stores'
  import ChecklistPicker, { type PickerItem } from './ChecklistPicker.svelte'

  let { bookmarkId, selected, onchange }: CollectionsPickerProps = $props()

  /** Longest collection name (quran-core `user_db`). */
  const NAME_MAX = 100

  const items: PickerItem[] = $derived(
    library.collections.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      count: c.itemCount,
      countLabel: i18n.tp('notes.collections.count', c.itemCount),
    })),
  )

  async function create(name: string): Promise<string | null> {
    const created = await library.createCollection(name)
    return created?.id ?? null
  }
</script>

<ChecklistPicker
  class="collections-picker"
  {items}
  {selected}
  {onchange}
  oncreate={create}
  listLabel={i18n.t('notes.collections.list')}
  placeholder={i18n.t('notes.collections.filter')}
  createLabel={(name) => i18n.t('notes.collections.create', { name })}
  creatingLabel={(name) => i18n.t('notes.collections.creating', { name })}
  emptyText={i18n.t('notes.collections.empty')}
  emptyHint={i18n.t('notes.collections.emptyHint')}
  noMatch={(query) => i18n.t('notes.collections.noMatch', { query })}
  maxLength={NAME_MAX}
  itemId={bookmarkId}
/>
