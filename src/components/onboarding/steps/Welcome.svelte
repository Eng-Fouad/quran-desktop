<!--
  Welcome (onboarding step 1). The headline with the app icon, three feature tiles, the UI language
  (`Segmented` English | العربية, switched live) and the theme cards: Match system (selected by default; the light and
  dark variants split on a diagonal), Paper, Sepia, Night and Black, each a thumbnail of page 1 in that theme.

  The theme cards are one radio group (`role=radiogroup`): one tab stop, arrow keys move and select (mirrored in RTL),
  Home and End jump to the ends. Choosing a card applies the theme at once.
-->
<script lang="ts">
  import AudioLines from '@lucide/svelte/icons/audio-lines'
  import BookOpenText from '@lucide/svelte/icons/book-open-text'
  import Check from '@lucide/svelte/icons/check'
  import NotebookPen from '@lucide/svelte/icons/notebook-pen'
  import type { LucideIcon } from '@lucide/svelte'
  import appIcon from '../../../assets/app-icon.svg'
  import { Segmented, type SegmentedOption } from '$components/ui'
  import type { ResolvedTheme } from '$lib/contracts/stores'
  import type { PageData, UiLanguage } from '$lib/ipc/bindings'
  import { PAGE_COUNT } from '$lib/mushaf/geometry'
  import { i18n, player, settings } from '$lib/stores'
  import { flow, THEME_CHOICES, type ThemeChoice } from '../flow.svelte'
  import StepHeader from '../StepHeader.svelte'
  import ThemePreview from '../ThemePreview.svelte'

  interface Props {
    /** Page 1 in the hafs style for the theme thumbnails, or null while it loads. */
    page: PageData | null
  }

  let { page }: Props = $props()

  /** The catalogue's reciter count (14), from the bootstrap. */
  const reciterCount = $derived(player.reciters.length > 0 ? player.reciters.length : 14)

  const features: readonly { id: 'page' | 'recite' | 'study'; icon: LucideIcon }[] = [
    { id: 'page', icon: BookOpenText },
    { id: 'recite', icon: AudioLines },
    { id: 'study', icon: NotebookPen },
  ]

  /** Endonyms: each language is named in itself, whatever the UI language. */
  const languages: SegmentedOption[] = [
    { value: 'en', label: 'English' },
    { value: 'ar', label: 'العربية' },
  ]

  function previewThemes(choice: ThemeChoice): ResolvedTheme[] {
    if (choice !== 'system') return [choice]
    return [settings.value.lightVariant, settings.value.darkVariant]
  }

  const selected = $derived<ThemeChoice>(
    (THEME_CHOICES as readonly string[]).includes(settings.value.theme)
      ? (settings.value.theme as ThemeChoice)
      : 'system',
  )
  const systemHint = $derived(
    i18n.t('onboarding.welcome.systemHint', {
      light: i18n.t(`onboarding.welcome.themes.${settings.value.lightVariant}`),
      dark: i18n.t(`onboarding.welcome.themes.${settings.value.darkVariant}`),
    }),
  )

  let group: HTMLElement | null = $state(null)

  function choose(choice: ThemeChoice, focus = false): void {
    flow.setTheme(choice)
    if (focus) group?.querySelector<HTMLElement>(`[data-theme-choice="${choice}"]`)?.focus()
  }

  /** Radio-group keys: arrows move and select (left/right mirror in RTL), Home/End jump to the ends. */
  function onkeydown(e: KeyboardEvent): void {
    const i = THEME_CHOICES.indexOf(selected)
    const last = THEME_CHOICES.length - 1
    const forward = i18n.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight'
    const backward = i18n.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft'
    let next: number
    if (e.key === forward || e.key === 'ArrowDown') next = i === last ? 0 : i + 1
    else if (e.key === backward || e.key === 'ArrowUp') next = i === 0 ? last : i - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    else return
    e.preventDefault()
    const choice = THEME_CHOICES[next]
    if (choice) choose(choice, true)
  }
</script>

