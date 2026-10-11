<!--
  Spinner (§9.5, internal to Button/SearchInput and exported for inline busy states): a 270° arc in `currentColor` over a
  faint ring. Decorative (`aria-hidden`): the busy state itself is announced by the owner (`aria-busy`, a label).
  Under reduced motion the arc stands still (base.css stops the animation).
-->
<script lang="ts">
  interface Props {
    /** Diameter in px (16 inside sm/md controls, 20 inside lg ones). */
    size?: number
    class?: string
  }

  let { size = 16, class: className }: Props = $props()
</script>

<svg
  class={['spinner', className]}
  width={size}
  height={size}
  viewBox="0 0 16 16"
  aria-hidden="true"
  focusable="false"
>
  <circle class="track" cx="8" cy="8" r="6.25" />
  <path class="arc" d="M8 1.75a6.25 6.25 0 1 1-6.25 6.25" />
</svg>

<style>
  .spinner {
    flex: none;
    animation: spin 0.8s linear infinite;
  }

  .track,
  .arc {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.75;
  }

  .track {
    opacity: 0.22;
  }

  .arc {
    stroke-linecap: round;
  }

  @keyframes spin {
    to {
      rotate: 1turn;
    }
  }
</style>
