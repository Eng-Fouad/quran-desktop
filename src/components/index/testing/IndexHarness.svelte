<!-- Test fixture: the Index panel in a sidebar-sized box (the shell's Sidebar gives it its height). -->
<script lang="ts">
  import IndexPanel from '../IndexPanel.svelte'

  interface Props {
    width?: number
    height?: number
  }

  let { width = 300, height = 720 }: Props = $props()
</script>

<div class="host" data-test-host style:inline-size="{width}px" style:block-size="{height}px">
  <IndexPanel />
</div>

<style>
  .host {
    display: flex;
    flex-direction: column;
    background-color: var(--surface-app);
    color: var(--text);
  }
</style>
