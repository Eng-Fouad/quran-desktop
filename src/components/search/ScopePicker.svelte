<!--
  ScopePicker (§9.7): what to search, a `Segmented` (Quran | Translation | Notes). With the Translation scope and an
  installed translation, a picker under it names the translation searched (the reader's own first) and switches between
  installed ones. Without any installed translation the Translation scope still selects: the panel then shows the
  install card (§9.8). In a sidebar too narrow for the three labels the options show their icons only. Reads and writes the `search` store. Owner: WP10b. Used only inside `SearchPanel`.
-->
<script lang="ts">
  import BookOpenText from '@lucide/svelte/icons/book-open-text'
  import Languages from '@lucide/svelte/icons/languages'
  import StickyNote from '@lucide/svelte/icons/sticky-note'
  import { Segmented, type SegmentedOption, Select, type SelectItem } from '$components/ui'
  import type { SearchScope } from '$lib/ipc/bindings'
  import { i18n, packs, search } from '$lib/stores'

  type Kind = SearchScope['type']

  /** Below this width the three labels do not fit: the options show their icons only (the label is the tooltip). */
  const LABELS_MIN_PX = 276

  let root: HTMLElement | null = $state(null)
  let width = $state(Number.POSITIVE_INFINITY)

  $effect(() => {
    if (!root) return
    const el = root
    const observer = new ResizeObserver(() => (width = el.clientWidth))
    observer.observe(el)
    width = el.clientWidth
    return () => observer.disconnect()
  })

  const iconOnly = $derived(width < LABELS_MIN_PX)

  const options: SegmentedOption[] = $derived([
    { value: 'quran', label: i18n.t('search.scope.quran'), icon: BookOpenText, iconOnly },
    { value: 'translation', label: i18n.t('search.scope.translation'), icon: Languages, iconOnly },
    { value: 'notes', label: i18n.t('search.scope.notes'), icon: StickyNote, iconOnly },
  ])

  const packItems: SelectItem[] = $derived(
    search.translationPacks.map((p) => ({
      value: p.id,
      label: packs.title(p),
      hint: languageName(p.language),
    })),
  )

  const languageNames = $derived.by(() => {
    try {
      return new Intl.DisplayNames([i18n.locale], { type: 'language' })
    } catch {
      return null
    }
  })

  function languageName(code: string | null): string | undefined {
    if (!code) return undefined
    try {
      return languageNames?.of(code) ?? code
    } catch {
      return code
    }
  }

  function setKind(value: string): void {
    const kind = value as Kind
    if (kind === 'translation') search.setScope({ type: 'translation', data: { packId: '' } })
    else if (kind === 'notes') search.setScope({ type: 'notes' })
    else search.setScope({ type: 'quran' })
  }

  function setPack(packId: string): void {
    search.setScope({ type: 'translation', data: { packId } })
  }
</script>

<div class="scope" bind:this={root}>
  <Segmented
    {options}
    value={search.scope.type}
    onValueChange={setKind}
    label={i18n.t('search.scope.label')}
    size="sm"
    fullWidth
  />
  {#if search.scope.type === 'translation' && packItems.length > 0}
    <Select
      items={packItems}
      value={search.scope.data.packId}
      onValueChange={setPack}
      label={i18n.t('search.scope.pack')}
      size="sm"
      fullWidth
    />
  {/if}
</div>

<style>
  .scope {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
</style>
