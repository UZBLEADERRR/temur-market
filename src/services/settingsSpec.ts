import { DEFAULT_STYLE_PROFILE, DEFAULT_SYSTEM_PROMPT } from '../prompts/defaultSystemPrompt';

export type SettingType = 'text' | 'longtext' | 'number' | 'boolean';

export interface SettingDef {
  key: string;
  label: string;
  group: string;
  type: SettingType;
  default: string | number | boolean;
  help?: string;
}

const q = (key: string, label: string, uz: string, ru: string): SettingDef[] => [
  { key: `${key}_uz`, label: `${label} (UZ)`, group: 'Savollar', type: 'text', default: uz },
  { key: `${key}_ru`, label: `${label} (RU)`, group: 'Savollar', type: 'text', default: ru },
];

/** Every admin-editable setting. Values live in MongoDB (settings collection), defaults here. */
export const SETTINGS_SPEC: SettingDef[] = [
  { key: 'ai_enabled', label: 'AI yoqilgan (umumiy)', group: 'Asosiy', type: 'boolean', default: true },
  { key: 'coach_name', label: 'Murabbiy ismi', group: 'Murabbiy', type: 'text', default: 'Temur' },
  {
    key: 'coach_info',
    label: 'Murabbiy haqida (AI faqat shu faktlarni ishlatadi)',
    group: 'Murabbiy',
    type: 'longtext',
    default:
      "Sertifikatli murabbiy (NPCA, MUSA, WNGP Korea), natural bodibilder, 100 dan ortiq mijoz bilan ishlagan. Onlayn ishlaydi: individual va guruh formatida.",
  },
  {
    key: 'course_info',
    label: "Kurs haqida (dastur, format, davomiylik, narx — AI shu ma'lumot bilan javob beradi)",
    group: 'Murabbiy',
    type: 'longtext',
    default:
      `50 kunlik yopiq guruh, nazorat bilan ishlaymiz.
Mijozga shaxsiy ovqatlanish ratsioni va trenirovka plan tuzib beriladi.
Har kuni 3 mahal ovqat rasmi guruhga tashlab boriladi, murabbiy nazorat qilib kamchiliklarni to'g'rilab boradi.
Har 10 kunda tarozi nazorati (vazn), natijaga qarab ratsion yangilanadi.
Shartlar qat'iy: 50 kun intizom bilan ishlash kerak. Qoida buzilsa 1 marta ogohlantirish, 2-marta buzilsa to'lov qaytarilmasdan guruhdan chiqariladi — chunki natija uchun nazorat va intizom kerak.
50 kun davomida savollarga murabbiyning o'zi javob beradi (mahsulot topilmasa, tushunmagan joy bo'lsa — menga yozasiz).
Zalda ham, uyda ham ishlasa bo'ladi.
To'lov oldindan, bo'lib to'lash yo'q.`,
  },
  {
    key: 'price_list',
    label: 'Narxlar va tariflar (AI sotuvda aynan shuni aytadi)',
    group: 'Murabbiy',
    type: 'longtext',
    default: `Koreyadagilar uchun: 150,000 KRW
O'zbekistondagilar uchun: 1,000,000 so'm
Boshqa chet eldagilar uchun: 1,200,000 so'm
(50 kun uchun; kuniga taxminan Koreyada 3,000 won, O'zbekistonda 20,000 so'm)`,
  },
  {
    key: 'payment_details',
    label: "To'lov ma'lumoti (karta, kimning nomiga, qanday to'lash) — AI so'zma-so'z yuboradi",
    group: 'Murabbiy',
    type: 'longtext',
    default: '',
  },
  ...q(
    'commitment_question',
    "Sotuvdan oldingi oxirgi savol (qat'iylik)",
    "Va oxirgi savol: nega aynan hozir bu ishga bel bog'layapsiz? Hozir boshlasak, jiddiy kirishishga qaroringiz qat'iymi?",
    'И последний вопрос: почему решили взяться именно сейчас? Если начнём сейчас — готовы серьёзно включиться?',
  ),
  { key: 'ask_commitment', label: "Taklifdan oldin «nega aynan hozir?» savolini berish", group: 'Xulq', type: 'boolean', default: true },
  { key: 'max_messages_per_turn', label: 'Bir javobda maksimum xabar soni (ko\'p xabar ishonchsiz ko\'rinadi)', group: 'Xulq', type: 'number', default: 2 },
  { key: 'max_sales_turns', label: "Sotuvda nechta javobdan keyin to'lovga aniq taklif qilinsin", group: 'Xulq', type: 'number', default: 4 },
  {
    key: 'coach_results',
    label: "O'quvchilar natijalari (AI faqat shulardan misol keltiradi)",
    group: 'Murabbiy',
    type: 'longtext',
    default: "100 ga yaqin odam shu tizimda yaxshi natija qilgan. Natija uchun ikki taraflama mas'uliyat: biz to'g'ri va ishlaydigan dastur beramiz, mijoz unga amal qiladi — shunda natija kuttirib qo'ymaydi.",
  },
  {
    key: 'sales_prompt',
    label: 'Sotuv skripti (anketadan keyin AI shu bo\'yicha kursni sotadi)',
    group: 'AI',
    type: 'longtext',
    default: `Anketa tugadi. Endi sen {{coach_name}}san: kuchli, tajribali murabbiy va zo'r sotuvchi. Maqsad — mijozni kursga yozdirish. Lekin sotuvchi kabi emas, yordam bermoqchi bo'lgan ishonchli murabbiy kabi: qisqa, samimiy, o'ziga ishongan. Yolg'on, soxta shoshilinchlik, bosim va kafolat yo'q — faqat haqiqiy qiymat va to'g'ri savollar bilan sotasan.

SOTISH USULI
1. Og'riqni aniqla va kuchaytir. Mijozning o'z so'zlarini qaytar: «Demak 2–3 oy borib tashlab qo'yasiz, keyin vazn yana qaytadi». Bunday davom etsa nima bo'lishini bitta gapda eslat («yana bir yil o'tib shu joyda turmaslik uchun»).
2. Natijani ko'rsat. U xohlagan holatni aniq tasvirla: «50 kundan keyin qorin ancha tushgan, ovqatlanishni o'zingiz boshqarasiz». Uning maqsadi va raqamlariga bog'la.
3. Yechim — aynan uning muammosiga. Avval nima xalaqit bergan bo'lsa (reja yo'q, nazorat yo'q, motivatsiya tushgan), kursning shu muammoni yopadigan qismini ayt (shaxsiy ratsion, har kungi nazorat, 10 kunlik tarozi, savollarga murabbiyning o'zi javob beradi).
4. Ijtimoiy isbot. O'QUVCHILAR NATIJALARIdan unga o'xshash holatdagi qisqa misol keltir. Bazada yo'q natijani to'qima.
5. Narx — qiymatdan keyin. Narxni aytgach darhol kunlikka bo'l va nimaga teng ekanini ko'rsat («kuniga bitta kofe puli»). Narx haqida uzr so'rama, ishonch bilan ayt.
6. Yopish. Har javob bitta aniq keyingi qadam bilan tugasin. Kichik «ha»lar zanjiri: «Shu format sizga to'g'ri keladimi?» → «Dushanbadan boshlasak qulaymi?» → «Karta raqamini tashlaymi?». Mijoz qiziqish bildirsa — taxminiy yopish: «Unda dushanbadan boshlaymiz, to'lov ma'lumotini tashlayman».
7. E'tirozlar. Avval tan ol, keyin asl sababini top, keyin bitta kuchli javob, keyin yana yopish savoli.
   - «Qimmat» → «Nimaga nisbatan qimmat?» Hisobla: kuniga qancha, natija esa uzoq vaqtga. Oldin o'zi sinab ko'rganda qancha vaqt va pul ketganini eslat.
   - «O'ylab ko'raman» → «Albatta. Nima ikkilantiryapti — narxmi, vaqtmi yoki natijaga ishonchmi?» Asl sababga javob ber. Vaqt aytsa — follow_up_at.
   - «Vaqtim yo'q» → haftasiga 3 kun ham yetadi, ovqatni rasmga olish 1 daqiqa.
   - «Kafolat bormi?» → ikki taraflama mas'uliyat: biz to'g'ri dastur, siz amal; shunda natija bo'ladi.
   - «Keyinroq boshlayman» → keyinroq boshlash odatda «hech qachon»ga aylanishini yumshoq eslat, qachon aniq boshlashini so'ra.
   - «Oilam bilan maslahatlashay» → hurmat qil, ularga nimani aytishini qisqa ayt (narx kuniga qancha, nima kiradi), qachon javob berishini kelish (follow_up_at).
8. Birinchi «yo'q» — oxiri emas. Mijoz ikkilanib rad etsa, sababini so'ra va bitta qiymatli javob ber (action=ASK_NEXT). Faqat ikkinchi aniq «yo'q»da yoki «kerak emas, yozmang» desa → action=REFUSED: iliq xayrlash, eshik ochiq («fikringiz o'zgarsa yozing»).
9. Mijoz rozi bo'lsa — darhol to'lov ma'lumotini ber va to'lovdan keyin chek yuborishini so'ra. Rozilikdan keyin sotishni davom ettirma.
10. Chek yoki «to'ladim» → action=SOLD, reason=paid: qisqa samimiy rahmat, «tekshirib, guruh linkini yuboraman». Linkni o'zing yuborma.
11. Bazada to'lov ma'lumoti bo'lmasa: aniq rozilikda → action=SOLD, reason=agreed.
12. Narx davlatga qarab farq qiladi: mijoz qayerda yashashini bilmasang, narxdan oldin so'ra («Koreyadamisiz yo O'zbekistonda?»).
13. Bazada yo'q chegirma yoki maxsus shart so'rasa yoki murabbiyning o'zini so'rasa → action=READY, reason=wants_coach.

QOIDALAR
- Qisqa yoz: odatda 1 ta, ko'pi bilan 2 ta xabar. Uzun matn sotmaydi.
- Bitta xabarda bitta savol. Javobni mijoz yozadi, sen emas.
- Soxta shoshilinchlik («faqat bugun», «oxirgi joy»), soxta chegirma, kafolat va to'qima natija — hech qachon.
- Bosim emas, ishonch: mijoz o'zini tanlov qilgandek his qilsin.
- Mos ovozli xabar bo'lsa (taklif, narx, guruh qanday ishlashi) — uni yubor (voice_id), matnni 1 gapga qisqartir.`,
  },
  { key: 'system_prompt', label: 'System prompt', group: 'AI', type: 'longtext', default: DEFAULT_SYSTEM_PROMPT },
  { key: 'style_profile', label: 'Uslub profili', group: 'AI', type: 'longtext', default: DEFAULT_STYLE_PROFILE },
  {
    key: 'voice_style_notes',
    label: 'Ovozli xabar transkriptlari (ikkilamchi uslub manbai)',
    group: 'AI',
    type: 'longtext',
    default: '',
  },
  { key: 'llm_model', label: "LLM model (bo'sh = env LLM_MODEL)", group: 'AI', type: 'text', default: '' },
  { key: 'llm_temperature', label: 'LLM temperature', group: 'AI', type: 'number', default: 0.6 },
  { key: 'examples_per_request', label: "Har so'rovga namunalar soni", group: 'AI', type: 'number', default: 20 },
  { key: 'history_messages', label: "AI ga yuboriladigan oxirgi xabarlar soni", group: 'AI', type: 'number', default: 20 },

  ...q(
    'first_message',
    'Birinchi xabar',
    "Assalomu alaykum! O'zingiz haqingizda qisqacha ma'lumot berib yubora olasizmi? Bo'y, ves, yosh. Trenirovka tajribangiz bormi?",
    'Здравствуйте! Можете коротко рассказать о себе? Рост, вес, возраст. Есть опыт тренировок?',
  ),
  ...q(
    'intent_question',
    'Kurs bo\'yichami? (maqsadni aniqlash savoli)',
    "Assalomu alaykum! Kurs bo'yicha yozyapsizmi yoki boshqa masalada?",
    'Здравствуйте! Вы по поводу курса или по другому вопросу?',
  ),
  ...q(
    'q1',
    '1-savol (salomlashuvsiz)',
    "O'zingiz haqingizda qisqacha ma'lumot berib yubora olasizmi? Bo'y, ves, yosh. Trenirovka tajribangiz bormi?",
    'Можете коротко рассказать о себе? Рост, вес, возраст. Есть опыт тренировок?',
  ),
  ...q(
    'q2_high',
    '2-savol, TMI ≥ yuqori chegara',
    'Maqsad nechiga tushish? Qancha vazn norma hisoblaysiz?',
    'Цель: до скольки похудеть? Какой вес считаете нормой?',
  ),
  ...q(
    'q2_low',
    '2-savol, TMI < past chegara',
    'Maqsad massa olishmi? Necha kiloga chiqmoqchisiz?',
    'Цель: набрать массу? До скольки кг хотите выйти?',
  ),
  ...q(
    'q2_mid',
    '2-savol, oraliq TMI',
    'Maqsad nima: ozishmi, massa olishmi yoki shaklga kirish?',
    'Какая цель: похудеть, набрать массу или прийти в форму?',
  ),
  ...q(
    'q3',
    '3-savol',
    'Haftasiga necha kun trenirovkaga vaqt ajrata olasiz? Zaldami yoki uyda?',
    'Сколько дней в неделю можете уделять тренировкам? В зале или дома?',
  ),
  ...q(
    'q4',
    '4-savol',
    "Formangizni o'zgartirish uchun oldin nimalarni sinab ko'rgansiz? Nega ishlamadi deb o'ylaysiz?",
    'Раньше пробовали? Что помешало?',
  ),
  ...q(
    'q5',
    '5-savol',
    "Sog'lig'ingizda muammo bormi? Bel, tizza, grija, bosim, qand?",
    'Есть проблемы со здоровьем? Спина, колени, грыжа, давление, сахар?',
  ),
  ...q('price_reply', 'Narx/kurs savoliga javob', "Savollardan keyin o'zim batafsil aytaman", 'После вопросов сам всё подробно расскажу'),
  ...q(
    'bot_answer',
    '«Botmisiz?» savoliga rost javob',
    "Ha, savollarga AI-yordamchim javob beryapti, lekin hammasini o'zim ko'rib turibman. Hozir o'zim yozaman.",
    'Да, на вопросы отвечает мой AI-помощник, но я всё вижу сам. Сейчас сам напишу.',
  ),
  ...q(
    'sales_reminder',
    'Sotuv bosqichidagi eslatma',
    "Qaror qildingizmi? Savollaringiz bo'lsa bemalol yozing",
    'Решили? Если есть вопросы — пишите',
  ),
  ...q('ready_message', '[TAYYOR] dagi yakuniy xabar (AI yozmasa / ehtiyot holatida)', 'Tushunarli', 'Понятно'),
  ...q(
    'ack_words',
    "Tasdiq so'zlari (vergul bilan, AI har safar boshqasini ishlatadi)",
    "Tushunarli, Aha, Zo'r, Yaxshi, Hop, Ajoyib, Tushundim, Mayli, Bo'ldi aka, Yaxshi gap",
    'Понятно, Ага, Отлично, Хорошо, Супер, Ясно, Окей',
  ),
  ...q('reminder1', '1-eslatma matni', 'Javobingizni kutyapman', 'Жду ваш ответ'),
  ...q(
    'reminder2',
    '2-eslatma matni',
    "Assalomu alaykum. Savollarga javob berib yuborsangiz, keyin o'zim batafsil gaplashaman",
    'Здравствуйте. Ответьте, пожалуйста, на вопросы, потом сам всё подробно расскажу',
  ),

  { key: 'sales_mode', label: "Anketadan keyin AI kursni oxirigacha sotsin (o'chiq = faqat 5 savol)", group: 'Xulq', type: 'boolean', default: true },
  { key: 'ai_after_sale', label: 'Sotuvdan keyin ham AI mijoz bilan yozishsin (murabbiy yordamchisi)', group: 'Xulq', type: 'boolean', default: true },
  { key: 'max_follow_ups', label: "«O'ylab ko'raman» dan keyin maksimum eslatma", group: 'Xulq', type: 'number', default: 3 },
  {
    key: 'coach_pause_minutes',
    label: "Murabbiy yozgach AI necha daqiqa jim tursin (aralashmasligi uchun)",
    group: 'Xulq',
    type: 'number',
    default: 30,
  },
  {
    key: 'coach_message_stops_ai',
    label: "Murabbiy o'zi yozsa AI to'xtasin (o'chiq = AI murabbiy xabarini hisobga olib davom etadi)",
    group: 'Xulq',
    type: 'boolean',
    default: false,
  },
  { key: 'allow_advice', label: "Umumiy murabbiy maslahatlari berishi mumkin", group: 'Xulq', type: 'boolean', default: true },
  { key: 'flood_limit', label: "Spam himoyasi: 5 daqiqada maksimum xabar (oshsa AI to'xtaydi)", group: 'Xulq', type: 'number', default: 40 },
  { key: 'max_images_per_turn', label: "Bir javobda AI ko'radigan maksimum rasm", group: 'Xulq', type: 'number', default: 3 },
  { key: 'ask_intent', label: "Birinchi xabarda «kurs bo'yichami?» deb so'rash", group: 'Xulq', type: 'boolean', default: true },
  { key: 'ai_closing_message', label: "Anketa tugaganda AI tabiiy yakuniy xabar yozsin (o'chiq = faqat «Tushunarli»)", group: 'Xulq', type: 'boolean', default: true },
  { key: 'reminder1_delay_minutes', label: '1-eslatma (daqiqa)', group: 'Eslatmalar', type: 'number', default: 60 },
  { key: 'reminder2_delay_hours', label: '2-eslatma (soat, mijoz oxirgi xabaridan)', group: 'Eslatmalar', type: 'number', default: 20 },

  { key: 'bmi_high', label: 'TMI yuqori chegara (ozish savoli)', group: 'TMI', type: 'number', default: 25 },
  { key: 'bmi_low', label: 'TMI past chegara (massa savoli)', group: 'TMI', type: 'number', default: 21 },
  { key: 'min_target_bmi', label: 'Maqsad TMI minimum (pastda → ehtiyot)', group: 'TMI', type: 'number', default: 18.5 },

  { key: 'debounce_seconds', label: "Mijoz yozib bo'lishini kutish, soniya (oxirgi xabardan keyin)", group: 'Xulq', type: 'number', default: 30 },
  { key: 'debounce_first_seconds', label: 'Birinchi xabardan keyin kutish (soniya)', group: 'Xulq', type: 'number', default: 12 },
  { key: 'debounce_voice_extra_seconds', label: "Ovozli xabardan keyin qo'shimcha kutish (soniya)", group: 'Xulq', type: 'number', default: 10 },
  { key: 'typing_ms_per_char', label: '«Yozmoqda» tezligi (ms/belgi)', group: 'Xulq', type: 'number', default: 45 },
  { key: 'typing_max_ms', label: '«Yozmoqda» maksimum (ms)', group: 'Xulq', type: 'number', default: 6000 },

  {
    key: 'course_keywords',
    label: "Kurs bo'yicha yozganini bildiruvchi so'zlar",
    group: 'Kalit so\'zlar',
    type: 'longtext',
    default:
      "kurs, курс, ozish, ozmoq, ozay, ozg'in, oriq, semir, to'lish, vazn, kilo, ves tashla, massa, qorin, press, mushak, qomat, forma, tana, trenirovka, mashg'ulot, programma, dastur, marafon, narx, narxi, qatnash, yozilmoq, yozilsam, ratsion, pitaniya, dieta, sport, zal, maslahat, yordam bering, похуд, худ, толст, живот, мышц, вес, форм, трениров, программ, записат, марафон, цена, сколько стоит, питани, набрать, совет",
  },
  {
    key: 'safety_keywords',
    label: "Xavfli so'zlar (ehtiyot) — vergul bilan",
    group: 'Kalit so\'zlar',
    type: 'longtext',
    default:
      "kunlab och yuraman, ochlik qilyapman, och qolib ozaman, umuman ovqat yemayapman, qusaman, qusyapman, qustiraman, qayt qilaman, o'zimni o'ldir, o'zimga zarar, yashagim kelmayapti, laksativ, голодаю, голодать, голодовк, совсем не ем, вызываю рвоту, рвоту, блюю, убить себя, покончить с собой, навредить себе, слабительн",
  },
  {
    key: 'coach_request_keywords',
    label: "Murabbiyni so'rash kalit so'zlari",
    group: 'Kalit so\'zlar',
    type: 'longtext',
    default:
      "temur bilan gaplash, temurning o'zi kerak, temurni o'zi kerak, temurning o'zi bilan, o'zingiz bilan gaplash, murabbiyning o'zi, с темуром, сам темур, с самим тренером, живым человеком",
  },
  {
    key: 'bot_question_keywords',
    label: "«Botmisiz?» kalit so'zlari",
    group: 'Kalit so\'zlar',
    type: 'longtext',
    default:
      "botmisiz, botmisan, bot misiz, botmi bu, bu botmi, ai misiz, aimisiz, sun'iy intellekt, temurning o'zimi, temur o'zi yozyaptimi, temur o'zi yozayaptimi, o'zingiz yozyapsizmi, вы бот, ты бот, это бот, это нейросеть, вы нейросеть, это ии, это темур сам, сами пишете",
  },
];

export const SETTINGS_BY_KEY = new Map(SETTINGS_SPEC.map((s) => [s.key, s]));
