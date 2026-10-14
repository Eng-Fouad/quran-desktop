import type { Dict } from '$lib/contracts/i18n'

/** `reader` messages, Arabic. Same keys as `../en/reader.ts`; plurals define all six categories. */
export const reader = {
  announce: {
    page: 'الصفحة {page}',
    spread: 'الصفحتان {first} و{last}',
    ayah: '{surah} {ref}، الصفحة {page}',
  },
  mode: {
    mushaf: 'وضع المصحف',
    translation: 'وضع الترجمة',
  },
  pageMode: {
    changed: 'عرض الصفحات: {mode}',
    auto: 'تلقائي',
    single: 'صفحة واحدة',
    spread: 'صفحتان متقابلتان',
  },
  zoom: {
    control: 'التكبير',
    level: '{pct}٪',
    fit: 'ملاءمة النافذة',
    reset: 'التكبير {pct}٪، ملاءمة النافذة',
    announce: 'التكبير {pct}٪',
  },
  display: {
    button: 'العرض',
    textSize: 'حجم نص الترجمة',
    allSettings: 'جميع الإعدادات',
  },
  follow: {
    back: 'العودة إلى التلاوة',
    where: 'التلاوة في الصفحة {page}',
  },
  error: {
    page: 'تعذّر تحميل هذه الصفحة',
  },
} satisfies Dict['reader']
