<!-- Test fixture: the study pane in a docked-pane-sized aside (the shell's `PaneLayout` gives it its size). -->
<script lang="ts">
  import SidePane from '../SidePane.svelte'

  interface Props {
    width?: number
    height?: number
  }

  let { width = 400, height = 860 }: Props = $props()
</script>

<aside
  class="host"
  data-test-host
  data-qd-region="side-pane"
  style:inline-size="{width}px"
  style:block-size="{height}px"
>
  <SidePane />
</aside>

<style>
  .host {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background-color: var(--surface-raised);
    color: var(--text);
  }
</style>
