import type { Dict } from '$lib/contracts/i18n'

/** One user-facing message per `AppError` kind, Arabic. */
export const errors = {
  not_found: 'تعذّر العثور على العنصر المطلوب.',
  invalid_argument: 'هذا الطلب غير صالح.',
  database: 'حدثت مشكلة في قاعدة البيانات المحلية.',
  io: 'تعذّرت قراءة ملف أو الكتابة إليه.',
  network: 'تعذّر الوصول إلى الخادم. تحقّق من اتصالك ثم أعد المحاولة.',
  offline: 'أنت غير متصل. يتطلب هذا اتصالًا بالإنترنت.',
  integrity: 'كان الملف المنزَّل تالفًا فحُذف. أعد المحاولة.',
  cancelled: 'أُلغيت العملية.',
  conflict: 'تغيّر هذا العنصر في مكان آخر في الوقت نفسه. أعد المحاولة.',
  audio: 'حدثت مشكلة في تشغيل الصوت.',
  unsupported: 'هذه الميزة غير متاحة في هذا الإصدار.',
  internal: 'حدث خطأ غير متوقع في التطبيق.',
} satisfies Dict['errors']
