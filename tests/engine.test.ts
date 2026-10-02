import { describe, expect, it } from 'vitest';
import { Lead } from '../src/database/models/Lead';
import { Message } from '../src/database/models/Message';
import { Campaign } from '../src/database/models/misc';
import { buildApp, clientMsg, LlmError, useDatabase } from './helpers';

useDatabase();

const FIRST = "Assalomu alaykum! O'zingiz haqingizda qisqacha ma'lumot berib yubora olasizmi? Bo'y, ves, yosh. Trenirovka tajribangiz bormi?";
const Q2_HIGH = 'Tushunarli. Maqsad nechiga tushish? Qancha vazn norma hisoblaysiz?';
const Q2_LOW = 'Tushunarli. Maqsad massa olishmi? Necha kiloga chiqmoqchisiz?';
const Q2_MID = 'Tushunarli. Maqsad nima: ozishmi, massa olishmi yoki shaklga kirish?';
const Q3 = 'Haftasiga necha kun trenirovkaga vaqt ajrata olasiz? Zaldami yoki uyda?';
const Q4 = "Oldin harakat qilib ko'rganmisiz? Nima xalaqit bergan?";
const Q5 = "Sog'lig'ingizda muammo bormi? Bel, tizza, grija, bosim, qand?";

describe('questionnaire flow', () => {
  it('1. new client gets exactly the first message and status QUESTIONNAIRE', async () => {
    const { engine, gateway } = buildApp();
    await engine.handleClientMessage(clientMsg(10, 'Salom'));
    expect(gateway.textsTo(10)).toEqual([FIRST]);
    const lead = await Lead.findOne({ chatId: 10 });
    expect(lead?.status).toBe('QUESTIONNAIRE');
    expect(lead?.mode).toBe('AI');
    expect(gateway.typing).toBeGreaterThan(0); // "yozmoqda" shown before reply
  });

  it('2–6. walks through all five questions one at a time and ends with Tushunarli + [TAYYOR]', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(11, 'Salom'));
    // Q1 answer → TMI 29.3 → Q2 high variant
    await engine.handleClientMessage(clientMsg(11, "180 bo'yim 95 kg 24 yosh, 2 yildan beri zalga boraman"));
    expect(gateway.textsTo(11).at(-1)).toBe(Q2_HIGH);
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
    expect(gateway.textsTo(11).at(-1)).toBe(Q5);

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
    await engine.handleClientMessage(clientMsg(12, 'Salom'));
    await engine.handleClientMessage(clientMsg(12, '180/60/22 tajriba yo\'q'));
    expect(gateway.textsTo(12).at(-1)).toBe(Q2_LOW);
    await engine.handleClientMessage(clientMsg(13, 'Salom'));
    await engine.handleClientMessage(clientMsg(13, "22 yoshman, 178 bo'y, 72 kg, 1 yil zal"));
    expect(gateway.textsTo(13).at(-1)).toBe(Q2_MID);
  });

  it('7. all answers in one message → skips answered questions and finishes', async () => {
    const { engine, gateway, llm } = buildApp();
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
    await engine.handleClientMessage(clientMsg(15, 'Salom'));
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
    await engine.handleClientMessage(clientMsg(16, 'Salom'));
    await engine.handleClientMessage(clientMsg(16, '180 90 25, 1 yil zal'));
    llm.push((req) => {
      expect(req.parts[0].text).toContain("Narx/kurs savoliga javob: «Savollardan keyin o'zim batafsil aytaman»");
      return { messages: ["Savollardan keyin o'zim batafsil aytaman", Q2_HIGH], action: 'ASK_NEXT', answered_current: false, question: 2 };
    });
    await engine.handleClientMessage(clientMsg(16, 'Narxi qancha?'));
    expect(gateway.textsTo(16).slice(-2)).toEqual(["Savollardan keyin o'zim batafsil aytaman", Q2_HIGH]);
    expect((await Lead.findOne({ chatId: 16 }))?.mode).toBe('AI');
  });

  it('9. "Botmisiz?" → honest answer, AI stops, card sent', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(17, 'Salom'));
    await engine.handleClientMessage(clientMsg(17, 'Botmisiz?'));
    expect(gateway.textsTo(17).at(-1)).toBe(
      "Ha, savollarga AI-yordamchim javob beryapti, lekin hammasini o'zim ko'rib turibman. Hozir o'zim yozaman.",
    );
    const lead = await Lead.findOne({ chatId: 17 });
    expect(lead?.status).toBe('READY');
    expect(lead?.mode).toBe('MANUAL');
    expect(lead?.readyReason).toBe('bot_question');
    expect(llm.calls.filter((c) => c.json)).toHaveLength(0); // handled by backend rule
  });

  it('9b. model-detected bot question (no keyword) is also handled honestly', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(18, 'Salom'));
    llm.push({ messages: ['[TAYYOR]'], action: 'READY', reason: 'bot_question' });
    await engine.handleClientMessage(clientMsg(18, 'Rostini ayting, men robot bilan yozishyapmanmi?'));
    expect(gateway.textsTo(18).at(-1)).toContain('AI-yordamchim');
    expect((await Lead.findOne({ chatId: 18 }))?.mode).toBe('MANUAL');
  });

  it('10. client asks for TEMUR → Tushunarli, [TAYYOR]', async () => {
    const { engine, gateway } = buildApp();
    await engine.handleClientMessage(clientMsg(19, 'Salom'));
    await engine.handleClientMessage(clientMsg(19, 'Temur bilan gaplashmoqchiman'));
    expect(gateway.textsTo(19).at(-1)).toBe('Tushunarli');
    const lead = await Lead.findOne({ chatId: 19 });
    expect(lead?.readyReason).toBe('wants_coach');
    expect(lead?.urgent).toBe(false);
  });

  it('11/15. dangerous behaviour → only Tushunarli, [TAYYOR: ehtiyot], urgent card on top', async () => {
    const { engine, gateway } = buildApp();
    await engine.handleClientMessage(clientMsg(20, 'Salom'));
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
    await engine.handleClientMessage(clientMsg(21, 'Salom'));
    llm.push({ messages: ['Tushunarli\n[TAYYOR: ehtiyot]'], action: 'URGENT_READY', reason: 'safety' });
    await engine.handleClientMessage(clientMsg(21, 'Bir haftadan beri faqat suv ichib yuribman'));
    expect(gateway.textsTo(21).at(-1)).toBe('Tushunarli');
    expect((await Lead.findOne({ chatId: 21 }))?.urgent).toBe(true);
  });

  it('12. target BMI < 18.5 → [TAYYOR: ehtiyot]', async () => {
    const { engine, gateway } = buildApp();
    await engine.handleClientMessage(clientMsg(22, 'Salom'));
    await engine.handleClientMessage(clientMsg(22, "170 bo'y 60 kg 19 yosh, tajriba yo'q"));
    await engine.handleClientMessage(clientMsg(22, '50 kg gacha tushmoqchiman'));
    const lead = await Lead.findOne({ chatId: 22 });
    expect(lead?.targetBmi).toBe(17.3);
    expect(lead?.urgent).toBe(true);
    expect(lead?.readyReason).toBe('low_target_bmi');
    expect(gateway.textsTo(22).at(-1)).toBe('Tushunarli');
  });

  it('13. TEMUR writes manually → AI never answers again in that chat', async () => {
    const { engine, gateway } = buildApp();
    await engine.handleClientMessage(clientMsg(23, 'Salom'));
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
    await engine.handleClientMessage(clientMsg(24, 'Salom'));
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
    expect(gateway.textsTo(25).at(-1)).toBe('Понятно. Цель — до скольки похудеть? Какой вес считаете нормой?');
    expect((await Lead.findOne({ chatId: 25 }))?.language).toBe('ru');
  });

  it('18. Uzbek client and language switch mid-conversation is followed', async () => {
    const { engine, gateway } = buildApp();
    await engine.handleClientMessage(clientMsg(26, 'Assalomu alaykum'));
    expect(gateway.textsTo(26)[0]).toBe(FIRST);
    await engine.handleClientMessage(clientMsg(26, 'Рост 180, вес 70, 25 лет, опыта нет'));
    expect(gateway.textsTo(26).at(-1)).toBe('Понятно. Какая цель: похудеть, набрать массу или прийти в форму?');
  });

  it('21. source tracking from a chat-link prefilled message', async () => {
    const { engine, gateway } = buildApp();
    await Campaign.create({ code: '#v1', source: 'video_01' });
    await Campaign.create({ code: '#v2', source: 'video_02' });
    await engine.handleClientMessage(clientMsg(27, 'Salom! #v2'));
    await engine.handleClientMessage(clientMsg(28, 'Salom! 1-videodan keldim'));
    await engine.handleClientMessage(clientMsg(29, 'Salom #target_mass'));
    await engine.handleClientMessage(clientMsg(30, 'Salom'));
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
    const { engine, gateway, llm } = buildApp();
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
    await engine.handleClientMessage(clientMsg(32, 'Salom'));
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
    expect(gateway.textsTo(32).at(-1)).toBe(Q2_HIGH);
  });

  it('invalid model output is rejected by Zod and never sent', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(33, 'Salom'));
    const before = gateway.sent.length;
    llm.push({ foo: 'bar' }, { action: 'DANCE' }, { messages: 'x' });
    await engine.handleClientMessage(clientMsg(33, '180 90 25 1 yil'));
    expect(gateway.sent.length).toBe(before);
  });

  it('wrong question from the model is corrected to the backend question', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(34, 'Salom'));
    llm.push({ messages: ['Tushunarli', Q5], action: 'ASK_NEXT', answered_current: true, question: 5 });
    await engine.handleClientMessage(clientMsg(34, '180 90 25 1 yil zal'));
    expect(gateway.textsTo(34).at(-1)).toBe(Q2_HIGH);
  });

  it('bot paused / connection closed while sending → AI stops for that chat', async () => {
    const { engine, gateway } = buildApp();
    gateway.failSend = Object.assign(new Error('Forbidden: BUSINESS_PEER_USAGE_MISSING'), { error_code: 403 });
    await engine.handleClientMessage(clientMsg(35, 'Salom'));
    expect((await Lead.findOne({ chatId: 35 }))?.mode).toBe('MANUAL');
  });

  it('voice note is transcribed and processed like text', async () => {
    const { engine, gateway, llm } = buildApp();
    await engine.handleClientMessage(clientMsg(36, 'Salom'));
    llm.transcript = "bo'yim 180 vazn 90 kg 25 yosh bir yil zal";
    await engine.handleClientMessage(clientMsg(36, '', { kind: 'voice', voice: { fileId: 'f1' } }));
    const lead = await Lead.findOne({ chatId: 36 });
    expect(lead?.answers?.height).toBe(180);
    expect(gateway.textsTo(36).at(-1)).toBe(Q2_HIGH);
  });

  it('global AI switch off → new chats are MANUAL and get no messages', async () => {
    const { engine, gateway, settings } = buildApp();
    await settings.set({ ai_enabled: false });
    await engine.handleClientMessage(clientMsg(37, 'Salom'));
    expect(gateway.sent).toHaveLength(0);
  });

  it('admin-edited question texts are used immediately', async () => {
    const { engine, gateway, settings } = buildApp();
    await settings.set({ first_message_uz: 'Salom! Boy, ves, yosh?' });
    await engine.handleClientMessage(clientMsg(38, 'Salom'));
    expect(gateway.textsTo(38)).toEqual(['Salom! Boy, ves, yosh?']);
  });

  it('style examples and coach info reach the LLM prompt; system prompt edits apply', async () => {
    const { engine, llm, settings } = buildApp();
    await settings.set({ coach_info: 'Koreyada yashaydi', system_prompt: 'MAXSUS PROMPT {{coach_name}}' });
    await engine.handleClientMessage(clientMsg(39, 'Salom'));
    await engine.handleClientMessage(clientMsg(39, '180 90 25 1 yil'));
    const call = llm.calls.find((c) => c.json)!;
    expect(call.system).toContain('MAXSUS PROMPT Temur');
    expect(call.system).toContain('USLUB PROFILI');
    expect(call.system).toContain('TEXNIK QOIDALAR');
  });
});
