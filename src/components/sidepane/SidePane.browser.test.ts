/**
 * The study pane (§9.7, §9.8, §8.15) in a real browser on the IPC mock: what it shows (selection, recitation, reading
 * position, ranges, the pin and its chips), the header's chevrons, and each tab with its states — translations in their
 * own language and direction, tafsir typography, range entries, the offline and stale states, notes on and around the
 * ayah, and word-by-word cards that show their word on the page. Also the Arabic UI.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import { api } from '$lib/ipc'
import type { AudioSnapshot } from '$lib/ipc/bindings'
import { app, library, packs, player, quran, reader, settings, translations, ui } from '$lib/stores'
import { wordSpanOf } from './pane.svelte'
import PaneHarness from './testing/PaneHarness.svelte'
import {
  $,
  $$,
  boot,
  IBN_KATHIR,
  KURSI,
  MAARIF,
  MUYASSAR,
  plain,
  resetAll,
  SAHEEH,
  settle,
  tab,
  until,
  URDU,
} from './testing/setup'

afterEach(() => {
  vi.restoreAllMocks()
  resetAll()
})

async function mount(): Promise<void> {
  render(PaneHarness)
  await settle()
}

const heading = () => plain($('.ayah-header .title'))

/** A recitation of `ayahId` as the player store sees it (the audio mock is not driven here). */
function recite(ayahId: number, status: AudioSnapshot['status'] = 'playing'): void {
  const ref = quran.ayahRef(ayahId)
  player.snapshot = {
    status,
    reciterId: 7,
    current: ref,
    currentAyahId: ayahId,
    range: null,
    ayahRepeat: 1,
    ayahRepeatLeft: 0,
    rangeRepeat: 1,
    rangeRepeatLeft: 0,
    gap: { type: 'none' },
    abLoop: null,
    speedPct: 100,
    volumePct: 100,
    fileMs: 0,
    fileDurationMs: 100_000,
    ayahFromMs: 0,
    ayahToMs: 5000,
    bufferedPct: 100,
    device: null,
    basmalaSkipped: false,
    error: null,
  }
  player.heard = { surah: ref.surah, ayah: ref.ayah, ayahId }
}

async function openTab(label: string): Promise<void> {
  await userEvent.click(tab(label))
  await settle()
}

