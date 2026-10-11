<!--
  Test fixture (WP7b): a Dialog with a trigger, two body inputs and footer actions, plus a control outside it; with
  `select`, a Select in the body (floating content opened from inside a modal layer); with `disabledFirst`, the sheet's
  body starts with a disabled icon button (the study pane at 1:1, whose "Previous ayah" is disabled); with `onlyDisabled`
  the sheet holds nothing that can take focus but that button; with `view`, an in-window view dialog (`layer="view"`,
  the Settings dialog's) below a 40 px band, which a click on the outside control does not close.
-->
<script lang="ts">
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import { Button, Dialog, IconButton, Select, Sheet, TextInput } from '../index'

  interface Props {
    kind?: 'dialog' | 'sheet'
    dismissible?: boolean
    select?: boolean
    disabledFirst?: boolean
    onlyDisabled?: boolean
    view?: boolean
    onSave?: () => void
  }

  let {
    kind = 'dialog',
    dismissible = true,
    select = false,
    disabledFirst = false,
    onlyDisabled = false,
    view = false,
    onSave,
  }: Props = $props()

  const COLOURS = [
    { value: 'teal', label: 'Teal' },
    { value: 'gold', label: 'Gold' },
    { value: 'rose', label: 'Rose' },
  ]
  let colour = $state('teal')

  let open = $state(false)

  function save(): void {
    onSave?.()
    open = false
  }
</script>

<button type="button" id="outside">Outside</button>

{#snippet trigger({ props }: { props: Record<string, unknown> })}
  <Button {...props} id="open">Open</Button>
{/snippet}

{#snippet footer()}
  <Button id="cancel" onclick={() => (open = false)}>Cancel</Button>
  <Button id="save" variant="primary" onclick={save}>Save</Button>
{/snippet}

{#if kind === 'dialog'}
  <Dialog
    bind:open
    title="Rename collection"
    description="Names show in the library."
    {dismissible}
    {trigger}
    {footer}
    layer={view ? 'view' : 'dialog'}
    insetTop={view ? 40 : 0}
    onInteractOutside={view
      ? (e: PointerEvent) => {
          if (e.target instanceof Element && e.target.closest('#outside')) e.preventDefault()
        }
      : undefined}
  >
    <TextInput id="name" aria-label="Name" />
    <TextInput id="details" aria-label="Details" />
    {#if select}
      <Select id="colour" label="Colour" items={COLOURS} bind:value={colour} />
    {/if}
  </Dialog>
{:else}
  <Sheet
    bind:open
    title="Al-Baqarah 2:255"
    {trigger}
    footer={onlyDisabled ? undefined : footer}
    closeButton={!onlyDisabled}
  >
    {#if disabledFirst || onlyDisabled}
      <IconButton id="previous" label="Previous ayah" icon={ChevronLeft} mirror disabled />
    {/if}
    {#if !onlyDisabled}
      <TextInput id="name" aria-label="Name" />
    {/if}
  </Sheet>
{/if}
