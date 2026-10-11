<!--
  Dialog (§9.5, §7.4): a modal bits-ui Dialog with a focus trap, Escape and outside-click dismissal and focus
  restoration. Sizes sm 400 / md 560 / lg 720 px (or `width`), radius-lg, shadow-3, a rgb(0 0 0 / .32) backdrop
  (`backdrop="faint"`: .18, onboarding over the page spread). Enters in 200 ms, decelerating from scale .98.

  - `title` is always the accessible name; `description` the accessible description. The default chrome is a header
    (title, description, close button), the body (`children`, scrolls when tall) and an optional `footer` (actions,
    end-aligned). `header` replaces the title block. `variant="bare"` drops the chrome (the command palette): the
    title stays for screen readers and the surface is the translucent glass of §9.4.
  - Opening focuses `[data-autofocus]`, else the first control of the body, then of the footer, else the dialog
    (never the close button). Pass `onOpenAutoFocus` / `onCloseAutoFocus` and call `preventDefault()` to take over
    (e.g. a jump that moves focus to the target ayah instead of restoring it, §7.4).
  - While open it counts as a layer for shortcuts (§7.7 rule 1).
  - `layer="view"` is an in-window view (the Settings dialog, §7.4): drawn just under `--z-dialog`, so every other
    dialog paints above it; it counts as no layer (its host registers its own) and leaves the page outside it live
    (no body lock), so the title bar and the player dock stay usable. With it: `variant="plain"` (no chrome; the
    content paints the surface and names the dialog through `labelledBy`), `insetTop` / `scrimTop` (a band at the top,
    the title bar, left uncovered), `insetBottom` (a band at the bottom, the player dock's, the dialog stays above),
    `height` (a fixed height, whatever the content), `fill` (edge to edge: no margin, radius or shadow) and
    `onInteractOutside` (`preventDefault()` keeps it open for a click on chrome that stays usable).
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
    /** sm 400 · md 560 · lg 720 px. */
    size?: 'sm' | 'md' | 'lg'
    /** Width in px, overriding `size`. */
    width?: number
    /** Height in px (at most the room there is): the dialog keeps this size whatever it shows. */
    height?: number
    /** `top` sits at 14 vh (palette, Go to); `center` centres in the window. */
    placement?: 'center' | 'top'
    /** `plain`: no chrome, an opaque surface the content paints itself. */
    variant?: 'default' | 'bare' | 'plain'
    backdrop?: 'dim' | 'faint'
    /**
     * Stacking layer: dialogs, the command palette above them (§9.4 z-index), or an in-window view just under the
     * dialogs (see the header).
     */
    layer?: 'dialog' | 'palette' | 'view'
    /** A band at the top (px) the dialog stays below, and the backdrop too unless `scrimTop` says otherwise. */
    insetTop?: number
    /** The band at the top (px) the backdrop leaves uncovered (default `insetTop`). */
    scrimTop?: number
    /** A band at the bottom (px) the dialog stays above; the backdrop still covers it. */
    insetBottom?: number
    /** Fill the room edge to edge, without margin, radius or shadow. */
    fill?: boolean
    /** The id(s) of a heading inside that names the dialog, instead of `title` (`bare` and `plain`). */
    labelledBy?: string
    /** Show the header close button (default chrome only). */
    closeButton?: boolean
    /** `false`: Escape and outside clicks do not close it (a step that must be answered). */
    dismissible?: boolean
    header?: Snippet
    footer?: Snippet
    trigger?: Snippet<[TriggerProps]>
    onOpenAutoFocus?: (e: Event) => void
    onCloseAutoFocus?: (e: Event) => void
    onEscapeKeydown?: (e: KeyboardEvent) => void
    onInteractOutside?: (e: PointerEvent) => void
    class?: string
    dir?: Dir
    children: Snippet
  }

  let {
    open = $bindable(false),
    onOpenChange,
    title,
    description,
    size = 'md',
    width,
    height,
    placement = 'center',
    variant = 'default',
    backdrop = 'dim',
    layer = 'dialog',
    insetTop = 0,
    scrimTop,
    insetBottom = 0,
    fill = false,
    labelledBy,
    closeButton = true,
    dismissible = true,
    header,
    footer,
    trigger,
    onOpenAutoFocus,
    onCloseAutoFocus,
    onEscapeKeydown,
    onInteractOutside,
    class: className,
    dir: dirProp,
    children,
  }: Props = $props()

  const WIDTHS = { sm: 400, md: 560, lg: 720 } as const

  const dir = $derived(resolveDir(dirProp))
  let content: HTMLElement | null = $state(null)
  let body: HTMLElement | null = $state(null)
  let foot: HTMLElement | null = $state(null)

  // A view dialog is no layer of its own (its host registers one); what opens inside it stacks as over a dialog.
  trackFloating(() => open && layer !== 'view')
  trackModal(() => open && layer !== 'view')
  setModalLayer(() => (layer === 'view' ? 'dialog' : layer))

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
        <div
          {...props}
          class={['backdrop', `backdrop-${backdrop}`, `layer-${layer}`]}
          style:inset-block-start="{scrimTop ?? insetTop}px"
        ></div>
      {/snippet}
    </Dialog.Overlay>
    <Dialog.Content
      bind:ref={content}
      onOpenAutoFocus={handleOpenAutoFocus}
      {onCloseAutoFocus}
      {onEscapeKeydown}
      {onInteractOutside}
      escapeKeydownBehavior={dismissible ? 'close' : 'ignore'}
      interactOutsideBehavior={dismissible ? 'close' : 'ignore'}
      preventScroll={layer !== 'view'}
    >
      {#snippet child({ props })}
        <div
          class={['positioner', `at-${placement}`, `layer-${layer}`, { fill }]}
          style:inset-block-start="{insetTop}px"
          style:inset-block-end="{insetBottom}px"
        >
          <div
            {...props}
            aria-labelledby={labelledBy ?? (props['aria-labelledby'] as string | undefined)}
            class={['dialog', `variant-${variant}`, { sized: height !== undefined }, className]}
            style:--_w="{width ?? WIDTHS[size]}px"
            style:--_h={height === undefined ? undefined : `${height}px`}
            {dir}
          >
            {#if variant === 'bare' || variant === 'plain'}
              {#if labelledBy === undefined}
                <Dialog.Title>
                  {#snippet child({ props: titleProps })}
                    <h2 {...titleProps} class="sr-only">{title}</h2>
                  {/snippet}
                </Dialog.Title>
              {/if}
              {#if description}
                <Dialog.Description>
                  {#snippet child({ props: descriptionProps })}
                    <p {...descriptionProps} class="sr-only">{description}</p>
                  {/snippet}
                </Dialog.Description>
              {/if}
              {@render children()}
            {:else}
              <!-- `div`, not `header`/`footer`: outside sectioning content those map to banner and contentinfo, so every
                   dialog would add a second banner landmark to the page (HTML-AAM). -->
              <div class="header">
                <div class="heading">
                  {#if header}
                    <Dialog.Title>
                      {#snippet child({ props: titleProps })}
                        <h2 {...titleProps} class="sr-only">{title}</h2>
                      {/snippet}
                    </Dialog.Title>
                    {@render header()}
                  {:else}
                    <Dialog.Title>
                      {#snippet child({ props: titleProps })}
                        <h2 {...titleProps} class="title">{title}</h2>
                      {/snippet}
                    </Dialog.Title>
                    {#if description}
                      <Dialog.Description>
                        {#snippet child({ props: descriptionProps })}
                          <p {...descriptionProps} class="description">{description}</p>
                        {/snippet}
                      </Dialog.Description>
                    {/if}
                  {/if}
                </div>
                {#if closeButton}
                  <Dialog.Close>
                    {#snippet child({ props: closeProps })}
                      <IconButton
                        {...closeProps}
                        class="close"
                        label={i18n.t('common.close')}
                        icon={X}
                        size="sm"
                      />
                    {/snippet}
                  </Dialog.Close>
                {/if}
              </div>
              <div class="body" bind:this={body}>
                {@render children()}
              </div>
              {#if footer}
                <div class="footer" bind:this={foot}>
                  {@render footer()}
                </div>
              {/if}
            {/if}
          </div>
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
    transition: opacity var(--dur-normal) var(--ease-decelerate);
  }

  .backdrop-faint {
    background-color: rgb(0 0 0 / 0.18);
  }

  .backdrop[data-starting-style],
  .backdrop[data-ending-style] {
    opacity: 0;
  }

  .positioner {
    position: fixed;
    inset: 0;
    z-index: var(--z-dialog);
    display: flex;
    justify-content: center;
    align-items: center;
    padding: var(--space-6) var(--space-4);
    pointer-events: none;
  }

  .layer-palette {
    z-index: var(--z-palette);
  }

  /* Under every other dialog (later in the document at --z-dialog), above the page and its floating chrome. */
  .layer-view {
    z-index: calc(var(--z-dialog) - 1);
  }

  /* In zen the uncovered band follows the title bar sliding in (`scrimTop`). */
  .backdrop.layer-view {
    transition:
      opacity var(--dur-normal) var(--ease-decelerate),
      inset-block-start var(--dur-normal) var(--ease-standard);
  }

  .positioner.layer-view {
    padding: var(--space-6);
  }

  .positioner.fill {
    padding: 0;
  }

  .at-top {
    align-items: flex-start;
    padding-block-start: 14vh;
  }

  .dialog {
    display: flex;
    flex-direction: column;
    inline-size: min(var(--_w), 100%);
    max-block-size: 100%;
    border-radius: var(--radius-lg);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-3);
    color: var(--text);
    pointer-events: auto;
    outline: none;
    transform-origin: center;
    transition:
      opacity var(--dur-normal) var(--ease-decelerate),
      scale var(--dur-normal) var(--ease-decelerate);
  }

  .at-top .dialog {
    max-block-size: calc(100% - 4vh);
  }

  .dialog.sized {
    block-size: min(var(--_h), 100%);
  }

  .fill .dialog {
    inline-size: 100%;
    block-size: 100%;
    border-radius: 0;
    box-shadow: none;
  }

  .dialog[data-starting-style],
  .dialog[data-ending-style] {
    opacity: 0;
    scale: 0.98;
  }

  .dialog[data-ending-style] {
    transition-duration: var(--dur-fast);
    transition-timing-function: var(--ease-accelerate);
  }

  .variant-bare {
    overflow: hidden;
    background-color: var(--glass-fill);
    backdrop-filter: var(--backdrop-palette);
  }

  .variant-plain {
    overflow: hidden;
    background-color: var(--surface-app);
  }

  .header {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding-block: var(--space-5) 0;
    padding-inline: var(--space-6) var(--space-4);
  }

  .heading {
    flex: 1 1 auto;
    min-inline-size: 0;
    padding-block-start: 2px;
  }

  .title {
    font-size: var(--text-xl);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .description {
    margin-block-start: var(--space-1);
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
  }

  .header :global(.close) {
    margin-block-start: -2px;
  }

  .body {
    flex: 1 1 auto;
    min-block-size: 0;
    overflow: auto;
    padding-block: var(--space-4) var(--space-6);
    padding-inline: var(--space-6);
    overscroll-behavior: contain;
  }

  .footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
    gap: var(--space-2);
    padding-block: var(--space-3) var(--space-5);
    padding-inline: var(--space-6);
  }

  .body:has(+ .footer) {
    padding-block-end: var(--space-2);
  }

  @media (forced-colors: active) {
    .dialog {
      border: 1px solid CanvasText;
    }
  }
</style>
