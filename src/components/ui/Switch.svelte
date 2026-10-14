<!--
  Switch: an on/off control (bits-ui Switch, `role="switch"`). 32×18 track: off is `--surface-sunken` with a
  1 px `--border-input` outline and a muted thumb; on is the accent with an accent-ink thumb at the inline end (the
  left in RTL). The thumb slides in 150 ms.

  With `label` the switch renders its own label (and optional `description`) before it, both clickable; without
  one, name it with `aria-label` / `aria-labelledby` (e.g. a Settings row whose label is elsewhere).
-->
<script lang="ts">
  import { Switch } from 'bits-ui'
  import { resolveDir } from './floating.svelte'
  import type { Dir } from './types'

  interface Props {
    checked?: boolean
    onCheckedChange?: (checked: boolean) => void
    /** Visible label before the switch. */
    label?: string
    /** Secondary text under the label. */
    description?: string
    disabled?: boolean
    id?: string
    'aria-label'?: string
    'aria-labelledby'?: string
    'aria-describedby'?: string
    dir?: Dir
    class?: string
  }

  let {
    checked = $bindable(false),
    onCheckedChange,
    label,
    description,
    disabled = false,
    id: idProp,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    'aria-describedby': ariaDescribedBy,
    dir: dirProp,
    class: className,
  }: Props = $props()

  const uid = $props.id()
  const id = $derived(idProp ?? `${uid}-switch`)
  const descriptionId = $derived(`${id}-description`)
  const dir = $derived(resolveDir(dirProp))

  function setChecked(next: boolean): void {
    if (next === checked) return
    checked = next
    onCheckedChange?.(next)
  }
</script>

{#snippet control()}
  <Switch.Root bind:checked={() => checked, setChecked} {disabled} {id}>
    {#snippet child({ props })}
      <button
        {...props}
        class={['switch', !label && ['standalone', className]]}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy ?? (label && description ? descriptionId : undefined)}
        {dir}
      >
        <Switch.Thumb>
          {#snippet child({ props: thumbProps })}
            <span {...thumbProps} class="thumb"></span>
          {/snippet}
        </Switch.Thumb>
      </button>
    {/snippet}
  </Switch.Root>
{/snippet}

{#if label}
  <div class={['field', { disabled }, className]} {dir}>
    <span class="text">
      <label class="label" for={id}>{label}</label>
      {#if description}<span class="description" id={descriptionId}>{description}</span>{/if}
    </span>
    {@render control()}
  </div>
{:else}
  {@render control()}
{/if}

<style>
  .field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .field.disabled {
    opacity: 0.5;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }

  .label {
    font-size: var(--text-md);
    font-weight: var(--weight-label);
    cursor: pointer;
  }

  .disabled .label {
    cursor: default;
  }

  .description {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .switch {
    position: relative;
    flex: none;
    inline-size: 32px;
    block-size: 18px;
    padding: 0;
    border: 1px solid var(--border-input);
    border-radius: var(--radius-full);
    background-color: var(--surface-sunken);
    cursor: pointer;
    transition:
      background-color var(--dur-quick) var(--ease-standard),
      border-color var(--dur-quick) var(--ease-standard);
  }

  .switch:hover:not(:disabled) {
    border-color: var(--text-muted);
  }

  .switch[data-state='checked'] {
    border-color: var(--accent);
    background-color: var(--accent);
  }

  .switch[data-state='checked']:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--accent) 94%, var(--text));
    background-color: color-mix(in srgb, var(--accent) 94%, var(--text));
  }

  .switch:disabled {
    cursor: default;
  }

  .standalone:disabled {
    opacity: 0.5;
  }

  .thumb {
    position: absolute;
    inset-block-start: 50%;
    inset-inline-start: 3px;
    display: block;
    inline-size: 10px;
    block-size: 10px;
    margin-block-start: -5px;
    border-radius: var(--radius-full);
    background-color: var(--text-muted);
    transition:
      inset-inline-start var(--dur-quick) var(--ease-standard),
      inline-size var(--dur-quick) var(--ease-standard),
      block-size var(--dur-quick) var(--ease-standard),
      margin var(--dur-quick) var(--ease-standard),
      background-color var(--dur-quick) var(--ease-standard);
  }

  .thumb[data-state='checked'] {
    inset-inline-start: 15px;
    inline-size: 12px;
    block-size: 12px;
    margin-block-start: -6px;
    background-color: var(--accent-ink);
  }

  @media (forced-colors: active) {
    .switch[data-state='checked'] {
      border-color: Highlight;
      background-color: Highlight;
    }

    .thumb {
      background-color: CanvasText;
    }

    .thumb[data-state='checked'] {
      background-color: Canvas;
    }
  }
</style>
