<!--
  Field (§9.5): a label, a control and its hint or error, wired for assistive technology. The control comes from the
  `children` snippet, which receives `{ id, describedBy, invalid, required }` to put on the input
  (`<TextInput id={c.id} aria-describedby={c.describedBy} invalid={c.invalid} />`). The error (text-xs,
  `--danger-text`, announced politely) replaces the hint while present.

  `layout="row"` puts label and hint at the inline start and the control at the inline end (Settings rows, §9.7).
-->
<script lang="ts">
  import type { FieldControl } from './types'

  interface Props {
    label: string
    hint?: string
    error?: string
    required?: boolean
    /** Use this id for the control (otherwise one is generated). */
    id?: string
    layout?: 'column' | 'row'
    class?: string
    children: FieldControl
  }

  let {
    label,
    hint,
    error,
    required = false,
    id: idProp,
    layout = 'column',
    class: className,
    children,
  }: Props = $props()

  const uid = $props.id()
  const id = $derived(idProp ?? `${uid}-control`)
  const messageId = $derived(`${id}-message`)
  const message = $derived(error ?? hint)
  const invalid = $derived(error !== undefined && error !== '')
</script>

<div class={['field', `layout-${layout}`, className]}>
  <div class="text">
    <label class="label" for={id}>
      {label}{#if required}<span class="required" aria-hidden="true">*</span>{/if}
    </label>
    {#if layout === 'row' && message}
      <p class={['message', { error: invalid }]} id={messageId} aria-live={invalid ? 'polite' : undefined}>
        {message}
      </p>
    {/if}
  </div>
  <div class="control">
    {@render children({ id, describedBy: message ? messageId : undefined, invalid, required })}
  </div>
  {#if layout === 'column' && message}
    <p class={['message', { error: invalid }]} id={messageId} aria-live={invalid ? 'polite' : undefined}>
      {message}
    </p>
  {/if}
</div>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-inline-size: 0;
  }

  .layout-row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }

  .label {
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
  }

  .layout-row .label {
    font-size: var(--text-md);
  }

  .required {
    margin-inline-start: 2px;
    color: var(--danger-text);
  }

  .control {
    display: flex;
    min-inline-size: 0;
  }

  .layout-row .control {
    flex: none;
  }

  .message {
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
  }

  .layout-row .message {
    font-size: var(--text-sm);
  }

  .message.error {
    color: var(--danger-text);
  }
</style>
