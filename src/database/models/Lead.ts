import { defineModel, type Doc } from '../odm';

export interface LeadAnswers {
  height?: number;
  weight?: number;
  age?: number;
  trainingExperience?: string;
  goal?: string;
  targetWeight?: number;
  trainingDays?: number;
  trainingLocation?: string;
  previousAttempts?: string;
  healthProblems?: string;
}

/**
 * Biznes akkauntning har bir mijoz chati uchun bitta lead. Suhbat holati ham
 * shu yerda (status / rejim / joriy savol / eslatmalar) — PDF ularni bitta
 * yozuv deb qaraydi.
 */
export interface LeadData {
  businessConnectionId: string;
  chatId: number;
  telegramId: number;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  language: 'uz' | 'ru';
  /** Kirill yozuvida yozgan o'zbek mijozga kirillda javob beriladi. */
  uzScript: 'latn' | 'cyrl';

  source: string;
  sourceRaw?: string | null;

  answers: LeadAnswers;
  bmi?: number | null;
  targetBmi?: number | null;
  currentQuestion: number;
  /** asked = «kurs bo'yichami?» yuborilgan; course = lead; other = lead emas. */
  intent?: 'asked' | 'course' | 'other' | null;
  /** Admin tugmasi: AI shu mijoz bilan gaplashishni davom etadi. */
  alwaysOn: boolean;
  lastAskedStep?: number | null;
  askCount: number;
  skippedSteps: number[];

  status: string;
  mode: 'AI' | 'MANUAL';
  urgent: boolean;
  readyReason?: string | null;

  summary?: string | null;
  summaryMessageCount: number;
  notes?: string | null;

  remindersSent: number;
  pendingSince?: Date | null;
  aiFailures: number;
  aiFailureNotifiedAt?: Date | null;

  adminCardMessageIds: Array<{ chatId: number; messageId: number }>;

  lastClientMessageAt?: Date | null;
  lastOutgoingAt?: Date | null;
  readyAt?: Date | null;
  answeredAt?: Date | null;
  paidAt?: Date | null;
  rejectedAt?: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export type LeadDoc = Doc<LeadData>;

export const Lead = defineModel<LeadData>('leads', { json: ['answers', 'adminCardMessageIds'] });
