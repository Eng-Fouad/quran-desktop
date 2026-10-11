<!--
  Toaster (§9.5 "Toast"): the region that shows `ui.toast(...)` messages (svelte-sonner). Mount it once in the shell.

  - Placement: bottom-centre above the player dock (`offset`, 96 px), or `placement="end"` above the side dock card
    (`insetInlineEnd`, `offset`); in RTL the end is the left. The shell raises `offset` over a bottom-centre overlay
    (§7.5 slot), and the list glides there. `placement="top"` is top-centre, `offsetTop` below the top edge: the shell
    uses it where bottom toasts would cover the Quran text.
  - Look: surface-raised, radius-md, shadow-3, text-sm; a tone icon (success, warning, danger); the action (Undo) as a
    link-style button in `--accent-text`; a close button.
  - Durations come from `ui.toast` (5 s, ≥ 10 s with an action). Timers pause while a toast is hovered **or focused**
    (focus moves in with `F6` / `Mod+Shift+U`, `ui.focusToasts()`); svelte-sonner only pauses on hover, so focus is
    bridged here.
-->
<script lang="ts">
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import CircleCheck from '@lucide/svelte/icons/circle-check'
  import Info from '@lucide/svelte/icons/info'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
  import X from '@lucide/svelte/icons/x'
  import { Toaster } from 'svelte-sonner'
  import { i18n } from '$lib/stores/i18n.svelte'
  import { resolveDir } from './floating.svelte'
  import type { Dir } from './types'

  interface Props {
    /** Accessible name of the region ("Notifications"), localised by the shell. */
    label: string
    /** Distance from the bottom of the window (px): above the dock bar, or above the side card. */
    offset?: number
    placement?: 'center' | 'end' | 'top'
    /** Distance from the top edge for `placement="top"` (px). */
    offsetTop?: number
    /** Distance from the inline-end edge for `placement="end"` (px). */
    insetInlineEnd?: number
    /** How many toasts stay visible in the stack. */
    visible?: number
    dir?: Dir
  }

  let {
    label,
    offset = 96,
    placement = 'center',
    offsetTop = 12,
    insetInlineEnd = 16,
    visible = 3,
    dir: dirProp,
  }: Props = $props()

  const dir = $derived(resolveDir(dirProp))
  const position = $derived(
    placement === 'top'
      ? 'top-center'
      : placement === 'center'
        ? 'bottom-center'
        : dir === 'rtl'
          ? 'bottom-left'
          : 'bottom-right',
  )
  const offsets = $derived({
    top: offsetTop,
    bottom: offset,
    left: insetInlineEnd,
    right: insetInlineEnd,
  })

  const SONNER_LIST = '[data-sonner-toaster]'

  /** svelte-sonner expands the stack (and pauses every timer) on mouse movement over the list: focus does the same. */
  function onfocusin(e: FocusEvent): void {
    const list = e.target instanceof Element ? e.target.closest(SONNER_LIST) : null
    list?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: -1, clientY: -1 }))
  }

  function onfocusout(e: FocusEvent): void {
    const list = e.target instanceof Element ? e.target.closest(SONNER_LIST) : null
    if (list === null) return
    if (e.relatedTarget instanceof Node && list.contains(e.relatedTarget)) return
    if (list.matches(':hover')) return
    list.dispatchEvent(new MouseEvent('mouseleave', { clientX: -10_000, clientY: -10_000 }))
  }
</script>

{#snippet successIcon()}<CircleCheck size={18} strokeWidth={1.75} />{/snippet}
{#snippet warningIcon()}<TriangleAlert size={18} strokeWidth={1.75} />{/snippet}
{#snippet errorIcon()}<CircleAlert size={18} strokeWidth={1.75} />{/snippet}
{#snippet infoIcon()}<Info size={18} strokeWidth={1.75} />{/snippet}
{#snippet closeIcon()}<X size={14} strokeWidth={2} />{/snippet}

<div class="toaster-host" {onfocusin} {onfocusout}>
  <Toaster
    class="qd-toaster"
    {position}
    {dir}
    offset={offsets}
    mobileOffset={offsets}
    visibleToasts={visible}
    gap={8}
    hotkey={['F6']}
    containerAriaLabel={label}
    closeButton
    closeButtonAriaLabel={i18n.t('common.close')}
    {successIcon}
    {warningIcon}
    {errorIcon}
    {infoIcon}
    {closeIcon}
    toastOptions={{
      unstyled: true,
      classes: {
        toast: 'qd-toast',
        content: 'qd-toast-content',
        title: 'qd-toast-title',
        description: 'qd-toast-description',
        icon: 'qd-toast-icon',
        actionButton: 'qd-toast-action',
        cancelButton: 'qd-toast-action',
        closeButton: 'qd-toast-close',
      },
    }}
  />
</div>

<style>
  .toaster-host {
    display: contents;
  }

  /* `offset` moves while toasts show (the shell keeps them above an overlay that appears): glide, not jump. */
  :global(.qd-toaster[data-sonner-toaster]) {
    z-index: var(--z-toast);
    font-family: var(--font-ui);
    transition:
      bottom var(--dur-normal) var(--ease-standard),
      top var(--dur-normal) var(--ease-standard);
  }

  :global(.qd-toast[data-sonner-toast]) {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    inline-size: var(--width);
    min-block-size: 48px;
    padding-block: var(--space-2);
    padding-inline: var(--space-4) var(--space-2);
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-3);
    color: var(--text);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
  }

  :global(.qd-toast[data-sonner-toast]:focus-visible) {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  /* Collapsed stack: the toasts behind the front one show only their edge, never their text. */
  :global(.qd-toast[data-sonner-toast][data-expanded='false'][data-front='false'] > *) {
    opacity: 0;
  }

  :global(.qd-toast .qd-toast-icon) {
    display: flex;
    flex: none;
    color: var(--text-muted);
  }

  :global(.qd-toast[data-type='success'] .qd-toast-icon) {
    color: var(--success);
  }

  :global(.qd-toast[data-type='warning'] .qd-toast-icon) {
    color: var(--warning);
  }

  :global(.qd-toast[data-type='error'] .qd-toast-icon) {
    color: var(--danger);
  }

  :global(.qd-toast .qd-toast-content) {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
    padding-block: var(--space-1);
  }

  :global(.qd-toast .qd-toast-title) {
    font-weight: var(--weight-label);
  }

  :global(.qd-toast .qd-toast-description) {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  :global(.qd-toast .qd-toast-action) {
    flex: none;
    block-size: 28px;
    padding-inline: var(--space-2);
    border: 0;
    border-radius: var(--radius-xs);
    background: none;
    color: var(--accent-text);
    font-family: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-title);
    cursor: pointer;
  }

  :global(.qd-toast .qd-toast-action:hover) {
    background-color: var(--surface-hover);
  }

  :global(.qd-toast .qd-toast-close) {
    order: 1;
    display: grid;
    flex: none;
    place-items: center;
    inline-size: 24px;
    block-size: 24px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-xs);
    background: none;
    color: var(--text-muted);
    cursor: pointer;
  }

  :global(.qd-toast .qd-toast-close:hover) {
    background-color: var(--surface-hover);
    color: var(--text);
  }

  @media (forced-colors: active) {
    :global(.qd-toast[data-sonner-toast]) {
      border: 1px solid CanvasText;
    }
  }
</style>
