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
  },
  { _id: false },
);

/**
 * One lead per client chat of the business account. It also holds the conversation state
 * (status / mode / current question / reminders) because the PDF treats them as one record.
 */
const LeadSchema = new Schema(
  {
    businessConnectionId: { type: String, required: true },
    chatId: { type: Number, required: true },
    telegramId: { type: Number, required: true, index: true },
    username: String,
    firstName: String,
    lastName: String,
    name: String,
    language: { type: String, enum: ['uz', 'ru'], default: 'uz' },

    source: { type: String, default: 'unknown', index: true },
    sourceRaw: String,

    answers: { type: AnswersSchema, default: () => ({}) },
    bmi: Number,
    targetBmi: Number,
    currentQuestion: { type: Number, default: 1 },
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
