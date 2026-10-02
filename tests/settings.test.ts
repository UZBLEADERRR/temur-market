import { describe, expect, it } from 'vitest';
import { SettingsDoc } from '../src/database/models/misc';
import { SettingsService } from '../src/services/settings';
import { useDatabase } from './helpers';

useDatabase();

describe('settings storage', () => {
  it('does not store values equal to the default and migrates old defaults', async () => {
    const s = new SettingsService(0);
    await s.set({ debounce_seconds: 30, coach_info: 'Maxsus' });
    const doc = await SettingsDoc.findById('main').lean();
    expect(doc?.values).toEqual({ coach_info: 'Maxsus' });

    await SettingsDoc.updateOne({ _id: 'main' }, { $set: { 'values.debounce_seconds': 6, 'values.q2_high_uz': 'Tushunarli. Maqsad nechiga tushish? Qancha vazn norma hisoblaysiz?' } });
    expect((await s.migrateLegacyDefaults()).sort()).toEqual(['debounce_seconds', 'q2_high_uz']);
    expect(await s.num('debounce_seconds')).toBe(30);
    expect(await s.get('coach_info')).toBe('Maxsus');
  });
});
