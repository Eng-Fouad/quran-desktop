<!--
  DisplayPopover (owner request 2026-10-11): the reading-display popover of the canvas's "Aa" button (`DisplayControl`).
  Settings' own controls, compact, applied live to the page beside it (no scrim), and only those that change what is on
  screen (`displayRows`):

  - Theme: the six theme cards, three across (`ThemePicker compact`).
  - Ink brightness on Night and Black, as in Settings › Appearance (with its note under "increase contrast").
  - Beside the Mushaf: the Mushaf style (`StylePicker compact`: the styles Settings offers, with its availability
    rules) and the pages (automatic, one page, two pages).
  - The translation text size wherever translation text shows (translation mode, the study pane's Translation tab).
  - Footer: "All settings" with `Mod+,`, which opens the Settings dialog on the reading mode's section (Mushaf, or
    Translations). The key works inside the popover too: as a floating layer it holds `Mod+,` back otherwise.

  340 px wide; the header and footer stay and the rows scroll when the window is short. Arrowless, as the app's other
  chrome-button popovers. A floating layer: Escape or a click outside closes it; it closes when the view leaves
  the reader. It opens on its heading, so Tab reaches the cards and arrow keys never change the theme by surprise.
-->
<script lang="ts">
  import { tick, type Snippet } from 'svelte'
  import { MediaQuery } from 'svelte/reactivity'
  import { Button, Kbd, Popover, ScrollArea, Segmented, Slider } from '$components/ui'
  import type { Align, SegmentedOption, Side, TriggerProps } from '$components/ui/types'
  import type { PageMode } from '$lib/ipc/bindings'
  import { i18n, settings, shortcuts, ui } from '$lib/stores'
  import StylePicker from './controls/StylePicker.svelte'
  import ThemePicker from './controls/ThemePicker.svelte'
  import { DISPLAY_W, displayRows, displaySection, inkNoteKey, MORE_CONTRAST, PAGE_MODES } from './display'
  import { metaOf } from './meta'
  import { formatValue, save } from './model'
  import { settingsView } from './view.svelte'

  interface Props {
    /** The "Aa" button (it receives the trigger props to spread). */
    trigger: Snippet<[TriggerProps]>
    /** Anchor to this element instead of the trigger (the button's glass capsule). */
    anchor?: HTMLElement | null
    side?: Side
    align?: Align
    sideOffset?: number
    open?: boolean
  }

  let {
    trigger,
    anchor = null,
    side = 'left',
    align = 'start',
    sideOffset = 8,
    open = $bindable(false),
  }: Props = $props()

  type SliderId = 'inkBrightnessPct' | 'translationFontPct'

  const uid = $props.id()
  let heading: HTMLElement | null = $state(null)
  const moreContrast = new MediaQuery(MORE_CONTRAST, false)

  const mode = $derived(settings.value.readingMode)
  const rows = $derived(
    new Set(
      displayRows({
        mode,
        theme: settings.resolvedTheme,
        paneTranslation: ui.sidePaneOpen && settings.value.sidePane.tab === 'translation',
      }),
    ),
  )
  /** Under "increase contrast" the ink stays at full brightness, as Settings › Appearance says. */
  const inkNote = $derived.by(() => {
    const key = inkNoteKey(settings.resolvedTheme, moreContrast.current)
    return key && i18n.t(key)
  })
  const pageModes: SegmentedOption[] = $derived(
    PAGE_MODES.map((value) => ({ value, label: i18n.t(`settings.options.pageMode.${value}`) })),
  )
  const settingsKey = $derived.by(() => {
    const def = shortcuts.defs.find((d) => d.id === 'app.settings')
    return def ? shortcuts.format(def) : ''
  })

  // Never over another view: Settings, About or the Downloads manager replaces or covers the reader.
  $effect(() => {
    if (ui.view !== 'reader') open = false
  })

  /**
   * "All settings": the popover closes and gives focus back first (to the button, or where a pointer left it), so the
   * Settings dialog returns focus there when it closes.
   */
  async function allSettings(): Promise<void> {
    const section = displaySection(mode)
    open = false
    await tick()
    settingsView.open(section)
    ui.setView('settings')
  }

  function onOpenAutoFocus(e: Event): void {
    e.preventDefault()
    heading?.focus({ preventScroll: true })
  }

  /** `Mod+,` while it is open (and no overlay is above it): the floating layer holds the global shortcut back. */
  function onkeydown(e: KeyboardEvent): void {
    if (!open || e.defaultPrevented || ui.overlays.length > 0 || !shortcuts.matches('app.settings', e)) return
    e.preventDefault()
    void allSettings()
  }
