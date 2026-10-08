import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { LEAD_MODES, LEAD_STATUSES } from '../../types/domain';

const AnswersSchema = new Schema(
  {
    height: Number,
    weight: Number,
    age: Number,
    trainingExperience: String,
    goal: String,
    targetWeight: Number,
    trainingDays: Number,
    trainingLocation: String,
    previousAttempts: String,
    healthProblems: String,
    country: String,
    motivation: String,
  },
  { _id: false },
);

/**
 * One lead per client chat of the business account. It also holds the conversation state
 * (status / mode / current question / reminders) because the PDF treats them as one record.
 */
const LeadSchema = new Schema(
  {
    /** Telegram: business connection id. Instagram: «ig:<account id>». */
    businessConnectionId: { type: String, required: true },
    channel: { type: String, enum: ['telegram', 'instagram'], default: 'telegram', index: true },
    /** Instagram-scoped user id (chatId is a stable number derived from it). */
    igUserId: { type: String, index: true },
    /** The comment that started this conversation (Instagram automation). */
    igCommentId: String,
    igMediaId: String,
    igCommentText: String,
    chatId: { type: Number, required: true },
    telegramId: { type: Number, required: true, index: true },
    username: String,
    firstName: String,
    lastName: String,
    name: String,
    language: { type: String, enum: ['uz', 'ru'], default: 'uz' },
    /** Uzbek clients writing in Cyrillic get answers in Cyrillic. */
    uzScript: { type: String, enum: ['latn', 'cyrl'], default: 'latn' },

    source: { type: String, default: 'unknown', index: true },
    sourceRaw: String,

    answers: { type: AnswersSchema, default: () => ({}) },
    bmi: Number,
    targetBmi: Number,
    currentQuestion: { type: Number, default: 1 },
    /** asked = «kurs bo'yichami?» sent; course = lead; other = not a lead (handed to the coach silently). */
    intent: { type: String, enum: ['asked', 'course', 'other'] },
    /** Admin switch: AI keeps chatting with this client (also after the questionnaire / manual messages). */
    alwaysOn: { type: Boolean, default: false },
    lastAskedStep: Number,
    askCount: { type: Number, default: 0 },
    skippedSteps: { type: [Number], default: [] },

    status: { type: String, enum: LEAD_STATUSES, default: 'NEW', index: true },
    mode: { type: String, enum: LEAD_MODES, default: 'AI' },
    urgent: { type: Boolean, default: false },
    readyReason: String,

    summary: String,
    summaryMessageCount: { type: Number, default: 0 },
    notes: String,

    remindersSent: { type: Number, default: 0 },
    pendingSince: Date,
    aiFailures: { type: Number, default: 0 },
    aiFailureNotifiedAt: Date,

    adminCardMessageIds: { type: [{ chatId: Number, messageId: Number }], default: [] },

    lastClientMessageAt: Date,
    lastOutgoingAt: Date,
    readyAt: Date,
    /** Questionnaire finished (sales stage started). */
    questionnaireDoneAt: Date,
    /** AI closed the sale (client paid / agreed) — the coach sends the group link. */
    soldAt: Date,
    /** Sales funnel: 0 start, 1 offer+price given, 2 closing asked, 3 payment details sent. */
    salesStep: { type: Number, default: 0 },
    salesTurns: { type: Number, default: 0 },
    /** «O'ylab ko'raman» → when to write again and why. */
    followUpAt: Date,
    followUpNote: String,
    followUpsSent: { type: Number, default: 0 },
    /** The coach is writing himself — the AI stays silent in this chat until this time. */
    aiPausedUntil: Date,
    commitmentAsked: { type: Boolean, default: false },
    /** How many times the client said a soft «no» during the sale (one save attempt before giving up). */
    refusalCount: { type: Number, default: 0 },
    /** The results link was already sent to this client (never spam it). */
    resultsLinkSent: { type: Boolean, default: false },
    /** Last time the coach was reminded that this client is waiting for him. */
    coachNudgedAt: Date,
    coachNudges: { type: Number, default: 0 },
    sentVoiceIds: { type: [String], default: [] },
    answeredAt: Date,
    paidAt: Date,
    rejectedAt: Date,
  },
  { timestamps: true, collection: 'leads' },
);

LeadSchema.index({ businessConnectionId: 1, chatId: 1 }, { unique: true });
LeadSchema.index({ status: 1, mode: 1, lastClientMessageAt: 1 });

export type LeadData = InferSchemaType<typeof LeadSchema>;
export type LeadDoc = HydratedDocument<LeadData>;
export const Lead = model('Lead', LeadSchema);
