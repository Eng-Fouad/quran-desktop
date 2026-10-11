/**
 * The synthetic data generator (§4.6, §5.17; WP0C, frozen). It lets `pnpm dev:web` and unit tests run with no
 * QF-derived data at all: when `src/lib/ipc/mock/fixtures/` is absent (it is generated and gitignored, D10), the mock
 * serves a synthetic `QuranIndex`, pages, ayah texts, timings, reciters and the pack catalogue from here.
 *
 * What is real and what is not:
 * - Surah metadata, juz/hizb/rub/manzil starts, sajdas and the 604 page starts are Tanzil's `quran-data.xml`
 *   (© Tanzil.info, CC BY 3.0; https://tanzil.net), embedded below. Page starts are Tanzil's Madani list (the 1405H V1
 *   print) and are used for all three layouts.
 * - Words are placeholders: every word is `كلمة` ("word") and every end marker is U+06DD + the Arabic-Indic ayah number,
 *   so no synthetic text can be mistaken for Quran text. Word counts are invented so that each page fills its 15 lines
 *   (8 on the opening pages); synthetic word ids are therefore not core.db's 83,665 ids.
 * - `syntheticPage()` also works on a real fixture index: it then uses the real page/ayah/word ids and real per-ayah word
 *   counts, so a page outside the fixture list keeps its true numbering (§4.6 "pages outside the list").
 */
import type {
  AyahText,
  Division,
  L10nText,
  LayoutInfo,
  MushafLayout,
  MushafStyle,
  PackInfo,
  PackKind,
  PageAyah,
  PageData,
  PageLine,
  PageWord,
  QuranIndex,
  ReciterInfo,
  SajdaKind,
  SurahInfo,
  SurahTimings,
  TextDir,
} from '../bindings'

// ---------------------------------------------------------------------------------------------------------------------
// Tanzil metadata (quran-data.xml 1.0, © 2008-2009 Tanzil.info, CC BY 3.0). Ayah ids are 1..6236 in Hafs order.

