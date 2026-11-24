import { defineModel, type Doc } from '../odm';

/** Idempotentlik: har bir ishlangan Telegram update uchun bitta qator. */
export const ProcessedUpdate = defineModel('processed_updates', { timestamps: false });

export const BusinessConnection = defineModel('business_connections');

export const SettingsDoc = defineModel('settings', { json: ['values'] });

export interface StyleExampleData {
  client: string;
  coach: string[];
  language: 'uz' | 'ru';
  tokens: string[];
  source: string;
  enabled: boolean;
  /** Orqaga qaytarilgan "sotuv" versiyasidan qolgan yozuvlarni ajratish uchun. */
  kind?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type StyleExampleDoc = Doc<StyleExampleData>;

export const StyleExample = defineModel<StyleExampleData>('style_examples');

export const StyleProfile = defineModel('style_profiles', { json: ['profile', 'stats'] });

export const Campaign = defineModel('campaigns');

export const Reminder = defineModel('reminders', { timestamps: false });

export const AdminEvent = defineModel('admin_events', { json: ['data'] });
