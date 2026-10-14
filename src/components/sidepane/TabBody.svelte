<!--
  TabBody: the frame of a study-pane tab — an optional fixed toolbar (a pack picker, a toggle) over a scrolling body
  with overlay scrollbars (`ScrollArea`). The body returns to the top when `resetKey` changes (another ayah), and is
  `aria-busy` while its content loads. Used only inside `src/components/sidepane`.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import { untrack } from 'svelte'
  import { ScrollArea } from '$components/ui'

  interface Props {
    /** Scroll back to the top whenever this changes (the pane's subject). */
    resetKey: string
    busy?: boolean
    toolbar?: Snippet
    children: Snippet
  }

  let { resetKey, busy = false, toolbar, children }: Props = $props()

  let viewport: HTMLElement | null = $state(null)

  $effect(() => {
    void resetKey
    untrack(() => {
      if (viewport) viewport.scrollTop = 0
    })
  })
</script>

<div class="tab-body">
  {#if toolbar}
    <div class="toolbar">{@render toolbar()}</div>
  {/if}
  <ScrollArea class="tab-scroll" bind:viewport>
    <div class="content" aria-busy={busy}>
      {@render children()}
    </div>
  </ScrollArea>
</div>

<style>
  .tab-body {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-block-size: 0;
  }

  .toolbar {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    min-block-size: 44px;
    padding-block: var(--space-2);
    padding-inline: var(--space-4);
    border-block-end: 1px solid var(--border);
  }

  .tab-body :global(.tab-scroll) {
    flex: 1 1 auto;
    min-block-size: 0;
  }

  .content {
    padding-block: var(--space-4) var(--space-6);
    padding-inline: var(--space-5);
  }
</style>
