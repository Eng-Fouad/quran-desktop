<!--
  Kbd: keycaps for a shortcut. Pass the caps (`keys={['Ctrl', 'K']}`) or a label from
  `shortcuts.format(def)` (`chord="Ctrl+K"`, split with `splitChord`). The caps sit inside `<bdi dir="ltr">`, so
  "Ctrl+K" never reads "K+Ctrl" in the Arabic UI. Windows/Linux chords show a faint "+" between caps; macOS glyph
  chords (⌘⇧K) do not. Text-xs mono, 1 px `--border-strong`, radius-xs, a bottom inset shadow. A cap named by a word in
  a non-Latin script (the Arabic UI's "مسافة" for Space) uses the UI font: a monospaced fallback spaces its letters apart.
-->
<script lang="ts">
  import { isMacModifier, splitChord } from './kbd'

  interface Props {
    /** One entry per keycap. */
    keys?: readonly string[]
    /** A whole chord label (`Ctrl+Shift+K`, `⌘K`), used when `keys` is not given. */
    chord?: string
    /** `sm` (16 px caps) for dense rows and menus; `md` (20 px) elsewhere. */
    size?: 'sm' | 'md'
    class?: string
  }

  let { keys, chord, size = 'md', class: className }: Props = $props()

  const caps = $derived(keys ?? (chord === undefined ? [] : splitChord(chord)))
  const glyphChord = $derived(caps.some(isMacModifier))

  /** A key name written in a non-Latin script (letters outside ASCII): set in the UI font, in its own direction. */
  const isWord = (cap: string) => /\p{L}/u.test(cap) && /[^\p{ASCII}]/u.test(cap)
</script>

{#if caps.length > 0}
  <!-- Flex layout: the whitespace between the caps is not rendered. -->
  <kbd class={['kbd', `s-${size}`, className]}>
    <bdi dir="ltr" class="caps">
      {#each caps as cap, i (i)}
        {#if i > 0 && !glyphChord}<span class="plus" aria-hidden="true">+</span>{/if}
        <kbd class={['cap', { word: isWord(cap) }]} dir={isWord(cap) ? 'auto' : undefined}>{cap}</kbd>
      {/each}
    </bdi>
  </kbd>
{/if}

<style>
  .kbd {
    display: inline-flex;
    vertical-align: middle;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: var(--weight-body);
    line-height: 1;
    white-space: nowrap;
    color: var(--text-muted);
  }

  .caps {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  .cap {
    display: inline-grid;
    place-items: center;
    min-inline-size: 20px;
    block-size: 20px;
    padding-inline: 5px;
    padding-block-end: 1px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-xs);
    background-color: var(--surface-raised);
    box-shadow: inset 0 -1px 0 var(--border-strong);
    font: inherit;
  }

  .s-sm .cap {
    min-inline-size: 16px;
    block-size: 16px;
    padding-inline: 3px;
    font-size: var(--text-2xs);
  }

  .cap.word {
    font-family: var(--font-ui);
  }

  .plus {
    color: var(--text-faint);
    font-size: var(--text-2xs);
  }
</style>
