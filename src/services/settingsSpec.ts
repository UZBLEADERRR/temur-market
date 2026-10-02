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
    'q2_high',
    '2-savol, TMI ≥ yuqori chegara',
    'Tushunarli. Maqsad nechiga tushish? Qancha vazn norma hisoblaysiz?',
    'Понятно. Цель — до скольки похудеть? Какой вес считаете нормой?',
  ),
  ...q(
    'q2_low',
    '2-savol, TMI < past chegara',
    'Tushunarli. Maqsad massa olishmi? Necha kiloga chiqmoqchisiz?',
    'Понятно. Цель — набрать массу? До скольки кг хотите выйти?',
  ),
  ...q(
    'q2_mid',
    '2-savol, oraliq TMI',
    'Tushunarli. Maqsad nima: ozishmi, massa olishmi yoki shaklga kirish?',
    'Понятно. Какая цель: похудеть, набрать массу или прийти в форму?',
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
    "Oldin harakat qilib ko'rganmisiz? Nima xalaqit bergan?",
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
  ...q('ready_message', '[TAYYOR] dagi yakuniy xabar', 'Tushunarli', 'Понятно'),
  ...q('reminder1', '1-eslatma matni', 'Javobingizni kutyapman', 'Жду ваш ответ'),
  ...q(
    'reminder2',
    '2-eslatma matni',
    "Assalomu alaykum. Savollarga javob berib yuborsangiz, keyin o'zim batafsil gaplashaman",
    'Здравствуйте. Ответьте, пожалуйста, на вопросы, потом сам всё подробно расскажу',
  ),

  { key: 'reminder1_delay_minutes', label: '1-eslatma (daqiqa)', group: 'Eslatmalar', type: 'number', default: 60 },
  { key: 'reminder2_delay_hours', label: '2-eslatma (soat, mijoz oxirgi xabaridan)', group: 'Eslatmalar', type: 'number', default: 20 },

  { key: 'bmi_high', label: 'TMI yuqori chegara (ozish savoli)', group: 'TMI', type: 'number', default: 25 },
  { key: 'bmi_low', label: 'TMI past chegara (massa savoli)', group: 'TMI', type: 'number', default: 21 },
  { key: 'min_target_bmi', label: 'Maqsad TMI minimum (pastda → ehtiyot)', group: 'TMI', type: 'number', default: 18.5 },

  { key: 'debounce_seconds', label: "Ketma-ket xabarlarni yig'ish (soniya)", group: 'Xulq', type: 'number', default: 6 },
  { key: 'typing_ms_per_char', label: '«Yozmoqda» tezligi (ms/belgi)', group: 'Xulq', type: 'number', default: 45 },
  { key: 'typing_max_ms', label: '«Yozmoqda» maksimum (ms)', group: 'Xulq', type: 'number', default: 6000 },

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
