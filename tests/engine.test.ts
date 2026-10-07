import { describe, expect, it } from 'vitest';
import { Lead } from '../src/database/models/Lead';
import { Message } from '../src/database/models/Message';
import { Campaign } from '../src/database/models/misc';
import { buildApp, clientMsg, LlmError, useDatabase } from './helpers';

useDatabase();

const FIRST = "Assalomu alaykum! O'zingiz haqingizda qisqacha ma'lumot berib yubora olasizmi? Bo'y, ves, yosh. Trenirovka tajribangiz bormi?";
const Q2_HIGH = 'Maqsad nechiga tushish? Qancha vazn norma hisoblaysiz?';
const Q2_LOW = 'Maqsad massa olishmi? Necha kiloga chiqmoqchisiz?';
const Q2_MID = 'Maqsad nima: ozishmi, massa olishmi yoki shaklga kirish?';
const Q3 = 'Haftasiga necha kun trenirovkaga vaqt ajrata olasiz? Zaldami yoki uyda?';
const Q4 = "Oldin harakat qilib ko'rganmisiz? Nima xalaqit bergan?";
const Q5 = "Sog'lig'ingizda muammo bormi? Bel, tizza, grija, bosim, qand?";

describe('questionnaire flow', () => {
  it('1. new client gets exactly the first message and status QUESTIONNAIRE', async () => {
    const { engine, gateway } = buildApp();
    await engine.handleClientMessage(clientMsg(10, 'Salom, kurs haqida'));
    expect(gateway.textsTo(10)).toEqual([FIRST]);
    const lead = await Lead.findOne({ chatId: 10 });
    expect(lead?.status).toBe('QUESTIONNAIRE');
    expect(lead?.mode).toBe('AI');
    expect(gateway.typing).toBeGreaterThan(0); // "yozmoqda" shown before reply
  });

  it('2–6. walks through all five questions one at a time and ends with Tushunarli + [TAYYOR]', async () => {
    const { settings, engine, gateway, llm } = buildApp();
    await settings.set({ sales_mode: false });
    await engine.handleClientMessage(clientMsg(11, 'Salom, kurs haqida'));
    // Q1 answer → TMI 29.3 → Q2 high variant
    await engine.handleClientMessage(clientMsg(11, "180 bo'yim 95 kg 24 yosh, 2 yildan beri zalga boraman"));
    expect(gateway.textsTo(11).at(-1)).toContain(Q2_HIGH);
    const l1 = await Lead.findOne({ chatId: 11 });
    expect(l1?.answers?.height).toBe(180);
    expect(l1?.answers?.weight).toBe(95);
    expect(l1?.answers?.age).toBe(24);
    expect(l1?.bmi).toBe(29.3);

    llm.push((req) => ({ messages: [Q3], action: 'ASK_NEXT', answered_current: true, question: 3, extracted: { goal: 'ozish', targetWeight: 85 } }));
    await engine.handleClientMessage(clientMsg(11, '85 kg gacha tushmoqchiman'));
    expect(gateway.textsTo(11).at(-1)).toBe(Q3);

    llm.push({ messages: [Q4], action: 'ASK_NEXT', answered_current: true, question: 4, extracted: { trainingDays: 4, trainingLocation: 'zal' } });
    await engine.handleClientMessage(clientMsg(11, '4 kun zalda'));
    expect(gateway.textsTo(11).at(-1)).toBe(Q4);

    await engine.handleClientMessage(clientMsg(11, "Ha, vaqt yetmadi, ishdan charchab qolardim"));
    expect(gateway.textsTo(11).at(-1)).toContain(Q5);

    llm.push({ messages: ['Tushunarli'], action: 'READY', reason: 'completed', answered_current: true, extracted: { healthProblems: "yo'q" } });
    await engine.handleClientMessage(clientMsg(11, "Yo'q, sog'man"));
    expect(gateway.textsTo(11).at(-1)).toBe('Tushunarli');

    const lead = await Lead.findOne({ chatId: 11 });
    expect(lead?.status).toBe('READY');
    expect(lead?.mode).toBe('MANUAL');
    expect(lead?.readyReason).toBe('completed');
    expect(lead?.answers?.previousAttempts).toContain('vaqt yetmadi');
    expect(lead?.answers?.targetWeight).toBe(85);
    expect(gateway.textsTo(11).every((t) => !t.includes('TAYYOR'))).toBe(true);
    // lead card to the coach
    expect(gateway.admin.at(-1)?.html).toContain('YANGI LEAD');
  });

  it('Q2 variants depend on backend TMI (<21 → mass, 21–25 → open question)', async () => {
    const { engine, gateway } = buildApp();
    await engine.handleClientMessage(clientMsg(12, 'Salom, kurs haqida'));
    await engine.handleClientMessage(clientMsg(12, '180/60/22 tajriba yo\'q'));
    expect(gateway.textsTo(12).at(-1)).toContain(Q2_LOW);
    await engine.handleClientMessage(clientMsg(13, 'Salom, kurs haqida'));
    await engine.handleClientMessage(clientMsg(13, "22 yoshman, 178 bo'y, 72 kg, 1 yil zal"));
    expect(gateway.textsTo(13).at(-1)).toContain(Q2_MID);
  });

  it('7. all answers in one message → skips answered questions and finishes', async () => {
    const { settings, engine, gateway, llm } = buildApp();
    await settings.set({ sales_mode: false });
    llm.push({
      messages: ['Tushunarli'],
      action: 'READY',
      reason: 'completed',
      answered_current: true,
      extracted: {
        trainingExperience: '2 yil',
        goal: 'ozish 85 kg',
        targetWeight: 85,
        trainingDays: 4,
        trainingLocation: 'zalda',
        previousAttempts: 'dieta qilganman, uzilib qolganman',
        healthProblems: "yo'q",
      },
    });
    await engine.handleClientMessage(
      clientMsg(14, "180 bo'yim, 95 kgman, 24 yosh. 2 yildan beri zalga boraman. 85 gacha tushmoqchiman, haftasiga 4 kun zalda, oldin dieta qilib uzilib qolganman, sog'ligim yaxshi"),
    );
    expect(gateway.textsTo(14)).toEqual(['Tushunarli']); // first message is NOT sent, Q1 data already given
    const lead = await Lead.findOne({ chatId: 14 });
    expect(lead?.status).toBe('READY');
    expect(lead?.answers?.trainingLocation).toBe('zal');
  });

  it('client answers partially → asks only for what is missing in Q1', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(15, 'Salom, kurs haqida'));
    llm.push((req) => {
      const text = req.parts[0].text!;
      expect(text).toContain('Joriy savolda yetishmayapti: yosh, trenirovka tajribasi');
      return { messages: ['Yoshingiz nechida? Trenirovka tajribangiz bormi?'], action: 'ASK_NEXT', answered_current: false, question: 1 };
    });
    await engine.handleClientMessage(clientMsg(15, "175 bo'y 82 kg"));
    expect(gateway.textsTo(15).at(-1)).toBe('Yoshingiz nechida? Trenirovka tajribangiz bormi?');
    const lead = await Lead.findOne({ chatId: 15 });
    expect(lead?.answers?.height).toBe(175);
    expect(lead?.status).toBe('QUESTIONNAIRE');
  });

  it('8. price question → deflects with the configured phrase and returns to the questionnaire', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(16, 'Salom, kurs haqida'));
    await engine.handleClientMessage(clientMsg(16, '180 90 25, 1 yil zal'));
    llm.push((req) => {
      expect(req.parts[0].text).toContain("Bazada javobi yo'q savolga: «Savollardan keyin o'zim batafsil aytaman»");
      return { messages: ["Savollardan keyin o'zim batafsil aytaman", Q2_HIGH], action: 'ASK_NEXT', answered_current: false, question: 2 };
    });
    await engine.handleClientMessage(clientMsg(16, 'Narxi qancha?'));
    // answers the question and does NOT repeat the question it has just asked
    expect(gateway.textsTo(16).at(-1)).toBe("Savollardan keyin o'zim batafsil aytaman");
    expect(gateway.textsTo(16).filter((t) => t.includes(Q2_HIGH))).toHaveLength(1);
    expect(llm.calls.at(-1)!.system).toContain('BILIMLAR BAZASI');
    expect((await Lead.findOne({ chatId: 16 }))?.mode).toBe('AI');
  });

  it('9. "Botmisiz?" → honest answer, AI stops, card sent', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(17, 'Salom, kurs haqida'));
    const callsBefore = llm.calls.filter((c) => c.json).length;
    await engine.handleClientMessage(clientMsg(17, 'Botmisiz?'));
    expect(gateway.textsTo(17).at(-1)).toBe(
      "Ha, savollarga AI-yordamchim javob beryapti, lekin hammasini o'zim ko'rib turibman. Hozir o'zim yozaman.",
    );
    const lead = await Lead.findOne({ chatId: 17 });
    expect(lead?.status).toBe('READY');
    expect(lead?.mode).toBe('MANUAL');
    expect(lead?.readyReason).toBe('bot_question');
    expect(llm.calls.filter((c) => c.json)).toHaveLength(callsBefore); // handled by backend rule
  });

  it('9b. model-detected bot question (no keyword) is also handled honestly', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(18, 'Salom, kurs haqida'));
    llm.push({ messages: ['[TAYYOR]'], action: 'READY', reason: 'bot_question' });
    await engine.handleClientMessage(clientMsg(18, 'Rostini ayting, men robot bilan yozishyapmanmi?'));
    expect(gateway.textsTo(18).at(-1)).toContain('AI-yordamchim');
    expect((await Lead.findOne({ chatId: 18 }))?.mode).toBe('MANUAL');
  });

  it('10. client asks for TEMUR → honest hand-over line, [TAYYOR]', async () => {
    const { engine, gateway } = buildApp();
    await engine.handleClientMessage(clientMsg(19, 'Salom, kurs haqida'));
    await engine.handleClientMessage(clientMsg(19, 'Temur bilan gaplashmoqchiman'));
    expect(gateway.textsTo(19).at(-1)).toBe("Hop, buni o'zim alohida gaplashib ko'raman, hozir yozaman");
    const lead = await Lead.findOne({ chatId: 19 });
    expect(lead?.readyReason).toBe('wants_coach');
    expect(lead?.urgent).toBe(false);
  });

  it('11/15. dangerous behaviour → only Tushunarli, [TAYYOR: ehtiyot], urgent card on top', async () => {
    const { engine, gateway } = buildApp();
    await engine.handleClientMessage(clientMsg(20, 'Salom, kurs haqida'));
    await engine.handleClientMessage(clientMsg(20, 'Ovqatdan keyin qustiraman, tezroq ozish uchun'));
    expect(gateway.textsTo(20).at(-1)).toBe('Tushunarli');
    const lead = await Lead.findOne({ chatId: 20 });
    expect(lead?.urgent).toBe(true);
    expect(lead?.status).toBe('READY');
    expect(lead?.mode).toBe('MANUAL');
    expect(lead?.readyReason).toBe('safety');
    expect(gateway.admin.at(-1)?.html).toContain('SHOSHILINCH');
  });

  it('11b. model-detected starvation (URGENT_READY with marker) is honoured and the marker never leaks', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(21, 'Salom, kurs haqida'));
    llm.push({ messages: ['Tushunarli\n[TAYYOR: ehtiyot]'], action: 'URGENT_READY', reason: 'safety' });
    await engine.handleClientMessage(clientMsg(21, 'Bir haftadan beri faqat suv ichib yuribman'));
    expect(gateway.textsTo(21).at(-1)).toBe('Tushunarli');
    expect((await Lead.findOne({ chatId: 21 }))?.urgent).toBe(true);
  });

  it('12. target BMI < 18.5 → [TAYYOR: ehtiyot]', async () => {
    const { engine, gateway } = buildApp();
    await engine.handleClientMessage(clientMsg(22, 'Salom, kurs haqida'));
    await engine.handleClientMessage(clientMsg(22, "170 bo'y 60 kg 19 yosh, tajriba yo'q"));
    await engine.handleClientMessage(clientMsg(22, '50 kg gacha tushmoqchiman'));
    const lead = await Lead.findOne({ chatId: 22 });
    expect(lead?.targetBmi).toBe(17.3);
    expect(lead?.urgent).toBe(true);
    expect(lead?.readyReason).toBe('low_target_bmi');
    expect(gateway.textsTo(22).at(-1)).toBe('Tushunarli');
  });

  it('13. TEMUR writes manually → AI never answers again in that chat', async () => {
    const { settings, engine, gateway } = buildApp();
    await settings.set({ coach_message_stops_ai: true });
    await engine.handleClientMessage(clientMsg(23, 'Salom, kurs haqida'));
    await engine.handleCoachMessage({ connectionId: 'conn-1', chat: { id: 23 }, messageId: 9999, text: 'Salom, Temur', kind: 'text' });
    const before = gateway.sent.length;
    await engine.handleClientMessage(clientMsg(23, "180 90 25 1 yil zal"));
    expect(gateway.sent.length).toBe(before);
    const lead = await Lead.findOne({ chatId: 23 });
    expect(lead?.mode).toBe('MANUAL');
    expect(lead?.status).toBe('ANSWERED');
    expect(await Message.countDocuments({ leadId: lead!._id, sender: 'temur' })).toBe(1);
  });

  it('14. after [TAYYOR] nothing automatic is ever sent (messages, reminders)', async () => {
    const { engine, gateway, reminders } = buildApp();
    await engine.handleClientMessage(clientMsg(24, 'Salom, kurs haqida'));
    await engine.handleClientMessage(clientMsg(24, 'Temur bilan gaplashmoqchiman'));
    const count = gateway.sent.length;
    await engine.handleClientMessage(clientMsg(24, 'Hali yozmadingizmi?'));
    await engine.handleClientMessage(clientMsg(24, 'Narxi qancha?'));
    await reminders.tick(new Date(Date.now() + 2 * 3600_000));
    await reminders.tick(new Date(Date.now() + 21 * 3600_000));
    expect(gateway.sent.length).toBe(count);
  });

  it('17. Russian client gets Russian questions', async () => {
    const { engine, gateway } = buildApp();
    await engine.handleClientMessage(clientMsg(25, 'Здравствуйте, хочу похудеть'));
    expect(gateway.textsTo(25)[0]).toBe('Здравствуйте! Можете коротко рассказать о себе? Рост, вес, возраст. Есть опыт тренировок?');
    await engine.handleClientMessage(clientMsg(25, 'Рост 175, вес 90, 30 лет, занимаюсь 2 года'));
    expect(gateway.textsTo(25).at(-1)).toContain('Цель: до скольки похудеть? Какой вес считаете нормой?');
    expect((await Lead.findOne({ chatId: 25 }))?.language).toBe('ru');
  });

  it('18. Uzbek client and language switch mid-conversation is followed', async () => {
    const { engine, gateway } = buildApp();
    await engine.handleClientMessage(clientMsg(26, 'Assalomu alaykum'));
    expect(gateway.textsTo(26)[0]).toBe("Assalomu alaykum! Kurs bo'yicha yozyapsizmi yoki boshqa masalada?");
    await engine.handleClientMessage(clientMsg(26, 'Рост 180, вес 70, 25 лет, опыта нет'));
    expect(gateway.textsTo(26).at(-1)).toContain('Какая цель: похудеть, набрать массу или прийти в форму?');
  });

  it('21. source tracking from a chat-link prefilled message', async () => {
    const { engine, gateway } = buildApp();
    await Campaign.create({ code: '#v1', source: 'video_01' });
    await Campaign.create({ code: '#v2', source: 'video_02' });
    await engine.handleClientMessage(clientMsg(27, 'Salom! #v2'));
    await engine.handleClientMessage(clientMsg(28, 'Salom! 1-videodan keldim'));
    await engine.handleClientMessage(clientMsg(29, 'Salom #target_mass'));
    await engine.handleClientMessage(clientMsg(30, 'Salom, kurs haqida'));
    expect((await Lead.findOne({ chatId: 27 }))?.source).toBe('video_02');
    expect((await Lead.findOne({ chatId: 28 }))?.source).toBe('video_01');
    expect((await Lead.findOne({ chatId: 29 }))?.source).toBe('target_mass');
    expect((await Lead.findOne({ chatId: 30 }))?.source).toBe('unknown');
    // the tracking code is not shown to the AI
    const stored = await Message.findOne({ telegramId: 27 });
    expect(stored?.text).toBe('Salom!');
    expect(gateway.textsTo(27)).toEqual([FIRST]);
  });

  it('22. lead card has all fields and status buttons', async () => {
    const { settings, engine, gateway, llm } = buildApp();
    await settings.set({ sales_mode: false });
    await Campaign.create({ code: '#v3', source: 'video_03' });
    await engine.handleClientMessage(clientMsg(31, 'Salom #v3'));
    llm.push({
      messages: ['Tushunarli'],
      action: 'READY',
      reason: 'completed',
      answered_current: true,
      extracted: { trainingExperience: '2 yil', goal: 'ozish', targetWeight: 85, trainingDays: 4, trainingLocation: 'zal', previousAttempts: 'vaqt', healthProblems: 'bel' },
    });
    await engine.handleClientMessage(clientMsg(31, "180 95 24, hammasi: 2 yil, 85 gacha, 4 kun zal, vaqt yetmagan, bel og'riydi"));
    const card = gateway.admin.at(-1)!;
    for (const s of ['Ism', '@user31', '31', 'video_03', "Bo'y: 180", 'Vazn: 95 kg', 'Yosh: 24', 'Tajriba: 2 yil', 'Maqsad: ozish (85 kg)', '4 kun / zal', 'Oldingi urinish', "Sog'liq", 'TMI: 29.3', 'Status: <b>Tayyor']) {
      expect(card.html).toContain(s);
    }
    const buttons = card.keyboard!.inline_keyboard.flat().map((b) => b.text);
    expect(buttons).toEqual(expect.arrayContaining(['✅ Javob berildi', "💰 To'ladi", '❌ Rad etdi', '💬 Chatni ochish']));
  });

  it('O. AI API fails → nothing is sent, admin is notified after repeated failures, retry later works', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(32, 'Salom, kurs haqida'));
    const sentBefore = gateway.sent.length;
    llm.push(new LlmError('HTTP 503', true), new LlmError('HTTP 503', true), new LlmError('HTTP 503', true));
    await engine.handleClientMessage(clientMsg(32, '180 90 25 1 yil'));
    expect(gateway.sent.length).toBe(sentBefore);
    llm.push(new LlmError('HTTP 503', true), new LlmError('HTTP 503', true), new LlmError('HTTP 503', true));
    await engine.process(String((await Lead.findOne({ chatId: 32 }))!._id));
    expect(gateway.sent.length).toBe(sentBefore);
    expect(gateway.admin.at(-1)?.html).toContain('AI javob bera olmayapti');
    // AI recovers → pending message is answered
    const lead = await Lead.findOne({ chatId: 32 });
    expect(lead?.pendingSince).toBeTruthy();
    await Lead.updateOne({ _id: lead!._id }, { $set: { pendingSince: new Date(Date.now() - 10 * 60_000) } });
    await engine.retryPending();
    expect(gateway.textsTo(32).at(-1)).toContain(Q2_HIGH);
  });

  it('invalid model output is rejected by Zod and never sent', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(33, 'Salom, kurs haqida'));
    const before = gateway.sent.length;
    llm.push({ foo: 'bar' }, { action: 'DANCE' }, { messages: 'x' });
    await engine.handleClientMessage(clientMsg(33, '180 90 25 1 yil'));
    expect(gateway.sent.length).toBe(before);
  });

  it('wrong question from the model is corrected to the backend question', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(34, 'Salom, kurs haqida'));
    llm.push({ messages: ['Tushunarli', Q5], action: 'ASK_NEXT', answered_current: true, question: 5 });
    await engine.handleClientMessage(clientMsg(34, '180 90 25 1 yil zal'));
    expect(gateway.textsTo(34).at(-1)).toContain(Q2_HIGH);
  });

  it('bot paused / connection closed while sending → AI stops for that chat', async () => {
    const { engine, gateway } = buildApp();
    gateway.failSend = Object.assign(new Error('Forbidden: BUSINESS_PEER_USAGE_MISSING'), { error_code: 403 });
    await engine.handleClientMessage(clientMsg(35, 'Salom, kurs haqida'));
    expect((await Lead.findOne({ chatId: 35 }))?.mode).toBe('MANUAL');
  });

  it('voice note is transcribed and processed like text', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(36, 'Salom, kurs haqida'));
    llm.transcript = "bo'yim 180 vazn 90 kg 25 yosh bir yil zal";
    await engine.handleClientMessage(clientMsg(36, '', { kind: 'voice', voice: { fileId: 'f1' } }));
    const lead = await Lead.findOne({ chatId: 36 });
    expect(lead?.answers?.height).toBe(180);
    expect(gateway.textsTo(36).at(-1)).toContain(Q2_HIGH);
  });

  it('global AI switch off → new chats are MANUAL and get no messages', async () => {
    const { engine, gateway, settings } = buildApp();
    await settings.set({ ai_enabled: false });
    await engine.handleClientMessage(clientMsg(37, 'Salom, kurs haqida'));
    expect(gateway.sent).toHaveLength(0);
  });

  it('admin-edited question texts are used immediately', async () => {
    const { engine, gateway, settings } = buildApp();
    await settings.set({ first_message_uz: 'Salom! Boy, ves, yosh?' });
    await engine.handleClientMessage(clientMsg(38, 'Salom, kurs haqida'));
    expect(gateway.textsTo(38)).toEqual(['Salom! Boy, ves, yosh?']);
  });

  it('style examples and coach info reach the LLM prompt; system prompt edits apply', async () => {
    const { engine, llm, settings } = buildApp();
    await settings.set({ coach_info: 'Koreyada yashaydi', system_prompt: 'MAXSUS PROMPT {{coach_name}}' });
    await engine.handleClientMessage(clientMsg(39, 'Salom, kurs haqida'));
    await engine.handleClientMessage(clientMsg(39, '180 90 25 1 yil'));
    const call = llm.calls.find((c) => c.json)!;
    expect(call.system).toContain('MAXSUS PROMPT Temur');
    expect(call.system).toContain('USLUB PROFILI');
    expect(call.system).toContain('TEXNIK QOIDALAR');
  });
});

