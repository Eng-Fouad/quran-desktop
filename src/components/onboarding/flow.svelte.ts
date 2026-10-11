/**
 * The onboarding flow (§9.7, §2.5.4). Owner: WP12c. One module-level instance, so the flow survives the dialog being
 * unmounted while another overlay sits on top of it (`OverlayHost` renders only the top overlay: Mod+K during the
 * Keys step opens the palette, and closing it brings the dialog back on the same step).
 *
 * - **Applied live** (step 1, §9.7 "live switch"): the UI language and the theme, through `settings.update`. The
 *   "Work offline" switch (step 3) is live too: it is the `networkAllowed` setting itself.
 * - **Applied when the starter set is decided** (step 3, "Download now" or "Start reading"): the Mushaf style, the
 *   reciter, and the reading packs the set puts to use: a translation or tafsir already on disk or fetched as you read,
 *   and the UI language's word-by-word pack ("Downloads as you read", §2.5.4 item 4) unless one is chosen already. A
 *   pack "Download now" fetches is put to use by the packs store when it lands. Choosing them does not touch the page
 *   behind the dialog or start any download, so Skip leaves the defaults in place.
 * - **Offline behaviour.** Without network use (Work offline, or no connection) nothing can be downloaded: the QCF
 *   and Tajweed cards are disabled, the effective style is Hafs (the chosen card comes back once online), the
 *   "Download all pages" option is ignored, the reciter preview is unavailable and "Download now" is disabled.
 * - **Reciter preview** (▶, 1:1) plays through `player.preview`: it is no part of the user's listening, so it leaves no
 *   resume point behind (Space after the onboarding recites the page being read, as the Keys step says).
 * - **Starter set** (§2.5.4, exact): `packs.starterSetFor` with these choices (WP12a, mirroring `Catalog::starter_set`,
 *   WP5a), minus the ornament fonts when the Hafs card's "Ornate surah headers" option is off (the QCF styles require
 *   them, so it is offered on the Hafs card only).
 * - **Done.** Finish and Skip set `onboardingDone` and close the dialog; it never shows again (§9.7).
 */
import type { AudioSnapshot, MushafStyle, Settings, ThemeMode } from '$lib/ipc/bindings'
import { events } from '$lib/ipc'
import { defaultSettings, SETTING_LIMITS } from '$lib/contracts/settings'
import { app, packs, player, settings, ui } from '$lib/stores'
import { listenEvent } from '$lib/stores/app.svelte'
import { isActivePhase, isInstalled, type StarterSet } from '$lib/stores/packs.svelte'

/** The four steps, in order (§9.7). */
export const STEPS = ['welcome', 'reading', 'summary', 'keys'] as const
export type StepId = (typeof STEPS)[number]

/** The Mushaf style cards of step 2 (§9.7). `qcf_v1` stays a Settings choice. */
export const STYLE_CHOICES = ['hafs', 'qcf_v2', 'qcf_v4'] as const satisfies readonly MushafStyle[]
export type StyleChoice = (typeof STYLE_CHOICES)[number]

/** The theme cards of step 1 (§9.7): Match system first (the default), then the four reading themes. */
export const THEME_CHOICES = [
  'system',
  'paper',
  'sepia',
  'night',
  'black',
] as const satisfies readonly ThemeMode[]
export type ThemeChoice = (typeof THEME_CHOICES)[number]

/** The reciter preview plays Al-Fatihah 1:1 (§9.7 "▶ preview of 1:1"). */
export const PREVIEW_AYAH = { surah: 1, ayah: 1 } as const

/** How the starter-set download is going (the Keys step shows it after "Download now"). */
export interface StarterProgress {
  state: 'running' | 'done' | 'failed'
  /** 0–100, by KiB received over the set's size. */
  percent: number
}

function isStyleChoice(style: MushafStyle): style is StyleChoice {
  return (STYLE_CHOICES as readonly MushafStyle[]).includes(style)
}

class OnboardingFlow {
  /** The current step (index into `STEPS`). */
  step = $state(0)
  /** +1 after moving forward, −1 after moving back: the side the new step slides in from. */
  direction = $state<1 | -1>(1)
  /** The chosen Mushaf style card (the effective style is Hafs while nothing can download). */
  style = $state<StyleChoice>('hafs')
  /** Hafs card: "Ornate surah headers" (the `decor` pack; on by default, §2.5.4 item 1). */
  ornaments = $state(true)
  /** QCF cards: "Download all pages in the background" (off by default, §2.5.4 item 3). */
  allPages = $state(false)
  /** The translation (or tafsir) pack: `undefined` follows the UI language's default, `null` is "No translation". */
  translation = $state<string | null | undefined>(undefined)
  reciterId = $state(defaultSettings().reciterId)
  /** The reciter whose 1:1 preview is playing, or null. */
  previewing = $state<number | null>(null)
  /** `audio_play` for the preview is in flight. */
  previewStarting = $state(false)
  /** The starter-set step is being applied ("Download now" / "Start reading"). */
  committing = $state(false)
  /** The packs "Download now" started (their progress shows on the Keys step). */
  started = $state.raw<readonly string[]>([])
  /** An install request of "Download now" was refused (its error was shown as a toast). */
  refused = $state(false)
  /** Finish or Skip ran: the dialog is closing and the flow resets once it is gone. */
  done = $state(false)

