<!--
  Tabs (§9.5): a tab list with an underline indicator (2 px accent, gliding between tabs) and one panel per tab. Labels
  are text-sm 500; the active label is `--accent-text`. Arrow keys move between tabs and select them (mirrored in RTL,
  §9.5); Home/End jump to the ends.

  `panel` renders the content for a tab value; only the active panel is mounted unless `keepMounted` (tabs that keep
  state, like an editor). Without `panel`, Tabs is a plain tab strip (the consumer shows the content itself).
-->
<script lang="ts">
  import { Tabs } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import { resolveDir } from './floating.svelte'
  import type { Dir, TabItem } from './types'

  interface Props {
    tabs: readonly TabItem[]
    value: string
    onValueChange?: (value: string) => void
    /** Accessible name of the tab list. */
    label: string
    panel?: Snippet<[string]>
    keepMounted?: boolean
    /** Tabs share the full width equally (side pane). */
    fill?: boolean
    /** `manual`: arrows move focus, Enter/Space selects. */
    activation?: 'automatic' | 'manual'
    dir?: Dir
    class?: string
  }

  let {
    tabs,
    value = $bindable(),
    onValueChange,
    label,
    panel,
    keepMounted = false,
    fill = false,
    activation = 'automatic',
    dir: dirProp,
    class: className,
  }: Props = $props()

  const dir = $derived(resolveDir(dirProp))
  let list: HTMLElement | null = $state(null)
  let bar = $state<{ x: number; w: number } | null>(null)
  let animate = $state(false)

  function select(next: string): void {
    if (next === value) return
    value = next
    onValueChange?.(next)
  }

  function measure(): void {
    const active = list?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
    bar = active ? { x: active.offsetLeft, w: active.offsetWidth } : null
  }

  $effect(() => {
    void value
    void tabs
    void dir
    measure()
    const id = requestAnimationFrame(() => (animate = true))
    return () => cancelAnimationFrame(id)
  })

  $effect(() => {
    if (!list) return
    const observer = new ResizeObserver(() => {
      animate = false
      measure()
      requestAnimationFrame(() => (animate = true))
    })
    observer.observe(list)
    return () => observer.disconnect()
  })
</script>

<Tabs.Root bind:value={() => value, select} activationMode={activation}>
  {#snippet child({ props })}
    <div {...props} class={['tabs', className]} {dir}>
      <Tabs.List bind:ref={list}>
        {#snippet child({ props: listProps })}
          <div {...listProps} class={['list', { fill }]} aria-label={label}>
            {#each tabs as tab (tab.value)}
              {@const Icon = tab.icon}
              <Tabs.Trigger value={tab.value} disabled={tab.disabled}>
                {#snippet child({ props: triggerProps })}
                  <button {...triggerProps} class="tab">
                    {#if Icon}<Icon size={16} strokeWidth={1.75} aria-hidden="true" />{/if}
                    <span class="text">{tab.label}</span>
                    {#if tab.badge !== undefined}<span class="badge">{tab.badge}</span>{/if}
                  </button>
                {/snippet}
              </Tabs.Trigger>
            {/each}
            {#if bar}
              <span
                class={['indicator', { animate }]}
                style:translate="{bar.x}px 0"
                style:inline-size="{bar.w}px"
                aria-hidden="true"
              ></span>
            {/if}
          </div>
        {/snippet}
      </Tabs.List>
      {#if panel}
        {#each tabs as tab (tab.value)}
          <Tabs.Content value={tab.value}>
            {#snippet child({ props: contentProps })}
              <div {...contentProps} class="panel">
                {#if keepMounted || tab.value === value}
                  {@render panel(tab.value)}
                {/if}
              </div>
            {/snippet}
          </Tabs.Content>
        {/each}
      {/if}
    </div>
  {/snippet}
</Tabs.Root>

<style>
  .tabs {
    display: flex;
    flex-direction: column;
    min-block-size: 0;
  }

  .list {
    position: relative;
    display: flex;
    flex: none;
    overflow-x: auto;
    scrollbar-width: none;
    gap: var(--space-1);
    border-block-end: 1px solid var(--border);
  }

  .tab {
    position: relative;
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    gap: 6px;
    block-size: 36px;
    padding-block: 0;
    padding-inline: var(--space-3);
    border: 0;
    background: none;
    color: var(--text-muted);
    font-family: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    white-space: nowrap;
    cursor: pointer;
    transition: color var(--dur-quick) var(--ease-standard);
  }

  .fill .tab {
    flex: 1 0 auto;
    padding-inline: var(--space-2);
  }

  .tab:hover:not(:disabled, [data-state='active']) {
    color: var(--text);
  }

  .tab[data-state='active'] {
    color: var(--accent-text);
  }

  .tab:disabled {
    color: var(--text-faint);
    cursor: default;
  }

  .tab:focus-visible {
    outline-offset: -2px;
  }

  .text {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
  }

  .badge {
    min-inline-size: 18px;
    padding-inline: 5px;
    border-radius: var(--radius-full);
    background-color: color-mix(in srgb, var(--text) 8%, var(--surface-raised));
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: var(--weight-title);
    font-variant-numeric: tabular-nums;
    line-height: 18px;
  }

  /* Placed from the measured physical offset of the active tab. */
  .indicator {
    position: absolute;
    inset-block-end: -1px;
    left: 0; /* physical-ok */
    block-size: 2px;
    border-radius: 2px 2px 0 0;
    background-color: var(--accent);
  }

  .indicator.animate {
    transition:
      translate var(--dur-quick) var(--ease-standard),
      inline-size var(--dur-quick) var(--ease-standard);
  }

  .panel {
    flex: 1 1 auto;
    min-block-size: 0;
    outline: none;
  }

  .panel[hidden] {
    display: none;
  }

  @media (forced-colors: active) {
    .indicator {
      background-color: Highlight;
    }
  }
</style>