/** [ayahCount, nameAr, transliteration, meaning, 0 Meccan | 1 Medinan, revelationOrder] per surah. */
const SURAHS: readonly (readonly [number, string, string, string, 0 | 1, number])[] = [
  [7, 'الفاتحة', 'Al-Faatiha', 'The Opening', 0, 5],
  [286, 'البقرة', 'Al-Baqara', 'The Cow', 1, 87],
  [200, 'آل عمران', 'Aal-i-Imraan', 'The Family of Imraan', 1, 89],
  [176, 'النساء', 'An-Nisaa', 'The Women', 1, 92],
  [120, 'المائدة', 'Al-Maaida', 'The Table', 1, 112],
  [165, 'الأنعام', "Al-An'aam", 'The Cattle', 0, 55],
  [206, 'الأعراف', "Al-A'raaf", 'The Heights', 0, 39],
  [75, 'الأنفال', 'Al-Anfaal', 'The Spoils of War', 1, 88],
  [129, 'التوبة', 'At-Tawba', 'The Repentance', 1, 113],
  [109, 'يونس', 'Yunus', 'Jonas', 0, 51],
  [123, 'هود', 'Hud', 'Hud', 0, 52],
  [111, 'يوسف', 'Yusuf', 'Joseph', 0, 53],
  [43, 'الرعد', "Ar-Ra'd", 'The Thunder', 1, 96],
  [52, 'ابراهيم', 'Ibrahim', 'Abraham', 0, 72],
  [99, 'الحجر', 'Al-Hijr', 'The Rock', 0, 54],
  [128, 'النحل', 'An-Nahl', 'The Bee', 0, 70],
  [111, 'الإسراء', 'Al-Israa', 'The Night Journey', 0, 50],
  [110, 'الكهف', 'Al-Kahf', 'The Cave', 0, 69],
  [98, 'مريم', 'Maryam', 'Mary', 0, 44],
  [135, 'طه', 'Taa-Haa', 'Taa-Haa', 0, 45],
  [112, 'الأنبياء', 'Al-Anbiyaa', 'The Prophets', 0, 73],
  [78, 'الحج', 'Al-Hajj', 'The Pilgrimage', 1, 103],
  [118, 'المؤمنون', 'Al-Muminoon', 'The Believers', 0, 74],
  [64, 'النور', 'An-Noor', 'The Light', 1, 102],
  [77, 'الفرقان', 'Al-Furqaan', 'The Criterion', 0, 42],
  [227, 'الشعراء', "Ash-Shu'araa", 'The Poets', 0, 47],
  [93, 'النمل', 'An-Naml', 'The Ant', 0, 48],
  [88, 'القصص', 'Al-Qasas', 'The Stories', 0, 49],
  [69, 'العنكبوت', 'Al-Ankaboot', 'The Spider', 0, 85],
  [60, 'الروم', 'Ar-Room', 'The Romans', 0, 84],
  [34, 'لقمان', 'Luqman', 'Luqman', 0, 57],
  [30, 'السجدة', 'As-Sajda', 'The Prostration', 0, 75],
  [73, 'الأحزاب', 'Al-Ahzaab', 'The Clans', 1, 90],
  [54, 'سبإ', 'Saba', 'Sheba', 0, 58],
  [45, 'فاطر', 'Faatir', 'The Originator', 0, 43],
  [83, 'يس', 'Yaseen', 'Yaseen', 0, 41],
  [182, 'الصافات', 'As-Saaffaat', 'Those drawn up in Ranks', 0, 56],
  [88, 'ص', 'Saad', 'The letter Saad', 0, 38],
  [75, 'الزمر', 'Az-Zumar', 'The Groups', 0, 59],
  [85, 'غافر', 'Al-Ghaafir', 'The Forgiver', 0, 60],
  [54, 'فصلت', 'Fussilat', 'Explained in detail', 0, 61],
  [53, 'الشورى', 'Ash-Shura', 'Consultation', 0, 62],
  [89, 'الزخرف', 'Az-Zukhruf', 'Ornaments of gold', 0, 63],
  [59, 'الدخان', 'Ad-Dukhaan', 'The Smoke', 0, 64],
  [37, 'الجاثية', 'Al-Jaathiya', 'Crouching', 0, 65],
  [35, 'الأحقاف', 'Al-Ahqaf', 'The Dunes', 0, 66],
  [38, 'محمد', 'Muhammad', 'Muhammad', 1, 95],
  [29, 'الفتح', 'Al-Fath', 'The Victory', 1, 111],
  [18, 'الحجرات', 'Al-Hujuraat', 'The Inner Apartments', 1, 106],
  [45, 'ق', 'Qaaf', 'The letter Qaaf', 0, 34],
  [60, 'الذاريات', 'Adh-Dhaariyat', 'The Winnowing Winds', 0, 67],
  [49, 'الطور', 'At-Tur', 'The Mount', 0, 76],
  [62, 'النجم', 'An-Najm', 'The Star', 0, 23],
  [55, 'القمر', 'Al-Qamar', 'The Moon', 0, 37],
  [78, 'الرحمن', 'Ar-Rahmaan', 'The Beneficent', 1, 97],
  [96, 'الواقعة', 'Al-Waaqia', 'The Inevitable', 0, 46],
  [29, 'الحديد', 'Al-Hadid', 'The Iron', 1, 94],
  [22, 'المجادلة', 'Al-Mujaadila', 'The Pleading Woman', 1, 105],
  [24, 'الحشر', 'Al-Hashr', 'The Exile', 1, 101],
  [13, 'الممتحنة', 'Al-Mumtahana', 'She that is to be examined', 1, 91],
  [14, 'الصف', 'As-Saff', 'The Ranks', 1, 109],
  [11, 'الجمعة', "Al-Jumu'a", 'Friday', 1, 110],
  [11, 'المنافقون', 'Al-Munaafiqoon', 'The Hypocrites', 1, 104],
  [18, 'التغابن', 'At-Taghaabun', 'Mutual Disillusion', 1, 108],
  [12, 'الطلاق', 'At-Talaaq', 'Divorce', 1, 99],
  [12, 'التحريم', 'At-Tahrim', 'The Prohibition', 1, 107],
  [30, 'الملك', 'Al-Mulk', 'The Sovereignty', 0, 77],
  [52, 'القلم', 'Al-Qalam', 'The Pen', 0, 2],
  [52, 'الحاقة', 'Al-Haaqqa', 'The Reality', 0, 78],
  [44, 'المعارج', "Al-Ma'aarij", 'The Ascending Stairways', 0, 79],
  [28, 'نوح', 'Nooh', 'Noah', 0, 71],
  [28, 'الجن', 'Al-Jinn', 'The Jinn', 0, 40],
  [20, 'المزمل', 'Al-Muzzammil', 'The Enshrouded One', 0, 3],
  [56, 'المدثر', 'Al-Muddaththir', 'The Cloaked One', 0, 4],
  [40, 'القيامة', 'Al-Qiyaama', 'The Resurrection', 0, 31],
  [31, 'الانسان', 'Al-Insaan', 'Man', 1, 98],
  [50, 'المرسلات', 'Al-Mursalaat', 'The Emissaries', 0, 33],
  [40, 'النبإ', 'An-Naba', 'The Announcement', 0, 80],
  [46, 'النازعات', "An-Naazi'aat", 'Those who drag forth', 0, 81],
  [42, 'عبس', 'Abasa', 'He frowned', 0, 24],
  [29, 'التكوير', 'At-Takwir', 'The Overthrowing', 0, 7],
  [19, 'الإنفطار', 'Al-Infitaar', 'The Cleaving', 0, 82],
  [36, 'المطففين', 'Al-Mutaffifin', 'Defrauding', 0, 86],
  [25, 'الإنشقاق', 'Al-Inshiqaaq', 'The Splitting Open', 0, 83],
  [22, 'البروج', 'Al-Burooj', 'The Constellations', 0, 27],
  [17, 'الطارق', 'At-Taariq', 'The Morning Star', 0, 36],
  [19, 'الأعلى', "Al-A'laa", 'The Most High', 0, 8],
  [26, 'الغاشية', 'Al-Ghaashiya', 'The Overwhelming', 0, 68],
  [30, 'الفجر', 'Al-Fajr', 'The Dawn', 0, 10],
  [20, 'البلد', 'Al-Balad', 'The City', 0, 35],
  [15, 'الشمس', 'Ash-Shams', 'The Sun', 0, 26],
  [21, 'الليل', 'Al-Lail', 'The Night', 0, 9],
  [11, 'الضحى', 'Ad-Dhuhaa', 'The Morning Hours', 0, 11],
  [8, 'الشرح', 'Ash-Sharh', 'The Consolation', 0, 12],
  [8, 'التين', 'At-Tin', 'The Fig', 0, 28],
  [19, 'العلق', 'Al-Alaq', 'The Clot', 0, 1],
  [5, 'القدر', 'Al-Qadr', 'The Power, Fate', 0, 25],
  [8, 'البينة', 'Al-Bayyina', 'The Evidence', 1, 100],
  [8, 'الزلزلة', 'Az-Zalzala', 'The Earthquake', 1, 93],
  [11, 'العاديات', 'Al-Aadiyaat', 'The Chargers', 0, 14],
  [11, 'القارعة', "Al-Qaari'a", 'The Calamity', 0, 30],
  [8, 'التكاثر', 'At-Takaathur', 'Competition', 0, 16],
  [3, 'العصر', 'Al-Asr', 'The Declining Day, Epoch', 0, 13],
  [9, 'الهمزة', 'Al-Humaza', 'The Traducer', 0, 32],
  [5, 'الفيل', 'Al-Fil', 'The Elephant', 0, 19],
  [4, 'قريش', 'Quraish', 'Quraysh', 0, 29],
  [7, 'الماعون', "Al-Maa'un", 'Almsgiving', 0, 17],
  [3, 'الكوثر', 'Al-Kawthar', 'Abundance', 0, 15],
  [6, 'الكافرون', 'Al-Kaafiroon', 'The Disbelievers', 0, 18],
  [3, 'النصر', 'An-Nasr', 'Divine Support', 1, 114],
  [5, 'المسد', 'Al-Masad', 'The Palm Fibre', 0, 6],
  [4, 'الإخلاص', 'Al-Ikhlaas', 'Sincerity', 0, 22],
  [5, 'الفلق', 'Al-Falaq', 'The Dawn', 0, 20],
  [6, 'الناس', 'An-Naas', 'Mankind', 0, 21],
]
/** First ayah id of each juz (30). */
const JUZ_STARTS: readonly number[] = [
  1, 149, 260, 386, 517, 641, 751, 900, 1042, 1201, 1328, 1479, 1649, 1803, 2030, 2215, 2484, 2674, 2876,
  3215, 3386, 3564, 3733, 4090, 4265, 4511, 4706, 5105, 5242, 5673,
]
/** First ayah id of each rub' al-hizb quarter (240); every fourth starts a hizb. */
const RUB_STARTS: readonly number[] = [
  1, 33, 51, 67, 82, 99, 113, 131, 149, 165, 184, 196, 210, 226, 240, 250, 260, 270, 279, 290, 308, 326, 345,
  368, 386, 406, 426, 446, 464, 479, 494, 505, 517, 529, 551, 567, 581, 593, 607, 628, 641, 656, 670, 681,
  696, 710, 720, 736, 751, 766, 778, 802, 825, 848, 863, 884, 900, 916, 930, 940, 955, 985, 1001, 1019, 1042,
  1071, 1096, 1110, 1125, 1143, 1161, 1182, 1201, 1221, 1236, 1254, 1269, 1281, 1295, 1310, 1328, 1346, 1357,
  1375, 1390, 1417, 1435, 1454, 1479, 1497, 1514, 1534, 1557, 1581, 1603, 1626, 1649, 1673, 1697, 1712, 1726,
  1742, 1760, 1778, 1803, 1852, 1902, 1931, 1952, 1976, 1991, 2012, 2030, 2052, 2079, 2099, 2128, 2157, 2172,
  2191, 2215, 2239, 2272, 2309, 2349, 2403, 2431, 2459, 2484, 2512, 2534, 2566, 2596, 2614, 2633, 2655, 2674,
  2709, 2748, 2792, 2812, 2826, 2844, 2856, 2876, 2908, 2933, 2984, 3043, 3113, 3160, 3186, 3215, 3241, 3264,
  3281, 3303, 3328, 3341, 3366, 3386, 3410, 3440, 3463, 3491, 3514, 3534, 3551, 3564, 3584, 3593, 3616, 3630,
  3652, 3675, 3701, 3733, 3765, 3810, 3871, 3933, 3991, 4022, 4066, 4090, 4111, 4134, 4154, 4174, 4199, 4227,
  4243, 4265, 4285, 4299, 4323, 4349, 4382, 4431, 4485, 4511, 4531, 4555, 4578, 4601, 4613, 4626, 4657, 4706,
  4759, 4810, 4855, 4902, 4980, 5054, 5091, 5105, 5118, 5137, 5157, 5178, 5192, 5218, 5230, 5242, 5272, 5324,
  5394, 5448, 5495, 5552, 5610, 5673, 5759, 5830, 5885, 5949, 6024, 6091, 6155,
]
/** First ayah id of each manzil (7). */
const MANZIL_STARTS: readonly number[] = [1, 670, 1365, 2030, 2933, 3789, 4631]
/** [ayahId, 1 obligatory | 0 recommended] of each sajda (15). */
const SAJDAS: readonly (readonly [number, 0 | 1])[] = [
  [1160, 0],
  [1722, 0],
  [1951, 0],
  [2138, 0],
  [2308, 0],
  [2613, 0],
  [2672, 0],
  [2915, 0],
  [3185, 0],
  [3518, 1],
  [3994, 0],
  [4256, 1],
  [4846, 1],
  [5905, 0],
  [6125, 1],
]
/** First ayah id of each Madani page (604; Tanzil's page list, = the 1405H V1 page starts). */
const PAGE_STARTS: readonly number[] = [
  1, 8, 13, 24, 32, 37, 45, 56, 65, 69, 77, 84, 91, 96, 101, 109, 113, 120, 127, 134, 142, 149, 153, 161, 171,
  177, 184, 189, 194, 198, 204, 210, 218, 223, 227, 232, 238, 241, 245, 253, 256, 260, 264, 267, 272, 277,
  282, 289, 290, 294, 303, 309, 316, 323, 331, 339, 346, 355, 364, 371, 377, 385, 394, 402, 409, 415, 426,
  434, 442, 447, 451, 459, 467, 474, 480, 488, 494, 500, 505, 508, 513, 517, 520, 527, 531, 538, 545, 553,
  559, 568, 573, 580, 585, 588, 595, 599, 607, 615, 621, 628, 634, 641, 648, 656, 664, 669, 672, 675, 679,
  683, 687, 693, 701, 706, 711, 715, 720, 727, 734, 740, 746, 752, 759, 765, 773, 778, 783, 790, 798, 808,
  817, 825, 834, 842, 849, 858, 863, 871, 880, 884, 891, 900, 908, 914, 921, 927, 932, 936, 941, 947, 955,
  966, 977, 985, 992, 998, 1006, 1012, 1022, 1028, 1036, 1042, 1050, 1059, 1075, 1085, 1092, 1098, 1104, 1110,
  1114, 1118, 1125, 1133, 1142, 1150, 1161, 1169, 1177, 1186, 1194, 1201, 1206, 1213, 1222, 1230, 1236, 1242,
  1249, 1256, 1262, 1267, 1272, 1276, 1283, 1290, 1297, 1304, 1308, 1315, 1322, 1329, 1335, 1342, 1347, 1353,
  1358, 1365, 1371, 1379, 1385, 1390, 1398, 1407, 1418, 1426, 1435, 1443, 1453, 1462, 1471, 1479, 1486, 1493,
  1502, 1511, 1519, 1527, 1536, 1545, 1555, 1562, 1571, 1582, 1591, 1601, 1611, 1619, 1627, 1634, 1640, 1649,
  1660, 1666, 1675, 1683, 1692, 1700, 1708, 1713, 1721, 1726, 1736, 1742, 1750, 1756, 1761, 1769, 1775, 1784,
  1793, 1803, 1818, 1834, 1854, 1873, 1893, 1908, 1916, 1928, 1936, 1944, 1956, 1966, 1974, 1981, 1989, 1995,
  2004, 2012, 2020, 2030, 2037, 2047, 2057, 2068, 2079, 2088, 2096, 2105, 2116, 2126, 2134, 2145, 2156, 2161,
  2168, 2175, 2186, 2194, 2202, 2215, 2224, 2238, 2251, 2262, 2276, 2289, 2302, 2315, 2327, 2346, 2361, 2386,
  2400, 2413, 2425, 2436, 2447, 2462, 2474, 2484, 2494, 2508, 2519, 2528, 2541, 2556, 2565, 2574, 2585, 2596,
  2601, 2611, 2619, 2626, 2634, 2642, 2651, 2660, 2668, 2674, 2691, 2701, 2716, 2733, 2748, 2763, 2778, 2792,
  2802, 2812, 2819, 2823, 2828, 2835, 2845, 2850, 2853, 2858, 2867, 2876, 2888, 2899, 2911, 2923, 2933, 2952,
  2972, 2993, 3016, 3044, 3069, 3092, 3116, 3139, 3160, 3173, 3182, 3195, 3204, 3215, 3223, 3236, 3248, 3258,
  3266, 3274, 3281, 3288, 3296, 3303, 3312, 3323, 3330, 3337, 3347, 3355, 3364, 3371, 3379, 3386, 3393, 3404,
  3415, 3425, 3434, 3442, 3451, 3460, 3470, 3481, 3489, 3498, 3504, 3515, 3524, 3534, 3540, 3549, 3556, 3564,
  3569, 3577, 3584, 3588, 3596, 3607, 3614, 3621, 3629, 3638, 3646, 3655, 3664, 3672, 3679, 3691, 3699, 3705,
  3718, 3733, 3746, 3760, 3776, 3789, 3813, 3840, 3865, 3891, 3915, 3942, 3971, 3987, 3997, 4013, 4032, 4054,
  4064, 4069, 4080, 4090, 4099, 4106, 4115, 4126, 4133, 4141, 4150, 4159, 4167, 4174, 4183, 4192, 4200, 4211,
  4219, 4230, 4239, 4248, 4257, 4265, 4273, 4283, 4288, 4295, 4304, 4317, 4324, 4336, 4348, 4359, 4373, 4386,
  4399, 4415, 4433, 4454, 4474, 4487, 4496, 4506, 4516, 4525, 4531, 4539, 4546, 4557, 4565, 4575, 4584, 4593,
  4599, 4607, 4612, 4617, 4624, 4631, 4646, 4666, 4682, 4706, 4727, 4750, 4767, 4785, 4811, 4829, 4853, 4874,
  4896, 4918, 4942, 4969, 4996, 5030, 5056, 5079, 5087, 5094, 5100, 5105, 5111, 5116, 5126, 5130, 5136, 5143,
  5151, 5156, 5162, 5169, 5178, 5186, 5193, 5200, 5209, 5218, 5223, 5230, 5237, 5242, 5254, 5268, 5287, 5314,
  5332, 5358, 5386, 5415, 5430, 5448, 5461, 5476, 5495, 5513, 5543, 5571, 5597, 5617, 5642, 5673, 5703, 5728,
  5759, 5801, 5830, 5855, 5883, 5910, 5932, 5964, 5994, 6017, 6044, 6073, 6099, 6126, 6138, 6156, 6177, 6194,
  6208, 6222,
]

