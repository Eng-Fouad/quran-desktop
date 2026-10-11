<!--
  SafeHtml (§7.6; WP0C, frozen): the only component that renders an HTML string, and the only file allowed to disable
  svelte/no-at-html-tags. Input goes through `renderSafeHtml` (DOMPurify with the §2.5.6 policy). Reference buttons
  (`button[data-ref]`) call `onref`; footnote markers (`sup.fn[data-fn]`, role=button) call `onfootnote` on click,
  Enter or Space. Style the content from the parent with `.safe-html :global(...)`.
-->
<script lang="ts">
  import type { SafeHtmlProps } from '$lib/contracts/components'
  import { renderSafeHtml } from '$lib/text/html'

  let { html, onref, onfootnote }: SafeHtmlProps = $props()

  let container: HTMLDivElement | undefined = $state()
  const safe = $derived(renderSafeHtml(html))

  /** Activates the reference or footnote at `target`; returns whether one was found inside this component. */
  function activate(target: EventTarget | null): boolean {
    if (!(target instanceof Element) || !container) return false
    const ref = target.closest('button[data-ref]')
    if (ref && container.contains(ref)) {
      const value = ref.getAttribute('data-ref')
      if (value) onref?.(value)
      return true
    }
    const footnote = target.closest('sup.fn[data-fn]')
    if (footnote && container.contains(footnote)) {
      const id = footnote.getAttribute('data-fn')
      if (id) onfootnote?.(id)
      return true
    }
    return false
  }

  function onclick(e: MouseEvent): void {
    if (activate(e.target)) e.preventDefault()
  }

  function onkeydown(e: KeyboardEvent): void {
    // Buttons activate natively; footnote markers are role=button spans and need Enter/Space here.
    if (e.key !== 'Enter' && e.key !== ' ') return
    if (e.target instanceof Element && e.target.matches('sup.fn[data-fn]') && activate(e.target))
      e.preventDefault()
  }
</script>

<!-- Delegation container: the interactive children (buttons, role=button markers) carry their own semantics. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="safe-html" bind:this={container} {onclick} {onkeydown}>
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html safe}
</div>

<style>
  .safe-html :global(button.ref) {
    all: unset;
    color: var(--accent-text, inherit);
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 0.2em;
  }
  .safe-html :global(button.ref:focus-visible),
  .safe-html :global(sup.fn:focus-visible) {
    outline: var(--focus-ring-w, 2px) solid var(--focus-ring, currentColor);
    outline-offset: var(--focus-ring-offset, 2px);
  }
  .safe-html :global(sup.fn) {
    color: var(--accent-text, inherit);
    cursor: pointer;
  }
</style>
