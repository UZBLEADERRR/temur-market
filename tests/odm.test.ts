import { describe, expect, it } from 'vitest';
import { Lead } from '../src/database/models/Lead';
import { Message } from '../src/database/models/Message';
import { Campaign, SettingsDoc, StyleExample } from '../src/database/models/misc';
import { getPool } from '../src/database/odm';
import { useDatabase } from './helpers';

useDatabase();

/**
 * Moslik qatlami uchun testlar. Butun loyiha shu faylga suyanadi, shuning
 * uchun uning har bir imkoniyati alohida tekshiriladi: boshqa testlar
 * buzilganda sabab shu yerdan ko'rinadi.
 */

const base = { businessConnectionId: 'c', mode: 'MANUAL' as const };
let n = 0;
const mkLead = (extra: Record<string, unknown> = {}) => {
  n += 1;
  return Lead.create({ ...base, chatId: n, telegramId: n, ...extra });
};

describe('odm — filtr', () => {
  it('tenglik, null va $exists', async () => {
    await mkLead({ name: 'Ali', readyReason: null });
    await mkLead({ name: 'Vali', readyReason: 'tugadi' });

    expect(await Lead.countDocuments({ name: 'Ali' })).toBe(1);
    expect(await Lead.countDocuments({ readyReason: null })).toBe(1);
    expect(await Lead.countDocuments({ readyReason: { $exists: true } })).toBe(1);
    expect(await Lead.countDocuments({ readyReason: { $exists: false } })).toBe(1);
    expect(await Lead.countDocuments()).toBe(2);
  });

  it('$in, $nin va bo‘sh $in hech narsa qaytarmaydi', async () => {
    await mkLead({ status: 'NEW' });
    await mkLead({ status: 'READY' });
    await mkLead({ status: 'PAID' });

    expect(await Lead.countDocuments({ status: { $in: ['NEW', 'PAID'] } })).toBe(2);
    expect(await Lead.countDocuments({ status: { $nin: ['NEW', 'PAID'] } })).toBe(1);
    // Mongo bo'sh $in uchun hech narsa qaytarmaydi — biz ham
    expect(await Lead.countDocuments({ status: { $in: [] } })).toBe(0);
  });

  it('$ne NULL qatorlarni ham qamrab oladi (Mongo‘dagidek)', async () => {
    await mkLead({ status: 'READY', readyReason: 'tugadi' });
    await mkLead({ status: 'READY' }); // readyReason NULL

    // Mongo'da maydon yo'q bo'lsa ham {$ne: 'tugadi'} unga tushadi
    expect(await Lead.countDocuments({ readyReason: { $ne: 'tugadi' } })).toBe(1);
    expect(await Lead.countDocuments({ status: { $ne: 'PAID' } })).toBe(2);
  });

  it('sana oraliqlari va $or', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-06-01T00:00:00Z');
    await mkLead({ readyAt: t0, name: 'eski' });
    await mkLead({ readyAt: t1, name: 'yangi' });

    expect(await Lead.countDocuments({ readyAt: { $gte: t0, $lt: t1 } })).toBe(1);
    expect(await Lead.countDocuments({ readyAt: { $lte: t1 } })).toBe(2);
    expect(await Lead.countDocuments({ $or: [{ name: 'eski' }, { name: 'yangi' }] })).toBe(2);
    expect(await Lead.countDocuments({ $or: [{ name: 'eski' }, { name: 'yo‘q' }] })).toBe(1);
  });

  it('noma‘lum operator jim o‘tib ketmaydi', async () => {
    await expect(Lead.find({ name: { $regex: 'a' } })).rejects.toThrow(/\$regex/);
  });
});

