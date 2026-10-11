<!--
  AboutView (§9.7 About and attribution, §7.4 view `about`). Owner: WP12c. Takes no props: it reads stores (§7.9).

  - **Header:** the app icon (64 px, §9.9), the full name (`common.appFullName`, LEAD.md item 16), the version with the
    platform, the build line ("core.db: qul · 2026-10-10 · schema 1") and "Copy diagnostics" (the app info as JSON),
    plus "Open data folder".
  - **Attribution** (`AttributionList`): the app itself (its GPL-3.0-or-later licence with the full text, and the
    Quran.com identity of its name and icon), Quran text and layout, fonts, translations and tafsir as installed (each
    with its version and link), word by word, recitations.
  - **Open-source licences** (`OpenSourceList`): collapsible, loaded lazily from `thirdparty.json`.
  The column keeps clear of the player dock, which stays visible in every view (§7.4). Opening the view refreshes the
  catalogue, so packs installed meanwhile are credited.
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import Copy from '@lucide/svelte/icons/copy'
  import FolderOpen from '@lucide/svelte/icons/folder-open'
  import { onMount } from 'svelte'
  import appIcon from '../../assets/app-icon.svg'
  import { Badge, Button, ScrollArea } from '$components/ui'
  import { attributionGroups } from '$lib/about/attributions'
  import { app, i18n, packs, reader, settings, ui } from '$lib/stores'
  import AttributionList from './AttributionList.svelte'
  import OpenSourceList from './OpenSourceList.svelte'

  /** How long "Copied" replaces the button label. */
  const COPIED_MS = 2_000

  const info = $derived(app.info)
  const groups = $derived(attributionGroups({ packs: packs.list, coreSource: info.core.source }))

  /** Space kept free under the column for the player dock (the side card, or the bar), plus its margin. */
  const dockReserve = $derived(
    reader.dock === 'side' ? 120 + 34 : reader.dock === 'compact' ? 56 + 34 : 64 + 34,
  )

  /** The build date of core.db as an ISO day ("2026-10-10"), or the raw value when it is not an ISO timestamp. */
  const builtOn = $derived(/^\d{4}-\d{2}-\d{2}/.exec(info.core.builtAt)?.[0] ?? (info.core.builtAt || '—'))
  const buildLine = $derived(
    i18n.t('about.build', {
      source: info.core.source || '—',
      date: builtOn,
      schema: String(info.core.schemaVersion),
    }),
  )
  const platformLine = $derived(
    [i18n.t(`about.platforms.${info.platform}`), info.osVersion, info.arch].filter(Boolean).join(' · '),
  )

  let copied = $state(false)
  let copyTimer: ReturnType<typeof setTimeout> | undefined

  /** "Copy diagnostics" (§9.7): the app info, plus the few session facts a bug report needs, as JSON. */
  function diagnostics(): string {
    return JSON.stringify(
      {
        app: info,
        session: {
          uiLanguage: settings.value.uiLanguage,
          theme: settings.resolvedTheme,
          mushafStyle: settings.value.mushafStyle,
          uiScalePct: settings.value.uiScalePct,
          networkAllowed: settings.value.networkAllowed,
          online: app.online,
        },
        userAgent: navigator.userAgent,
      },
      null,
      2,
    )
  }

  async function copyDiagnostics(): Promise<void> {
    try {
      await navigator.clipboard.writeText(diagnostics())
      copied = true
      clearTimeout(copyTimer)
      copyTimer = setTimeout(() => (copied = false), COPIED_MS)
      ui.announce(i18n.t('about.diagnosticsCopied'))
    } catch (e) {
      console.warn('[qd] about: the diagnostics could not be copied', e)
      ui.toast({ message: i18n.t('about.diagnosticsFailed'), tone: 'danger' })
    }
  }

  function openDataFolder(): void {
    app.revealDataDir().catch((e: unknown) => ui.toastError(e))
  }

  onMount(() => {
    void packs.refresh()
    return () => clearTimeout(copyTimer)
  })
</script>