describe('what the pane shows', () => {
  it('heads the selected ayah: its number in the rosette, "Al-Baqarah 2:255", the Naskh name, juz and page', async () => {
    await boot()
    await mount()
    reader.select(KURSI)
    await until(() => heading() === 'Al-Baqarah 2:255', 'the heading of 2:255')
    expect($('.ayah-header .rosette .num')?.textContent).toBe('255')
    expect(plain($('.ayah-header .meta'))).toBe('البقرة · Juz 3 · Page 42')
    const name = $('.ayah-header .arabic-name')
    expect(name?.getAttribute('lang')).toBe('ar')
    expect(getComputedStyle(name ?? document.body).fontFamily).toContain('Noto Naskh Arabic')
    expect($('.ayah-header')?.getBoundingClientRect().height).toBe(56)
  })

  it('follows the reading position without a selection, the recitation while one plays, and shows a range whole', async () => {
    await boot()
    await mount()
    // No selection, nothing playing: the reader's action target (the first ayah on pages 1–2).
    await until(() => heading() === 'Al-Fatihah 1:1', 'the reading position')
    expect($('.ayah-header')?.dataset.source).toBe('reading')

    recite(270)
    await until(() => heading() === 'Al-Baqarah 2:263', 'the recited ayah')
    expect($('.ayah-header')?.dataset.source).toBe('recitation')
    expect($('.ayah-header .rosette')?.classList.contains('active')).toBe(true)

    player.snapshot = null
    player.heard = null
    reader.select(KURSI)
    reader.select(KURSI + 2, true)
    await until(() => heading() === 'Al-Baqarah 2:255–257', 'the selected range')
    await until(() => $$('.ayahs .ayah').length === 3, 'three ayahs in the Translation tab')
    expect($$('.ayahs .ayah').map((a) => Number(a.dataset.ayah))).toEqual([KURSI, KURSI + 1, KURSI + 2])
  })

  it('steps to the previous and next ayah, selecting it, and stops at either end of the Quran', async () => {
    await boot()
    await mount()
    reader.select(KURSI)
    await until(() => heading() === 'Al-Baqarah 2:255', 'heading')
    await userEvent.click($('.ayah-header [aria-label="Next ayah"]') ?? document.body)
    await until(() => heading() === 'Al-Baqarah 2:256', 'the next ayah')
    expect(reader.selection).toMatchObject({ fromAyahId: KURSI + 1, toAyahId: KURSI + 1 })
    await userEvent.click($('.ayah-header [aria-label="Previous ayah"]') ?? document.body)
    await until(() => heading() === 'Al-Baqarah 2:255', 'back to 2:255')

    reader.select(1)
    await until(() => heading() === 'Al-Fatihah 1:1', '1:1')
    expect($<HTMLButtonElement>('.ayah-header [aria-label="Previous ayah"]')?.disabled).toBe(true)
    expect($<HTMLButtonElement>('.ayah-header [aria-label="Next ayah"]')?.disabled).toBe(false)
  })

  it('stays on a selection during a recitation and offers "Follow recitation", which lets it follow (§8.15)', async () => {
    await boot()
    await mount()
    reader.select(KURSI)
    recite(270)
    await settle()
    expect(heading()).toBe('Al-Baqarah 2:255')
    const chip = await until(() => $('.ayah-header .chip[data-chip="follow"]'), 'the follow chip')
    expect(plain(chip)).toBe('Follow recitation')
    expect(chip.getAttribute('aria-label')?.replace(/[⁦-⁩]/gu, '')).toBe('Follow recitation (now at 2:263)')
    await userEvent.click(chip)
    await until(() => heading() === 'Al-Baqarah 2:263', 'the recited ayah')
    expect(reader.paneFollow).toBe('audio')
    // The selection stays on the page.
    expect(reader.selection?.fromAyahId).toBe(KURSI)
    expect($('.ayah-header .chip')).toBeNull()
  })

  it('a pin holds the pane, offers to move to the selection, moves with the chevrons, and lets go', async () => {
    await boot()
    await mount()
    reader.select(KURSI)
    await until(() => heading() === 'Al-Baqarah 2:255', 'heading')
    const pin = $('.ayah-header .pin')
    expect(pin?.getAttribute('aria-pressed')).toBe('false')
    await userEvent.click(pin ?? document.body)
    await until(() => settings.value.sidePane.follow === 'pinned', 'follow = pinned')
    expect($('.ayah-header .pin')?.getAttribute('aria-pressed')).toBe('true')
    expect(JSON.parse(localStorage.getItem('qd-sidepane-pin-v1') ?? 'null')).toEqual({
      from: KURSI,
      to: KURSI,
    })

    // Another selection leaves the pane where it is, and the chip offers to move the pin there.
    reader.select(292)
    await settle()
    expect(heading()).toBe('Al-Baqarah 2:255')
    const chip = await until(() => $('.ayah-header .chip[data-chip="selection"]'), 'the selection chip')
    expect(plain(chip)).toBe('Show 2:285')
    await userEvent.click(chip)
    await until(() => heading() === 'Al-Baqarah 2:285', 'the pin moved')
    expect(settings.value.sidePane.follow).toBe('pinned')

    // The chevrons move the pin, not the page.
    const page = reader.page
    await userEvent.click($('.ayah-header [aria-label="Next ayah"]') ?? document.body)
    await until(() => heading() === 'Al-Baqarah 2:286', 'the pin moved on')
    expect(reader.selection?.fromAyahId).toBe(292)
    expect(reader.page).toBe(page)

    // Unpinning returns to the mode before and follows the selection again.
    await userEvent.click($('.ayah-header .pin') ?? document.body)
    await until(() => settings.value.sidePane.follow === 'selection_or_audio', 'unpinned')
    await until(() => heading() === 'Al-Baqarah 2:285', 'the selection again')
    expect(localStorage.getItem('qd-sidepane-pin-v1')).toBeNull()
  })

  it('holds what it shows while a field in it has focus, so a recitation moving on never swaps the editor away', async () => {
    await boot()
    await mount()
    recite(KURSI)
    await until(() => heading() === 'Al-Baqarah 2:255', 'the recited ayah')
    await openTab('Notes')
    const field = await until(() => $<HTMLTextAreaElement>('[data-qd-pane] textarea'), 'the note composer')
    field.focus()
    await settle()
    recite(KURSI + 1)
    await settle()
    expect(heading()).toBe('Al-Baqarah 2:255')
    field.blur()
    await until(() => heading() === 'Al-Baqarah 2:256', 'following again after the field lost focus')
  })

  it('persists the chosen tab and hides from its header when docked', async () => {
    await boot()
    await mount()
    await openTab('Words')
    expect(settings.value.sidePane.tab).toBe('words')
    expect(tab('Words').getAttribute('aria-selected')).toBe('true')
    if (ui.paneDocked) {
      await userEvent.click($('.ayah-header [aria-label="Hide the study pane"]') ?? document.body)
      await until(() => !settings.value.sidePane.open, 'the pane closed')
    }
  })
})