describe('odm — zanjir', () => {
  it('sort, limit va select', async () => {
    await mkLead({ name: 'b', askCount: 2 });
    await mkLead({ name: 'a', askCount: 3 });
    await mkLead({ name: 'c', askCount: 1 });

    const desc = await Lead.find().sort({ askCount: -1 }).lean();
    expect(desc.map((l) => l.name)).toEqual(['a', 'b', 'c']);

    const top = await Lead.find().sort({ askCount: -1 }).limit(2).lean();
    expect(top).toHaveLength(2);

    const picked = await Lead.find().sort({ name: 1 }).select('name').lean();
    // select() faqat so'ralgan maydonlar + _id ni qaytaradi
    expect(Object.keys(picked[0]).sort()).toEqual(['_id', 'name']);
  });

  it('bo‘sh va manfiy limit xato bermaydi', async () => {
    await mkLead();
    expect(await Lead.find().limit(0).lean()).toHaveLength(0);
    expect(await Lead.find().limit(-5).lean()).toHaveLength(0);
  });

  it('findOne topilmasa null, find esa bo‘sh massiv', async () => {
    expect(await Lead.findOne({ chatId: 999_999 })).toBeNull();
    expect(await Lead.findById('yo‘q-id')).toBeNull();
    expect(await Lead.find({ chatId: 999_999 })).toEqual([]);
  });

  it('lean() oddiy obyekt beradi, lean()siz esa hujjat', async () => {
    await mkLead({ name: 'Ali' });

    const plain = await Lead.findOne({ name: 'Ali' }).lean();
    expect(typeof (plain as unknown as { save?: unknown }).save).toBe('undefined');
    // oddiy obyekt — JSON va spread xavfsiz
    expect(JSON.parse(JSON.stringify({ ...plain! })).name).toBe('Ali');

    const doc = await Lead.findOne({ name: 'Ali' });
    expect(typeof doc!.save).toBe('function');
    expect(doc!.id).toBe(doc!._id);
  });
});

