export const LEAD_STATUSES = ['NEW', 'QUESTIONNAIRE', 'READY', 'ANSWERED', 'PAID', 'REJECTED'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_MODES = ['AI', 'MANUAL'] as const;
export type LeadMode = (typeof LEAD_MODES)[number];

export type ReadyReason =
  | 'completed'
  | 'wants_coach'
  | 'bot_question'
  | 'safety'
  | 'low_target_bmi'
  | 'manual_takeover'
  | 'paused'
  | 'not_lead';

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

/** Questionnaire step that still needs an answer; 6 means everything is collected. */
export type QuestionStep = 1 | 2 | 3 | 4 | 5 | 6;

export type MessageSender = 'client' | 'temur' | 'ai';
export type MessageDirection = 'incoming' | 'outgoing';