describe('Translation tab', () => {
  it('shows the Arabic in qd-hafs and each translation in its language and direction, at 16 px', async () => {
    await boot({ installed: [SAHEEH, URDU], settings: { translations: [SAHEEH, URDU] } })
    await mount()
    reader.select(KURSI)
    await until(
      () => $$(`.ayah[data-ayah="${KURSI}"] section.tr`).length === 2,
      'two translation blocks for 2:255',
    )
    const arabic = $(`.ayah[data-ayah="${KURSI}"] .arabic`)
    expect(arabic?.getAttribute('dir')).toBe('rtl')
    expect(arabic?.classList.contains('quran-text')).toBe(true)
    expect(getComputedStyle(arabic ?? document.body).fontFamily).toContain('qd-hafs')
    expect(getComputedStyle(arabic ?? document.body).fontSize).toBe('24px')
    const blocks = $$('.ayah section.tr').map((b) => [
      b.dataset.pack,
      b.getAttribute('lang'),
      b.getAttribute('dir'),
    ])
    expect(blocks).toEqual([
      [SAHEEH, 'en', 'ltr'],
      [URDU, 'ur', 'rtl'],
    ])
    const english = $('.ayah section.tr[lang="en"] .text')
    expect(getComputedStyle(english ?? document.body).fontSize).toBe('16px')
    expect(plain($('.ayah section.tr[lang="en"] .label'))).toBe('Saheeh International')

    // translationFontPct scales the pane's reading text too.
    await settings.update({ translationFontPct: 125 })
    await settle()
    expect(getComputedStyle(english ?? document.body).fontSize).toBe('20px')
  })

  it('says a failed load once, politely, while each ayah keeps its own silent Retry', async () => {
    await boot({ installed: [SAHEEH, URDU], settings: { translations: [SAHEEH, URDU] } })
    const failure = { status: 'error', error: { kind: 'offline', message: 'no connection' } } as const
    vi.spyOn(api, 'quranGetAyahs').mockResolvedValue(failure)
    vi.spyOn(api, 'translationGet').mockResolvedValue(failure)
    await mount()
    reader.select(KURSI)
    reader.select(KURSI + 2, true)
    await until(() => $$('.ayah .error').length >= 3, 'an error on each listed ayah')
    expect($$('.ayah .error').every((e) => plain(e).endsWith('Retry'))).toBe(true)
    // No alert per ayah and pack: one polite status for the tab.
    expect($$('[role="alert"]')).toHaveLength(0)
    await until(() => $$('[role="status"]').some((st) => plain(st) !== ''), 'the polite status')
    const statuses = $$('[role="status"]').filter((s) => plain(s) !== '')
    expect(statuses.map((s) => plain(s))).toEqual(["The translation couldn't be loaded"])
  })

  it('offers translations to add when none is selected; Install selects the pack and downloads it', async () => {
    await boot({ installed: [], settings: { translations: [] } })
    const install = vi.spyOn(packs, 'install').mockResolvedValue(undefined)
    await mount()
    reader.select(KURSI)
    const card = await until(() => $('.picker[data-kind="translation"]'), 'the add card')
    expect(plain(card.querySelector('.title'))).toBe('Add a translation')
    const rows = await until(() => {
      const r = $$('.picker .row')
      return r.length === 3 ? r : null
    }, 'three translations to add')
    // The UI language first (English), the recommended one on top.
    expect(rows[0]?.dataset.pack).toBe(SAHEEH)
    expect(plain(rows[0]?.querySelector('.meta'))).toMatch(/^English · \d/)
    await userEvent.click(rows[0]?.querySelector('button') ?? document.body)
    await until(() => install.mock.calls.length === 1, 'packs.install')
    expect(install).toHaveBeenCalledWith(SAHEEH)
    expect(settings.value.translations).toEqual([SAHEEH])
  })
})

