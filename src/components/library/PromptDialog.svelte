<!--
  PromptDialog: a small dialog that asks for one line of text (a collection name, a bookmark label). Used by the
  library panels and the ayah context menu only.

  The field is `dir="auto"` and selected when the dialog opens; Enter submits. The confirm button stays disabled while
  the text is blank (unless `allowEmpty`) or longer than `maxLength` characters (the backend's limits: names 100,
  labels 200). `onsubmit` may be async; the dialog closes when it resolves `true`.
-->
<script lang="ts">
  import Button from '$components/ui/Button.svelte'
  import Dialog from '$components/ui/Dialog.svelte'
  import Field from '$components/ui/Field.svelte'
  import TextInput from '$components/ui/TextInput.svelte'
  import { i18n } from '$lib/stores'

  interface Props {
    open?: boolean
    title: string
    description?: string
    label: string
    /** The text the field starts with when the dialog opens. */
    initial?: string
    placeholder?: string
    confirmLabel: string
    /** Longest accepted text, in characters (code points). */
    maxLength?: number
    /** A blank text is a valid answer (clearing a label). */
    allowEmpty?: boolean
    onsubmit: (value: string) => boolean | Promise<boolean>
  }

  let {
    open = $bindable(false),
    title,
    description,
    label,
    initial = '',
    placeholder,
    confirmLabel,
    maxLength = 100,
    allowEmpty = false,
    onsubmit,
  }: Props = $props()

  let value = $state('')
  let busy = $state(false)
  let input: HTMLInputElement | null = $state(null)

  const length = $derived([...value.trim()].length)
  const tooLong = $derived(length > maxLength)
  const valid = $derived(!tooLong && (allowEmpty || length > 0))

  // A fresh field every time the dialog opens.
  let wasOpen = false
  $effect.pre(() => {
    if (open && !wasOpen) {
      value = initial
      busy = false
    }
    wasOpen = open
  })

  function onOpenAutoFocus(e: Event): void {
    e.preventDefault()
    input?.focus()
    input?.select()
  }

  async function submit(e?: SubmitEvent): Promise<void> {
    e?.preventDefault()
    if (!valid || busy) return
    busy = true
    try {
      if (await onsubmit(value.trim())) open = false
    } finally {
      busy = false
    }
  }
</script>

<Dialog bind:open {title} {description} size="sm" {onOpenAutoFocus}>
  <form class="form" onsubmit={submit}>
    <Field {label} error={tooLong ? i18n.t('library.prompt.tooLong', { max: maxLength }) : undefined}>
      {#snippet children(c)}
        <TextInput
          id={c.id}
          aria-describedby={c.describedBy}
          invalid={c.invalid}
          bind:value
          bind:ref={input}
          {placeholder}
          autocomplete="off"
          spellcheck="false"
        />
      {/snippet}
    </Field>
    <!-- One text field: Enter submits the form (implicit submission). -->
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{i18n.t('common.cancel')}</Button>
    <Button variant="primary" disabled={!valid} loading={busy} onclick={() => void submit()}
      >{confirmLabel}</Button
    >
  {/snippet}
</Dialog>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
</style>
