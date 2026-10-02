import { describe, expect, it } from 'vitest';
import { parseAnswers, parseTargetWeight } from '../src/leads/answerParser';
import { calcBmi, bmiBand } from '../src/leads/bmi';
import { nextStep } from '../src/leads/questionnaire';
import { parseAiResponse, stripMarkers } from '../src/ai/responseSchema';
import { detectLanguage } from '../src/utils/text';
import { anonymize, isUnsafeCoachReply } from '../src/style/anonymizer';
import { identifyCoach, parseTelegramHtml, parseTelegramJson } from '../src/style/chatImport';
import { buildPairs } from '../src/style/examples';
import { computeStyleStats } from '../src/style/styleProfile';
import { validateInitData, signInitData } from '../src/webapp/auth';
import { startOfDayInTz } from '../src/utils/time';

describe('answer parser', () => {
  it.each([
    ["180 bo'yim 90 kg 24 yosh", { height: 180, weight: 90, age: 24 }],
    ['175/82/22', { height: 175, weight: 82, age: 22 }],
    ["22 yoshman, 178 bo'y, 85 kg", { height: 178, weight: 85, age: 22 }],
    ['1. 173sm\n2. 75kg\n3. 30yosh', { height: 173, weight: 75, age: 30 }],
    ['Рост 175, вес 90, 30 лет', { height: 175, weight: 90, age: 30 }],
    ["bo'y 1.80, ves 77.5", { height: 180, weight: 77.5 }],
    ['180 90 25', { height: 180, weight: 90, age: 25 }],
  ])('%s', (text, expected) => {
    expect(parseAnswers(text)).toMatchObject(expected);
  });

  it('training experience and frequency', () => {
    expect(parseAnswers('2 yildan beri zalga boraman').trainingExperience).toBe('2 yildan');
    expect(parseAnswers("tajribam yo'q").trainingExperience).toBe("yo'q");
    expect(parseAnswers('haftasiga 4 kun zalda')).toMatchObject({ trainingDays: 4, trainingLocation: 'zal' });
    expect(parseAnswers('3 раза в неделю дома')).toMatchObject({ trainingDays: 3, trainingLocation: 'uy' });
  });

  it('bare numbers are ignored outside question 1', () => {
    expect(parseAnswers('85 gacha', {}, { bareNumbers: false }).weight).toBeUndefined();
  });

  it('target weight', () => {
    expect(parseTargetWeight('85 kg gacha tushmoqchiman', 95)).toBe(85);
    expect(parseTargetWeight('10 kg tashlamoqchiman', 95)).toBe(85);
    expect(parseTargetWeight('до 70', 80)).toBe(70);
    expect(parseTargetWeight('5 kg massa olish', 60)).toBeUndefined();
  });
});

describe('BMI and steps', () => {
  it('calculates TMI = kg / m²', () => {
    expect(calcBmi(95, 180)).toBe(29.3);
    expect(calcBmi(60, 180)).toBe(18.5);
    expect(bmiBand(25)).toBe('high');
    expect(bmiBand(20.9)).toBe('low');
    expect(bmiBand(23)).toBe('mid');
  });
  it('next step skips answered questions', () => {
    expect(nextStep({})).toBe(1);
    expect(nextStep({ height: 1, weight: 1, age: 1, trainingExperience: 'x' })).toBe(2);
    expect(nextStep({ height: 1, weight: 1, age: 1, trainingExperience: 'x', goal: 'g', trainingDays: 3, trainingLocation: 'zal', previousAttempts: 'p', healthProblems: 'h' })).toBe(6);
    expect(nextStep({ height: 1, weight: 1, age: 1, trainingExperience: 'x', goal: 'g', previousAttempts: 'p' })).toBe(3);
  });
});

describe('[TAYYOR] markers and model output validation', () => {
  it('strips markers', () => {
    expect(stripMarkers('Tushunarli\n[TAYYOR]')).toEqual({ text: 'Tushunarli', ready: true, urgent: false });
    expect(stripMarkers('Tushunarli\n[TAYYOR: ehtiyot]')).toEqual({ text: 'Tushunarli', ready: true, urgent: true });
    expect(stripMarkers('[ tayyor :ehtiyot ]').urgent).toBe(true);
  });
  it('validates JSON with Zod, tolerates fences and single message', () => {
    const r = parseAiResponse('```json\n{"message":"Salom?","action":"ASK_NEXT","extracted":{"height":"180 sm","age":null}}\n```');
    expect(r.messages).toEqual(['Salom?']);
    expect(r.extracted?.height).toBe(180);
    expect(() => parseAiResponse('{"action":"HACK"}')).toThrow();
    expect(() => parseAiResponse('not json')).toThrow();
  });
});

describe('language detection', () => {
  it('detects Russian, Uzbek Latin and Uzbek Cyrillic', () => {
    expect(detectLanguage('Здравствуйте, хочу похудеть')).toBe('ru');
    expect(detectLanguage("Assalomu alaykum, ozmoqchiman")).toBe('uz');
    expect(detectLanguage('Ассалому алайкум, қандай')).toBe('uz');
    expect(detectLanguage('ok')).toBe('uz');
    expect(detectLanguage('👍')).toBeUndefined();
  });
});