describe('Tafsir tab', () => {
  it('Arabic tafsir in Naskh 18 px at leading 2.0, right to left, with its source and version (S22)', async () => {
    await boot({
      settings: {
        sidePane: {
          open: true,
          widthPx: 400,
          tab: 'tafsir',
          follow: 'selection_or_audio',
          autoCollapseSidebar: true,
        },
      },
    })
    await mount()
    reader.select(KURSI)
    const entry = await until(() => $('.entry[aria-label*="2:255"]'), 'the tafsir entry of 2:255')
    expect(entry.getAttribute('dir')).toBe('rtl')
    expect(entry.getAttribute('lang')).toBe('ar')
    const text = entry.querySelector('.text') ?? document.body
    const style = getComputedStyle(text)
    expect(style.fontFamily).toContain('Noto Naskh Arabic')
    expect(style.fontSize).toBe('18px')
    expect(style.lineHeight).toBe('36px')
    expect(entry.querySelector('.covers')).toBeNull()
    const footer = plain($('.source'))
    expect(footer).toContain('At-Tafsir Al-Muyassar')
    expect(footer).toMatch(/Version \d{4}\.\d{2}/)
    // The toolbar switches the tafsir.
    expect($('.toolbar [role="combobox"], .toolbar button')).not.toBeNull()
  })

  it('a Quran.com range entry says "Covers 2:253–255" and is shown once for a range (S37)', async () => {
    await boot({ settings: { tafsirPackId: IBN_KATHIR } })
    await mount()
    await openTab('Tafsir')
    reader.select(KURSI - 2)
    reader.select(KURSI, true)
    const entry = await until(() => $('.entry[aria-label*="2:253"]'), 'the entry over 2:253–255')
    expect(plain(entry.querySelector('.covers'))).toBe('Covers 2:253–255')
    expect(entry.getAttribute('dir')).toBe('ltr')
    expect(getComputedStyle(entry.querySelector('.text') ?? document.body).fontSize).toBe('16px')
    await settle(100)
    expect($$('.entry').length).toBe(1)
    expect(plain($('.source'))).toMatch(/Saved (now|\d+ seconds? ago)/)
    // The cache holds the entry under every ayah it covers.
    expect(translations.tafsirOf(IBN_KATHIR, KURSI - 2)?.toAyahId).toBe(KURSI)
  })

  it('shows six skeleton lines while a chapter is fetched (§9.8)', async () => {
    await boot({ settings: { tafsirPackId: MAARIF } })
    await mount()
    await openTab('Tafsir')
    reader.select(quran.ayahId(18, 10))
    await until(
      () => heading() === 'Al-Kahf 18:10' && $$('.skeleton .line').length === 6,
      'six skeleton lines',
    )
    expect($('.tab-body .content')?.getAttribute('aria-busy')).toBe('true')
    await until(() => $('.entry[aria-label*="18:"]'), 'the entry after the fetch')
    expect($$('.skeleton .line').length).toBe(0)
  })

  it('offline and not cached: "needs a connection for Al-Kahf (≈ size)" with Retry; it loads when back online', async () => {
    await boot({ settings: { tafsirPackId: IBN_KATHIR, networkAllowed: false } })
    await mount()
    await openTab('Tafsir')
    reader.select(quran.ayahId(18, 10))
    const message = await until(
      () => (heading() === 'Al-Kahf 18:10' ? $('.message') : null),
      'the offline message',
    )
    expect(app.online).toBe(false)
    expect(plain(message.querySelector('.text'))).toMatch(
      /^This tafsir needs a connection for Al-Kahf \(≈\d+(\.\d)? kB\)$/,
    )
    expect(message.querySelector('button')?.textContent?.trim()).toBe('Retry')
    await settings.update({ networkAllowed: true })
    await until(() => $('.entry[aria-label*="18:"]'), 'the entry once online', 6000)
    expect($('.message')).toBeNull()
  })

  it('an on-demand tafsir without commentary on a surah says so, with no Retry (Ibn Kathir on Al-Fil)', async () => {
    await boot({ settings: { tafsirPackId: IBN_KATHIR } })
    await mount()
    await openTab('Tafsir')
    reader.select(quran.ayahId(105, 1))
    const message = await until(
      () => (heading().endsWith('105:1') ? $('.message') : null),
      'the no-commentary message',
    )
    expect(plain(message.querySelector('.text'))).toBe(
      `${translations.packTitle(IBN_KATHIR)} has no commentary on ${quran.surahName(105)}`,
    )
    expect(plain(message.querySelector('.hint'))).toBe(
      'Choose another tafsir above to read about this surah.',
    )
    expect(message.getAttribute('data-tone')).toBe('neutral')
    expect(message.querySelector('button')).toBeNull()
    expect($('.skeleton')).toBeNull()
    expect($('.tab-body .content')?.getAttribute('aria-busy')).not.toBe('true')
    // Another surah of the same tafsir reads as usual.
    reader.select(KURSI)
    await until(() => (heading().endsWith('2:255') ? $('.entry') : null), 'the entry covering 2:255')
    expect($('.message')).toBeNull()
  })

  it('a chapter saved on an earlier run is stale offline: "Saved 9 days ago · refreshes when online" (§9.8)', async () => {
    await boot({ settings: { tafsirPackId: MAARIF, networkAllowed: false }, cached: { [MAARIF]: [2] } })
    await mount()
    await openTab('Tafsir')
    reader.select(KURSI)
    const footer = await until(() => $('.source.stale'), 'the stale footer')
    expect(plain(footer.querySelector('.date'))).toBe('Saved 9 days ago · refreshes when online')
  })

  it('no tafsir chosen: the card lists tafsir with Use and Install; Use chooses one', async () => {
    await boot({ settings: { tafsirPackId: null } })
    await mount()
    await openTab('Tafsir')
    const card = await until(() => $('.picker[data-kind="tafsir"]'), 'the tafsir card')
    expect(plain(card.querySelector('.title'))).toBe('Choose a tafsir')
    const rows = $$('.picker .row')
    expect(rows.length).toBeGreaterThanOrEqual(3)
    const muyassar = rows.find((r) => r.dataset.pack === MUYASSAR)
    // Installed in this boot: usable at once.
    expect(muyassar?.dataset.action).toBe('use')
    const onDemand = rows.find((r) => r.dataset.pack === IBN_KATHIR)
    expect(plain(onDemand?.querySelector('.meta'))).toBe('English · fetched as you read')
    await userEvent.click(onDemand?.querySelector('button') ?? document.body)
    await until(() => settings.value.tafsirPackId === IBN_KATHIR, 'the tafsir chosen')
  })

  it('a chosen tafsir that no catalogue knows (a stale setting) offers the choice again', async () => {
    await boot({ settings: { tafsirPackId: 'tafsir.xx.gone' } })
    await mount()
    await openTab('Tafsir')
    reader.select(KURSI)
    await until(
      () => (heading() === 'Al-Baqarah 2:255' ? $('.picker[data-kind="tafsir"]') : null),
      'the card',
    )
    expect($('.tab-body .toolbar')).toBeNull()
  })

  it('a whole tafsir that is not downloaded offers its download', async () => {
    await boot({ installed: [SAHEEH] })
    const install = vi.spyOn(packs, 'install').mockResolvedValue(undefined)
    await mount()
    await openTab('Tafsir')
    reader.select(KURSI)
    const message = await until(
      () => (heading() === 'Al-Baqarah 2:255' ? $('.message') : null),
      'the not-downloaded message',
    )
    expect(plain(message.querySelector('.text'))).toBe('At-Tafsir Al-Muyassar isn’t downloaded')
    await userEvent.click(message.querySelector('button') ?? document.body)
    expect(install).toHaveBeenCalledWith(MUYASSAR)
  })
})