<div class="about" data-qd-view="about" style:--_reserve="{dockReserve}px">
  <ScrollArea class="scroll">
    <div class="column">
      <header class="hero" aria-labelledby="about-name">
        <!-- The name is right next to it, so the icon is decorative (assets/brand/README.md). -->
        <img class="icon" src={appIcon} width="64" height="64" alt="" draggable="false" />
        <div class="identity">
          <h1 class="name" id="about-name">{i18n.t('common.appFullName')}</h1>
          <p class="tagline">{i18n.t('about.tagline')}</p>
          <p class="version">
            <span class="version-number">{i18n.t('about.version', { version: info.version || '—' })}</span>
            {#if info.debug}<Badge tone="warning" size="sm">{i18n.t('about.debugBuild')}</Badge>{/if}
          </p>
          <p class="platform" dir="ltr">{platformLine}</p>
          <p class="build" dir="ltr" data-build-line><code>{buildLine}</code></p>
        </div>
        <div class="actions">
          <Button
            variant="secondary"
            size="sm"
            onclick={() => void copyDiagnostics()}
            title={i18n.t('about.diagnosticsHint')}
            data-action="copy-diagnostics"
          >
            {#snippet icon()}
              {#if copied}<Check size={16} strokeWidth={2} aria-hidden="true" />{:else}<Copy
                  size={16}
                  strokeWidth={1.75}
                  aria-hidden="true"
                />{/if}
            {/snippet}
            {copied ? i18n.t('common.copied') : i18n.t('about.copyDiagnostics')}
          </Button>
          <Button variant="ghost" size="sm" onclick={openDataFolder} data-action="data-folder">
            {#snippet icon()}<FolderOpen size={16} strokeWidth={1.75} aria-hidden="true" />{/snippet}
            {i18n.t('about.dataFolder')}
          </Button>
        </div>
      </header>

      <section class="attribution" aria-labelledby="about-attribution">
        <div class="section-head">
          <h2 class="section-title" id="about-attribution">{i18n.t('about.attribution.title')}</h2>
          <p class="section-lede">{i18n.t('about.attribution.lede')}</p>
        </div>
        <AttributionList {groups} />
      </section>

      <OpenSourceList />
    </div>
  </ScrollArea>
</div>

<style>
  .about {
    position: relative;
    block-size: 100%;
    min-block-size: 0;
    container-type: inline-size;
    background-color: var(--surface-app);
  }

  .about > :global(.scroll) {
    block-size: 100%;
  }

  .column {
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
    inline-size: 100%;
    max-inline-size: 820px;
    margin-inline: auto;
    padding-block: var(--space-8) calc(var(--_reserve) + var(--space-6));
    padding-inline: var(--space-8);
  }

  /* --- header ------------------------------------------------------------------------------------------------------ */

  .hero {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: start;
    gap: var(--space-5);
    padding: var(--space-6);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background:
      radial-gradient(
        120% 140% at 0% 0%,
        color-mix(in srgb, var(--frame-gold) 10%, transparent),
        transparent 60%
      ),
      var(--surface-raised);
    box-shadow: var(--shadow-1);
  }

  :global([dir='rtl']) .hero {
    background:
      radial-gradient(
        120% 140% at 100% 0%,
        color-mix(in srgb, var(--frame-gold) 10%, transparent),
        transparent 60%
      ),
      var(--surface-raised);
  }

  .icon {
    display: block;
    border-radius: 15px;
    box-shadow: var(--shadow-2);
    -webkit-user-drag: none;
  }

  .identity {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }

  /* §9.3: --text-4xl is the about/brand size. */
  .name {
    margin: 0;
    color: var(--text);
    font-size: var(--text-4xl);
    font-weight: var(--weight-title);
    line-height: 1.15;
    letter-spacing: -0.01em;
  }

  :global(:root[lang='ar']) .name {
    letter-spacing: 0;
  }

  .tagline {
    margin: 0;
    margin-block-end: var(--space-2);
    color: var(--text-muted);
    font-size: var(--text-md);
    line-height: var(--leading-ui);
  }

  .version {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    font-variant-numeric: tabular-nums;
  }

  .platform {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-align: start;
  }

  :global([dir='rtl']) .platform,
  :global([dir='rtl']) .build {
    text-align: end;
  }

  .build {
    margin: 0;
    margin-block-start: var(--space-1);
    text-align: start;
  }

  .build code {
    display: inline-block;
    padding-block: 2px;
    padding-inline: var(--space-2);
    border-radius: var(--radius-xs);
    background-color: var(--surface-sunken);
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .actions {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-2);
  }

  /* --- attribution ------------------------------------------------------------------------------------------------- */

  .attribution {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .section-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding-inline: var(--space-1);
  }

  .section-title {
    margin: 0;
    color: var(--text);
    font-size: var(--text-xl);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .section-lede {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-md);
    line-height: var(--leading-ui);
  }

  @container (max-width: 640px) {
    .hero {
      grid-template-columns: auto minmax(0, 1fr);
    }

    .actions {
      grid-column: 1 / -1;
      flex-direction: row;
      flex-wrap: wrap;
    }
  }
</style>
