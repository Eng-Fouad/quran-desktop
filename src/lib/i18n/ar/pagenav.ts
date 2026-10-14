import type { Dict } from '$lib/contracts/i18n'

/** `pagenav` messages, Arabic. Same keys as `../en/pagenav.ts`; plurals define all six categories. */
export const pagenav = {
  label: {
    page: 'ص {page}',
    pages: 'ص {range}',
    juz: 'ج {juz}',
  },
  rail: {
    name: 'شريط الصفحات',
    valueText: 'الصفحة {page}، {surah}، الجزء {juz}',
  },
  hint: {
    pageTurn: 'مرِّر أو اسحب أو اضغط {keys} لتقليب الصفحات',
    pageTurnText: 'مرِّر أو اسحب أو اضغط مفتاحَي السهمين الأيمن والأيسر لتقليب الصفحات',
    dismiss: 'حسنًا',
  },
  division: {
    /** Also the chip's Arabic heading in every UI language (genitive ordinal: «بداية الجزء الخامس عشر»). */
    juz: 'بداية الجزء {ordinal}',
    hizb: 'بداية الحزب {ordinal}',
  },
} satisfies Dict['pagenav']
