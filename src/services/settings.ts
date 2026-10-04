import crypto from 'node:crypto';
import { SettingsDoc } from '../database/models/misc';
import { SETTINGS_BY_KEY, SETTINGS_SPEC, type SettingDef } from './settingsSpec';
import type { Lang } from '../utils/text';

export type SettingsValues = Record<string, string | number | boolean>;

/** Admin-editable settings stored in MongoDB with in-memory caching. */
export class SettingsService {
  private cache?: { values: SettingsValues; at: number };
  constructor(private readonly ttlMs = 5_000) {}

  async all(): Promise<SettingsValues> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.values;
    const doc = await SettingsDoc.findById('main').lean();
    const stored = (doc?.values ?? {}) as SettingsValues;
    const values: SettingsValues = {};
    for (const def of SETTINGS_SPEC) values[def.key] = stored[def.key] ?? def.default;
    this.cache = { values, at: Date.now() };
    return values;
  }

  async get(key: string): Promise<string> {
    return String((await this.all())[key] ?? '');
  }

  async num(key: string): Promise<number> {
    const n = Number((await this.all())[key]);
    const def = SETTINGS_BY_KEY.get(key);
    return Number.isFinite(n) ? n : Number(def?.default ?? 0);
  }

  async bool(key: string): Promise<boolean> {
    const v = (await this.all())[key];
    return v === true || v === 'true' || v === 1 || v === '1';
  }

  async text(key: string, lang: Lang): Promise<string> {
    const all = await this.all();
    return String(all[`${key}_${lang}`] || all[`${key}_uz`] || '');
  }

  coerce(def: SettingDef, raw: unknown): string | number | boolean {
    if (def.type === 'number') {
      const n = Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(n)) throw new Error(`${def.key}: son kerak`);
      return n;
    }
    if (def.type === 'boolean') {
      const s = String(raw).toLowerCase();
      return raw === true || ['true', '1', 'on', 'ha', 'yes'].includes(s);
    }
    return String(raw ?? '');
  }

  async set(updates: Record<string, unknown>): Promise<SettingsValues> {
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};
    for (const [key, raw] of Object.entries(updates)) {
      const def = SETTINGS_BY_KEY.get(key);
      if (!def) throw new Error(`Noma'lum sozlama: ${key}`);
      const value = this.coerce(def, raw);
      // values equal to the default are not stored, so improved defaults reach the bot after updates
      if (value === def.default) $unset[`values.${key}`] = '';
      else $set[`values.${key}`] = value;
    }
    const update: Record<string, unknown> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    if (Object.keys(update).length) await SettingsDoc.updateOne({ _id: 'main' }, update, { upsert: true });
    this.cache = undefined;
    return this.all();
  }

  async reset(key: string): Promise<void> {
    if (!SETTINGS_BY_KEY.has(key)) throw new Error(`Noma'lum sozlama: ${key}`);
    await SettingsDoc.updateOne({ _id: 'main' }, { $unset: { [`values.${key}`]: '' } }, { upsert: true });
    this.cache = undefined;
  }

  /** Removes stored copies of defaults from older versions (saved by the mini app "Saqlash" button). */
  async migrateLegacyDefaults(): Promise<string[]> {
    const doc = await SettingsDoc.findById('main').lean();
    const stored = (doc?.values ?? {}) as Record<string, unknown>;
    const removed: string[] = [];
    for (const [key, value] of Object.entries(stored)) {
      const def = SETTINGS_BY_KEY.get(key);
      const legacy = LEGACY_DEFAULTS[key] ?? [];
      const hash = typeof value === 'string' ? crypto.createHash('sha256').update(value).digest('hex') : '';
      if ((def && value === def.default) || legacy.includes(String(value)) || legacy.includes(hash)) removed.push(key);
    }
    if (removed.length) {
      await SettingsDoc.updateOne({ _id: 'main' }, { $unset: Object.fromEntries(removed.map((k) => [`values.${k}`, ''])) });
      this.cache = undefined;
    }
    return removed;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}

/** Default values (or sha256 of long ones) shipped by earlier versions. */
const LEGACY_DEFAULTS: Record<string, string[]> = {
  system_prompt: [
    'f6ea8c5f084430843919e991f69d1b24233c8df8b42ec9f0c0568d52b0ef109f',
    '0bb9189f38da4cf30d7f62c616bdd88805689200bd0e822ccf49d70739bed90a',
    '3c214611741c2c0611a61d492c1ad4c40e8d4144d44817fe11f5d1c113cf3c37',
  ],
  debounce_seconds: ['6'],
  q2_high_uz: ['Tushunarli. Maqsad nechiga tushish? Qancha vazn norma hisoblaysiz?'],
  q2_low_uz: ['Tushunarli. Maqsad massa olishmi? Necha kiloga chiqmoqchisiz?'],
  q2_mid_uz: ['Tushunarli. Maqsad nima: ozishmi, massa olishmi yoki shaklga kirish?'],
  q2_high_ru: ['Понятно. Цель — до скольки похудеть? Какой вес считаете нормой?'],
  q2_low_ru: ['Понятно. Цель — набрать массу? До скольки кг хотите выйти?'],
  q2_mid_ru: ['Понятно. Какая цель: похудеть, набрать массу или прийти в форму?'],
};