describe('human-like behaviour', () => {
  it('asks "kurs bo\'yichami?" first when the purpose is unclear, and stops silently for non-course chats', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(70, 'Salom'));
    expect(gateway.textsTo(70)).toEqual(["Assalomu alaykum! Kurs bo'yicha yozyapsizmi yoki boshqa masalada?"]);
    llm.push({ messages: [], action: 'NOT_LEAD', intent: 'other' });
    await engine.handleClientMessage(clientMsg(70, 'Yoq, reklama boyicha hamkorlik taklifim bor edi'));
    expect(gateway.textsTo(70)).toHaveLength(1);
    const lead = await Lead.findOne({ chatId: 70 });
    expect(lead?.mode).toBe('MANUAL');
    expect(lead?.intent).toBe('other');
    expect(gateway.admin.at(-1)?.html).toContain("Kurs bo'yicha emas");
  });

  it('course answer after the intent question → continues with question 1 in natural words', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(71, 'Assalomu alaykum'));
    llm.push({ messages: ['Zo\'r!', "O'zingiz haqingizda qisqacha yozing: bo'y, ves, yosh, tajriba bormi?"], action: 'ASK_NEXT', intent: 'course', question: 1 });
    await engine.handleClientMessage(clientMsg(71, 'ha, ozmoqchi edim'));
    expect(gateway.textsTo(71).slice(-2)).toEqual(["Zo'r!", "O'zingiz haqingizda qisqacha yozing: bo'y, ves, yosh, tajriba bormi?"]);
    expect((await Lead.findOne({ chatId: 71 }))?.intent).toBe('course');
  });

  it('ad-link clients skip the intent question', async () => {
    const { engine, gateway } = buildApp();
    await engine.handleClientMessage(clientMsg(72, 'Salom #video_05'));
    expect(gateway.textsTo(72)[0]).toBe(FIRST);
  });

  it('several messages and voice notes in a row are answered together, once', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(73, 'Salom, kurs haqida'));
    const lead = await Lead.findOne({ chatId: 73 });
    // simulate the debounce window: messages are stored, processed once
    (engine as unknown as { opts: { debounceMsOverride: number } }).opts.debounceMsOverride = 60_000;
    await engine.handleClientMessage(clientMsg(73, "180 bo'y"));
    await engine.handleClientMessage(clientMsg(73, '90 kg'));
    llm.transcript = '25 yoshman, 2 yil zalga borganman';
    await engine.handleClientMessage(clientMsg(73, '', { kind: 'voice', voice: { fileId: 'v1' } }));
    engine.cancel(String(lead!._id));
    await engine.process(String(lead!._id));
    const after = await Lead.findOne({ chatId: 73 });
    expect(after?.answers).toMatchObject({ height: 180, weight: 90, age: 25 });
    expect(gateway.textsTo(73)).toHaveLength(2); // first message + one answer
    expect(gateway.textsTo(73).at(-1)).toContain(Q2_HIGH);
  });

  it('a new client message during sending interrupts the remaining bot messages', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(74, 'Salom, kurs haqida'));
    const lead = await Lead.findOne({ chatId: 74 });
    const orig = gateway.sendBusinessMessage.bind(gateway);
    let n = 0;
    gateway.sendBusinessMessage = async (c, chat, text) => {
      const r = await orig(c, chat, text);
      if (++n === 1) {
        await Message.create({ leadId: lead!._id, sender: 'client', direction: 'incoming', text: 'yana bir narsa', processed: false });
      }
      return r;
    };
    llm.push({ messages: ['Zo\'r', 'Natija bo\'ladi', Q2_HIGH], action: 'ASK_NEXT', question: 2, answered_current: true });
    n = 0;
    (engine as unknown as { opts: { debounceMsOverride: number } }).opts.debounceMsOverride = 60_000;
    await engine.handleClientMessage(clientMsg(74, '180 90 25 1 yil'));
    engine.cancel(String(lead!._id));
    await engine.process(String(lead!._id));
    expect(gateway.textsTo(74).slice(1)).toEqual(["Zo'r"]);
  });

  it('does not open every message with the same acknowledgement', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(75, 'Salom, kurs haqida'));
    // the model asks the wrong question twice → backend corrects with varying acknowledgements
    llm.push({ messages: ['Tushunarli', Q5], action: 'ASK_NEXT', answered_current: true, question: 5 });
    await engine.handleClientMessage(clientMsg(75, '180 90 25 1 yil zal'));
    llm.push({ messages: ['Tushunarli', Q5], action: 'ASK_NEXT', answered_current: true, question: 5, extracted: { goal: 'ozish' } });
    await engine.handleClientMessage(clientMsg(75, 'ozish'));
    const [a, b] = gateway.textsTo(75).slice(-2);
    expect(a.split('.')[0]).not.toBe(b.split('.')[0]);
  });

  it('completed questionnaire ends with the model\'s natural closing message, marker hidden', async () => {
    const { settings, engine, gateway, llm } = buildApp();
    await settings.set({ sales_mode: false });
    llm.push({
      messages: ["Rahmat, hammasi tushunarli 👍", "Hozir o'zim batafsil yozaman\n[TAYYOR]"],
      action: 'READY',
      reason: 'completed',
      extracted: { trainingExperience: '1 yil', goal: 'ozish', trainingDays: 3, trainingLocation: 'uy', previousAttempts: "yo'q", healthProblems: "yo'q" },
    });
    await engine.handleClientMessage(clientMsg(76, "Kurs uchun: 175 80 30, 1 yil, ozish, 3 kun uyda, oldin urinmaganman, sog'man"));
    expect(gateway.textsTo(76)).toEqual(["Rahmat, hammasi tushunarli 👍", "Hozir o'zim batafsil yozaman"]);
    expect((await Lead.findOne({ chatId: 76 }))?.status).toBe('READY');
  });
});