describe('anonymization and import', () => {
  it('removes personal data', () => {
    const t = anonymize('Ali aka, karta 4000 1234 5678 9010, tel +998 90 123 45 67, @ali_fit, narx 700 ming, grija bor', { names: ['Ali Valiyev'], maskNumbers: true });
    expect(t).not.toMatch(/Ali|4000|998|@ali_fit|700|grija/);
    expect(t).toContain('[karta]');
    expect(t).toContain('[telefon]');
    expect(t).toContain('[username]');
    expect(t).toContain('[narx]');
    expect(t).toContain("[sog'liq]");
  });

  it('drops unsafe coach replies (prices, promises with numbers, long diet plans)', () => {
    expect(isUnsafeCoachReply('800 qilib beraman aka')).toBe(true);
    expect(isUnsafeCoachReply('Chegirma qila olmayman')).toBe(true);
    expect(isUnsafeCoachReply('Ha boldi aka')).toBe(false);
  });

  const HTML = `<div class="page_header"><div class="content"><div class="text bold">
Mijoz Ism
</div></div></div>
<div class="message service" id="message-1"><div class="body details">28 July 2026</div></div>
<div class="message default clearfix" id="message1"><div class="body"><div class="pull_right date details" title="28.07.2026 14:56:06 UTC+09:00">14:56</div><div class="from_name">
𝑇𝑒𝑚𝑢𝑟 Coach
</div><div class="text">
Assalomu alaykum
</div></div></div>
<div class="message default clearfix" id="message2"><div class="body"><div class="from_name">
Mijoz Ism
</div><div class="text">
Salom, 173sm 75kg, narxi qancha?
</div></div></div>
<div class="message default clearfix" id="message3"><div class="body"><div class="from_name">
𝑇𝑒𝑚𝑢𝑟 Coach
</div><div class="text">
Tushunarli
</div></div></div>
<div class="message default clearfix joined" id="message4"><div class="body"><div class="text">
Maqsad nima?
</div></div></div>
<div class="message default clearfix" id="message5"><div class="body"><div class="from_name">
Mijoz Ism
</div><div class="text">
Ozish, Mijoz deb chaqiring
</div></div></div>
<div class="message default clearfix" id="message6"><div class="body"><div class="from_name">
𝑇𝑒𝑚𝑢𝑟 Coach
</div><div class="text">
800 qberolaman aka
</div></div></div>`;

  it('parses a Telegram Desktop HTML export and builds anonymized pairs', () => {
    const chat = parseTelegramHtml(HTML);
    expect(chat.peerName).toBe('Mijoz Ism');
    expect(chat.messages).toHaveLength(6);
    expect(identifyCoach(chat, {})).toContain('Coach');
    const pairs = buildPairs(chat, { coachName: 'Temur' });
    expect(pairs).toHaveLength(1); // the price reply is dropped
    expect(pairs[0].coach).toEqual(['Tushunarli', 'Maqsad nima?']);
    expect(pairs[0].client).not.toMatch(/173|75|Mijoz/);
  });

  it('parses Telegram JSON export (single chat and full export)', () => {
    const single = JSON.stringify({
      name: 'Client',
      type: 'personal_chat',
      messages: [
        { type: 'message', from: 'Client', from_id: 'user5', text: 'Salom' },
        { type: 'message', from: 'Temur', from_id: 'user9', text: [{ type: 'plain', text: 'Va alaykum ' }, 'assalom'] },
      ],
    });
    const chats = parseTelegramJson(single);
    expect(chats[0].messages[1].text).toBe('Va alaykum assalom');
    expect(buildPairs(chats[0], { coachId: 9 })[0].coach).toEqual(['Va alaykum assalom']);
    const full = JSON.stringify({ chats: { list: [JSON.parse(single), { ...JSON.parse(single), type: 'private_group' }] } });
    expect(parseTelegramJson(full)).toHaveLength(1);
  });

  it('style stats', () => {
    const s = computeStyleStats([{ coach: ['Hop', 'Ha boldi aka'] }, { coach: ['Ha boldi aka 🔥'] }]);
    expect(s.coachMessages).toBe(3);
    expect(s.topPhrases).toContain('ha boldi aka');
    expect(s.emojiPerMessage).toBeGreaterThan(0);
  });
});

describe('misc', () => {
  it('mini app initData signature', () => {
    const data = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 5 }) }, 'tok');
    expect(validateInitData(data, 'tok')?.id).toBe(5);
    expect(validateInitData(data, 'other')).toBeNull();
    const old = signInitData({ auth_date: '1000', user: JSON.stringify({ id: 5 }) }, 'tok');
    expect(validateInitData(old, 'tok')).toBeNull();
  });
  it('start of day in time zone', () => {
    expect(startOfDayInTz(new Date('2026-10-01T20:30:00Z'), 'Asia/Tashkent').toISOString()).toBe('2026-10-01T19:00:00.000Z');
  });
});

describe('language detection (cyrillic uzbek without special letters)', () => {
  it('detects uzbek cyrillic by common words', () => {
    expect(detectLanguage('Салом рахмат яхши')).toBe('uz');
    expect(detectLanguage('Привет, сколько стоит')).toBe('ru');
  });
});

describe('anonymizer word awareness', () => {
  it('does not mask "qanday" as health and masks cyrillic names', () => {
    expect(anonymize('hechqanday farq qilmaydi, qanday?')).toBe('hechqanday farq qilmaydi, qanday?');
    expect(anonymize('qand kasalim bor, bosim ham')).toBe("[sog'liq] kasalim bor, [sog'liq] ham");
    expect(anonymize('Привет, Алишер', { names: ['Алишер'] })).toBe('Привет, [ism]');
  });
});
