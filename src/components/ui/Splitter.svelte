<!--
  Splitter (§9.5, §9.6): the resize handle between two paneforge panes (`PaneResizer`), used by the shell's
  `PaneLayout`. A 6 px hit area over a 1 px `--border` line that takes no layout width (it overlaps both neighbours),
  turning into a 2 px accent line while hovered, dragged or focused. Double-click calls `onReset` (back to the default
  width). Arrow keys resize (paneforge); the handle owns its keys, so they never reach reader shortcuts (§7.7).
  Pixel/percent conversion for the panes lives in `splitter.ts`.
-->
<script lang="ts">
  import { PaneResizer } from 'paneforge'

  interface Props {
    /** Accessible name ("Resize sidebar"). */
    label: string
    /** Double-click: restore the default size. */
    onReset?: () => void
    onDraggingChange?: (dragging: boolean) => void
    disabled?: boolean
    class?: string
  }

  let { label, onReset, onDraggingChange, disabled = false, class: className }: Props = $props()
</script>

<PaneResizer {disabled} {onDraggingChange}>
  {#snippet child({ props })}
    <div
      {...props}
      class={['splitter', className]}
      aria-label={label}
      data-qd-keys="own"
      ondblclick={() => onReset?.()}
    >
      <span class="line" aria-hidden="true"></span>
    </div>
  {/snippet}
</PaneResizer>

<style>
  .splitter {
    position: relative;
    z-index: 1;
    display: flex;
    flex: none;
    justify-content: center;
    outline: none;
  }

  .splitter[data-direction='horizontal'] {
    inline-size: 6px;
    margin-inline: -3px;
  }

  .splitter[data-direction='vertical'] {
    flex-direction: column;
    block-size: 6px;
    margin-block: -3px;
  }

  .line {
    background-color: var(--border);
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      inline-size var(--dur-fast) var(--ease-standard),
      block-size var(--dur-fast) var(--ease-standard);
  }

  [data-direction='horizontal'] .line {
    inline-size: 1px;
    block-size: 100%;
  }

  [data-direction='vertical'] .line {
    inline-size: 100%;
    block-size: 1px;
    align-self: center;
  }

  .splitter[data-enabled='true']:hover .line,
  .splitter[data-active] .line {
    background-color: var(--accent);
  }

  [data-direction='horizontal'][data-enabled='true']:hover .line,
  [data-direction='horizontal'][data-active] .line {
    inline-size: 2px;
  }

  [data-direction='vertical'][data-enabled='true']:hover .line,
  [data-direction='vertical'][data-active] .line {
    block-size: 2px;
  }

  .splitter[data-active='keyboard'] .line {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: 1px;
  }

  @media (forced-colors: active) {
    .line {
      background-color: CanvasText;
    }
  }
</style>
