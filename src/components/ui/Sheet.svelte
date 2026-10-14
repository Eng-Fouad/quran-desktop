<!--
  Sheet: a modal panel built on bits-ui Dialog. `side="end"` slides a full-height panel in from the
  inline end (from the left in the Arabic UI); `side="bottom"` rises from the bottom edge. Used for the side pane when
  it cannot dock and for the note editor on narrow windows.

  Same contract as `Dialog`: `title` names it (shown in the header unless `header` replaces it), `children` is the
  scrolling body, `footer` holds actions; it traps focus, closes on Escape or an outside click, restores focus, and
  counts as a layer for shortcuts while open.
-->
<script lang="ts">
  import X from '@lucide/svelte/icons/x'
  import { Dialog } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import { i18n } from '$lib/stores/i18n.svelte'
  import { focusInitial } from './focus'
  import { resolveDir, setModalLayer, trackFloating, trackModal } from './floating.svelte'
  import IconButton from './IconButton.svelte'
  import type { Dir, TriggerProps } from './types'

  interface Props {
    open?: boolean
    onOpenChange?: (open: boolean) => void
    title: string
    description?: string
    side?: 'end' | 'bottom'
    /** Panel width for `side="end"` (px; capped at the window width minus 48 px). */
    width?: number
    /** Panel height for `side="bottom"` (px; capped at 85 % of the window). */
    height?: number
    closeButton?: boolean
    header?: Snippet
    footer?: Snippet
    trigger?: Snippet<[TriggerProps]>
    /** `false`: Escape and outside clicks do not close it (as `Dialog`). */
    dismissible?: boolean
    onOpenAutoFocus?: (e: Event) => void
    onCloseAutoFocus?: (e: Event) => void
    onEscapeKeydown?: (e: KeyboardEvent) => void
    class?: string
    dir?: Dir
    children: Snippet
  }

  let {
    open = $bindable(false),
    onOpenChange,
    title,
    description,
    side = 'end',
    width = 400,
    height,
    closeButton = true,
    header,
    footer,
    trigger,
    dismissible = true,
    onOpenAutoFocus,
    onCloseAutoFocus,
    onEscapeKeydown,
    class: className,
    dir: dirProp,
    children,
  }: Props = $props()

  const dir = $derived(resolveDir(dirProp))
  let content: HTMLElement | null = $state(null)
  let body: HTMLElement | null = $state(null)
  let foot: HTMLElement | null = $state(null)

  trackFloating(() => open)
  trackModal(() => open)
  setModalLayer(() => 'dialog')

  function handleOpenAutoFocus(e: Event): void {
    onOpenAutoFocus?.(e)
    if (e.defaultPrevented || content === null) return
    e.preventDefault()
    focusInitial(content, [body, foot])
  }
</script>

<Dialog.Root bind:open {onOpenChange}>
  {#if trigger}
    <Dialog.Trigger>
      {#snippet child({ props })}
        {@render trigger({ props })}
      {/snippet}
    </Dialog.Trigger>
  {/if}
  <Dialog.Portal>
    <Dialog.Overlay>
      {#snippet child({ props })}
        <div {...props} class="backdrop"></div>
      {/snippet}
    </Dialog.Overlay>
    <Dialog.Content
      bind:ref={content}
      onOpenAutoFocus={handleOpenAutoFocus}
      {onCloseAutoFocus}
      {onEscapeKeydown}
      escapeKeydownBehavior={dismissible ? 'close' : 'ignore'}
      interactOutsideBehavior={dismissible ? 'close' : 'ignore'}
    >
      {#snippet child({ props })}
        <div
          {...props}
          class={['sheet', `side-${side}`, className]}
          style:--_w="{width}px"
          style:--_h={height === undefined ? undefined : `${height}px`}
          {dir}
        >
          <header class="header">
            <div class="heading">
              <Dialog.Title>
                {#snippet child({ props: titleProps })}
                  <h2 {...titleProps} class={header ? 'sr-only' : 'title'}>{title}</h2>
                {/snippet}
              </Dialog.Title>
              {#if header}
                {@render header()}
              {:else if description}
                <Dialog.Description>
                  {#snippet child({ props: descriptionProps })}
                    <p {...descriptionProps} class="description">{description}</p>
                  {/snippet}
                </Dialog.Description>
              {/if}
            </div>
            {#if closeButton}
              <Dialog.Close>
                {#snippet child({ props: closeProps })}
                  <IconButton {...closeProps} label={i18n.t('common.close')} icon={X} size="sm" />
                {/snippet}
              </Dialog.Close>
            {/if}
          </header>
          <div class="body" bind:this={body}>
            {@render children()}
          </div>
          {#if footer}
            <footer class="footer" bind:this={foot}>
              {@render footer()}
            </footer>
          {/if}
        </div>
      {/snippet}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-dialog);
    background-color: rgb(0 0 0 / 0.32);
    transition: opacity var(--dur-slow) var(--ease-decelerate);
  }

  .backdrop[data-starting-style],
  .backdrop[data-ending-style] {
    opacity: 0;
  }

  .sheet {
    position: fixed;
    z-index: var(--z-dialog);
    display: flex;
    flex-direction: column;
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-3);
    color: var(--text);
    outline: none;
    transition: translate var(--dur-slow) var(--ease-emphasized);
  }

  .side-end {
    inset-block: 0;
    inset-inline-end: 0;
    inline-size: min(var(--_w), 100vw - 48px);
    border-start-start-radius: var(--radius-lg);
    border-end-start-radius: var(--radius-lg);
  }

  .side-bottom {
    inset-inline: 0;
    inset-block-end: 0;
    block-size: var(--_h, auto);
    max-block-size: 85vh;
    border-start-start-radius: var(--radius-lg);
    border-start-end-radius: var(--radius-lg);
  }

  /* Enter from the inline end: from the right in LTR, from the left in RTL. */
  .side-end[data-starting-style],
  .side-end[data-ending-style] {
    translate: 100% 0;
  }

  .side-end[dir='rtl'][data-starting-style],
  .side-end[dir='rtl'][data-ending-style] {
    translate: -100% 0;
  }

  .side-bottom[data-starting-style],
  .side-bottom[data-ending-style] {
    translate: 0 100%;
  }

  .sheet[data-ending-style] {
    transition-duration: var(--dur-normal);
    transition-timing-function: var(--ease-accelerate);
  }

  .header {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding-block: var(--space-4) var(--space-2);
    padding-inline: var(--space-5) var(--space-3);
  }

  .heading {
    flex: 1 1 auto;
    min-inline-size: 0;
    padding-block-start: 3px;
  }

  .title {
    font-size: var(--text-lg);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .description {
    margin-block-start: var(--space-1);
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .body {
    flex: 1 1 auto;
    min-block-size: 0;
    overflow: auto;
    padding-block: var(--space-2) var(--space-5);
    padding-inline: var(--space-5);
    overscroll-behavior: contain;
  }

  .footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding-block: var(--space-3);
    padding-inline: var(--space-5);
    border-block-start: 1px solid var(--border);
  }

  @media (forced-colors: active) {
    .sheet {
      border-inline-start: 1px solid CanvasText;
    }
  }
</style>
