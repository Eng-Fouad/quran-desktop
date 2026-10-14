<!--
  ConfirmDialog: the shared yes/no question behind `ui.confirm(options)`. Rendered by `OverlayHost` while `confirm`
  is the top overlay; props are exactly `ConfirmOptions`, already localised.

  - The confirm button answers `ui.resolveConfirm(true)`; Cancel, Escape and a click outside close it, which answers
    `false` (`ui.close('confirm')`).
  - A destructive question (`danger`) styles the confirm button red and puts the initial focus on Cancel, so Enter
    never deletes by accident; otherwise focus starts on the confirm button.
-->
<script lang="ts">
  import { Button, Dialog } from '$components/ui'
  import type { OverlayComponentProps } from '$lib/contracts/components'
  import { i18n, ui } from '$lib/stores'
  import { overlayOpen } from '../shell/overlay'

  let { title, body, confirmLabel, danger = false }: OverlayComponentProps<'confirm'> = $props()

  const isOpen = overlayOpen('confirm')
</script>

<Dialog
  open={isOpen()}
  onOpenChange={(open) => {
    if (!open) ui.close('confirm')
  }}
  {title}
  size="sm"
  closeButton={false}
  class="confirm-dialog"
>
  <p class="body">{body}</p>

  {#snippet footer()}
    <Button variant="secondary" data-autofocus={danger ? '' : undefined} onclick={() => ui.close('confirm')}>
      {i18n.t('common.cancel')}
    </Button>
    <Button
      variant={danger ? 'danger' : 'primary'}
      data-autofocus={danger ? undefined : ''}
      data-confirm
      onclick={() => ui.resolveConfirm(true)}
    >
      {confirmLabel}
    </Button>
  {/snippet}
</Dialog>

<style>
  .body {
    color: var(--text-muted);
    font-size: var(--text-md);
    line-height: var(--leading-ui);
    white-space: pre-line;
  }
</style>
