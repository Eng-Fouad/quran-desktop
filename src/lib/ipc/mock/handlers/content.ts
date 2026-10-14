/**
 * Mock handlers: ayah text, translations, tafsir and word by word.
 *
 * Behaviour mirrors the real commands (`commands/content.rs`; `PackManager::translation_db`, `tafsir_entry`,
 * `wbw_range`) on the mock's catalogue (the `packs` slice, owned by `packs.ts`):
 * - **Validation** like the commands: ayah ranges of at most 300, at most 5 distinct packs, word ranges of at most
 *   2,000 inside the Quran (`invalid_argument`); an unknown pack id, or a pack of another kind, is `not_found` /
 *   `invalid_argument`.
 * - **Installed packs only** for whole packs (QuranEnc translations and tafsir): a pack that is not installed (or an
 *   update of it: `update_available` still works) answers `not_found`, like `translation_db`.
 * - **On-demand chapters** (Quran.com tafsir and word by word): a chapter that is not in the pack's items is fetched (a
 *   short delay) when the network is usable and recorded through `recordCachedItem`, so Downloads and Clear cache see
 *   it; offline it is `offline`. A chapter fetched in this page session is fresh; one already cached when the page
 *   loaded counts as fetched on an earlier run, `PREVIOUS_RUN_AGE_DAYS` (9) days ago. Offline such an entry is `stale`
 *   (the footer "Saved 9 days ago · refreshes when online"); online it is revalidated on the spot.
 * - **Content.** Exported fixtures (`translations/{pack}/{from}-{to}.json`, `tafsir/{pack}/{ayahId}.json`,
 *   `wbw/{pack}/{surah}.json`) win wherever they exist. Everywhere else the text is synthetic, deterministic and
 *   clearly marked as such, in the pack's language and script, with QuranEnc-style footnotes (`sup.fn[data-fn=s:a:n]`,
 *   numbered through the whole pack, Bengali digits for Bengali; some notes carry an `a[data-ref]` reference, and some
 *   surahs open with a general note whose marker is empty) and Quran.com-style tafsir ranges of 1–3 ayahs. Synthetic
 *   text never contains Quran text: word-by-word words come from the ayah fixtures (or the placeholder word).
 * - Every answer arrives after 2–8 ms, to surface races.
 */
import type {
  AyahText,
  Footnote,
  MushafLayout,
  PackInfo,
  PackKind,
  QuranIndex,
  TafsirEntry,
  TranslationRow,
  TranslationText,
  WbwEntry,
} from '../../bindings'
import { fixtures } from '../fixtures'
import {
  assertAyahRange,
  assertRange,
  delay,
  type Handlers,
  handle,
  jitter,
  MockError,
  nowSecs,
} from '../result'
import { state } from '../state'
import { AYAH_COUNT, ayahOfWord, lastWordOf, PLACEHOLDER_WORD, refOf, wordTotal } from '../synthetic'
import { recordCachedItem } from './packs'
import { mockOnline } from './settings'

/** `translation_get` and `quran_get_ayahs` take at most this many ayahs. */
export const MAX_AYAHS = 300
/** `translation_get` takes at most this many packs. */
export const MAX_PACKS = 5
/** `wbw_get_range` takes at most this many words. */
export const MAX_WORDS = 2000
/** How old a chapter cached before this page session counts as (days). */
export const PREVIOUS_RUN_AGE_DAYS = 9
/** QF content older than this is stale while it cannot be revalidated. */
export const REVALIDATE_DAYS = 7
const DAY = 86_400

// ---------------------------------------------------------------------------------------------------------------------
// Packs

function findPack(id: string): PackInfo | undefined {
  return state.packs.value.list.find((p) => p.id === id)
}

function isInstalled(p: PackInfo): boolean {
  return p.state.type === 'installed' || p.state.type === 'update_available'
}

/** The pack `id` of `kind`, or the error the real command gives. */
function requirePack(id: string, kind: PackKind): PackInfo {
  const p = findPack(id)
  if (!p) throw new MockError('not_found', `unknown pack: ${id}`)
  if (p.kind !== kind) throw new MockError('invalid_argument', `${id} is a ${p.kind} pack, not ${kind}`)
  return p
}

/** A whole pack must be installed (`translation_db` / the tafsir pack DB). */
function requireInstalled(p: PackInfo): void {
  if (!isInstalled(p)) throw new MockError('not_found', `pack ${p.id} is not installed`)
}