describe('intent, photos, spam, always-on, reset', () => {
  it('screenshot case: "ozğin edim, semirishim kerak, maslahat berasizmi" is about the course → no intent question', async () => {
    const { engine, gateway, llm } = buildApp();
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).not.toContain('MAQSAD ANIQLANMAGAN');
      return {
        messages: ['Va alaykum assalom aka', "Semirish ham to'g'ri tizim bilan bo'ladi, muntazam ovqat va kuch mashqlari kerak", "O'zingiz haqingizda yozing: bo'y, ves, yosh, trenirovka tajribangiz bormi?"],
        action: 'ASK_NEXT',
        question: 1,
      };
    });
    await engine.handleClientMessage(clientMsg(80, 'Assolomu alaykum aka yaxshimisiz, menga yordamiz kerak edi, men juda ozğin edim, semirishim kerak, maslahat berasizmi'));
    const texts = gateway.textsTo(80);
    expect(texts.some((t) => t.includes("Kurs bo'yicha"))).toBe(false);
    expect(texts.at(-1)).toContain("bo'y, ves, yosh");
    expect((await Lead.findOne({ chatId: 80 }))?.intent).toBe('course');
  });

  it('a meaningful message without keywords is classified by the model (other → silent stop)', async () => {
    const { engine, gateway, llm } = buildApp();
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain('MAQSAD ANIQLANMAGAN');
      return { messages: [], action: 'NOT_LEAD', intent: 'other' };
    });
    await engine.handleClientMessage(clientMsg(81, 'Aka mashinangizni sotasizmi?'));
    expect(gateway.textsTo(81)).toHaveLength(0);
    expect((await Lead.findOne({ chatId: 81 }))?.mode).toBe('MANUAL');
  });

  it('a meaningful but unclear first message gets the intent question once', async () => {
    const { engine, gateway, llm } = buildApp();
    llm.push({ messages: [], action: 'ASK_NEXT', intent: 'unclear' });
    await engine.handleClientMessage(clientMsg(82, 'Aka bir narsa so\'ramoqchi edim'));
    expect(gateway.textsTo(82)).toEqual(["Assalomu alaykum! Kurs bo'yicha yozyapsizmi yoki boshqa masalada?"]);
  });

  it('body photos are shown to the model as images', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(83, 'Salom, kurs haqida'));
    llm.push((req) => {
      expect(req.parts.filter((p) => p.inlineData)).toHaveLength(2);
      expect(req.parts.at(-1)!.text).toContain('2 ta rasm yubordi');
      return { messages: ["Rasmlarni ko'rdim, yaxshi asos bor", "Bo'y, ves, yoshingizni ham yozib yuboring"], action: 'ASK_NEXT', question: 1 };
    });
    (engine as unknown as { opts: { debounceMsOverride: number } }).opts.debounceMsOverride = 60_000;
    await engine.handleClientMessage(clientMsg(83, '', { kind: 'photo', photo: { fileId: 'p1' } }));
    await engine.handleClientMessage(clientMsg(83, '', { kind: 'photo', photo: { fileId: 'p2' } }));
    const lead = await Lead.findOne({ chatId: 83 });
    engine.cancel(String(lead!._id));
    await engine.process(String(lead!._id));
    expect(gateway.textsTo(83).at(-1)).toContain('yoshingizni');
  });

  it('stickers/emoji only → no reply; a flood of messages → AI steps back', async () => {
    const { engine, gateway, settings } = buildApp();
    await engine.handleClientMessage(clientMsg(84, 'Salom, kurs haqida'));
    const n = gateway.sent.length;
    await engine.handleClientMessage(clientMsg(84, '', { kind: 'sticker' }));
    await engine.handleClientMessage(clientMsg(84, '😂😂😂'));
    expect(gateway.sent.length).toBe(n);

    await settings.set({ flood_limit: 5 });
    for (let i = 0; i < 6; i++) await engine.handleClientMessage(clientMsg(85, `spam ${i} kurs`));
    const lead = await Lead.findOne({ chatId: 85 });
    expect(lead?.mode).toBe('MANUAL');
    expect(lead?.readyReason).toBe('flood');
  });

  it('always-on: AI keeps answering after the questionnaire and after the coach writes', async () => {
    const { settings, engine, gateway, llm } = buildApp();
    await settings.set({ coach_pause_minutes: 0 });
    await engine.handleClientMessage(clientMsg(86, 'Salom, kurs haqida'));
    await Lead.updateOne({ chatId: 86 }, { $set: { alwaysOn: true } });
    await engine.handleClientMessage(clientMsg(86, 'Temur bilan gaplashmoqchiman'));
    let lead = await Lead.findOne({ chatId: 86 });
    expect(lead?.status).toBe('READY');
    expect(lead?.mode).toBe('AI');
    await engine.handleCoachMessage({ connectionId: 'conn-1', chat: { id: 86 }, messageId: 5555, text: 'Salom', kind: 'text' });
    expect((await Lead.findOne({ chatId: 86 }))?.mode).toBe('AI');
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain('REJIM: anketa tugagan');
      return { messages: ["Oqsilni ko'proq yeng, uyquga e'tibor bering"], action: 'ASK_NEXT' };
    });
    await engine.handleClientMessage(clientMsg(86, 'Qanday ovqatlanay?'));
    expect(gateway.textsTo(86).at(-1)).toBe("Oqsilni ko'proq yeng, uyquga e'tibor bering");
    lead = await Lead.findOne({ chatId: 86 });
    expect(lead?.mode).toBe('AI');
  });

  it('reset clears answers and history; the bot starts from zero', async () => {
    const { engine, gateway } = buildApp();
    await engine.handleClientMessage(clientMsg(87, 'Salom, kurs haqida'));
    await engine.handleClientMessage(clientMsg(87, 'Temur bilan gaplashmoqchiman'));
    const lead = await Lead.findOne({ chatId: 87 });
    expect(await engine.resetLead(String(lead!._id))).toBe(true);
    const fresh = await Lead.findOne({ chatId: 87 });
    expect(fresh?.status).toBe('NEW');
    expect(fresh?.mode).toBe('AI');
    expect(await Message.countDocuments({ leadId: lead!._id })).toBe(0);
    await engine.handleClientMessage(clientMsg(87, 'Salom, kurs haqida'));
    expect(gateway.textsTo(87).at(-1)).toBe(FIRST);
  });
});

