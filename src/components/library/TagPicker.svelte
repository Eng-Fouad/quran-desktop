<!--
  TagPicker: the tags of a bookmark, note or highlight. The chosen tags sit on top as removable chips;
  below, a filter field over every tag (most used first) with checkboxes. Typing a name that does not exist offers to
  create it (`library.createTag`, get-or-create, case-insensitive), and the new tag is chosen at once. Backspace in the
  empty field removes the last chip.

  Controlled (`TagPickerProps`): every change is reported through `onchange` with the full list of tag ids. The
  library panels apply it with `library.setTags` (toast and undo); the note editor keeps it with the note until Save.
-->
<script lang="ts">
  import type { TagPickerProps } from '$lib/contracts/components'
  import { i18n, library } from '$lib/stores'
  import ChecklistPicker, { type PickerItem } from './ChecklistPicker.svelte'

  let { kind, itemId, selected, onchange }: TagPickerProps = $props()

  /** Longest tag name (quran-core `user_db::tags`). */
  const NAME_MAX = 100

  const items: PickerItem[] = $derived(
    [...library.tags]
      .sort((a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name, i18n.locale))
      .map((tag) => ({
        id: tag.id,
        name: tag.name,
        color: tag.color,
        count: tag.usageCount,
        countLabel: i18n.tp('notes.tags.count', tag.usageCount),
      })),
  )

  async function create(name: string): Promise<string | null> {
    const tag = await library.createTag(name)
    return tag?.id ?? null
  }
</script>

<ChecklistPicker
  class="tag-picker tag-picker-{kind}"
  {items}
  {selected}
  {onchange}
  oncreate={create}
  listLabel={i18n.t('notes.tags.list')}
  placeholder={i18n.t('notes.tags.filter')}
  createLabel={(name) => i18n.t('notes.tags.create', { name })}
  creatingLabel={(name) => i18n.t('notes.tags.creating', { name })}
  emptyText={i18n.t('notes.tags.empty')}
  emptyHint={i18n.t('notes.tags.emptyHint')}
  noMatch={(query) => i18n.t('notes.tags.noMatch', { query })}
  chips={{
    label: i18n.t('notes.tags.selected'),
    removeLabel: (name) => i18n.t('notes.tags.remove', { name }),
  }}
  maxLength={NAME_MAX}
  {itemId}
/>