describe('Notes tab', () => {
  it('composes a note on the ayah and lists notes that cover it, with a count on the tab', async () => {
    await boot()
    await mount()
    await library.saveNote({
      id: null,
      fromAyahId: KURSI - 2,
      toAyahId: KURSI + 2,
      title: 'Around the Throne verse',
      body: 'A note over five ayahs.',
      tagIds: [],
    })
    reader.select(KURSI)
    await until(() => plain(tab('Notes').querySelector('.badge')) === '1', 'the count on the Notes tab')
    await openTab('Notes')
    const notes = await until(() => {
      const list = $$('.notes > .note')
      return list.length === 2 ? list : null
    }, 'the composer and the covering note')
    expect(notes[0]?.dataset.note).toBe('new')
    expect(notes[0]?.querySelector('textarea')).not.toBeNull()
    expect(plain(notes[1]?.querySelector('.range'))).toBe('On Al-Baqarah 2:253–257')
    expect(plain(notes[1])).toContain('Around the Throne verse')
    // The pane never puts the caret in the editor by itself.
    expect(document.activeElement?.matches('textarea, input')).toBe(false)
  })
})

describe('Words tab', () => {
  it('lays the words out in reading order; a card shows its word on the page, a second click clears it', async () => {
    await boot()
    await mount()
    await openTab('Words')
    reader.select(KURSI)
    const span = wordSpanOf(KURSI)
    expect(span).not.toBeNull()
    if (!span) return
    const cards = await until(() => {
      const list = $$<HTMLButtonElement>('.grid .card[data-word]')
      return list.length === span.last - span.first + 1 ? list : null
    }, 'a card for every word but the end marker')
    expect(Number(cards[0]?.dataset.word)).toBe(span.first)
    // Right to left in every UI language: the first word is on the right.
    const [a, b] = [cards[0]?.getBoundingClientRect(), cards[1]?.getBoundingClientRect()]
    expect((a?.left ?? 0) > (b?.left ?? 0)).toBe(true)
    const word = cards[0]?.querySelector('.word')
    expect(getComputedStyle(word ?? document.body).fontFamily).toContain('qd-hafs')
    expect(getComputedStyle(word ?? document.body).fontSize).toBe('24px')
    expect(cards[0]?.querySelector('.gloss')?.getAttribute('lang')).toBe('en')
    expect(cards[0]?.querySelector('.translit')).not.toBeNull()

    await userEvent.click(cards[2] ?? document.body)
    expect(reader.searchHit).toEqual({ ayahId: KURSI, wordIds: [span.first + 2] })
    await settle()
    expect(cards[2]?.getAttribute('aria-pressed')).toBe('true')
    await userEvent.click(cards[2] ?? document.body)
    expect(reader.searchHit).toBeNull()
  })

  it('switches transliteration off from its toolbar, and offers a word-by-word pack when none is chosen', async () => {
    await boot()
    await mount()
    await openTab('Words')
    reader.select(KURSI)
    await until(() => $('.grid .card .translit'), 'transliterations')
    await userEvent.click($('.toolbar [role="switch"]') ?? document.body)
    await until(() => !settings.value.wbwShowTransliteration, 'the setting')
    await until(() => $('.grid .card .translit') === null, 'no transliteration')

    await settings.update({ wbwPackId: null })
    const card = await until(() => $('.picker[data-kind="wbw"]'), 'the word-by-word card')
    const first = card.querySelector<HTMLElement>('.row')
    expect(first?.dataset.pack).toBe('wbw.en')
    await userEvent.click(first?.querySelector('button') ?? document.body)
    await until(() => settings.value.wbwPackId === 'wbw.en', 'the pack chosen')
  })
})

describe('Arabic UI', () => {
  it('mirrors the header, uses Arabic-Indic digits and does not repeat the surah name', async () => {
    await boot({ lang: 'ar' })
    await mount()
    reader.select(KURSI)
    await until(() => heading() === 'البقرة ٢:٢٥٥', 'the Arabic heading')
    expect(plain($('.ayah-header .meta'))).toBe('الجزء ٣، الصفحة ٤٢')
    expect($('.ayah-header .arabic-name')).toBeNull()
    expect(getComputedStyle($('.ayah-header') ?? document.body).direction).toBe('rtl')
    // The chevrons mirror (they point the way the reading goes).
    expect($('.ayah-header [aria-label="الآية التالية"] svg')?.classList.contains('icon-dir')).toBe(true)
    await userEvent.click(tab('التفسير'))
    const entry = await until(() => $('.entry[aria-label*="٢:٢٥٥"]'), 'the tafsir entry')
    expect(entry.getAttribute('dir')).toBe('rtl')
    expect(plain($('.source'))).toContain('التفسير الميسر')
  })
})