describe('sales stage and coach messages', () => {
  const completeQuestionnaire = {
    messages: ['Rahmat!'],
    action: 'READY',
    reason: 'completed',
    answered_current: true,
    extracted: { trainingExperience: '1 yil', goal: 'ozish', targetWeight: 80, trainingDays: 4, trainingLocation: 'zal', previousAttempts: 'vaqt', healthProblems: "yo'q" },
  };

  it('after the questionnaire the AI sells the course (offer, prices from course info) and the coach gets the card', async () => {
    const { engine, gateway, llm, settings } = buildApp();
    await settings.set({ course_info: "Individual 50 kun — 800 000 so'm. Guruh — 600 000 so'm. To'lov: karta 8600 1234 5678 9012" });
    llm.push(completeQuestionnaire);
    llm.push((req) => {
      const text = req.parts.at(-1)!.text!;
      expect(text).toContain('REJIM: SOTUV');
      expect(req.system).toContain('800 000');
      return { messages: ['Sizga individual format mos keladi', "Individual 50 kun — 800 000 so'm. Boshlaymizmi?"], action: 'ASK_NEXT' };
    });
    await engine.handleClientMessage(clientMsg(90, "Kurs: 180 95 25, 1 yil zal, 80 kg gacha, 4 kun, vaqt yetmagan, sog'man. Toshkentdaman"));
    const lead = await Lead.findOne({ chatId: 90 });
    expect(lead?.status).toBe('SALES');
    expect(lead?.mode).toBe('AI');
    expect(gateway.admin.at(-1)?.html).toContain('ANKETA TUGADI');
    expect(gateway.textsTo(90).at(-1)).toContain('Boshlaymizmi?');
  });

  it('objection is handled; payment receipt → SOLD: AI stops and the coach is told to send the group link', async () => {
    const { engine, gateway, llm, settings } = buildApp();
    await settings.set({ ai_after_sale: false });
    llm.push(completeQuestionnaire, { messages: ['Taklif...', 'Boshlaymizmi?'], action: 'ASK_NEXT' });
    await engine.handleClientMessage(clientMsg(91, 'Kurs: 180 95 25, hammasi'));
    llm.push({ messages: ["Tushunaman. Kuniga 16 ming so'mga to'g'ri keladi, natija esa butun umrga", 'Boshlaymizmi?'], action: 'ASK_NEXT' });
    await engine.handleClientMessage(clientMsg(91, 'Qimmat ekan'));
    expect(gateway.textsTo(91).at(-1)).toContain('16 ming'); // the repeated «Boshlaymizmi?» is not sent twice
    llm.push((req) => {
      expect(req.parts.filter((p) => p.inlineData)).toHaveLength(1);
      return { messages: ['Rahmat! Tekshirib, guruh linkini yuboraman'], action: 'SOLD', reason: 'paid' };
    });
    await engine.handleClientMessage(clientMsg(91, "To'ladim", { kind: 'photo', photo: { fileId: 'chek' } }));
    const lead = await Lead.findOne({ chatId: 91 });
    expect(lead?.status).toBe('READY');
    expect(lead?.readyReason).toBe('sold');
    expect(lead?.mode).toBe('MANUAL');
    expect(lead?.soldAt).toBeTruthy();
    expect(gateway.textsTo(91).at(-1)).toBe('Rahmat! Tekshirib, guruh linkini yuboraman');
    expect(gateway.admin.at(-1)?.html).toContain('SOTILDI');
    const before = gateway.sent.length;
    await engine.handleClientMessage(clientMsg(91, 'Link qachon?'));
    expect(gateway.sent.length).toBe(before); // the coach takes over from here
  });

  it('refusal ends politely and hands over', async () => {
    const { engine, llm } = buildApp();
    llm.push(completeQuestionnaire, { messages: ['Taklif', 'Boshlaymizmi?'], action: 'ASK_NEXT' });
    await engine.handleClientMessage(clientMsg(92, 'Kurs: 180 95 25, hammasi'));
    llm.push({ messages: ["Tushunarli, eshik doim ochiq. Omad!"], action: 'REFUSED' });
    await engine.handleClientMessage(clientMsg(92, 'Yoq, qiziqmayman'));
    const lead = await Lead.findOne({ chatId: 92 });
    expect(lead?.readyReason).toBe('refused');
    expect(lead?.mode).toBe('MANUAL');
  });

  it("the coach's own message does not stop the AI; it is shown to the model as the coach's words", async () => {
    const { settings, engine, gateway, llm } = buildApp();
    await settings.set({ coach_pause_minutes: 0 });
    await engine.handleClientMessage(clientMsg(93, 'Salom, kurs haqida'));
    await engine.handleCoachMessage({ connectionId: 'conn-1', chat: { id: 93 }, messageId: 7777, text: "Sizga 700 000 ga qilib beraman", kind: 'text' });
    expect((await Lead.findOne({ chatId: 93 }))?.mode).toBe('AI');
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain("Temur (O'ZI yozgan): Sizga 700 000 ga qilib beraman");
      return { messages: ["Zo'r, kelishdik", Q2_HIGH], action: 'ASK_NEXT', question: 2 };
    });
    await engine.handleClientMessage(clientMsg(93, '180 95 25 1 yil zal'));
    expect(gateway.textsTo(93).at(-1)).toContain(Q2_HIGH);
  });

  it('a coach message answers pending client messages: the AI does not answer them again', async () => {
    const { engine, gateway } = buildApp();
    await engine.handleClientMessage(clientMsg(94, 'Salom, kurs haqida'));
    const lead = await Lead.findOne({ chatId: 94 });
    (engine as unknown as { opts: { debounceMsOverride: number } }).opts.debounceMsOverride = 60_000;
    await engine.handleClientMessage(clientMsg(94, 'Narxi qancha?'));
    await engine.handleCoachMessage({ connectionId: 'conn-1', chat: { id: 94 }, messageId: 7778, text: '800 ming', kind: 'text' });
    const before = gateway.sent.length;
    await engine.process(String(lead!._id));
    expect(gateway.sent.length).toBe(before);
  });
});

describe('sales funnel goes all the way to payment', () => {
  const done = {
    messages: ['Rahmat!'],
    action: 'READY',
    reason: 'completed',
    answered_current: true,
    extracted: { trainingExperience: '1 yil', goal: 'ozish', targetWeight: 80, trainingDays: 4, trainingLocation: 'zal', previousAttempts: 'vaqt', healthProblems: "yo'q" },
  };

  it('first sales message must contain the price; agreement → exact payment details are sent; receipt → SOLD', async () => {
    const { engine, gateway, llm, settings } = buildApp();
    await settings.set({
      price_list: "Individual 50 kun — 800 000 so'm",
      payment_details: "Karta: 8600 1234 5678 9012\nTemur F.\nTo'lovdan keyin chekni yuboring",
      ask_commitment: false,
    });
    llm.push(done);
    llm.push((req) => {
      const t = req.parts.at(-1)!.text!;
      expect(t).toContain('KEYINGI QADAM: Endi taklif');
      expect(t).toContain("NARXLAR: Individual 50 kun — 800 000 so'm");
      expect(t).toContain('«savollardan keyin aytaman» qoidalari AMAL QILMAYDI');
      expect(t).not.toContain('Bazada javobi yo\'q savolga');
      return { messages: ["Sizga individual format: 50 kun, 800 000 so'm", 'Boshlaymizmi?'], action: 'ASK_NEXT', sales_step: 2 };
    });
    await engine.handleClientMessage(clientMsg(95, 'Kurs: 180 95 25, hammasi. Toshkentdaman'));
    expect(gateway.textsTo(95).at(-2)).toContain('800 000');

    // model says "here are the details" but forgets the card → backend appends the exact admin text
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain('DARHOL to\'lov ma\'lumotini ber');
      return { messages: ["Zo'r! To'lov ma'lumoti:"], action: 'ASK_NEXT', sales_step: 3 };
    });
    await engine.handleClientMessage(clientMsg(95, 'Ha boshlaymiz, qanday to\'layman?'));
    expect(gateway.textsTo(95).at(-1)).toBe("Karta: 8600 1234 5678 9012\nTemur F.\nTo'lovdan keyin chekni yuboring");
    expect((await Lead.findOne({ chatId: 95 }))?.salesStep).toBe(3);

    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain("To'lov ma'lumoti allaqachon berilgan");
      return { messages: ['Rahmat! Tekshirib, guruh linkini yuboraman'], action: 'SOLD', reason: 'paid' };
    });
    await engine.handleClientMessage(clientMsg(95, '', { kind: 'photo', photo: { fileId: 'chek' } }));
    const lead = await Lead.findOne({ chatId: 95 });
    expect(lead?.readyReason).toBe('sold');
    expect(gateway.admin.at(-1)?.html).toContain('SOTILDI');
  });

  it('a long discussion is pushed to closing after max_sales_turns', async () => {
    const { engine, llm, settings } = buildApp();
    await settings.set({ max_sales_turns: 2, price_list: '800 000' });
    llm.push(done, { messages: ['Taklif 800 000', 'Boshlaymizmi?'], action: 'ASK_NEXT', sales_step: 2 });
    await engine.handleClientMessage(clientMsg(96, 'Kurs: 180 95 25, hammasi'));
    llm.push({ messages: ['Javob 1', 'Boshlaymizmi, aka?'], action: 'ASK_NEXT', sales_step: 2 });
    await engine.handleClientMessage(clientMsg(96, 'Hmm, oylab koraman'));
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain("Suhbat cho'zildi");
      return { messages: ["To'lov ma'lumotini yuboraymi?"], action: 'ASK_NEXT', sales_step: 2 };
    });
    await engine.handleClientMessage(clientMsg(96, 'Bilmadim'));
  });

  it('the admin is warned when no price is configured', async () => {
    const { engine, gateway, llm, settings } = buildApp();
    await settings.set({ course_info: 'Onlayn kurs', price_list: '' });
    llm.push(done, { messages: ['Taklif', 'Boshlaymizmi?'], action: 'ASK_NEXT' });
    await engine.handleClientMessage(clientMsg(97, 'Kurs: 180 95 25, hammasi'));
    expect(gateway.admin.some((a) => a.html.includes('Kurs narxi kiritilmagan'))).toBe(true);
  });
});