<div class="welcome">
  <StepHeader title={i18n.t('onboarding.welcome.title')} lede={i18n.t('onboarding.welcome.lede')} hero>
    {#snippet art()}
      <img class="app-icon" src={appIcon} width="56" height="56" alt="" draggable="false" />
    {/snippet}
  </StepHeader>

  <ul class="features">
    {#each features as f (f.id)}
      {@const Icon = f.icon}
      <li class="feature">
        <span class="feature-icon"><Icon size={18} strokeWidth={1.75} aria-hidden="true" /></span>
        <span class="feature-text">
          <span class="feature-title">{i18n.t(`onboarding.welcome.features.${f.id}.title`)}</span>
          <span class="feature-body"
            >{i18n.t(`onboarding.welcome.features.${f.id}.body`, {
              pages: PAGE_COUNT,
              reciters: reciterCount,
            })}</span
          >
        </span>
      </li>
    {/each}
  </ul>

  <div class="row">
    <span class="label" id="ob-language">{i18n.t('onboarding.welcome.language')}</span>
    <Segmented
      options={languages}
      value={settings.value.uiLanguage}
      onValueChange={(v) => flow.setLanguage(v as UiLanguage)}
      label={i18n.t('onboarding.welcome.language')}
      class="language"
    />
  </div>

  <div class="themes-block">
    <span class="label" id="ob-theme">{i18n.t('onboarding.welcome.theme')}</span>
    <div
      class="themes"
      role="radiogroup"
      aria-labelledby="ob-theme"
      tabindex="-1"
      bind:this={group}
      {onkeydown}
    >
      {#each THEME_CHOICES as choice (choice)}
        {@const on = selected === choice}
        <button
          type="button"
          role="radio"
          class={['theme', { on }]}
          aria-checked={on}
          tabindex={on ? 0 : -1}
          title={choice === 'system' ? systemHint : undefined}
          data-theme-choice={choice}
          onclick={() => choose(choice)}
        >
          <span class="thumb">
            <ThemePreview {page} themes={previewThemes(choice)} qfs={4.25} />
            <span class="theme-check" aria-hidden="true"><Check size={12} strokeWidth={2.75} /></span>
          </span>
          <span class="theme-name">{i18n.t(`onboarding.welcome.themes.${choice}`)}</span>
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .welcome {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  /* Naskh sets taller lines and the Arabic feature texts wrap to two: the step keeps within the 540 px dialog with
     slightly closer sections (it would otherwise scroll by a few pixels and clip the theme cards). */
  .welcome:lang(ar) {
    gap: var(--space-4);
  }

  .welcome:lang(ar) .row {
    padding-block-start: var(--space-3);
  }

  .app-icon {
    display: block;
    border-radius: 13px;
    box-shadow: var(--shadow-2);
    -webkit-user-drag: none;
  }

  /* --- features ------------------------------------------------------------------------------------------------- */

  .features {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .feature {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    min-inline-size: 0;
  }

  .feature-icon {
    display: grid;
    flex: none;
    place-items: center;
    inline-size: 32px;
    block-size: 32px;
    border-radius: var(--radius-sm);
    background-color: var(--accent-soft);
    color: var(--accent-text);
  }

  .feature-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }

  .feature-title {
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-title);
    line-height: var(--leading-ui);
  }

  .feature-body {
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
  }

  /* --- language and theme ----------------------------------------------------------------------------------------- */

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding-block-start: var(--space-4);
    border-block-start: 1px solid var(--border);
  }

  .label {
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-title);
  }

  .row :global(.language) {
    min-inline-size: 220px;
  }

  .row :global(.language .option) {
    flex: 1 1 0;
  }

  .themes-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .themes {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: var(--space-3);
    outline: none;
  }

  .theme {
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
    padding: 0;
    overflow: hidden;
    border: 0;
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-1);
    color: var(--text);
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition:
      box-shadow var(--dur-quick) var(--ease-standard),
      translate var(--dur-quick) var(--ease-standard);
  }

  .theme:hover {
    translate: 0 -1px;
  }

  .theme:hover:not(.on) {
    box-shadow: var(--shadow-2);
  }

  .theme.on {
    box-shadow:
      0 0 0 2px var(--accent),
      var(--shadow-2);
  }

  :global(:root[data-motion='reduce']) .theme:hover {
    translate: none;
  }

  .thumb {
    position: relative;
    display: block;
    block-size: 96px;
    border-block-end: 1px solid var(--border);
  }

  .theme-name {
    display: block;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    padding-block: var(--space-2);
    padding-inline: var(--space-3);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    line-height: var(--leading-ui);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The selected card's tick, on the thumbnail's top end corner. */
  .theme-check {
    position: absolute;
    inset-block-start: 6px;
    inset-inline-end: 6px;
    display: grid;
    place-items: center;
    inline-size: 18px;
    block-size: 18px;
    border-radius: var(--radius-full);
    background-color: var(--accent);
    box-shadow: 0 0 0 2px var(--surface-raised);
    color: var(--accent-ink);
    opacity: 0;
    scale: 0.6;
    transition:
      opacity var(--dur-quick) var(--ease-standard),
      scale var(--dur-quick) var(--ease-emphasized);
  }

  .on .theme-name {
    color: var(--accent-text);
    font-weight: var(--weight-title);
  }

  .on .theme-check {
    opacity: 1;
    scale: 1;
  }

  @media (forced-colors: active) {
    .theme {
      border: 1px solid CanvasText;
    }

    .theme.on {
      outline: 3px solid Highlight;
      outline-offset: 1px;
    }
  }
</style>