// ---------------------------------------------------------------------------------------------------------------------
// Constants and helpers

export const AYAH_COUNT = 6236
export const PAGE_COUNT = 604
export const SURAH_COUNT = 114
/** core.db's word count (§0.2): the total of a real (fixture) index. */
export const REAL_WORD_COUNT = 83665
/** The placeholder word ("word"). Synthetic pages never contain Quran text. */
export const PLACEHOLDER_WORD = 'كلمة'
/** U+06DD ARABIC END OF AYAH; followed by Arabic-Indic digits it renders the ayah-end ornament in KFGQPC Hafs. */
export const END_OF_AYAH = String.fromCodePoint(0x06dd)
const LAYOUTS: readonly MushafLayout[] = ['v2', 'v1', 'v4']
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩'

/** `arr[i]`, or a `RangeError` (the mock's handlers turn it into an `internal` error) instead of `undefined`. */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i]
  if (v === undefined) throw new RangeError(`index ${i} is outside 0..${arr.length - 1}`)
  return v
}

/** Arabic-Indic digits for a number (Mushaf furniture always uses them, §0.2). */
export function arabicIndic(n: number): string {
  return String(n).replace(/[0-9]/g, (d) => ARABIC_INDIC[Number(d)] ?? d)
}

/** A deterministic hash of an integer to [0, 1) (mulberry32's mixer), so synthetic data is the same on every run. */
function hash01(n: number): number {
  let t = (n + 0x6d2b79f5) | 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Index of the last element `<= value` of an ascending array, or -1 (binary search). */
export function floorIndex(arr: readonly number[], value: number): number {
  let lo = 0
  let hi = arr.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (at(arr, mid) <= value) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/** The layout a style renders in (§0.2): hafs and qcf_v2 → v2, qcf_v1 → v1, qcf_v4 → v4. */
export function layoutOf(style: MushafStyle): MushafLayout {
  return style === 'qcf_v1' ? 'v1' : style === 'qcf_v4' ? 'v4' : 'v2'
}

const firstsCache = new WeakMap<readonly unknown[], readonly number[]>()

/** Ascending first-ayah ids of a division or surah list, cached per array. */
function firsts(list: readonly { firstAyahId: number }[]): readonly number[] {
  let out = firstsCache.get(list)
  if (!out) {
    out = list.map((d) => d.firstAyahId)
    firstsCache.set(list, out)
  }
  return out
}

/** The id of the division (juz, hizb, rub, manzil) containing an ayah. */
export function divisionOf(divisions: readonly Division[], ayahId: number): number {
  return at(divisions, Math.max(0, floorIndex(firsts(divisions), ayahId))).id
}

/** `(surah, ayah)` of an ayah id within an index. */
export function refOf(index: QuranIndex, ayahId: number): { surah: number; ayah: number } {
  const i = Math.max(0, floorIndex(firsts(index.surahs), ayahId))
  const s = at(index.surahs, i)
  return { surah: s.id, ayah: ayahId - s.firstAyahId + 1 }
}

/** The layout info of an index for a layout (falls back to the first one). */
export function layoutInfo(index: QuranIndex, layout: MushafLayout): LayoutInfo {
  return index.layouts.find((l) => l.layout === layout) ?? at(index.layouts, 0)
}

// ---------------------------------------------------------------------------------------------------------------------
// Index

const SURAH_FIRST_AYAH: readonly number[] = (() => {
  const out: number[] = []
  let next = 1
  for (const s of SURAHS) {
    out.push(next)
    next += s[0]
  }
  return out
})()

function divisions(starts: readonly number[]): Division[] {
  return starts.map((first, i) => ({
    id: i + 1,
    firstAyahId: first,
    lastAyahId: (starts[i + 1] ?? AYAH_COUNT + 1) - 1,
  }))
}

/** Surahs 1 and 9 have no basmala line (surah 1's basmala is its first ayah). */
function hasBasmalaLine(surah: number): boolean {
  return surah !== 1 && surah !== 9
}

function surahInfos(): SurahInfo[] {
  return SURAHS.map(([ayahCount, nameAr, translit, meaning, place, order], i) => ({
    id: i + 1,
    nameAr,
    nameSimple: translit,
    nameComplex: translit,
    nameEn: meaning,
    revelationPlace: place === 0 ? 'makkah' : 'madinah',
    revelationOrder: order,
    ayahCount,
    firstAyahId: at(SURAH_FIRST_AYAH, i),
    bismillahPre: hasBasmalaLine(i + 1),
    headerCp: null,
  }))
}

/** Lines on a page: 8 on the opening pages, 15 elsewhere (§5.4). */
export function linesOnPage(page: number): number {
  return page <= 2 ? 8 : 15
}

/**
 * Invented word counts per ayah (end marker included, at least 2): each page's ayahs share about 9 words per content
 * line (5 on the opening pages), so every synthetic page fills its lines.
 */
function syntheticWordCounts(): number[] {
  const counts = new Array<number>(AYAH_COUNT).fill(2)
  for (let p = 1; p <= PAGE_COUNT; p++) {
    const first = at(PAGE_STARTS, p - 1)
    const last = p < PAGE_COUNT ? at(PAGE_STARTS, p) - 1 : AYAH_COUNT
    let headerLines = 0
    for (let s = 1; s <= SURAH_COUNT; s++) {
      const a = at(SURAH_FIRST_AYAH, s - 1)
      if (a >= first && a <= last) headerLines += hasBasmalaLine(s) ? 2 : 1
    }
    const target = Math.max(0, linesOnPage(p) - headerLines) * (p <= 2 ? 5 : 9)
    let sum = 0
    for (let a = first; a <= last; a++) sum += 0.55 + hash01(a)
    for (let a = first; a <= last; a++) {
      counts[a - 1] = Math.max(2, Math.round((target * (0.55 + hash01(a))) / sum))
    }
  }
  return counts
}

let indexCache: QuranIndex | null = null
const wordTotals = new WeakMap<QuranIndex, number>()

/** The synthetic `QuranIndex` (memoised): real Tanzil metadata, synthetic word ids. */
export function syntheticIndex(): QuranIndex {
  if (indexCache) return indexCache
  const ayahFirstWord: number[] = []
  let next = 1
  for (const count of syntheticWordCounts()) {
    ayahFirstWord.push(next)
    next += count
  }
  const pageFirstWord = PAGE_STARTS.map((a) => at(ayahFirstWord, a - 1))
  const index: QuranIndex = {
    surahs: surahInfos(),
    juz: divisions(JUZ_STARTS),
    hizb: divisions(RUB_STARTS.filter((_, i) => i % 4 === 0)),
    rub: divisions(RUB_STARTS),
    manzil: divisions(MANZIL_STARTS),
    sajdas: SAJDAS.map(([ayahId, kind], i) => ({
      id: i + 1,
      ayahId,
      kind: kind === 1 ? 'obligatory' : 'recommended',
    })),
    layouts: LAYOUTS.map((layout) => ({
      layout,
      pages: PAGE_COUNT,
      linesPerPage: 15,
      pageFirstAyah: [...PAGE_STARTS],
      pageFirstWord: [...pageFirstWord],
    })),
    ayahFirstWord,
  }
  wordTotals.set(index, next - 1)
  indexCache = index
  return index
}

/** Whether an index came from `syntheticIndex()` (as opposed to a fixture `index.json`). */
export function isSyntheticIndex(index: QuranIndex): boolean {
  return wordTotals.has(index)
}

/** The highest word id of an index: synthetic totals are invented, a real index has 83,665 words. */
export function wordTotal(index: QuranIndex): number {
  return wordTotals.get(index) ?? REAL_WORD_COUNT
}

/** The ayah id a word belongs to. */
export function ayahOfWord(index: QuranIndex, wordId: number): number {
  return floorIndex(index.ayahFirstWord, wordId) + 1
}

/** The last word (the end marker) of an ayah. */
export function lastWordOf(index: QuranIndex, ayahId: number): number {
  return ayahId < AYAH_COUNT ? at(index.ayahFirstWord, ayahId) - 1 : wordTotal(index)
}

/** The page of a layout that holds the first word of an ayah. */
export function pageOfAyah(index: QuranIndex, layout: MushafLayout, ayahId: number): number {
  return floorIndex(layoutInfo(index, layout).pageFirstWord, at(index.ayahFirstWord, ayahId - 1)) + 1
}

// ---------------------------------------------------------------------------------------------------------------------
// Pages

function wordText(isEnd: boolean, ayah: number): string {
  return isEnd ? END_OF_AYAH + arabicIndic(ayah) : PLACEHOLDER_WORD
}

/**
 * Splits `total` lines between segments of `sizes` words: each segment gets at least one line and at most one line
 * per word; the rest go, one at a time, to the segment with the most words per line.
 */
function allocateLines(sizes: readonly number[], total: number): number[] {
  const out = sizes.map((n): number => (n > 0 ? 1 : 0))
  let left = total - out.reduce((a, b) => a + b, 0)
  while (left > 0) {
    let best = -1
    let bestRatio = 0
    sizes.forEach((n, i) => {
      const lines = at(out, i)
      if (lines > 0 && lines < n && n / lines > bestRatio) {
        best = i
        bestRatio = n / lines
      }
    })
    if (best < 0) break
    out[best] = at(out, best) + 1
    left--
  }
  return out
}

interface Segment {
  surah: number
  /** The surah starts on this page: its header (and basmala) lines precede the words. */
  header: boolean
  words: PageWord[]
}

/**
 * A synthetic page of any index (synthetic or fixture). The words of the page (from `LayoutInfo.pageFirstWord`) are
 * grouped by surah; surahs starting on the page get a `surah_name` line and, except surahs 1 and 9, a `basmallah` line;
 * the remaining lines are shared between the surah segments and their words spread evenly over them. Every word is a
 * placeholder (`glyph = text`, for every style); end markers carry the real ayah number.
 */
export function syntheticPage(index: QuranIndex, style: MushafStyle, page: number): PageData {
  if (!Number.isInteger(page) || page < 1 || page > PAGE_COUNT) throw new RangeError(`page ${page}`)
  const layout = layoutOf(style)
  const li = layoutInfo(index, layout)
  const w0 = at(li.pageFirstWord, page - 1)
  const w1 = page < PAGE_COUNT ? at(li.pageFirstWord, page) - 1 : wordTotal(index)
  const a0 = ayahOfWord(index, w0)
  const a1 = ayahOfWord(index, w1)

  const segments: Segment[] = []
  for (let a = a0; a <= a1; a++) {
    const { surah, ayah } = refOf(index, a)
    const first = at(index.ayahFirstWord, a - 1)
    const last = lastWordOf(index, a)
    let seg = segments.at(-1)
    if (!seg || seg.surah !== surah) {
      seg = { surah, header: ayah === 1 && first >= w0, words: [] }
      segments.push(seg)
    }
    for (let w = Math.max(first, w0); w <= Math.min(last, w1); w++) {
      const isEnd = w === last
      const text = wordText(isEnd, ayah)
      seg.words.push({ id: w, ayahId: a, surah, ayah, position: w - first + 1, isEnd, glyph: text, text })
    }
  }

  const basmala = (surah: number) => at(index.surahs, surah - 1).bismillahPre
  const headerLines = segments.reduce((n, s) => n + (s.header ? (basmala(s.surah) ? 2 : 1) : 0), 0)
  const budget = Math.max(segments.length, linesOnPage(page) - headerLines)
  const alloc = allocateLines(
    segments.map((s) => s.words.length),
    budget,
  )

  const lines: PageLine[] = []
  const lineOfWord = new Map<number, number>()
  segments.forEach((seg, i) => {
    if (seg.header) {
      lines.push({ line: lines.length + 1, kind: 'surah_name', centered: true, surah: seg.surah, words: [] })
      if (basmala(seg.surah)) {
        lines.push({ line: lines.length + 1, kind: 'basmallah', centered: true, surah: seg.surah, words: [] })
      }
    }
    const count = at(alloc, i)
    const base = Math.floor(seg.words.length / Math.max(1, count))
    const extra = seg.words.length % Math.max(1, count)
    let k = 0
    for (let j = 0; j < count; j++) {
      const take = base + (j < extra ? 1 : 0)
      const words = seg.words.slice(k, k + take)
      k += take
      const line = lines.length + 1
      for (const w of words) lineOfWord.set(w.id, line)
      lines.push({ line, kind: 'ayah', centered: page <= 2, surah: null, words })
    }
  })

  const ayahs: PageAyah[] = []
  for (let a = a0; a <= a1; a++) {
    const { surah, ayah } = refOf(index, a)
    const first = at(index.ayahFirstWord, a - 1)
    const last = lastWordOf(index, a)
    const rub = divisionOf(index.rub, a)
    const rubStart = at(index.rub, rub - 1).firstAyahId === a
    const juz = divisionOf(index.juz, a)
    const juzStart = at(index.juz, juz - 1).firstAyahId === a
    const sajda: SajdaKind | null = index.sajdas.find((s) => s.ayahId === a)?.kind ?? null
    const flags =
      (rubStart ? 1 : 0) |
      (rubStart && (rub - 1) % 4 === 0 ? 2 : 0) |
      (juzStart ? 4 : 0) |
      (ayah === 1 ? 8 : 0)
    const firstOnPage = Math.max(first, w0)
    ayahs.push({
      id: a,
      surah,
      ayah,
      juz,
      hizb: divisionOf(index.hizb, a),
      rub,
      sajda,
      flags,
      firstWordId: firstOnPage,
      lastWordId: Math.min(last, w1),
      startsOnPage: first >= w0,
      endsOnPage: last <= w1,
      line: lineOfWord.get(firstOnPage) ?? 1,
    })
  }

  return {
    layout,
    style,
    page,
    lines,
    ayahs,
    info: {
      firstAyahId: a0,
      lastAyahId: a1,
      juz: divisionOf(index.juz, a0),
      hizb: divisionOf(index.hizb, a0),
      headSurah: refOf(index, a0).surah,
      surahIds: segments.map((s) => s.surah),
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Ayah text and timings

/** `quran_get_ayahs` rows: placeholder words joined by spaces, end marker last, page in `layout`. */
export function syntheticAyahs(
  index: QuranIndex,
  layout: MushafLayout,
  from: number,
  to: number,
): AyahText[] {
  const out: AyahText[] = []
  for (let a = from; a <= to; a++) {
    const { surah, ayah } = refOf(index, a)
    const first = at(index.ayahFirstWord, a - 1)
    const last = lastWordOf(index, a)
    const words: string[] = []
    for (let w = first; w <= last; w++) words.push(wordText(w === last, ayah))
    const rub = divisionOf(index.rub, a)
    const juz = divisionOf(index.juz, a)
    out.push({
      id: a,
      surah,
      ayah,
      juz,
      hizb: divisionOf(index.hizb, a),
      rub,
      sajda: index.sajdas.find((s) => s.ayahId === a)?.kind ?? null,
      flags:
        (at(index.rub, rub - 1).firstAyahId === a ? 1 : 0) |
        (at(index.rub, rub - 1).firstAyahId === a && (rub - 1) % 4 === 0 ? 2 : 0) |
        (at(index.juz, juz - 1).firstAyahId === a ? 4 : 0) |
        (ayah === 1 ? 8 : 0),
      page: pageOfAyah(index, layout, a),
      textHafs: words.join(' '),
    })
  }
  return out
}

/**
 * Synthetic word-level timings (§4.6): each ayah lasts `1200 ms + 380 ms × (non-end words)`, its words split that time
 * evenly, and ayahs follow each other without gaps.
 */
export function syntheticTimings(index: QuranIndex, reciterId: number, surah: number): SurahTimings {
  const info = at(index.surahs, surah - 1)
  let t = 0
  const ayahs = []
  for (let k = 1; k <= info.ayahCount; k++) {
    const a = info.firstAyahId + k - 1
    const words = lastWordOf(index, a) - at(index.ayahFirstWord, a - 1)
    const duration = 1200 + 380 * words
    const wordTimings = []
    for (let i = 0; i < words; i++) {
      wordTimings.push({
        pos: i + 1,
        startMs: t + Math.round((i * duration) / words),
        endMs: t + Math.round(((i + 1) * duration) / words),
      })
    }
    ayahs.push({ ayah: k, fromMs: t, toMs: t + duration, words: wordTimings })
    t += duration
  }
  return { reciterId, surah, durationMs: t, wordLevel: true, ayahs }
}

// ---------------------------------------------------------------------------------------------------------------------
// Pack catalogue and reciters (shape of the §2.5.4 seed; sizes are estimates)

const l10n = (en: string, ar: string): L10nText => ({ en, ar })
const kib = (megabytes: number) => Math.round((megabytes * 1_000_000) / 1024)

const ATTRIBUTION = {
  qfFonts: {
    text: l10n(
      'Quran fonts provided by Quran Foundation (© KFGQPC)',
      'خطوط المصحف مقدمة من Quran Foundation (© مجمع الملك فهد)',
    ),
    url: 'https://quran.foundation',
    licence: 'Quran Foundation terms of use',
  },
  quranEnc: {
    text: l10n('QuranEnc.com, the Noble Quran Encyclopedia', 'موسوعة القرآن الكريم QuranEnc.com'),
    url: 'https://quranenc.com',
    licence: 'QuranEnc terms of use',
  },
  quranCom: {
    text: l10n('Quran.com by Quran Foundation', 'Quran.com من Quran Foundation'),
    url: 'https://quran.com',
    licence: 'Quran Foundation terms of use',
  },
  quranicAudio: {
    text: l10n(
      'QuranicAudio.com; timings by Quran Foundation',
      'QuranicAudio.com؛ التوقيتات من Quran Foundation',
    ),
    url: 'https://quranicaudio.com',
    licence: 'Personal use',
  },
} as const

interface PackSeed {
  id: string
  kind: PackKind
  title: L10nText
  description: L10nText
  language?: string
  direction?: TextDir
  version?: string
  onDemand?: boolean
  requires?: string[]
  megabytes: number
  items: number
  recommended?: boolean
  revalidateDays?: number
  attribution: PackInfo['attribution']
}

function pack(seed: PackSeed): PackInfo {
  return {
    id: seed.id,
    kind: seed.kind,
    title: seed.title,
    description: seed.description,
    language: seed.language ?? null,
    direction: seed.direction ?? null,
    version: seed.version ?? '2026.10',
    installMode: seed.onDemand ? 'on_demand' : 'whole',
    requires: seed.requires ?? [],
    sizeKib: kib(seed.megabytes),
    itemCount: seed.items,
    recommended: seed.recommended ?? false,
    revalidateDays: seed.revalidateDays ?? null,
    attribution: { ...seed.attribution },
    state: { type: 'not_installed' },
    installedKib: 0,
    job: null,
  }
}

/** Reciters of the seed catalogue: QDC id, names, optional style, and the estimated full download in GB. */
const RECITERS: readonly { id: number; name: L10nText; style?: L10nText; gigabytes: number }[] = [
  { id: 7, name: l10n('Mishary Rashid Alafasy', 'مشاري راشد العفاسي'), gigabytes: 1.7 },
  {
    id: 2,
    name: l10n('AbdulBaset AbdulSamad', 'عبد الباسط عبد الصمد'),
    style: l10n('Murattal', 'مرتّل'),
    gigabytes: 2.1,
  },
  {
    id: 1,
    name: l10n('AbdulBaset AbdulSamad', 'عبد الباسط عبد الصمد'),
    style: l10n('Mujawwad', 'مجوّد'),
    gigabytes: 3.5,
  },
  { id: 6, name: l10n('Mahmoud Khalil Al-Husary', 'محمود خليل الحصري'), gigabytes: 1.4 },
  {
    id: 12,
    name: l10n('Mahmoud Khalil Al-Husary', 'محمود خليل الحصري'),
    style: l10n('Muallim', 'المعلّم'),
    gigabytes: 2.8,
  },
  {
    id: 9,
    name: l10n('Mohamed Siddiq al-Minshawi', 'محمد صديق المنشاوي'),
    style: l10n('Murattal', 'مرتّل'),
    gigabytes: 1.6,
  },
  {
    id: 168,
    name: l10n('Mohamed Siddiq al-Minshawi', 'محمد صديق المنشاوي'),
    style: l10n('With children', 'مع ترديد الأطفال'),
    gigabytes: 3.2,
  },
  { id: 3, name: l10n('Abdur-Rahman as-Sudais', 'عبد الرحمن السديس'), gigabytes: 1.1 },
  { id: 10, name: l10n("Sa'ud ash-Shuraym", 'سعود الشريم'), gigabytes: 1.05 },
  { id: 4, name: l10n('Abu Bakr al-Shatri', 'أبو بكر الشاطري'), gigabytes: 1.3 },
  { id: 5, name: l10n('Hani ar-Rifai', 'هاني الرفاعي'), gigabytes: 1.6 },
  { id: 97, name: l10n('Yasser Ad-Dossari', 'ياسر الدوسري'), gigabytes: 1.2 },
  { id: 161, name: l10n('Khalifa Al-Tunaiji', 'خليفة الطنيجي'), gigabytes: 1.3 },
]

const TRANSLATIONS: readonly [string, string, string, string, TextDir, number][] = [
  // id, lang, English title, Arabic title, direction, MB
  ['tr.en.saheeh', 'en', 'Saheeh International', 'صحيح إنترناشونال', 'ltr', 0.52],
  ['tr.en.rwwad', 'en', 'Rowwad Translation Center', 'مركز رواد الترجمة', 'ltr', 0.61],
  ['tr.en.hilali_khan', 'en', 'Hilali and Khan', 'الهلالي وخان', 'ltr', 0.83],
  ['tr.ur.junagarhi', 'ur', 'Muhammad Junagarhi', 'محمد جوناكري', 'rtl', 0.92],
  [
    'tr.id.affairs',
    'id',
    'Indonesian Ministry of Religious Affairs',
    'وزارة الشؤون الدينية الإندونيسية',
    'ltr',
    0.88,
  ],
  ['tr.tr.rwwad', 'tr', 'Rowwad Translation Center (Turkish)', 'مركز رواد الترجمة (التركية)', 'ltr', 0.71],
  ['tr.fr.rashid', 'fr', 'Rashid Maash', 'رشيد معاش', 'ltr', 0.66],
  ['tr.es.garcia', 'es', 'Isa Garcia', 'عيسى غارسيا', 'ltr', 0.69],
  ['tr.de.bubenheim', 'de', 'Bubenheim and Elyas', 'بوبنهايم وإلياس', 'ltr', 0.64],
  ['tr.bn.zakaria', 'bn', 'Abu Bakr Zakaria', 'أبو بكر زكريا', 'ltr', 4.18],
  ['tr.ru.rwwad', 'ru', 'Rowwad Translation Center (Russian)', 'مركز رواد الترجمة (الروسية)', 'ltr', 0.58],
  ['tr.fa.ih', 'fa', 'IslamHouse (Persian)', 'دار الإسلام (الفارسية)', 'rtl', 0.73],
  ['tr.hi.omari', 'hi', 'Azizul Haq al-Umari', 'عزيز الحق العمري', 'ltr', 1.12],
]

const WBW_LANGUAGES: readonly [string, string, string][] = [
  ['en', 'English', 'الإنجليزية'],
  ['ur', 'Urdu', 'الأردية'],
  ['id', 'Indonesian', 'الإندونيسية'],
  ['bn', 'Bengali', 'البنغالية'],
  ['tr', 'Turkish', 'التركية'],
  ['fa', 'Persian', 'الفارسية'],
  ['hi', 'Hindi', 'الهندية'],
  ['ta', 'Tamil', 'التاميلية'],
]

/** The synthetic pack catalogue: every pack of the §2.5.4 seed, all `not_installed`. */
export function syntheticPacks(): PackInfo[] {
  const mushaf = (v: 'v2' | 'v1' | 'v4', en: string, ar: string, megabytes: number, recommended = false) =>
    pack({
      id: `mushaf.${v}`,
      kind: 'mushaf_fonts',
      title: l10n(en, ar),
      description: l10n('Page fonts download as you read.', 'تُنزَّل خطوط الصفحات أثناء القراءة.'),
      onDemand: true,
      requires: ['decor'],
      megabytes,
      items: PAGE_COUNT,
      recommended,
      attribution: ATTRIBUTION.qfFonts,
    })
  return [
    mushaf('v2', 'Madani Mushaf (1421H print)', 'مصحف المدينة (طبعة ١٤٢١هـ)', 93.2, true),
    mushaf('v1', 'Madani Mushaf (1405H print)', 'مصحف المدينة (طبعة ١٤٠٥هـ)', 45.7),
    mushaf('v4', 'Tajweed Mushaf', 'مصحف التجويد', 48.5),
    pack({
      id: 'decor',
      kind: 'decor',
      title: l10n('Ornate surah headers', 'زخارف عناوين السور'),
      description: l10n(
        'Surah header, basmala and surah-name fonts.',
        'خطوط عناوين السور والبسملة وأسماء السور.',
      ),
      megabytes: 0.33,
      items: 3,
      recommended: true,
      attribution: ATTRIBUTION.qfFonts,
    }),
    ...TRANSLATIONS.map(([id, language, en, ar, direction, megabytes]) =>
      pack({
        id,
        kind: 'translation',
        title: l10n(en, ar),
        description: l10n('Translation of the meanings', 'ترجمة معاني القرآن الكريم'),
        language,
        direction,
        version: id === 'tr.en.saheeh' ? '1.1.2' : '2026.10',
        megabytes,
        items: 1,
        recommended: id === 'tr.en.saheeh',
        attribution: ATTRIBUTION.quranEnc,
      }),
    ),
    pack({
      id: 'tafsir.ar.muyassar',
      kind: 'tafsir',
      title: l10n('Al-Muyassar', 'التفسير الميسر'),
      description: l10n('A concise Arabic tafsir', 'تفسير عربي موجز'),
      language: 'ar',
      direction: 'rtl',
      megabytes: 0.81,
      items: 1,
      recommended: true,
      attribution: ATTRIBUTION.quranEnc,
    }),
    ...(
      [
        ['tafsir.en.ibn_kathir', 'en', 'ltr', 'Ibn Kathir (abridged)', 'ابن كثير (مختصر)', 38],
        ['tafsir.en.maarif', 'en', 'ltr', "Ma'arif al-Qur'an", 'معارف القرآن', 52],
        ['tafsir.ar.saadi', 'ar', 'rtl', "As-Sa'di", 'تفسير السعدي', 21],
      ] as const
    ).map(([id, language, direction, en, ar, megabytes]) =>
      pack({
        id,
        kind: 'tafsir',
        title: l10n(en, ar),
        description: l10n('Tafsir, downloaded by chapter', 'تفسير يُنزَّل حسب السورة'),
        language,
        direction,
        onDemand: true,
        megabytes,
        items: SURAH_COUNT,
        revalidateDays: 7,
        attribution: ATTRIBUTION.quranCom,
      }),
    ),
    ...RECITERS.map((r) =>
      pack({
        id: `audio.qdc.${r.id}`,
        kind: 'recitation',
        title: r.name,
        description: r.style ?? l10n('Murattal', 'مرتّل'),
        language: 'ar',
        onDemand: true,
        megabytes: r.gigabytes * 1000,
        items: SURAH_COUNT,
        recommended: r.id === 7,
        revalidateDays: 7,
        attribution: ATTRIBUTION.quranicAudio,
      }),
    ),
    ...WBW_LANGUAGES.map(([language, en, ar]) =>
      pack({
        id: `wbw.${language}`,
        kind: 'wbw',
        title: l10n(`Word by word: ${en}`, `كلمة بكلمة: ${ar}`),
        description: l10n('Word translations and transliteration', 'ترجمة الكلمات ونطقها'),
        language,
        onDemand: true,
        megabytes: 6.5,
        items: SURAH_COUNT,
        recommended: language === 'en',
        revalidateDays: 7,
        attribution: ATTRIBUTION.quranCom,
      }),
    ),
  ]
}

/** Reciters derived from the recitation packs of any catalogue (fixture or synthetic). */
export function recitersFromPacks(packs: readonly PackInfo[]): ReciterInfo[] {
  const out: ReciterInfo[] = []
  for (const p of packs) {
    if (p.kind !== 'recitation') continue
    const id = Number(/^audio\.qdc\.(\d+)$/.exec(p.id)?.[1])
    if (!Number.isInteger(id)) continue
    const seed = RECITERS.find((r) => r.id === id)
    out.push({
      id,
      packId: p.id,
      name: seed?.name ?? p.title,
      style: seed?.style ?? null,
      wordLevel: true,
      sizeKib: p.sizeKib,
      downloadedSurahs: 0,
      cachedSurahs: 0,
    })
  }
  return out
}