describe("«o'ylab ko'raman», card from course info, AI after sale", () => {
  const done = {
    messages: ['Rahmat!'],
    action: 'READY',
    reason: 'completed',
    answered_current: true,
    extracted: { trainingExperience: '1 yil', goal: 'ozish', targetWeight: 80, trainingDays: 4, trainingLocation: 'zal', previousAttempts: 'vaqt', healthProblems: "yo'q" },
  };

  it("«ertaga o'ylab ko'raman» → follow-up planned inside the 24h window, sent by the reminder tick, cleared if the client writes", async () => {
    const t0 = new Date('2026-10-04T15:00:00Z'); // 20:00 in Tashkent
    let now = t0;
    const { engine, gateway, llm, reminders } = buildApp({ now: () => now });
    llm.push(done, { messages: ['Taklif 800 000', 'Boshlaymizmi?'], action: 'ASK_NEXT', sales_step: 2 });
    await engine.handleClientMessage(clientMsg(98, 'Kurs: 180 95 25, hammasi', { date: t0 }));
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain('HOZIRGI VAQT (mijoz vaqti): 2026-10-04 20:00');
      return {
        messages: ["Albatta, shoshilmang. Nima ikkilantiryapti — narxmi?", 'Hop, ertaga yozaman'],
        action: 'ASK_NEXT',
        follow_up_at: '2026-10-05 19:00',
        follow_up_note: 'oilasi bilan maslahatlashadi',
      };
    });
    await engine.handleClientMessage(clientMsg(98, "Ertaga o'ylab ko'raman, oilam bilan maslahatlashay", { date: t0 }));
    let lead = await Lead.findOne({ chatId: 98 });
    expect(lead?.followUpAt?.toISOString()).toBe('2026-10-05T14:00:00.000Z'); // 19:00 Tashkent, < 24h window
    expect(lead?.followUpNote).toContain('oilasi');

    // the normal reminders do not fire while a follow-up is planned
    now = new Date(t0.getTime() + 2 * 3600_000);
    const before = gateway.sent.length;
    expect(await reminders.tick(now)).toBe(0);
    expect(gateway.sent.length).toBe(before);

    now = new Date('2026-10-05T14:01:00Z');
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain('ESLATMA VAQTI');
      expect(req.parts.at(-1)!.text).toContain('oilasi bilan maslahatlashadi');
      return { messages: ["Assalomu alaykum! Oilangiz bilan gaplashdingizmi?"], action: 'ASK_NEXT' };
    });
    expect(await reminders.tick(now)).toBe(1);
    expect(gateway.textsTo(98).at(-1)).toBe('Assalomu alaykum! Oilangiz bilan gaplashdingizmi?');
    lead = await Lead.findOne({ chatId: 98 });
    expect(lead?.followUpAt).toBeFalsy();
    expect(lead?.followUpsSent).toBe(1);
  });

  it('a follow-up asked for the night or beyond 24h is moved to daytime / inside the window', async () => {
    const t0 = new Date('2026-10-04T15:00:00Z'); // 20:00 Tashkent
    const { engine, llm } = buildApp({ now: () => t0 });
    llm.push(done, { messages: ['Taklif', 'Boshlaymizmi?'], action: 'ASK_NEXT', sales_step: 2 });
    await engine.handleClientMessage(clientMsg(99, 'Kurs: 180 95 25, hammasi', { date: t0 }));
    llm.push({ messages: ['Hop'], action: 'ASK_NEXT', follow_up_at: '2026-10-07 12:00' });
    await engine.handleClientMessage(clientMsg(99, "Dushanba javob beraman", { date: t0 }));
    const lead = await Lead.findOne({ chatId: 99 });
    expect(lead!.followUpAt!.getTime()).toBeLessThanOrEqual(t0.getTime() + 23 * 3600_000);
  });

  it('the card number written inside «Kurs haqida» is sent exactly at the payment step', async () => {
    const { engine, gateway, llm, settings } = buildApp();
    await settings.set({ course_info: "50 kunlik kurs — 800 000 so'm.\nTo'lov kartasi: 8600 1111 2222 3333\nKarta egasi: Temur F.\nBoshqa ma'lumot" });
    llm.push(done, { messages: ['Taklif 800 000', 'Boshlaymizmi?'], action: 'ASK_NEXT', sales_step: 2 });
    await engine.handleClientMessage(clientMsg(100, 'Kurs: 180 95 25, hammasi'));
    llm.push({ messages: ["Zo'r, to'lov ma'lumoti:"], action: 'ASK_NEXT', sales_step: 3 });
    await engine.handleClientMessage(clientMsg(100, 'Boshlaymiz'));
    expect(gateway.textsTo(100).at(-1)).toBe("To'lov kartasi: 8600 1111 2222 3333\nKarta egasi: Temur F.");
  });

  it('after the sale the AI keeps chatting as the coach assistant (and never hands out the group link itself)', async () => {
    const { engine, gateway, llm } = buildApp();
    llm.push(done, { messages: ['Taklif', 'Boshlaymizmi?'], action: 'ASK_NEXT', sales_step: 2 });
    await engine.handleClientMessage(clientMsg(101, 'Kurs: 180 95 25, hammasi'));
    llm.push({ messages: ['Rahmat! Guruh linkini yuboraman'], action: 'SOLD', reason: 'paid' });
    await engine.handleClientMessage(clientMsg(101, "To'ladim"));
    let lead = await Lead.findOne({ chatId: 101 });
    expect(lead?.readyReason).toBe('sold');
    expect(lead?.mode).toBe('AI');
    expect(lead?.alwaysOn).toBe(true);
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain('Mijoz kursni sotib olgan');
      return { messages: ["Ertalab suv iching, nonushtani o'tkazib yubormang"], action: 'ASK_NEXT' };
    });
    await engine.handleClientMessage(clientMsg(101, 'Ertalab nima qilay?'));
    expect(gateway.textsTo(101).at(-1)).toContain('suv iching');
    lead = await Lead.findOne({ chatId: 101 });
    expect(lead?.mode).toBe('AI');
  });

  it('«faqat 5 savol» mode: after the questionnaire the AI stops (no selling)', async () => {
    const { engine, gateway, llm, settings } = buildApp();
    await settings.set({ sales_mode: false });
    llm.push(done);
    await engine.handleClientMessage(clientMsg(102, 'Kurs: 180 95 25, hammasi'));
    const lead = await Lead.findOne({ chatId: 102 });
    expect(lead?.status).toBe('READY');
    expect(lead?.mode).toBe('MANUAL');
    expect(gateway.admin.at(-1)?.html).toContain('YANGI LEAD');
  });
});

describe('natural selling', () => {
  it('sales stage uses Temur\'s real sales examples and the client name; questionnaire does not', async () => {
    const { StyleExample } = await import('../src/database/models/misc');
    await StyleExample.create([
      { client: 'Qimmat ekan', coach: ['Kuniga chaqsangiz ham [narx]dan tushadi holos aka'], kind: 'sales', tokens: ['qimma'] },
      { client: 'Salom', coach: ['Va alaykum assalom'], kind: 'style', tokens: ['salom'] },
    ]);
    const { engine, llm } = buildApp();
    llm.push((req) => {
      expect(req.system).not.toContain('[narx]dan tushadi');
      return { messages: ['Rahmat!'], action: 'READY', reason: 'completed', answered_current: true, extracted: { trainingExperience: '1 yil', goal: 'ozish', trainingDays: 4, trainingLocation: 'zal', previousAttempts: 'vaqt', healthProblems: "yo'q" } };
    });
    llm.push((req) => {
      expect(req.system).toContain('[narx]dan tushadi holos aka');
      expect(req.parts.at(-1)!.text).toContain('Mijoz ismi (Telegram): Ali');
      expect(req.parts.at(-1)!.text).toContain("mijozning o'z so'zlari bilan");
      expect(req.parts.at(-1)!.text).toContain('ISHLATMA');
      return { messages: ['Demak vaqt yetmagani uchun to\'xtab qolgansiz', 'Boshlaymizmi?'], action: 'ASK_NEXT', sales_step: 2 };
    });
    await engine.handleClientMessage(clientMsg(103, 'Kurs: 180 95 25, hammasi'));
  });
});

describe('no double first message (screenshot: «Kurs»)', () => {
  it('model greets and asks Q1 without "?" → sent once, no extra fixed first message', async () => {
    const { engine, gateway, llm } = buildApp();
    llm.push({
      messages: ['Assalomu alaykum', 'Ozingiz haqingizda qisqacha yozvoring: boy, ves, yosh va trenirovka tajribasi bormi'],
      action: 'ASK_NEXT',
      question: 1,
    });
    await engine.handleClientMessage(clientMsg(110, 'Kurs'));
    expect(gateway.textsTo(110)).toEqual(['Assalomu alaykum', 'Ozingiz haqingizda qisqacha yozvoring: boy, ves, yosh va trenirovka tajribasi bormi']);
  });

  it('same without the question number from the model → still recognised as a question', async () => {
    const { engine, gateway, llm } = buildApp();
    llm.push({ messages: ['Assalomu alaykum', "Bo'y, ves, yosh, tajriba bormi"], action: 'ASK_NEXT' });
    await engine.handleClientMessage(clientMsg(111, 'Kurs'));
    expect(gateway.textsTo(111)).toHaveLength(2);
  });

  it('model only greets → greeting + question 1 without a second «Assalomu alaykum»', async () => {
    const { engine, gateway, llm } = buildApp();
    llm.push({ messages: ['Assalomu alaykum'], action: 'ASK_NEXT' });
    await engine.handleClientMessage(clientMsg(112, 'Kurs'));
    const texts = gateway.textsTo(112);
    expect(texts[0]).toBe('Assalomu alaykum');
    expect(texts[1]).not.toMatch(/assalomu/i);
    expect(texts[1]).toContain("Bo'y, ves, yosh");
    expect(texts).toHaveLength(2);
  });
});