  readonly stepId: StepId = $derived(STEPS[this.step] ?? 'welcome')
  /** Downloads can start: network use is allowed and the app is online (as the Downloads manager decides). */
  readonly canDownload = $derived(settings.value.networkAllowed && app.online)
  /** The style that is applied: the chosen one, or Hafs while nothing can download (§9.7 "the style stays hafs"). */
  readonly effectiveStyle: StyleChoice = $derived(this.canDownload ? this.style : 'hafs')
  /** The translation pack the starter set includes (the UI language's default until one is picked). */
  readonly translationId: string | null = $derived(
    this.translation === undefined
      ? (packs.defaultTranslation(settings.value.uiLanguage)?.id ?? null)
      : this.translation,
  )
  /** The exact starter set for these choices (§2.5.4), with the exact "Download now" total. */
  readonly starterSet: StarterSet = $derived.by(() => {
    const style = this.effectiveStyle
    const set = packs.starterSetFor({
      uiLanguage: settings.value.uiLanguage,
      translation: this.translationId,
      style,
      downloadAllPages: style !== 'hafs' && this.allPages,
      reciterId: this.reciterId,
    })
    if (style !== 'hafs' || this.ornaments) return set
    const items = set.items.filter((i) => i.pack.id !== 'decor')
    return { items, nowKib: items.reduce((sum, i) => sum + i.kib, 0) }
  })
  /** What "Download now" would start: `now` packs not on disk yet. */
  readonly pendingDownloads = $derived(
    this.starterSet.items.filter((i) => i.fetch === 'now' && !isInstalled(i.pack)).map((i) => i.pack.id),
  )
  /**
   * Progress of the packs "Download now" started, or null before it was pressed. A pack is done once the catalogue
   * shows it installed; between its job completing and the catalogue refresh (no job, not yet installed) it counts
   * as received. A failed job, or a pack whose install request was refused, fails the set.
   */
  readonly progress: StarterProgress | null = $derived.by(() => {
    if (this.started.length === 0 && !this.refused) return null
    let received = 0
    let total = 0
    let running = false
    let failed = this.refused
    for (const id of this.started) {
      const p = packs.pack(id)
      const size = p?.sizeKib ?? 0
      const job = packs.jobOf(id)
      if (job && job.phase === 'failed') {
        failed = true
        total += Math.max(job.totalKib, size)
        received += Math.min(job.receivedKib, Math.max(job.totalKib, size))
      } else if (job && (isActivePhase(job.phase) || job.phase === 'paused')) {
        running = true
        const jobTotal = Math.max(job.totalKib, size)
        received += Math.min(job.receivedKib, jobTotal)
        total += jobTotal
      } else {
        if (!p || !isInstalled(p)) running = true
        received += size
        total += size
      }
    }
    const percent = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 100
    if (running) return { state: 'running', percent: Math.min(percent, 99) }
    return failed ? { state: 'failed', percent } : { state: 'done', percent: 100 }
  })

  #seeded = false
  #unlistenAudio: (() => void) | null = null

