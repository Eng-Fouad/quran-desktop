<!--
  TooltipProvider: one bits-ui provider for a subtree, so moving between neighbouring controls (a toolbar, the
  rail) shows the next tooltip at once instead of waiting the 500 ms delay again. The shell wraps the app in it; a
  `Tooltip` outside any provider creates its own.
-->
<script lang="ts">
  import { Tooltip } from 'bits-ui'
  import { setContext, type Snippet } from 'svelte'
  import { TOOLTIP_PROVIDER } from './floating.svelte'

  interface Props {
    /** Hover delay before the first tooltip opens (ms). */
    delay?: number
    /** Window after a tooltip closes during which the next one opens instantly (ms). */
    skipDelay?: number
    children: Snippet
  }

  let { delay = 500, skipDelay = 300, children }: Props = $props()

  setContext(TOOLTIP_PROVIDER, true)
</script>

<Tooltip.Provider delayDuration={delay} skipDelayDuration={skipDelay} ignoreNonKeyboardFocus>
  {@render children()}
</Tooltip.Provider>
