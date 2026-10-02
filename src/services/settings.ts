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
    for (const [key, raw] of Object.entries(updates)) {
      const def = SETTINGS_BY_KEY.get(key);
      if (!def) throw new Error(`Noma'lum sozlama: ${key}`);
      $set[`values.${key}`] = this.coerce(def, raw);
    }
    if (Object.keys($set).length) await SettingsDoc.updateOne({ _id: 'main' }, { $set }, { upsert: true });
    this.cache = undefined;
    return this.all();
  }

  async reset(key: string): Promise<void> {
    if (!SETTINGS_BY_KEY.has(key)) throw new Error(`Noma'lum sozlama: ${key}`);
    await SettingsDoc.updateOne({ _id: 'main' }, { $unset: { [`values.${key}`]: '' } }, { upsert: true });
    this.cache = undefined;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}