function onDemand(p: PackInfo): boolean {
  return p.installMode === 'on_demand'
}

/** Fetch times (Unix seconds) of on-demand chapters fetched in this page session, by `pack:chapter`. */
const fetchedThisSession = new Map<string, number>()

function chapterCached(packId: string, chapter: number): boolean {
  return (state.packs.value.items[packId] ?? []).some((i) => i.item === chapter)
}

/**
 * Makes an on-demand chapter available: cached chapters are served (and revalidated when online); missing ones are
 * fetched when online, else `offline`. Returns when it was fetched and whether it is stale.
 */
async function ensureChapter(p: PackInfo, chapter: number): Promise<{ fetchedAt: number; stale: boolean }> {
  const key = `${p.id}:${chapter}`
  const online = mockOnline(state.settings.value)
  const now = nowSecs()
  if (!chapterCached(p.id, chapter)) {
    if (!online) {
      throw new MockError(
        'offline',
        `${p.id}: chapter ${chapter} is not cached and the network is unavailable`,
      )
    }
    await delay(60 + (hash(key) % 140))
    fetchedThisSession.set(key, now)
    recordCachedItem(p.id, chapter)
    return { fetchedAt: now, stale: false }
  }
  let fetchedAt = fetchedThisSession.get(key) ?? now - PREVIOUS_RUN_AGE_DAYS * DAY
  const old = now - fetchedAt > REVALIDATE_DAYS * DAY
  if (old && online) {
    fetchedAt = now
    fetchedThisSession.set(key, now)
  }
  return { fetchedAt, stale: old && !online }
}

// ---------------------------------------------------------------------------------------------------------------------
// Deterministic synthetic content

/** FNV-1a over a string with murmur3's final mix (keys differ in their last characters): the same content every run. */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** A value in [0, 1) for a key. */
function unit(key: string): number {
  return hash(key) / 4294967296
}

interface LanguageText {
  /** "Synthetic translation of {ref}." */
  lead: string
  /** Filler sentences, used in turn to give longer ayahs longer text. */
  pool: readonly string[]
  /** A footnote body ("{ref}" is the ayah). */
  note: string
  /** A general note on a surah (empty marker). */
  intro: string
  /** "Compare" before a reference. */
  compare: string
  /** A word-by-word gloss ("{n}" is the word id). */
  gloss: string
  /** Tafsir: heading and body. */
  tafsirHead: string
  tafsirBody: string
  digits?: string
}