describe('bot2: voices, coach pause, context after restart, human text', () => {
  const done = {
    messages: ['Rahmat!'],
    action: 'READY',
    reason: 'completed',
    answered_current: true,
    extracted: { trainingExperience: '1 yil', goal: 'ozish', targetWeight: 80, trainingDays: 3, trainingLocation: 'zal', previousAttempts: 'reja yo\'q', healthProblems: "yo'q" },
  };

  it('asks the «nega aynan hozir» question before the offer, then offers', async () => {
    const { engine, gateway, llm } = buildApp();
    llm.push(done);
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain('Hali taklif qilma');
      return { messages: ["Oxirgi savol: nega aynan hozir boshlamoqchisiz?"], action: 'ASK_NEXT' };
    });
    await engine.handleClientMessage(clientMsg(120, 'Kurs: 175 82 24, hammasi'));
    expect(gateway.textsTo(120).at(-1)).toContain('nega aynan hozir');
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain('Endi taklif');
      return { messages: ["Demak asosiy muammo reja va nazorat yo'qligida"], action: 'ASK_NEXT', extracted: { motivation: 'bu safar jiddiy' } };
    });
    await engine.handleClientMessage(clientMsg(120, 'Bu safar jiddiyman'));
    expect((await Lead.findOne({ chatId: 120 }))?.answers?.motivation).toBe('bu safar jiddiy');
  });

  it('the model picks a stored voice clip; it is sent once from the business account, after at most one text', async () => {
    const { VoiceClip } = await import('../src/database/models/misc');
    const clip = await VoiceClip.create({ fileId: 'VOICE_FILE', title: 'guruh qanday ishlaydi', transcript: '50 kun yopiq guruh...', duration: 40 });
    const short = String(clip._id).slice(-6);
    const { engine, gateway, llm } = buildApp();
    llm.push(done, { messages: ['Oxirgi savol?'], action: 'ASK_NEXT' });
    await engine.handleClientMessage(clientMsg(121, 'Kurs: 175 82 24, hammasi'));
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain(`${short}: guruh qanday ishlaydi`);
      return { messages: ['Guruh qanday ishlashini ovozli aytib berdim', 'ikkinchi xabar', 'uchinchi'], action: 'ASK_NEXT', voice_id: short };
    });
    await engine.handleClientMessage(clientMsg(121, 'Jiddiyman'));
    expect(gateway.voices).toEqual([{ chatId: 121, fileId: 'VOICE_FILE' }]);
    expect(gateway.textsTo(121).at(-1)).toBe('Guruh qanday ishlashini ovozli aytib berdim');
    const lead = await Lead.findOne({ chatId: 121 });
    expect(lead?.sentVoiceIds).toContain(String(clip._id));
    // the same clip is never sent twice to one client
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain('[yuborilgan]');
      return { messages: ['Yana savol bormi?'], action: 'ASK_NEXT', voice_id: short };
    });
    await engine.handleClientMessage(clientMsg(121, 'Tushunarli'));
    expect(gateway.voices).toHaveLength(1);
  });

  it('when the coach writes, the AI stays silent for the pause and answers after it with the coach in context', async () => {
    let now = new Date('2026-10-06T10:00:00Z');
    const { engine, gateway, llm, settings } = buildApp({ now: () => now });
    await settings.set({ coach_pause_minutes: 30 });
    await engine.handleClientMessage(clientMsg(122, 'Salom, kurs haqida', { date: now }));
    await engine.handleCoachMessage({ connectionId: 'conn-1', chat: { id: 122 }, messageId: 9001, text: 'Salom, Temur', kind: 'text' });
    const before = gateway.sent.length;
    now = new Date(now.getTime() + 5 * 60_000);
    await engine.handleClientMessage(clientMsg(122, '180 90 25 1 yil zal', { date: now }));
    expect(gateway.sent.length).toBe(before); // paused
    now = new Date(now.getTime() + 40 * 60_000);
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain("Temur (O'ZI yozgan): Salom, Temur");
      return { messages: ['Maqsad nechiga tushish?'], action: 'ASK_NEXT', question: 2 };
    });
    await engine.retryPending(0);
    expect(gateway.textsTo(122).at(-1)).toContain('Maqsad');
  });

  it('a reply to an old message in an unknown chat continues the conversation instead of greeting from scratch', async () => {
    const { engine, gateway, llm } = buildApp();
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain("Temur (O'ZI yozgan): Narxi 150 ming won");
      return { messages: ["Ha aka, 150 ming won. Boshlaymizmi?"], action: 'ASK_NEXT' };
    });
    await engine.handleClientMessage(clientMsg(123, 'Shuni olsam bo\'ladimi', { replyTo: { text: 'Narxi 150 ming won', fromCoach: true } }));
    const texts = gateway.textsTo(123);
    expect(texts.some((t) => t.startsWith('Assalomu alaykum!'))).toBe(false);
  });

  it('pending messages are answered right after a restart (startup catch-up)', async () => {
    const { engine: first } = buildApp();
    await first.handleClientMessage(clientMsg(124, 'Salom, kurs haqida'));
    const lead = await Lead.findOne({ chatId: 124 });
    await Message.create({ leadId: lead!._id, sender: 'client', direction: 'incoming', text: '180 90 25 1 yil zal', processed: false });
    await Lead.updateOne({ _id: lead!._id }, { $set: { pendingSince: new Date() } });
    const { engine: restarted, gateway } = buildApp(); // new process, no timers
    await restarted.retryPending(0);
    expect(gateway.textsTo(124).length).toBe(1);
  });

  it('AI slop is removed before sending', async () => {
    const { humanize } = await import('../src/utils/humanize');
    expect(humanize('Ajoyib savol! **Kurs** 50 kunlik — har kuni nazorat 💪🔥🎉')).toBe('**Kurs** 50 kunlik - har kuni nazorat 💪'.replace('**Kurs**', 'Kurs'));
    expect(humanize('- birinchi\n- ikkinchi')).toBe('Birinchi\nikkinchi');
    expect(humanize('Albatta! Boshlaymiz')).toBe('Boshlaymiz');
  });
});

describe('bot2: strong but honest closer', () => {
  const done = {
    messages: ['Rahmat!'],
    action: 'READY',
    reason: 'completed',
    answered_current: true,
    extracted: { trainingExperience: '1 yil', goal: 'ozish', trainingDays: 3, trainingLocation: 'zal', previousAttempts: 'reja yo\'q', healthProblems: "yo'q" },
  };
  async function inSales(chatId: number) {
    const ctx = buildApp();
    await ctx.settings.set({ ask_commitment: false });
    ctx.llm.push(done, { messages: ["Kuniga bitta kofe puli. Boshlaymizmi?"], action: 'ASK_NEXT', sales_step: 2 });
    await ctx.engine.handleClientMessage(clientMsg(chatId, 'Kurs: 175 82 24, hammasi'));
    return ctx;
  }

  it('the first soft «no» gets one save attempt instead of a goodbye', async () => {
    const { engine, gateway, llm } = await inSales(130);
    llm.push({ messages: ['Mayli, omad'], action: 'REFUSED' });
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain('birinchi marta rad etdi');
      return { messages: ["Tushunaman. Nima to'xtatyapti, narxmi yo vaqtmi?"], action: 'ASK_NEXT' };
    });
    await engine.handleClientMessage(clientMsg(130, "Yo'q, hozircha kerakmas"));
    const lead = await Lead.findOne({ chatId: 130 });
    expect(lead?.status).toBe('SALES');
    expect(lead?.mode).toBe('AI');
    expect(gateway.textsTo(130).at(-1)).toContain('narxmi yo vaqtmi');
    // second clear no → polite goodbye, handed over
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain('avval bir marta rad etgan');
      return { messages: ["Tushunarli, fikringiz o'zgarsa yozing"], action: 'REFUSED' };
    });
    await engine.handleClientMessage(clientMsg(130, "Yo'q, rostdan kerak emas"));
    expect((await Lead.findOne({ chatId: 130 }))?.readyReason).toBe('refused');
  });

  it('«yozmang» is respected immediately — no save attempt', async () => {
    const { engine, llm } = await inSales(131);
    llm.push({ messages: ['Uzr, bezovta qilmayman'], action: 'REFUSED' });
    await engine.handleClientMessage(clientMsg(131, 'Kerak emas, boshqa yozmang'));
    expect((await Lead.findOne({ chatId: 131 }))?.readyReason).toBe('refused');
  });

  it('the sales script is a closer: value before price, small yeses, no fake urgency', async () => {
    const { settings } = buildApp();
    const script = await settings.get('sales_prompt');
    for (const s of ["Og'riqni aniqla", 'Ijtimoiy isbot', 'kunlikka', "Kichik «ha»lar", 'Birinchi «yo\'q» — oxiri emas', 'Soxta shoshilinchlik']) {
      expect(script).toContain(s);
    }
  });
});