describe('odm — yozish', () => {
  it('create() bitta obyektni ham, massivni ham oladi', async () => {
    const one = await Lead.create({ ...base, chatId: 100, telegramId: 100 });
    expect(one._id).toBeTypeOf('string');

    const many = await Lead.create([
      { ...base, chatId: 101, telegramId: 101 },
      { ...base, chatId: 102, telegramId: 102 },
    ]);
    expect(many).toHaveLength(2);
    expect(await Lead.countDocuments()).toBe(3);
  });

  it('standart qiymatlar bazadan keladi', async () => {
    const lead = await Lead.create({ ...base, chatId: 1, telegramId: 1 });
    expect(lead.status).toBe('NEW');
    expect(lead.currentQuestion).toBe(1);
    expect(lead.urgent).toBe(false);
    expect(lead.answers).toEqual({});
    expect(lead.skippedSteps).toEqual([]);
    expect(lead.createdAt).toBeInstanceOf(Date);
  });

  it('.save() faqat o‘zgargan maydonni yozadi', async () => {
    const lead = await mkLead({ name: 'Ali', notes: 'eski' });
    // ikkinchi nusxa orqali boshqa maydonni o'zgartiramiz
    await Lead.updateOne({ _id: lead._id }, { $set: { notes: 'boshqa joydan' } });

    lead.name = 'Vali';
    await lead.save();

    const fresh = await Lead.findById(lead._id).lean();
    expect(fresh!.name).toBe('Vali');
    // name saqlanganda notes ustiga yozilmagan
    expect(fresh!.notes).toBe('boshqa joydan');
  });

  it('.set() va .save() birga ishlaydi, o‘zgarishsiz .save() bazaga tegmaydi', async () => {
    const lead = await mkLead({ name: 'Ali' });
    lead.set({ name: 'Vali', urgent: true });
    await lead.save();

    const fresh = await Lead.findById(lead._id).lean();
    expect(fresh!.name).toBe('Vali');
    expect(fresh!.urgent).toBe(true);

    const before = (await Lead.findById(lead._id).lean())!.updatedAt;
    await lead.save(); // dirty bo'sh
    expect((await Lead.findById(lead._id).lean())!.updatedAt).toEqual(before);
  });

  it('updatedAt har yangilanishda yangilanadi', async () => {
    const lead = await mkLead();
    const before = lead.updatedAt;
    await new Promise((r) => setTimeout(r, 10));
    await Lead.updateOne({ _id: lead._id }, { $set: { name: 'yangi' } });
    const after = (await Lead.findById(lead._id).lean())!.updatedAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('timestamps: false bo‘lgan jadvalga updatedAt yozilmaydi', async () => {
    // reminders jadvalida updatedAt ustuni yo'q — yozishga urinsa xato bo'lardi
    const lead = await mkLead();
    const { Reminder } = await import('../src/database/models/misc');
    await Reminder.create({ leadId: lead._id, number: 1, text: 'salom' });
    await Reminder.updateOne({ leadId: lead._id, number: 1 }, { $set: { text: 'yangi' } });
    const r = await Reminder.findOne({ leadId: lead._id }).lean();
    expect(r!.text).toBe('yangi');
  });

  it('updateOne faqat bitta qatorga tegadi, updateMany hammasiga', async () => {
    await mkLead({ status: 'READY' });
    await mkLead({ status: 'READY' });

    const one = await Lead.updateOne({ status: 'READY' }, { $set: { urgent: true } });
    expect(one.modifiedCount).toBe(1);
    expect(await Lead.countDocuments({ urgent: true })).toBe(1);

    const all = await Lead.updateMany({ status: 'READY' }, { $set: { status: 'PAID' } });
    expect(all.modifiedCount).toBe(2);
    expect(await Lead.countDocuments({ status: 'PAID' })).toBe(2);
  });

  it('deleteOne bittasini, deleteMany hammasini o‘chiradi', async () => {
    await mkLead({ status: 'NEW' });
    await mkLead({ status: 'NEW' });

    expect((await Lead.deleteOne({ status: 'NEW' })).deletedCount).toBe(1);
    expect((await Lead.deleteMany({ status: 'NEW' })).deletedCount).toBe(1);
    expect(await Lead.countDocuments()).toBe(0);
  });

  it('exists() _id qaytaradi yoki null', async () => {
    const lead = await mkLead({ name: 'Ali' });
    expect(await Lead.exists({ name: 'Ali' })).toEqual({ _id: lead._id });
    expect(await Lead.exists({ name: 'Hech kim' })).toBeNull();
  });

  it('unique cheklov buzilsa Postgres kodi bilan xato chiqadi', async () => {
    await Campaign.create({ code: 'v1', source: 'video' });
    await expect(Campaign.create({ code: 'v1', source: 'boshqa' })).rejects.toMatchObject({ code: '23505' });
  });
});

describe('odm — $unset', () => {
  it('NOT NULL ustun standart qiymatiga qaytadi, nullable esa NULL bo‘ladi', async () => {
    const lead = await mkLead({ summaryMessageCount: 7, summary: 'xulosa', askCount: 5 });

    await Lead.updateOne({ _id: lead._id }, { $unset: { summaryMessageCount: '', summary: '', askCount: '' } });

    const fresh = await Lead.findById(lead._id).lean();
    // summaryMessageCount / askCount — NOT NULL, standarti 0
    expect(fresh!.summaryMessageCount).toBe(0);
    expect(fresh!.askCount).toBe(0);
    // summary — oddiy nullable ustun
    expect(fresh!.summary).toBeNull();
  });

  it('delete lead.x — saqlanganda standart qiymatga qaytaradi', async () => {
    const lead = await mkLead({ summaryMessageCount: 9, summary: 'bor' });
    delete (lead as unknown as Record<string, unknown>).summaryMessageCount;
    delete (lead as unknown as Record<string, unknown>).summary;
    await lead.save();

    const fresh = await Lead.findById(lead._id).lean();
    expect(fresh!.summaryMessageCount).toBe(0);
    expect(fresh!.summary).toBeNull();
  });

  it('$set va $unset bitta so‘rovda birga ishlaydi', async () => {
    const lead = await mkLead({ status: 'READY', summary: 'bor', bmi: 25 });
    await Lead.updateOne({ _id: lead._id }, { $set: { status: 'NEW', urgent: true }, $unset: { summary: '', bmi: '' } });

    const fresh = await Lead.findById(lead._id).lean();
    expect(fresh!.status).toBe('NEW');
    expect(fresh!.urgent).toBe(true);
    expect(fresh!.summary).toBeNull();
    expect(fresh!.bmi).toBeNull();
  });
});

describe('odm — jsonb', () => {
  it('obyekt va obyektlar massivi jsonb‘ga to‘g‘ri yoziladi', async () => {
    const lead = await mkLead({
      answers: { height: 180, weight: 90, goal: 'ozish' },
      adminCardMessageIds: [{ chatId: 5, messageId: 6 }],
    });

    const fresh = await Lead.findById(lead._id).lean();
    expect(fresh!.answers).toEqual({ height: 180, weight: 90, goal: 'ozish' });
    // massiv Postgres massivi emas, jsonb bo'lib yozilishi kerak
    expect(fresh!.adminCardMessageIds).toEqual([{ chatId: 5, messageId: 6 }]);
  });

  it('jsonb butunlay almashtiriladi, qo‘shilmaydi', async () => {
    const lead = await mkLead({ answers: { height: 180, weight: 90 } });
    lead.answers = { age: 30 };
    await lead.save();

    expect((await Lead.findById(lead._id).lean())!.answers).toEqual({ age: 30 });
  });

  it('"values.kalit" yo‘li jsonb ichidagi bitta kalitga tegadi', async () => {
    await SettingsDoc.create({ _id: 'main', values: { a: 1, b: 2 } });
    await SettingsDoc.updateOne({ _id: 'main' }, { $set: { 'values.b': 99 } });

    expect((await SettingsDoc.findById('main').lean())!.values).toEqual({ a: 1, b: 99 });
  });

  it('bir so‘rovda bir nechta "values.kalit" yo‘li (Postgres bitta tayinlash talab qiladi)', async () => {
    await SettingsDoc.create({ _id: 'main', values: { a: 1 } });
    await SettingsDoc.updateOne({ _id: 'main' }, { $set: { 'values.b': 2, 'values.c': 3 } });

    expect((await SettingsDoc.findById('main').lean())!.values).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('$unset bilan jsonb ichidagi bir nechta kalit o‘chiriladi', async () => {
    await SettingsDoc.create({ _id: 'main', values: { a: 1, b: 2, c: 3 } });
    await SettingsDoc.updateOne({ _id: 'main' }, { $unset: { 'values.a': '', 'values.c': '' } });

    expect((await SettingsDoc.findById('main').lean())!.values).toEqual({ b: 2 });
  });

  it('bitta so‘rovda jsonb kalitini qo‘shib, boshqasini o‘chirish', async () => {
    await SettingsDoc.create({ _id: 'main', values: { a: 1, b: 2 } });
    await SettingsDoc.updateOne({ _id: 'main' }, { $set: { 'values.c': 3 }, $unset: { 'values.a': '' } });

    expect((await SettingsDoc.findById('main').lean())!.values).toEqual({ b: 2, c: 3 });
  });
});

describe('odm — upsert', () => {
  it('qator bo‘lmasa filtr + $set dan yangi qator yaratadi', async () => {
    await Campaign.updateOne({ code: 'v9' }, { $set: { source: 'video_09' } }, { upsert: true });

    const c = await Campaign.findOne({ code: 'v9' }).lean();
    expect(c!.source).toBe('video_09');
  });

  it('qator bo‘lsa yangilaydi, nusxa yaratmaydi', async () => {
    await Campaign.create({ code: 'v9', source: 'eski' });
    await Campaign.updateOne({ code: 'v9' }, { $set: { source: 'yangi' } }, { upsert: true });

    expect(await Campaign.countDocuments({ code: 'v9' })).toBe(1);
    expect((await Campaign.findOne({ code: 'v9' }).lean())!.source).toBe('yangi');
  });

  it('upsert jsonb yo‘li bilan ham ishlaydi (INSERT jsonb_set ni qabul qilmaydi)', async () => {
    await SettingsDoc.updateOne({ _id: 'main' }, { $set: { 'values.theme': 'dark' } }, { upsert: true });

    expect((await SettingsDoc.findById('main').lean())!.values).toEqual({ theme: 'dark' });
  });

  it('faqat $unset bo‘lgan upsert bo‘sh qator yaratadi', async () => {
    await SettingsDoc.updateOne({ _id: 'main' }, { $unset: { 'values.x': '' } }, { upsert: true });

    expect((await SettingsDoc.findById('main').lean())!.values).toEqual({});
  });
});

describe('odm — aggregate o‘rnidagi metodlar', () => {
  it('countBy maydon bo‘yicha sanaydi, ko‘pdan kamga', async () => {
    await mkLead({ source: 'video_01' });
    await mkLead({ source: 'video_01' });
    await mkLead({ source: 'video_02' });

    const rows = await Lead.countBy('source');
    expect(rows).toEqual([
      { value: 'video_01', count: 2 },
      { value: 'video_02', count: 1 },
    ]);
  });

  it('countBy filtr bilan', async () => {
    const old = new Date('2026-01-01T00:00:00Z');
    await mkLead({ source: 'a', createdAt: old });
    await mkLead({ source: 'b' });

    const rows = await Lead.countBy('source', { createdAt: { $gte: new Date('2026-02-01T00:00:00Z') } });
    expect(rows).toEqual([{ value: 'b', count: 1 }]);
  });

  it('sample so‘ralgandan ortiq qaytarmaydi', async () => {
    await StyleExample.create([
      { client: 'a', coach: ['x'] },
      { client: 'b', coach: ['y'] },
    ]);

    expect(await StyleExample.sample(1)).toHaveLength(1);
    expect(await StyleExample.sample(5)).toHaveLength(2);
    expect(await StyleExample.sample(0)).toHaveLength(0);
  });
});

describe('odm — massiv ustunlar va turlar', () => {
  it('TEXT[] va INTEGER[] massivlari aynan qaytadi', async () => {
    const lead = await mkLead({ skippedSteps: [2, 5, 7] });
    expect((await Lead.findById(lead._id).lean())!.skippedSteps).toEqual([2, 5, 7]);

    const ex = await StyleExample.create({ client: 'salom', coach: ['bir', 'ikki'], tokens: ['t1'] });
    const fresh = await StyleExample.findById(ex._id).lean();
    expect(fresh!.coach).toEqual(['bir', 'ikki']);
    expect(fresh!.tokens).toEqual(['t1']);
  });

  it('BIGINT son bo‘lib qaytadi, matn emas', async () => {
    const lead = await Lead.create({ ...base, chatId: 7_123_456_789, telegramId: 7_123_456_789 });
    const fresh = await Lead.findById(lead._id).lean();
    expect(fresh!.chatId).toBe(7_123_456_789);
    expect(typeof fresh!.telegramId).toBe('number');
  });

  it('lead o‘chirilsa xabarlari ham ketadi (ON DELETE CASCADE)', async () => {
    const lead = await mkLead();
    await Message.create({ leadId: lead._id, direction: 'incoming', sender: 'client', text: 'salom' });
    expect(await Message.countDocuments()).toBe(1);

    await Lead.deleteOne({ _id: lead._id });
    expect(await Message.countDocuments()).toBe(0);
  });

  it('sxema qayta ishga tushirilsa ma‘lumot yo‘qolmaydi (IF NOT EXISTS)', async () => {
    const lead = await mkLead({ name: 'Ali' });
    const { SCHEMA_SQL } = await import('../src/database/schema');
    await getPool().query(SCHEMA_SQL);

    expect((await Lead.findById(lead._id).lean())!.name).toBe('Ali');
  });
});