const TEXT: Record<string, LanguageText> = {
  en: {
    lead: 'Synthetic translation of {ref}.',
    pool: [
      'This placeholder stands in for the meaning of the verse while no real translation is installed.',
      'It speaks of patience, gratitude and remembrance only as sample themes.',
      'Longer verses receive longer text, so the layout behaves as it will with real packs.',
      'A further clause keeps the paragraph close to the length of a typical translation.',
      'Nothing here is quoted from any translation of the Quran.',
    ],
    note: 'Synthetic footnote on {ref}: a translator’s explanation would appear here.',
    intro: 'Synthetic introduction to this surah, shown as a general note without a number.',
    compare: 'Compare',
    gloss: 'gloss {n}',
    tafsirHead: 'Synthetic commentary on {range}',
    tafsirBody:
      'Placeholder commentary for the browser mock, grouped over {count} ayah(s) like Quran.com tafsir.',
  },
  ur: {
    lead: 'مصنوعی ترجمہ برائے آیت {ref}۔',
    pool: [
      'یہ عبارت صرف آزمائش کے لیے ہے۔',
      'اصل ترجمہ ڈاؤن لوڈ ہونے پر یہاں دکھایا جائے گا۔',
      'طویل آیات کے لیے متن بھی طویل رکھا گیا ہے تاکہ ترتیب درست جانچی جا سکے۔',
      'یہ کسی ترجمے سے نقل شدہ نہیں ہے۔',
    ],
    note: 'آیت {ref} پر مصنوعی حاشیہ: یہاں مترجم کی وضاحت ہوگی۔',
    intro: 'اس سورت کا مصنوعی تعارف، بغیر نمبر کے عمومی حاشیہ۔',
    compare: 'دیکھیے',
    gloss: 'معنی {n}',
    tafsirHead: 'آیات {range} کی مصنوعی تفسیر',
    tafsirBody: 'آزمائشی تفسیر، {count} آیات پر مشتمل۔',
  },
  fa: {
    lead: 'ترجمهٔ آزمایشی آیهٔ {ref}.',
    pool: [
      'این متن فقط برای آزمایش است.',
      'ترجمهٔ واقعی پس از دریافت بسته در اینجا نمایش داده می‌شود.',
      'آیه‌های بلندتر متن بلندتری دارند تا چیدمان درست آزموده شود.',
    ],
    note: 'پانوشت آزمایشی برای آیهٔ {ref}: توضیح مترجم اینجا می‌آید.',
    intro: 'مقدمهٔ آزمایشی این سوره، پانوشتی کلی بدون شماره.',
    compare: 'مقایسه کنید با',
    gloss: 'معنی {n}',
    tafsirHead: 'تفسیر آزمایشی {range}',
    tafsirBody: 'تفسیر نمونه برای {count} آیه.',
  },
  ar: {
    lead: 'نص تجريبي للآية {ref}.',
    pool: [
      'هذا النص مؤقت لأغراض العرض فقط.',
      'يظهر النص الحقيقي هنا بعد تنزيل الحزمة.',
      'تطول الفقرة مع طول الآية ليُختبر التخطيط.',
    ],
    note: 'حاشية تجريبية على الآية {ref}.',
    intro: 'مقدمة تجريبية لهذه السورة، تظهر حاشيةً عامة بلا رقم.',
    compare: 'قارن',
    gloss: 'معنى {n}',
    tafsirHead: 'تفسير تجريبي للآيات {range}',
    tafsirBody: 'نص تفسير مؤقت لأغراض العرض، يغطي {count} آية.',
    digits: '٠١٢٣٤٥٦٧٨٩',
  },
  id: {
    lead: 'Terjemahan sintetis untuk {ref}.',
    pool: [
      'Teks ini hanya contoh untuk menguji tata letak.',
      'Terjemahan sebenarnya akan tampil di sini setelah paket diunduh.',
      'Ayat yang lebih panjang mendapat teks yang lebih panjang pula.',
    ],
    note: 'Catatan kaki sintetis untuk {ref}.',
    intro: 'Pengantar sintetis untuk surah ini, sebagai catatan umum tanpa nomor.',
    compare: 'Bandingkan',
    gloss: 'arti {n}',
    tafsirHead: 'Tafsir sintetis {range}',
    tafsirBody: 'Tafsir contoh untuk {count} ayat.',
  },
  tr: {
    lead: '{ref} için yapay çeviri.',
    pool: [
      'Bu metin yalnızca düzeni denemek içindir.',
      'Gerçek çeviri, paket indirildiğinde burada görünür.',
      'Uzun ayetler daha uzun bir metin alır.',
    ],
    note: '{ref} için yapay dipnot.',
    intro: 'Bu surenin yapay girişi, numarasız genel bir not.',
    compare: 'Karşılaştırın',
    gloss: 'anlam {n}',
    tafsirHead: '{range} için yapay tefsir',
    tafsirBody: '{count} ayet için örnek tefsir.',
  },
  fr: {
    lead: 'Traduction synthétique de {ref}.',
    pool: [
      'Ce texte sert uniquement à tester la mise en page.',
      'La vraie traduction s’affichera ici une fois le paquet téléchargé.',
      'Les versets plus longs reçoivent un texte plus long.',
    ],
    note: 'Note synthétique sur {ref}.',
    intro: 'Introduction synthétique à cette sourate, une note générale sans numéro.',
    compare: 'Comparer',
    gloss: 'sens {n}',
    tafsirHead: 'Commentaire synthétique de {range}',
    tafsirBody: 'Commentaire d’exemple pour {count} verset(s).',
  },
  es: {
    lead: 'Traducción sintética de {ref}.',
    pool: [
      'Este texto solo sirve para probar el diseño.',
      'La traducción real aparecerá aquí cuando se descargue el paquete.',
      'Los versículos más largos reciben un texto más largo.',
    ],
    note: 'Nota sintética sobre {ref}.',
    intro: 'Introducción sintética a esta sura, una nota general sin número.',
    compare: 'Compárese',
    gloss: 'sentido {n}',
    tafsirHead: 'Comentario sintético de {range}',
    tafsirBody: 'Comentario de ejemplo para {count} versículo(s).',
  },
  de: {
    lead: 'Synthetische Übersetzung von {ref}.',
    pool: [
      'Dieser Text dient nur zum Testen des Layouts.',
      'Die echte Übersetzung erscheint hier, sobald das Paket geladen ist.',
      'Längere Verse erhalten einen längeren Text.',
    ],
    note: 'Synthetische Fußnote zu {ref}.',
    intro: 'Synthetische Einleitung zu dieser Sure, eine allgemeine Anmerkung ohne Nummer.',
    compare: 'Vergleiche',
    gloss: 'Bedeutung {n}',
    tafsirHead: 'Synthetischer Kommentar zu {range}',
    tafsirBody: 'Beispielkommentar für {count} Vers(e).',
  },
  ru: {
    lead: 'Синтетический перевод {ref}.',
    pool: [
      'Этот текст нужен только для проверки вёрстки.',
      'Настоящий перевод появится здесь после загрузки пакета.',
      'Длинные аяты получают более длинный текст.',
    ],
    note: 'Синтетическое примечание к {ref}.',
    intro: 'Синтетическое введение к этой суре, общее примечание без номера.',
    compare: 'Ср.',
    gloss: 'значение {n}',
    tafsirHead: 'Синтетический тафсир {range}',
    tafsirBody: 'Пример толкования для {count} аятов.',
  },
  bn: {
    lead: '{ref}-এর কৃত্রিম অনুবাদ।',
    pool: [
      'এই লেখাটি কেবল বিন্যাস পরীক্ষার জন্য।',
      'প্যাকেজ নামানোর পর আসল অনুবাদ এখানে দেখা যাবে।',
      'দীর্ঘ আয়াতের জন্য লেখাও দীর্ঘ রাখা হয়েছে।',
    ],
    note: '{ref}-এর কৃত্রিম টীকা।',
    intro: 'এই সূরার কৃত্রিম ভূমিকা, সংখ্যাহীন সাধারণ টীকা।',
    compare: 'তুলনা করুন',
    gloss: 'অর্থ {n}',
    tafsirHead: '{range}-এর কৃত্রিম তাফসীর',
    tafsirBody: '{count}টি আয়াতের নমুনা তাফসীর।',
    digits: '০১২৩৪৫৬৭৮৯',
  },
  hi: {
    lead: '{ref} का कृत्रिम अनुवाद।',
    pool: [
      'यह पाठ केवल लेआउट जाँचने के लिए है।',
      'पैकेज डाउनलोड होने पर असली अनुवाद यहाँ दिखेगा।',
      'लंबी आयतों को लंबा पाठ मिलता है।',
    ],
    note: '{ref} पर कृत्रिम टिप्पणी।',
    intro: 'इस सूरह का कृत्रिम परिचय, बिना संख्या की सामान्य टिप्पणी।',
    compare: 'तुलना करें',
    gloss: 'अर्थ {n}',
    tafsirHead: '{range} की कृत्रिम तफ़सीर',
    tafsirBody: '{count} आयतों की नमूना तफ़सीर।',
  },
  ta: {
    lead: '{ref} க்கான செயற்கை மொழிபெயர்ப்பு.',
    pool: [
      'இந்த உரை வடிவமைப்பைச் சோதிக்க மட்டுமே.',
      'தொகுப்பு பதிவிறக்கியதும் உண்மையான மொழிபெயர்ப்பு இங்கே தோன்றும்.',
    ],
    note: '{ref} க்கான செயற்கைக் குறிப்பு.',
    intro: 'இந்த அத்தியாயத்தின் செயற்கை அறிமுகம்.',
    compare: 'ஒப்பிடுக',
    gloss: 'பொருள் {n}',
    tafsirHead: '{range} க்கான செயற்கை விளக்கம்',
    tafsirBody: '{count} வசனங்களுக்கான மாதிரி விளக்கம்.',
  },
}