describe('bot2: won for Korea, so\'m for Uzbekistan', () => {
  const done = {
    messages: ['Rahmat!'],
    action: 'READY',
    reason: 'completed',
    answered_current: true,
    extracted: { trainingExperience: '1 yil', goal: 'ozish', trainingDays: 3, trainingLocation: 'zal', previousAttempts: 'reja yo\'q', healthProblems: "yo'q" },
  };
  async function inSales(chatId: number) {
    const ctx = buildApp();
    await ctx.settings.set({ ask_commitment: false });
    ctx.llm.push(done, { messages: ['Taklif', 'Shartlar ma\'qulmi?'], action: 'ASK_NEXT', sales_step: 1 });
    await ctx.engine.handleClientMessage(clientMsg(chatId, 'Kurs: 175 82 24, hammasi'));
    return ctx;
  }

  it('country unknown → no price is sent; the bot asks «Koreyadamisiz yo O\'zbekistonda?» first', async () => {
    const { engine, gateway, llm } = await inSales(140);
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain("MIJOZ DAVLATI: noma'lum");
      return { messages: ['Narxi 150 ming won'], action: 'ASK_NEXT' };
    });
    await engine.handleClientMessage(clientMsg(140, 'Narxi qancha?'));
    expect(gateway.textsTo(140).at(-1)).toBe("Qayerdasiz, Koreyadamisiz yo O'zbekistonda?");
  });

  it("client in Korea never gets a so'm price — the text is replaced with the Korea price line", async () => {
    const { engine, gateway, llm } = await inSales(141);
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain('MIJOZ DAVLATI: Koreya');
      expect(req.parts.at(-1)!.text).toContain('faqat won');
      return { messages: ["Narxi 1 mln so'm", 'Boshlaymizmi?'], action: 'ASK_NEXT' };
    });
    await engine.handleClientMessage(clientMsg(141, 'Koreadaman, narxi qancha?'));
    const texts = gateway.textsTo(141);
    expect(texts.at(-2)).toBe('Koreyadagilar uchun: 150,000 KRW');
    expect(texts.some((t) => t.includes("1 mln so'm"))).toBe(false);
    expect((await Lead.findOne({ chatId: 141 }))?.answers?.country).toBe('Koreya');
  });

  it('only the price voice of the client\'s country is offered and sent', async () => {
    const { VoiceClip } = await import('../src/database/models/misc');
    const kr = await VoiceClip.create({ fileId: 'KR_PRICE', title: 'narx', transcript: '150 ming won', country: 'KR' });
    const uz = await VoiceClip.create({ fileId: 'UZ_PRICE', title: 'narx', transcript: '1 million so\'m', country: 'UZ' });
    const { engine, gateway, llm } = await inSales(142);
    llm.push((req) => {
      const t = req.parts.at(-1)!.text!;
      expect(t).toContain(String(uz._id).slice(-6));
      expect(t).not.toContain(String(kr._id).slice(-6));
      // the model tries the wrong one anyway → blocked
      return { messages: ['Narxni ovozli aytdim'], action: 'ASK_NEXT', voice_id: String(kr._id).slice(-6) };
    });
    await engine.handleClientMessage(clientMsg(142, "Toshkentdaman. Narxi?"));
    expect(gateway.voices).toHaveLength(0);
    llm.push({ messages: ['Mana'], action: 'ASK_NEXT', voice_id: String(uz._id).slice(-6) });
    await engine.handleClientMessage(clientMsg(142, 'Ha ayting'));
    expect(gateway.voices).toEqual([{ chatId: 142, fileId: 'UZ_PRICE' }]);
  });

  it('clip country is guessed from caption / transcript', async () => {
    const { guessClipCountry, detectCountry } = await import('../src/utils/country');
    expect(guessClipCountry('narx koreya — 150 ming won')).toBe('KR');
    expect(guessClipCountry("narxi 1 million so'm")).toBe('UZ');
    expect(guessClipCountry('guruh qanday ishlaydi')).toBe('ALL');
    expect(detectCountry('Koreyadaman')).toBe('KR');
    expect(detectCountry('Uzbda man')).toBe('UZ');
    expect(detectCountry('Москвада яшайман')).toBe('OTHER');
  });
});

describe('bot2: results link', () => {
  it('client asks about results → the admin link is sent once with a short line; never repeated', async () => {
    const { engine, gateway, llm, settings } = buildApp();
    await settings.set({ results_link: 'https://t.me/temurfit_natijalar' });
    await engine.handleClientMessage(clientMsg(150, 'Salom, kurs haqida'));
    // the model forgets the link → backend adds it
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain('NATIJALAR HAVOLASI: https://t.me/temurfit_natijalar');
      return { messages: ["Ha, ko'p odam natija qilgan", "Bo'y, ves, yosh, tajriba bormi?"], action: 'ASK_NEXT', question: 1 };
    });
    await engine.handleClientMessage(clientMsg(150, 'Natijalar bormi? Ishonmayman'));
    const texts = gateway.textsTo(150);
    expect(texts).toContain("O'quvchilarimiz natijalari shu yerda, ko'rib chiqing: https://t.me/temurfit_natijalar");
    expect(texts.at(-1)).toContain('tajriba bormi');
    expect((await Lead.findOne({ chatId: 150 }))?.resultsLinkSent).toBe(true);
    // asked again → not repeated
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain('allaqachon yuborilgan');
      return { messages: ['Yuqorida tashlagan edim. Yoshingiz nechida?'], action: 'ASK_NEXT', question: 1 };
    });
    await engine.handleClientMessage(clientMsg(150, 'Yana natija bormi?'));
    expect(gateway.textsTo(150).filter((t) => t.includes('https://t.me/temurfit_natijalar'))).toHaveLength(1);
  });

  it('no link configured → nothing is added', async () => {
    const { engine, gateway } = buildApp();
    await engine.handleClientMessage(clientMsg(151, 'Salom, kurs haqida'));
    await engine.handleClientMessage(clientMsg(151, 'Natijalar bormi?'));
    expect(gateway.textsTo(151).some((t) => t.includes('http'))).toBe(false);
  });

  it('trimming to 2 messages never drops the link', async () => {
    const { trimMessages } = await import('../src/conversations/engine');
    expect(trimMessages(['a', 'Natijalar: https://t.me/x', 'b', 'Savol?'], 2)).toEqual(['a', 'Natijalar: https://t.me/x', 'Savol?']);
  });
});

describe('bot2: payment by country and start info', () => {
  const done = {
    messages: ['Rahmat!'],
    action: 'READY',
    reason: 'completed',
    answered_current: true,
    extracted: { trainingExperience: '1 yil', goal: 'ozish', trainingDays: 3, trainingLocation: 'zal', previousAttempts: 'reja yo\'q', healthProblems: "yo'q" },
  };
  const KR = "Woori bank: 1002-063-833262\nEgasi: Temur F.\nSumma: 150,000 KRW";
  const UZ = "Karta: 8600 1234 5678 9012\nTemur F.\nSumma: 1,000,000 so'm";
  async function ready(chatId: number, first: string) {
    const ctx = buildApp();
    await ctx.settings.set({ ask_commitment: false, payment_details_kr: KR, payment_details_uz: UZ });
    ctx.llm.push(done, { messages: ['Boshlaymizmi?'], action: 'ASK_NEXT', sales_step: 2 });
    await ctx.engine.handleClientMessage(clientMsg(chatId, first));
    return ctx;
  }

  it('Korea client gets the won account, Uzbekistan client gets the so\'m card — verbatim', async () => {
    const a = await ready(160, 'Kurs: 175 82 24, hammasi. Koreadaman');
    a.llm.push({ messages: ["Zo'r, to'lov ma'lumoti:"], action: 'ASK_NEXT', sales_step: 3 });
    await a.engine.handleClientMessage(clientMsg(160, 'Boshlaymiz'));
    expect(a.gateway.textsTo(160).at(-1)).toBe(KR);

    const b = await ready(161, 'Kurs: 175 82 24, hammasi. Toshkentdaman');
    b.llm.push({ messages: ["Zo'r, to'lov ma'lumoti:"], action: 'ASK_NEXT', sales_step: 3 });
    await b.engine.handleClientMessage(clientMsg(161, 'Boshlaymiz'));
    expect(b.gateway.textsTo(161).at(-1)).toBe(UZ);
  });

  it('country unknown at the payment step → asks the country, no card yet', async () => {
    const c = await ready(162, 'Kurs: 175 82 24, hammasi');
    c.llm.push({ messages: ["Zo'r, to'lov ma'lumoti:"], action: 'ASK_NEXT', sales_step: 3 });
    await c.engine.handleClientMessage(clientMsg(162, 'Boshlaymiz'));
    const texts = c.gateway.textsTo(162);
    expect(texts.at(-1)).toBe("Qayerdasiz, Koreyadamisiz yo O'zbekistonda?");
    expect(texts.some((t) => t.includes('8600') || t.includes('1002'))).toBe(false);
    expect((await Lead.findOne({ chatId: 162 }))?.salesStep).toBeLessThan(3);
    // then the client answers → the right card goes out
    c.llm.push({ messages: ['Hop, mana:'], action: 'ASK_NEXT', sales_step: 3 });
    await c.engine.handleClientMessage(clientMsg(162, 'Koreyadaman'));
    expect(c.gateway.textsTo(162).at(-1)).toBe(KR);
  });

  it('«qachon boshlanadi» — the start info is in the knowledge base', async () => {
    const { engine, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(163, 'Salom, kurs haqida'));
    llm.push((req) => {
      expect(req.system).toContain("QACHON BOSHLANADI / TO'LOVDAN KEYIN: To'lovdan keyin chekni va rasmlaringizni");
      return { messages: ["To'lovdan keyin ratsion tuzib beraman, keyin boshlaysiz. Bo'y, ves, yosh?"], action: 'ASK_NEXT', question: 1 };
    });
    await engine.handleClientMessage(clientMsg(163, 'Qachondan boshlanadi?'));
  });

  it('bank account inside «Kurs haqida» is found as payment info', async () => {
    const { paymentFromInfo } = await import('../src/conversations/engine');
    expect(paymentFromInfo("Kurs 50 kun\nWoori bank hisob: 1002063833262\nEgasi: Temur")).toBe('Woori bank hisob: 1002063833262\nEgasi: Temur');
  });
});

describe('Uzbek in Cyrillic is Uzbek, not Russian', () => {
  it('detection: «Курс» is ambiguous, Uzbek Cyrillic is uz, Russian is ru', async () => {
    const { detectLanguage, detectScript } = await import('../src/utils/text');
    expect(detectLanguage('Курс')).toBeUndefined();
    expect(detectLanguage('Курсингиз нархи канча?')).toBe('uz');
    expect(detectLanguage('Салом ака курс керак эди')).toBe('uz');
    expect(detectLanguage('Мен озмокчиман')).toBe('uz');
    expect(detectLanguage('Здравствуйте, хочу на курс')).toBe('ru');
    expect(detectLanguage('Сколько стоит курс?')).toBe('ru');
    expect(detectScript('Курс')).toBe('cyrl');
  });

  it('transliteration Latin → Uzbek Cyrillic keeps links, codes and card numbers', async () => {
    const { uzLatinToCyrillic, isConvertibleLatin } = await import('../src/utils/translit');
    expect(uzLatinToCyrillic("Assalomu alaykum! O'zingiz haqingizda qisqacha ma'lumot")).toBe('Ассалому алайкум! Ўзингиз ҳақингизда қисқача маълумот');
    expect(uzLatinToCyrillic('Koreyadagilar uchun: 150,000 KRW')).toBe('Кореядагилар учун: 150,000 KRW');
    expect(isConvertibleLatin('Karta: 8600 1234 5678 9012')).toBe(false);
  });

  it('client writes «Курс» in Cyrillic → bot answers in Uzbek Cyrillic, never switches to Russian', async () => {
    const { engine, gateway, llm } = buildApp();
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain("O'ZBEK, KIRILL alifbosida");
      // the model wrongly thinks it is Russian
      return { messages: ['Assalomu alaykum'], action: 'ASK_NEXT', language: 'ru' };
    });
    await engine.handleClientMessage(clientMsg(170, 'Курс'));
    const lead = await Lead.findOne({ chatId: 170 });
    expect(lead?.language).toBe('uz');
    expect(lead?.uzScript).toBe('cyrl');
    const texts = gateway.textsTo(170);
    expect(texts.join(' ')).toMatch(/Ассалому алайкум/);
    expect(texts.join(' ')).toMatch(/Бўй, вес, ёш/);
    expect(texts.join(' ')).not.toMatch(/Здравствуйте|Рост, вес, возраст/);
  });

  it('a real Russian client still gets Russian', async () => {
    const { engine, gateway } = buildApp();
    await engine.handleClientMessage(clientMsg(171, 'Здравствуйте, хочу на курс'));
    expect(gateway.textsTo(171).join(' ')).toMatch(/Здравствуйте|Рост, вес, возраст/);
    expect((await Lead.findOne({ chatId: 171 }))?.language).toBe('ru');
  });
});