  /** Takes the current settings as the starting choices, once per run of the flow. */
  seed(): void {
    if (this.#seeded) return
    this.#seeded = true
    const s = settings.value
    this.style = isStyleChoice(s.mushafStyle) ? s.mushafStyle : 'hafs'
    this.reciterId = s.reciterId
    const reading = s.translations[0] ?? s.tafsirPackId
    this.translation = reading ?? undefined
  }

  // --- steps -------------------------------------------------------------------------------------------------------

  go(step: number): void {
    const next = Math.min(STEPS.length - 1, Math.max(0, Math.trunc(step)))
    if (next === this.step) return
    this.direction = next > this.step ? 1 : -1
    this.step = next
    if (STEPS[next] !== 'reading') void this.stopPreview()
  }

  next(): void {
    this.go(this.step + 1)
  }

  back(): void {
    this.go(this.step - 1)
  }

  // --- choices -----------------------------------------------------------------------------------------------------

  setTheme(theme: ThemeChoice): void {
    if (settings.value.theme !== theme) void settings.update({ theme })
  }

  setLanguage(uiLanguage: Settings['uiLanguage']): void {
    if (settings.value.uiLanguage !== uiLanguage) void settings.update({ uiLanguage })
  }

  setStyle(style: StyleChoice): void {
    if (style !== 'hafs' && !this.canDownload) return
    this.style = style
  }

  /** "Download all pages" belongs to a QCF card: ticking it also picks that card. */
  setAllPages(style: StyleChoice, on: boolean): void {
    if (style === 'hafs' || !this.canDownload) return
    this.style = style
    this.allPages = on
  }

  setReciter(id: number): void {
    if (id === this.reciterId) return
    this.reciterId = id
    void this.stopPreview()
  }

  /** The "Work offline" switch (`networkAllowed`, live). */
  setWorkOffline(on: boolean): void {
    if (settings.value.networkAllowed === !on) return
    if (on) void this.stopPreview()
    void settings.update({ networkAllowed: !on })
  }

  // --- the starter set -----------------------------------------------------------------------------------------------

  /**
   * Step 3: applies the style and reciter, puts an already installed translation to use, and with `download`
   * installs the starter set ("Download now"; never audio). Then moves to the Keys step.
   */
  async start(download: boolean): Promise<void> {
    if (this.committing) return
    this.committing = true
    try {
      const set = this.starterSet
      const patch = this.#settingsPatch()
      if (Object.keys(patch).length > 0) void settings.update(patch)
      if (download && this.canDownload && this.pendingDownloads.length > 0) {
        const ids = this.pendingDownloads
        this.refused = false
        try {
          await packs.installStarter(set)
        } catch (e) {
          ui.toastError(e)
        }
        // Follow only what actually started (a refused request has no job and nothing on disk).
        const startedIds = ids.filter((id) => {
          const p = packs.pack(id)
          return packs.jobOf(id) !== undefined || (p !== undefined && isInstalled(p))
        })
        this.refused = startedIds.length < ids.length
        this.started = startedIds
      }
      this.go(STEPS.indexOf('keys'))
    } finally {
      this.committing = false
    }
  }

  /** The settings the starter-set step decides. */
  #settingsPatch(): Partial<Settings> {
    const s = settings.value
    const patch: Partial<Settings> = {}
    if (s.mushafStyle !== this.effectiveStyle) patch.mushafStyle = this.effectiveStyle
    if (s.reciterId !== this.reciterId) patch.reciterId = this.reciterId
    // Reading packs of the set that work now are put to use now: those on disk, and those fetched as you read ("Later",
    // §2.5.4 item 4: the word-by-word pack, an on-demand tafsir). A "Download now" pack is added by the packs store once
    // its download lands.
    for (const item of this.starterSet.items) {
      const p = item.pack
      if (!isInstalled(p) && item.fetch !== 'on_demand') continue
      if (p.kind === 'translation' && !s.translations.includes(p.id) && p.id === this.translationId) {
        patch.translations = [p.id, ...s.translations].slice(0, SETTING_LIMITS.maxTranslations)
      } else if (p.kind === 'tafsir' && s.tafsirPackId === null && p.id === this.translationId) {
        patch.tafsirPackId = p.id
      } else if (p.kind === 'wbw' && s.wbwPackId === null) {
        patch.wbwPackId = p.id
      }
    }
    return patch
  }

  // --- reciter preview -------------------------------------------------------------------------------------------------

  /** The preview needs the network (§9.7 "online only"). */
  get canPreview(): boolean {
    return this.canDownload
  }

  /** ▶ / ■: plays the chosen reciter's Al-Fatihah 1:1 (`player.preview`), or stops it. */
  async togglePreview(): Promise<void> {
    if (this.previewing !== null) {
      await this.stopPreview()
      return
    }
    if (!this.canPreview || this.previewStarting) return
    this.#listenAudio()
    const reciterId = this.reciterId
    this.previewing = reciterId
    this.previewStarting = true
    try {
      await player.preview(reciterId, PREVIEW_AYAH)
    } catch (e) {
      if (this.previewing === reciterId) this.previewing = null
      ui.toastError(e)
    } finally {
      this.previewStarting = false
    }
  }

  async stopPreview(): Promise<void> {
    if (this.previewing === null) return
    this.previewing = null
    try {
      await player.stopPreview()
    } catch (e) {
      console.warn('[qd] onboarding: the preview could not be stopped', e)
    }
  }

  /** Follows the engine: the preview ends when it stops, fails, pauses or plays something else. */
  #listenAudio(): void {
    if (this.#unlistenAudio) return
    this.#unlistenAudio = listenEvent(events.audioStateChanged, (s) => this.#onAudio(s))
  }

  #onAudio(s: AudioSnapshot): void {
    if (this.previewing === null || this.previewStarting) return
    const live = s.status === 'loading' || s.status === 'buffering' || s.status === 'playing'
    if (live && s.reciterId === this.previewing) return
    this.previewing = null
    // The dock leaves a preview's failure to us (`player.preview`): say why it stopped.
    if (s.status === 'error' && s.error) ui.toastError(s.error)
  }

  // --- the end -----------------------------------------------------------------------------------------------------

  /** Finish (step 4) and Skip: never show the onboarding again (§9.7) and close it. */
  complete(): void {
    if (this.done) return
    this.done = true
    void this.stopPreview()
    if (!settings.value.onboardingDone) void settings.update({ onboardingDone: true })
    ui.close('onboarding')
  }

  /** Back to the first step with fresh choices (after the dialog closed, and in tests). */
  reset(): void {
    this.#unlistenAudio?.()
    this.#unlistenAudio = null
    this.#seeded = false
    this.step = 0
    this.direction = 1
    this.style = 'hafs'
    this.ornaments = true
    this.allPages = false
    this.translation = undefined
    this.reciterId = defaultSettings().reciterId
    this.previewing = null
    this.previewStarting = false
    this.committing = false
    this.started = []
    this.refused = false
    this.done = false
  }
}

export const flow = new OnboardingFlow()