const EN = TEXT.en as LanguageText

function textFor(language: string | null): LanguageText {
  return (language && TEXT[language]) || EN
}

function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m))
}

function digitsOf(n: number, digits: string | undefined): string {
  const s = String(n)
  return digits ? s.replace(/[0-9]/g, (d) => digits[Number(d)] ?? d) : s
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Non-end words of an ayah (from the index). */
function wordsIn(index: QuranIndex, ayahId: number): number {
  const first = index.ayahFirstWord[ayahId - 1] ?? 0
  return Math.max(1, lastWordOf(index, ayahId) - first)
}

/** Footnotes per ayah of a pack (0–2; a general note on some surahs), and their running numbers. */
interface FootnotePlan {
  /** Ayah id → numbered markers of that ayah. */
  markers: Map<number, number[]>
  /** Ayah ids that open a surah with a general (unnumbered) note. */
  intros: Set<number>
}

const plans = new Map<string, FootnotePlan>()

function footnotePlan(index: QuranIndex, packId: string): FootnotePlan {
  let plan = plans.get(packId)
  if (plan) return plan
  plan = { markers: new Map(), intros: new Set() }
  let n = 0
  for (let a = 1; a <= AYAH_COUNT; a++) {
    const u = unit(`${packId}#fn#${a}`)
    const count = u < 0.06 ? 2 : u < 0.26 ? 1 : 0
    if (count > 0) {
      const list: number[] = []
      for (let i = 0; i < count; i++) list.push(++n)
      plan.markers.set(a, list)
    }
  }
  for (const s of index.surahs) if (unit(`${packId}#intro#${s.id}`) < 0.2) plan.intros.add(s.firstAyahId)
  plans.set(packId, plan)
  return plan
}

/** A deterministic "related" reference for a footnote (never the ayah itself). */
function relatedRef(index: QuranIndex, ayahId: number): string {
  const other = ((ayahId * 7919) % AYAH_COUNT) + 1
  const { surah, ayah } = refOf(index, other === ayahId ? (other % AYAH_COUNT) + 1 : other)
  return `${surah}:${ayah}`
}

function syntheticTranslation(index: QuranIndex, p: PackInfo, ayahId: number): TranslationText {
  const lang = textFor(p.language)
  const { surah, ayah } = refOf(index, ayahId)
  const ref = `${surah}:${ayah}`
  const sentences = [fill(lang.lead, { ref })]
  const wanted = Math.max(1, Math.round(wordsIn(index, ayahId) / 9))
  const start = hash(`${p.id}#${ayahId}`) % lang.pool.length
  for (let i = 0; i < wanted; i++) sentences.push(lang.pool[(start + i) % lang.pool.length] ?? '')
  const plan = footnotePlan(index, p.id)
  const markers = plan.markers.get(ayahId) ?? []
  const footnotes: Footnote[] = []
  if (plan.intros.has(ayahId)) {
    footnotes.push({ id: `${surah}:${ayah}:0`, marker: '', html: `<p>${escapeHtml(lang.intro)}</p>` })
  }
  // A marker closes the sentence it annotates, before its full stop (QuranEnc puts "[n]" right after a word).
  const parts = sentences.map(escapeHtml)
  markers.forEach((n, i) => {
    const marker = digitsOf(n, lang.digits)
    const id = `${surah}:${ayah}:${marker}`
    const at = Math.min(i, parts.length - 1)
    const sup = `<sup class="fn" data-fn="${id}">${marker}</sup>`
    parts[at] = (parts[at] ?? '').replace(/([.۔।!?])?$/u, `${sup}$1`)
    const related = relatedRef(index, ayahId)
    const body = escapeHtml(fill(lang.note, { ref }))
    const html =
      n % 2 === 0
        ? `<p>${body} ${escapeHtml(lang.compare)} <a data-ref="${related}">${related}</a>.</p>`
        : `<p>${body}</p>`
    footnotes.push({ id, marker, html })
  })
  return { packId: p.id, html: parts.join(' '), footnotes }
}

/** The ayah range (inside its surah) a synthetic Quran.com-style tafsir entry covers: groups of 1–3 ayahs. */
function tafsirRange(index: QuranIndex, packId: string, ayahId: number): [number, number] {
  const { surah } = refOf(index, ayahId)
  const info = index.surahs[surah - 1]
  if (!info) return [ayahId, ayahId]
  const last = info.firstAyahId + info.ayahCount - 1
  let from = info.firstAyahId
  for (;;) {
    const size = 1 + (hash(`${packId}#group#${from}`) % 3)
    const to = Math.min(last, from + size - 1)
    if (ayahId <= to) return [from, to]
    from = to + 1
  }
}

function syntheticTafsir(index: QuranIndex, p: PackInfo, ayahId: number, range: [number, number]): string {
  const lang = textFor(p.language)
  const [from, to] = range
  const a = refOf(index, from)
  const b = refOf(index, to)
  const label = from === to ? `${a.surah}:${a.ayah}` : `${a.surah}:${a.ayah}–${b.ayah}`
  const related = relatedRef(index, ayahId)
  const paragraphs = 1 + (hash(`${p.id}#tafsir#${from}`) % 3)
  const body: string[] = [`<h2>${escapeHtml(fill(lang.tafsirHead, { range: label }))}</h2>`]
  for (let i = 0; i < paragraphs; i++) {
    const text = escapeHtml(fill(lang.tafsirBody, { count: to - from + 1 }))
    body.push(
      i === paragraphs - 1
        ? `<p>${text} ${escapeHtml(lang.compare)} <a data-ref="${related}">${related}</a>.</p>`
        : `<p>${text} ${escapeHtml(lang.pool[i % lang.pool.length] ?? '')}</p>`,
    )
  }
  return body.join('')
}

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures

const translationFixtures = new Map<string, Promise<Map<number, TranslationText>>>()

/** Every exported window of a translation pack, merged by ayah id. */
function fixtureTranslations(packId: string): Promise<Map<number, TranslationText>> {
  let p = translationFixtures.get(packId)
  if (!p) {
    p = (async () => {
      const out = new Map<number, TranslationText>()
      const pattern = new RegExp(`^translations/${packId.replace(/\./g, '\\.')}/\\d+-\\d+\\.json$`)
      for (const rel of fixtures.list()) {
        if (!pattern.test(rel)) continue
        for (const row of (await fixtures.json<TranslationRow[]>(rel)) ?? []) {
          const item = row.items.find((i) => i.packId === packId) ?? row.items[0]
          if (item) out.set(row.ayahId, { ...item, packId })
        }
      }
      return out
    })()
    translationFixtures.set(packId, p)
  }
  return p
}

const wbwFixtures = new Map<string, Promise<Map<number, WbwEntry>>>()

function fixtureWbw(packId: string, surah: number): Promise<Map<number, WbwEntry>> {
  const key = `${packId}:${surah}`
  let p = wbwFixtures.get(key)
  if (!p) {
    p = (async () => {
      const out = new Map<number, WbwEntry>()
      for (const e of (await fixtures.json<WbwEntry[]>(`wbw/${packId}/${surah}.json`)) ?? [])
        out.set(e.wordId, e)
      return out
    })()
    wbwFixtures.set(key, p)
  }
  return p
}

/** Word texts of an ayah from the ayah fixtures (end marker excluded), or `null` when not exported. */
async function fixtureWords(ayahId: number): Promise<string[] | null> {
  const [row] = await fixtures.ayahs('v2', ayahId, ayahId)
  if (!row || row.textHafs.includes(PLACEHOLDER_WORD)) return null
  const words = row.textHafs.split(' ')
  words.pop()
  return words
}

// ---------------------------------------------------------------------------------------------------------------------
// Handlers

function assertPackIds(packIds: readonly string[]): void {
  if (packIds.length > MAX_PACKS) {
    throw new MockError('invalid_argument', `at most ${MAX_PACKS} packs, got ${packIds.length}`)
  }
  if (new Set(packIds).size !== packIds.length) throw new MockError('invalid_argument', 'duplicate pack ids')
}

async function translationRows(packIds: string[], from: number, to: number): Promise<TranslationRow[]> {
  assertAyahRange(from, to, MAX_AYAHS)
  assertPackIds(packIds)
  const list = packIds.map((id) => {
    const p = requirePack(id, 'translation')
    requireInstalled(p)
    return p
  })
  await jitter()
  const index = await fixtures.index()
  const sources = await Promise.all(list.map((p) => fixtureTranslations(p.id)))
  const rows: TranslationRow[] = []
  for (let a = from; a <= to; a++) {
    rows.push({
      ayahId: a,
      items: list.map((p, i) => sources[i]?.get(a) ?? syntheticTranslation(index, p, a)),
    })
  }
  return rows
}

/**
 * Surahs an on-demand tafsir has no commentary on: upstream sends an empty chapter, which Rust stores (it is complete)
 * and answers with `not_found` ("… has no commentary on surah N"). Ibn Kathir (QDC 169) on Al-Fil is the case.
 */
const NO_COMMENTARY: ReadonlyMap<string, ReadonlySet<number>> = new Map([
  ['tafsir.en.ibn_kathir', new Set([105])],
])

async function tafsirEntry(packId: string, ayahId: number): Promise<TafsirEntry> {
  assertRange('ayahId', ayahId, 1, AYAH_COUNT)
  const p = requirePack(packId, 'tafsir')
  const index = await fixtures.index()
  let stamp: { fetchedAt: number | null; stale: boolean } = { fetchedAt: null, stale: false }
  if (onDemand(p)) {
    const surah = refOf(index, ayahId).surah
    stamp = await ensureChapter(p, surah)
    if (NO_COMMENTARY.get(packId)?.has(surah)) {
      throw new MockError('not_found', `${packId} has no commentary on surah ${surah}`)
    }
  } else requireInstalled(p)
  await jitter()
  const language = p.language ?? 'en'
  const dir = p.direction ?? (language === 'ar' || language === 'ur' || language === 'fa' ? 'rtl' : 'ltr')
  const fixture = await fixtures.json<TafsirEntry>(`tafsir/${packId}/${ayahId}.json`)
  if (fixture) return { ...fixture, packId, lang: language, dir, ...stamp }
  const range: [number, number] = onDemand(p) ? tafsirRange(index, packId, ayahId) : [ayahId, ayahId]
  return {
    packId,
    fromAyahId: range[0],
    toAyahId: range[1],
    html: syntheticTafsir(index, p, ayahId, range),
    lang: language,
    dir,
    ...stamp,
  }
}

async function wbwEntries(packId: string, fromWordId: number, toWordId: number): Promise<WbwEntry[]> {
  const index = await fixtures.index()
  const total = wordTotal(index)
  assertRange('fromWordId', fromWordId, 1, total)
  assertRange('toWordId', toWordId, 1, total)
  if (fromWordId > toWordId) {
    throw new MockError('invalid_argument', `fromWordId ${fromWordId} > toWordId ${toWordId}`)
  }
  if (toWordId - fromWordId + 1 > MAX_WORDS) {
    throw new MockError('invalid_argument', `range longer than ${MAX_WORDS} words`)
  }
  const p = requirePack(packId, 'wbw')
  const firstSurah = refOf(index, ayahOfWord(index, fromWordId)).surah
  const lastSurah = refOf(index, ayahOfWord(index, toWordId)).surah
  for (let s = firstSurah; s <= lastSurah; s++) await ensureChapter(p, s)
  await jitter()
  const lang = textFor(p.language)
  const out: WbwEntry[] = []
  let ayahId = 0
  let words: string[] | null = null
  let chapter = 0
  let fixture = new Map<number, WbwEntry>()
  for (let w = fromWordId; w <= toWordId; w++) {
    const a = ayahOfWord(index, w)
    const last = lastWordOf(index, a)
    if (w === last) continue // end markers have no word-by-word entry
    if (a !== ayahId) {
      ayahId = a
      words = await fixtureWords(a)
      const s = refOf(index, a).surah
      if (s !== chapter) {
        chapter = s
        fixture = await fixtureWbw(packId, s)
      }
    }
    const known = fixture.get(w)
    if (known) {
      out.push(known)
      continue
    }
    const pos = w - (index.ayahFirstWord[a - 1] ?? w)
    out.push({
      wordId: w,
      text: words?.[pos] ?? PLACEHOLDER_WORD,
      translation: fill(lang.gloss, { n: digitsOf(w, lang.digits) }),
      transliteration: `translit-${w}`,
    })
  }
  return out
}

export const contentHandlers: Handlers<'quranGetAyahs' | 'translationGet' | 'tafsirGet' | 'wbwGetRange'> = {
  quranGetAyahs: handle(
    async (layout: MushafLayout, fromAyahId: number, toAyahId: number): Promise<AyahText[]> => {
      assertAyahRange(fromAyahId, toAyahId, MAX_AYAHS)
      await jitter()
      return fixtures.ayahs(layout, fromAyahId, toAyahId)
    },
  ),
  translationGet: handle(translationRows),
  tafsirGet: handle(tafsirEntry),
  wbwGetRange: handle(wbwEntries),
}

/** Test controls: forget chapter fetch times (a new page session) and cached fixture lookups. */
export const contentMock = {
  reset(): void {
    fetchedThisSession.clear()
    translationFixtures.clear()
    wbwFixtures.clear()
    plans.clear()
  },
}
