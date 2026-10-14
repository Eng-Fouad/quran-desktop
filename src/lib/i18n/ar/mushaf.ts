import type { Dict } from '$lib/contracts/i18n'

/** `mushaf` messages, Arabic. Same keys as `../en/mushaf.ts`. */
export const mushaf = {
  page: {
    label: 'الصفحة {page} · سورة {surah} · الجزء {juz}',
    roleDescription: 'صفحة',
  },
  synthetic: {
    badge: 'صفحة تجريبية',
    hint: 'هذه الصفحة ليست ضمن البيانات المصدَّرة، فتعرض المحاكاة كلمات بديلة مع الترقيم الحقيقي للصفحة والسورة والجزء.',
  },
  v4Unsupported: 'لا يستطيع هذا النظام عرض خط التجويد الملوَّن، لذا انتقل المصحف إلى نمط QCF V2.',
} satisfies Dict['mushaf']
