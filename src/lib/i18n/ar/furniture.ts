import type { Dict } from '$lib/contracts/i18n'

/** `furniture` messages, Arabic. Same keys as `../en/furniture.ts`. */
export const furniture = {
  marker: {
    juz: 'بداية الجزء {juz} · {ref}',
    hizb: 'بداية الحزب {hizb} · {ref}',
    quarter1: 'ربع الحزب {hizb} · {ref}',
    quarter2: 'نصف الحزب {hizb} · {ref}',
    quarter3: 'ثلاثة أرباع الحزب {hizb} · {ref}',
    sajda: 'موضع سجدة تلاوة · {ref}',
    sajdaObligatory: 'موضع سجدة تلاوة واجبة · {ref}',
    select: 'انقر لتحديد الآية',
  },
  marks: {
    bookmark: 'آية محفوظة · {ref}',
    note: 'ملاحظة · {ref}',
    noteEmpty: 'ملاحظة فارغة',
    noteOpen: 'انقر لفتح الملاحظة',
    pageBookmark: 'الصفحة {page} محفوظة',
    pageBookmarkOpen: 'انقر لعرض المحفوظات',
  },
  ribbon: {
    title: 'علامة القراءة',
    moved: 'نُقلت {time}',
    moveHere: 'انقلها إلى هنا',
    tooltip: 'علامة القراءة · {ref}',
    alreadyHere: 'هذا موضع قراءتك الحالي',
    moveTarget: 'تنقلها إلى {ref}',
  },
  surahInfo: {
    label: 'عن سورة {name}',
    meccan: 'مكية',
    medinan: 'مدنية',
    revelationOrder: 'ترتيب النزول {order}',
    revealed: 'النزول',
    ayahs: 'الآيات',
    pages: 'الصفحات',
    juz: 'الأجزاء',
    range: '{from}–{to}',
    play: 'تلاوة السورة',
    download: 'تنزيل التلاوة',
    downloaded: 'التلاوة منزَّلة',
    downloading: 'جارٍ التنزيل…',
    offline: 'يتاح التنزيل عند الاتصال بالإنترنت',
    downloadStarted: 'جارٍ تنزيل {surah} · {reciter}',
    reciter: 'بصوت {reciter}',
  },
} satisfies Dict['furniture']