</script>

<svelte:window {onkeydown} />

{#snippet slider(id: SliderId, label: string, note?: string)}
  {@const meta = metaOf(id)}
  {@const range = meta?.range ?? { min: 0, max: 100, step: 1 }}
  {@const format = (v: number) => formatValue(meta?.unit, v)}
  <div class="row" data-row={id}>
    <div class="row-head">
      <span class="label" id="{uid}-{id}">{label}</span>
      <output class="value" aria-hidden="true">{format(settings.value[id])}</output>
    </div>
    <Slider
      value={settings.value[id]}
      min={range.min}
      max={range.max}
      step={range.step}
      {format}
      labelledBy="{uid}-{id}"
      onValueChange={(v) => void save(id, v)}
    />
    {#if note}<p class="note">{note}</p>{/if}
  </div>
{/snippet}

<Popover
  bind:open
  {trigger}
  {anchor}
  {side}
  {align}
  {sideOffset}
  width={DISPLAY_W}
  padding="none"
  label={i18n.t('reader.display.button')}
  role="dialog"
  {onOpenAutoFocus}
>
  <div class="display" data-qd-popover="display" data-mode={mode}>
    <!-- Not `header` / `footer`: in a popover (portalled to the body) they would be page landmarks. -->
    <div class="head">
      <h2 class="title" tabindex="-1" bind:this={heading}>{i18n.t('reader.display.button')}</h2>
    </div>

    <ScrollArea class="body">
      <div class="content">
        <div class="row" data-row="theme">
          <span class="label" id="{uid}-theme">{i18n.t('settings.fields.theme.label')}</span>
          <ThemePicker labelledBy="{uid}-theme" compact />
        </div>

        {#if rows.has('ink')}
          {@render slider('inkBrightnessPct', i18n.t('settings.fields.inkBrightnessPct.label'), inkNote)}
        {/if}

        {#if rows.has('style')}
          <div class="row" data-row="mushafStyle">
            <span class="label" id="{uid}-style">{i18n.t('settings.fields.mushafStyle.label')}</span>
            <StylePicker labelledBy="{uid}-style" compact />
          </div>
        {/if}

        {#if rows.has('pages')}
          <div class="row" data-row="pageMode">
            <span class="label" aria-hidden="true">{i18n.t('settings.fields.pageMode.label')}</span>
            <Segmented
              options={pageModes}
              value={settings.value.pageMode}
              onValueChange={(v) => void save('pageMode', v as PageMode)}
              label={i18n.t('settings.fields.pageMode.label')}
              size="sm"
              fullWidth
            />
          </div>
        {/if}

        {#if rows.has('textSize')}
          {@render slider('translationFontPct', i18n.t('reader.display.textSize'))}
        {/if}
      </div>
    </ScrollArea>

    <div class="foot">
      <Button variant="secondary" size="sm" fullWidth onclick={allSettings} data-action="all-settings">
        {#snippet iconEnd()}{#if settingsKey}<Kbd chord={settingsKey} size="sm" />{/if}{/snippet}
        {i18n.t('reader.display.allSettings')}
      </Button>
    </div>
  </div>
</Popover>

<style>
  .display {
    display: flex;
    flex-direction: column;
    max-block-size: var(--bits-floating-available-height, 100vh);
    min-block-size: 0;
  }

  .head {
    flex: none;
    padding-block: var(--space-3) var(--space-2);
    padding-inline: var(--space-4);
    border-block-end: 1px solid var(--border);
  }

  .title {
    margin: 0;
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-title);
    line-height: 1.4;
    outline: none;
  }

  /* The body shrinks to the room the window leaves, and scrolls. */
  .display :global(.body) {
    display: flex;
    flex: 0 1 auto;
    flex-direction: column;
    min-block-size: 0;
  }

  .display :global(.body > [data-scroll-area-viewport]) {
    flex: 0 1 auto;
    block-size: auto;
    min-block-size: 0;
  }

  .content {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding-block: var(--space-3) var(--space-4);
    padding-inline: var(--space-4);
  }

  .row {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-inline-size: 0;
  }

  .row-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .label {
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    line-height: var(--leading-title);
  }

  .value {
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .note {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
  }

  .foot {
    flex: none;
    padding: var(--space-2);
    border-block-start: 1px solid var(--border);
  }

  .foot :global(.kbd) {
    margin-inline-start: var(--space-1);
  }
</style>
