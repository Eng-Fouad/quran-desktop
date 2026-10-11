<!--
  OptionCheck (§9.7 onboarding): a labelled checkbox for the options of a Mushaf style card ("Ornate surah headers",
  "Download all pages in the background"). Owner: WP12c. A native `<input type="checkbox">` drawn to the design system:
  16 px box, radius-xs, 1 px `--border-input`, accent fill with an accent-ink tick when checked, the focus ring of
  §9.4. The whole row is the label.
-->
<script lang="ts">
  interface Props {
    checked: boolean
    onchange: (checked: boolean) => void
    label: string
    disabled?: boolean
    class?: string
    /** Marks the input for tests and QA (`data-option`). */
    option?: string
  }

  let { checked, onchange, label, disabled = false, class: className, option }: Props = $props()
</script>

<label class={['option', { disabled }, className]}>
  <input
    type="checkbox"
    {checked}
    {disabled}
    data-option={option}
    onchange={(e) => onchange(e.currentTarget.checked)}
  />
  <span class="text">{label}</span>
</label>

<style>
  .option {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-block-size: 28px;
    color: var(--text);
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
    cursor: pointer;
  }

  .option.disabled {
    color: var(--text-faint);
    cursor: default;
  }

  input {
    appearance: none;
    display: inline-grid;
    flex: none;
    place-content: center;
    inline-size: 16px;
    block-size: 16px;
    margin: 0;
    border: 1px solid var(--border-input);
    border-radius: var(--radius-xs);
    background-color: var(--surface-raised);
    cursor: inherit;
    transition:
      background-color var(--dur-quick) var(--ease-standard),
      border-color var(--dur-quick) var(--ease-standard);
  }

  /* The tick: a rotated L drawn with borders, so it follows `--accent-ink` in every theme. */
  input::after {
    content: '';
    inline-size: 4px;
    block-size: 8px;
    margin-block-start: -2px;
    border: solid var(--accent-ink);
    border-width: 0 2px 2px 0; /* physical-ok: a tick never mirrors */
    rotate: 45deg;
    scale: 0;
    transition: scale var(--dur-quick) var(--ease-emphasized);
  }

  input:checked {
    border-color: var(--accent);
    background-color: var(--accent);
  }

  input:checked::after {
    scale: 1;
  }

  input:hover:not(:disabled, :checked) {
    border-color: var(--text-muted);
  }

  input:disabled {
    opacity: 0.5;
  }

  .text {
    min-inline-size: 0;
  }

  @media (forced-colors: active) {
    input {
      appearance: auto;
    }

    input::after {
      display: none;
    }
  }
</style>
