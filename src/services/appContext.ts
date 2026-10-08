import type { Env } from '../config/env';
import type { AiService } from '../ai/aiService';
import type { ConversationEngine } from '../conversations/engine';
import type { LeadService } from '../leads/leadService';
import type { ReminderService } from '../reminders/reminderService';
import type { TelegramGateway } from '../telegram/gateway';
import type { SettingsService } from './settings';
import type { InstagramModule } from '../instagram';

export interface AppContext {
  env: Env;
  settings: SettingsService;
  ai: AiService;
  engine: ConversationEngine;
  leads: LeadService;
  reminders: ReminderService;
  gateway: TelegramGateway;
  instagram?: InstagramModule;
}