describe('bot2: «karta tashen» always gets the card (or the coach)', () => {
  const done = {
    messages: ['Rahmat!'],
    action: 'READY',
    reason: 'completed',
    answered_current: true,
    extracted: { trainingExperience: '1 yil', goal: 'ozish', trainingDays: 3, trainingLocation: 'zal', previousAttempts: 'reja yo\'q', healthProblems: "yo'q" },
  };
  const KR = 'Woori bank: 1002-063-833262\nEgasi: Temur F.\nSumma: 150,000 KRW';

  it('screenshot case: the model says «hozir tashlayman» without sales_step 3 → the real card is sent anyway', async () => {
    const { engine, gateway, llm, settings } = buildApp();
    await settings.set({ ask_commitment: false, payment_details_kr: KR });
    llm.push(done, { messages: ['Boshlaymizmi?'], action: 'ASK_NEXT', sales_step: 2 });
    await engine.handleClientMessage(clientMsg(180, 'Kurs: 175 82 24, hammasi. Koreadaman'));
    llm.push({ messages: ["Bo'ldi aka, Koreyadagilar uchun 150,000 KRW", 'Hozir karta raqamni tashlayman'], action: 'ASK_NEXT', sales_step: 2 });
    await engine.handleClientMessage(clientMsg(180, 'Karta raqam tashen'));
    const texts = gateway.textsTo(180);
    expect(texts.at(-1)).toBe(KR);
    expect(texts).not.toContain('Hozir karta raqamni tashlayman');
    expect((await Lead.findOne({ chatId: 180 }))?.salesStep).toBe(3);
    // asked again → sent again
    llm.push({ messages: ['Mana aka'], action: 'ASK_NEXT', sales_step: 3 });
    await engine.handleClientMessage(clientMsg(180, 'Qani karta?'));
    expect(gateway.textsTo(180).filter((t) => t === KR)).toHaveLength(2);
  });

  it('no payment details configured → no empty promises: one honest line, urgent hand-over to the coach', async () => {
    const { engine, gateway, llm, settings } = buildApp();
    await settings.set({ ask_commitment: false, price_list: 'Koreyadagilar uchun: 150,000 KRW', course_info: 'Kurs' });
    llm.push(done, { messages: ['Boshlaymizmi?'], action: 'ASK_NEXT', sales_step: 2 });
    await engine.handleClientMessage(clientMsg(181, 'Kurs: 175 82 24, hammasi. Koreadaman'));
    llm.push({ messages: ['Hozir karta raqamni tashlayman'], action: 'ASK_NEXT', sales_step: 3 });
    await engine.handleClientMessage(clientMsg(181, 'Karta raqam tashen'));
    expect(gateway.textsTo(181).at(-1)).toBe("Hop, hozir karta raqamini o'zim tashlayman");
    const lead = await Lead.findOne({ chatId: 181 });
    expect(lead?.readyReason).toBe('payment_request');
    expect(lead?.urgent).toBe(true);
    expect(lead?.mode).toBe('MANUAL');
    expect(gateway.admin.some((a) => a.html.includes("KARTA SO'RAYAPTI"))).toBe(true);
    expect(gateway.admin.some((a) => a.html.includes("to'lov ma'lumoti kiritilmagan"))).toBe(true);
  });

  it('client wants to pay in the middle of the questionnaire → goes straight to payment', async () => {
    const { engine, gateway, llm, settings } = buildApp();
    await settings.set({ payment_details_kr: KR });
    await engine.handleClientMessage(clientMsg(182, 'Salom, kurs haqida'));
    llm.push({ messages: ['Zo\'r aka'], action: 'ASK_NEXT', sales_step: 3 });
    await engine.handleClientMessage(clientMsg(182, "Koreadaman, savollarsiz to'layman, karta tashlang"));
    expect(gateway.textsTo(182).at(-1)).toBe(KR);
    expect((await Lead.findOne({ chatId: 182 }))?.status).toBe('SALES');
  });
});

describe('bot2: screenshot «qayerdaligini so\'ramagan va javob bermagan»', () => {
  const done = {
    messages: ['Rahmat!'],
    action: 'READY',
    reason: 'completed',
    answered_current: true,
    extracted: { trainingExperience: '1 yil', goal: 'ozish', trainingDays: 3, trainingLocation: 'zal', previousAttempts: 'reja yo\'q', healthProblems: "yo'q" },
  };
  const KR = 'Woori bank: 1002-063-833262\nEgasi: Temur F.\nSumma: 150,000 KRW';

  it('a voice that cannot be transcribed → honest «yozib yuborsangiz», never «Tushunarli», admin is told', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(190, 'Salom, kurs haqida'));
    const calls = llm.calls.filter((c) => c.json).length;
    llm.transcript = '';
    await engine.handleClientMessage(clientMsg(190, '', { kind: 'voice', voice: { fileId: 'bad' } }));
    expect(gateway.textsTo(190).at(-1)).toBe('Aka, hozir ovozli eshitolmayapman, yozib yuborsangiz');
    expect(gateway.textsTo(190)).not.toContain('Tushunarli');
    expect(llm.calls.filter((c) => c.json).length).toBe(calls); // no guessing by the model
    expect(gateway.admin.some((a) => /ovoz/i.test(a.html))).toBe(true);
    // the next text message is answered normally
    llm.transcript = 'transkript matni';
    llm.push({ messages: ['Hop aka. Bo\'y, ves, yosh?'], action: 'ASK_NEXT', question: 1 });
    await engine.handleClientMessage(clientMsg(190, 'Kurs narxi qancha?'));
    expect(gateway.textsTo(190).at(-1)).toContain("Bo'y, ves, yosh?");
  });

  it('«ha» is not a sale: SOLD without a receipt → payment step, the card is sent, chat stays with the AI', async () => {
    const { engine, gateway, llm, settings } = buildApp();
    await settings.set({ ask_commitment: false, payment_details_kr: KR });
    llm.push(done, { messages: ['Boshlaymizmi?'], action: 'ASK_NEXT', sales_step: 2 });
    await engine.handleClientMessage(clientMsg(191, 'Kurs: 175 82 24, hammasi. Koreadaman'));
    llm.push({ messages: [], action: 'SOLD', reason: 'agreed' });
    await engine.handleClientMessage(clientMsg(191, 'Ha'));
    const lead = await Lead.findOne({ chatId: 191 });
    expect(lead?.status).toBe('SALES');
    expect(lead?.mode).toBe('AI');
    expect(gateway.textsTo(191).at(-1)).toBe(KR);
  });

  it('country unknown → «to\'lov ma\'lumotini yuboraymi?» is replaced by the country question', async () => {
    const { engine, gateway, llm, settings } = buildApp();
    await settings.set({ ask_commitment: false, payment_details_kr: KR, payment_details_uz: 'Karta: 8600 0000 0000 0000' });
    llm.push(done, { messages: ['Boshlaymizmi?'], action: 'ASK_NEXT', sales_step: 2 });
    await engine.handleClientMessage(clientMsg(192, 'Kurs: 175 82 24, hammasi'));
    llm.push({ messages: ["Zo'r, to'lov ma'lumotini yuboraymi?"], action: 'ASK_NEXT', sales_step: 2 });
    await engine.handleClientMessage(clientMsg(192, "Bo'ladi"));
    expect(gateway.textsTo(192).at(-1)).toBe("Qayerdasiz, Koreyadamisiz yo O'zbekistonda?");
  });

  it('«800 mingga bo\'ladimi?» — the discount policy is in the prompt and the AI keeps selling', async () => {
    const { engine, gateway, llm, settings } = buildApp();
    await settings.set({ ask_commitment: false, discount_policy: 'Chegirma yo\'q, lekin 2 kishi kelsa 10%' });
    llm.push(done, { messages: ['Boshlaymizmi?'], action: 'ASK_NEXT', sales_step: 2 });
    await engine.handleClientMessage(clientMsg(193, 'Kurs: 175 82 24, hammasi. Toshkentdaman'));
    llm.push((req) => {
      expect(req.parts.at(-1)!.text).toContain("CHEGIRMA QOIDASI: Chegirma yo'q, lekin 2 kishi kelsa 10%");
      return { messages: ["Chegirma yo'q aka, lekin do'stingiz bilan kelsangiz 10%"], action: 'ASK_NEXT', sales_step: 2 };
    });
    await engine.handleClientMessage(clientMsg(193, "Bo'ladimi 800ming bersam"));
    expect(gateway.textsTo(193).at(-1)).toContain('10%');
    expect((await Lead.findOne({ chatId: 193 }))?.mode).toBe('AI');
  });

  it('client waits after the hand-over and the coach is silent → admin is reminded (max once per interval)', async () => {
    const { engine, gateway, llm, reminders } = buildApp();
    await engine.handleClientMessage(clientMsg(194, 'Salom, kurs haqida'));
    llm.push({ messages: [], action: 'READY', reason: 'wants_coach' });
    await engine.handleClientMessage(clientMsg(194, "Temur akaning o'zi bilan gaplashsam bo'ladimi?"));
    expect(gateway.textsTo(194).at(-1)).toBe("Hop, buni o'zim alohida gaplashib ko'raman, hozir yozaman");
    await engine.handleClientMessage(clientMsg(194, 'Javob kutyapman'));
    const now = new Date(Date.now() + 16 * 60_000);
    const before = gateway.admin.length;
    expect(await reminders.nudgeCoach(now)).toBe(1);
    expect(gateway.admin.slice(before).some((a) => a.html.includes('javobingizni kutyapti'))).toBe(true);
    expect(await reminders.nudgeCoach(new Date(now.getTime() + 60_000))).toBe(0);
  });
});
