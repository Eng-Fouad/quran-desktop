<!--
  Test fixture: one primitive at a time, with the snippets the tests need, reporting through spy props.
  `which` picks the primitive; `onEvent(name, value?)` reports clicks and changes.
-->
<script lang="ts">
  import Bookmark from '@lucide/svelte/icons/bookmark'
  import { PaneGroup, Pane } from 'paneforge'
  import {
    Button,
    Card,
    Field,
    IconButton,
    Popover,
    SearchInput,
    Segmented,
    Splitter,
    Switch,
    Tabs,
    TextInput,
    Tooltip,
    TooltipProvider,
    VirtualList,
  } from '../index'

  type Which =
    | 'button'
    | 'icon-button'
    | 'segmented'
    | 'segmented-narrow'
    | 'switch'
    | 'tabs'
    | 'field'
    | 'search'
    | 'popover'
    | 'tooltip'
    | 'virtual-list'
    | 'card'
    | 'splitter'

  interface Props {
    which: Which
    onEvent?: (name: string, value?: unknown) => void
    loading?: boolean
    error?: string
    /** `segmented-narrow`: the Arabic labels. */
    arabic?: boolean
  }

  let { which, onEvent = () => {}, loading = false, error, arabic = false }: Props = $props()

  let scope = $state('quran')
  let memoScope = $state('page')
  let tab = $state('translation')
  let checked = $state(false)
  let query = $state('')
  let popoverOpen = $state(false)
  const rows = Array.from({ length: 5000 }, (_, i) => ({ id: i, label: `Row ${i + 1}` }))
  let list: VirtualList<{ id: number; label: string }> | undefined = $state()

  export function scrollListTo(index: number): void {
    list?.scrollToIndex(index, { align: 'start' })
  }
</script>

<button type="button" id="before">Before</button>

{#if which === 'button'}
  <Button id="target" {loading} onclick={() => onEvent('click')}>Play</Button>
{:else if which === 'icon-button'}
  <TooltipProvider delay={100}>
    <IconButton
      id="target"
      label="Bookmark"
      icon={Bookmark}
      pressed={checked}
      shortcut="B"
      onclick={() => (checked = !checked)}
    />
  </TooltipProvider>
{:else if which === 'segmented'}
  <Segmented
    label="Scope"
    bind:value={scope}
    onValueChange={(v) => onEvent('change', v)}
    options={[
      { value: 'quran', label: 'Quran' },
      { value: 'translation', label: 'Translation' },
      { value: 'notes', label: 'Notes', disabled: true },
      { value: 'words', label: 'Words' },
    ]}
  />
{:else if which === 'segmented-narrow'}
  <!-- The Memorize panel's scope picker in a 240 px card (the 300 px sidebar minus its padding). -->
  <div id="narrow" style="inline-size: 240px">
    <Segmented
      label={arabic ? 'النطاق' : 'Scope'}
      size="sm"
      fullWidth
      bind:value={memoScope}
      options={[
        { value: 'selection', label: arabic ? 'التحديد' : 'Selection' },
        { value: 'page', label: arabic ? 'الصفحة' : 'Page' },
        { value: 'surah', label: arabic ? 'السورة' : 'Surah' },
        { value: 'juz', label: arabic ? 'الجزء' : 'Juz' },
      ]}
    />
  </div>
{:else if which === 'switch'}
  <Switch
    label="Follow the recitation"
    description="Turn pages with the reciter"
    bind:checked
    onCheckedChange={(v) => onEvent('change', v)}
  />
{:else if which === 'tabs'}
  <Tabs
    label="Side pane"
    bind:value={tab}
    onValueChange={(v) => onEvent('change', v)}
    tabs={[
      { value: 'translation', label: 'Translation' },
      { value: 'tafsir', label: 'Tafsir' },
      { value: 'notes', label: 'Notes', badge: 2 },
    ]}
  >
    {#snippet panel(value)}
      <p class="panel-content" data-panel={value}>Panel {value}</p>
    {/snippet}
  </Tabs>
{:else if which === 'field'}
  <Field label="Collection name" hint="Shown in the library" {error} required>
    {#snippet children(c)}
      <TextInput id={c.id} aria-describedby={c.describedBy} invalid={c.invalid} required={c.required} />
    {/snippet}
  </Field>
{:else if which === 'search'}
  <SearchInput
    id="target"
    bind:value={query}
    shortcut="Ctrl+F"
    onSubmit={(v) => onEvent('submit', v)}
    onClear={() => onEvent('clear')}
    data-qd-focus="search"
  />
{:else if which === 'popover'}
  <Popover bind:open={popoverOpen} label="Repeat">
    {#snippet trigger({ props })}
      <Button {...props} id="target">Repeat</Button>
    {/snippet}
    <button type="button" id="inside">×3</button>
  </Popover>
{:else if which === 'tooltip'}
  <Tooltip content="Search" kbd="Ctrl+K" delay={100}>
    {#snippet children({ props })}
      <button type="button" {...props} id="target">S</button>
    {/snippet}
  </Tooltip>
{:else if which === 'virtual-list'}
  <div style="block-size: 300px">
    <VirtualList bind:this={list} data={rows} getKey={(r) => r.id} itemSize={30} label="Rows" role="list">
      {#snippet children(row)}
        <div role="listitem" class="row" data-row={row.id} style="block-size: 30px">{row.label}</div>
      {/snippet}
    </VirtualList>
  </div>
{:else if which === 'card'}
  <Card interactive selected={checked} label="Paper theme" onclick={() => (checked = !checked)}>Paper</Card>
{:else if which === 'splitter'}
  <div style="block-size: 200px; inline-size: 800px">
    <PaneGroup direction="horizontal">
      <Pane defaultSize={30} minSize={10}>left</Pane>
      <Splitter label="Resize sidebar" onReset={() => onEvent('reset')} />
      <Pane defaultSize={70}>right</Pane>
    </PaneGroup>
  </div>
{/if}
