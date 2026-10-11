<!--
  EmptyState (§9.5, §9.8): a centred message for an empty panel or list: the 48 px eight-point star
  (`src/assets/star8.svg`, drawn as a mask in `--frame-gold`, not a lucide icon), a title, an optional body, the key
  that fills it (`kbd`, e.g. "Press B on any ayah" teaches `B`) and an optional `action` (a Button).
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import star8 from '../../assets/star8.svg'
  import Kbd from './Kbd.svelte'

  interface Props {
    title: string
    body?: string
    /** A shortcut label (`shortcuts.format(def)`) shown as keycaps under the body. */
    kbd?: string
    action?: Snippet
    /** Less padding and a 36 px star, for narrow panels. */
    compact?: boolean
    class?: string
  }

  let { title, body, kbd, action, compact = false, class: className }: Props = $props()
</script>

<div class={['empty', { compact }, className]}>
  <span class="star" style:--_star={`url("${star8}")`} aria-hidden="true"></span>
  <p class="title">{title}</p>
  {#if body}<p class="body">{body}</p>{/if}
  {#if kbd}<Kbd chord={kbd} />{/if}
  {#if action}<div class="action">{@render action()}</div>{/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding-block: var(--space-10);
    padding-inline: var(--space-6);
    text-align: center;
  }

  .compact {
    padding-block: var(--space-6);
    padding-inline: var(--space-4);
  }

  .star {
    inline-size: 48px;
    block-size: 48px;
    margin-block-end: var(--space-2);
    background-color: var(--frame-gold);
    mask: var(--_star) center / contain no-repeat;
  }

  .compact .star {
    inline-size: 36px;
    block-size: 36px;
  }

  .title {
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .body {
    max-inline-size: 300px;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
  }

  .action {
    margin-block-start: var(--space-2);
  }

  @media (forced-colors: active) {
    .star {
      background-color: CanvasText;
    }
  }
</style>
