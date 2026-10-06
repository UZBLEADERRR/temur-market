import { Schema, model, type InferSchemaType } from 'mongoose';

/** Idempotency: one row per processed Telegram update / message key. */
const ProcessedUpdateSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 14 },
  },
  { collection: 'processed_updates' },
);
export const ProcessedUpdate = model('ProcessedUpdate', ProcessedUpdateSchema);

const BusinessConnectionSchema = new Schema(
  {
    connectionId: { type: String, required: true, unique: true },
    userId: { type: Number, required: true },
    userChatId: Number,
    isEnabled: { type: Boolean, default: true },
    canReply: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'business_connections' },
);
export const BusinessConnection = model('BusinessConnection', BusinessConnectionSchema);

const SettingsSchema = new Schema(
  {
    _id: { type: String, default: 'main' },
    values: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, collection: 'settings' },
);
export const SettingsDoc = model('Settings', SettingsSchema);

const StyleExampleSchema = new Schema(
  {
    client: { type: String, required: true },
    coach: { type: [String], required: true },
    language: { type: String, enum: ['uz', 'ru'], default: 'uz' },
    tokens: { type: [String], default: [] },
    source: { type: String, default: 'import' },
    /** style = tone only; sales = Temur's real selling lines (numbers masked), used in the sales stage. */
    kind: { type: String, enum: ['style', 'sales'], default: 'style' },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'style_examples' },
);
export type StyleExampleData = InferSchemaType<typeof StyleExampleSchema>;
export const StyleExample = model('StyleExample', StyleExampleSchema);

const StyleProfileSchema = new Schema(
  {
    profile: { type: Schema.Types.Mixed, required: true },
    stats: { type: Schema.Types.Mixed },
    exampleCount: Number,
    active: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'style_profiles' },
);
export const StyleProfile = model('StyleProfile', StyleProfileSchema);

const CampaignSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    source: { type: String, required: true },
    description: String,
  },
  { timestamps: true, collection: 'campaigns' },
);
export const Campaign = model('Campaign', CampaignSchema);

const ReminderSchema = new Schema(
  {
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    number: { type: Number, required: true },
    sentAt: { type: Date, default: Date.now },
    text: String,
  },
  { collection: 'reminders' },
);
ReminderSchema.index({ leadId: 1, number: 1 }, { unique: true });
export const Reminder = model('Reminder', ReminderSchema);

const AdminEventSchema = new Schema(
  {
    type: { type: String, required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    actorId: Number,
    data: Schema.Types.Mixed,
  },
  { timestamps: true, collection: 'admin_events' },
);
export const AdminEvent = model('AdminEvent', AdminEventSchema);

/**
 * Pre-recorded voice messages of the coach (offer, price, how the group works…).
 * The admin sends them to the bot; the AI picks the right one during the conversation.
 */
const VoiceClipSchema = new Schema(
  {
    fileId: { type: String, required: true },
    fileUniqueId: { type: String, index: true },
    mimeType: String,
    duration: Number,
    title: { type: String, default: '' },
    description: { type: String, default: '' },
    transcript: { type: String, default: '' },
    /** Who may receive it: KR (won prices), UZ (so'm prices), OTHER, or ALL. */
    country: { type: String, enum: ['ALL', 'KR', 'UZ', 'OTHER'], default: 'ALL' },
    enabled: { type: Boolean, default: true },
    sentCount: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'voice_clips' },
);
export type VoiceClipData = InferSchemaType<typeof VoiceClipSchema>;
export const VoiceClip = model('VoiceClip', VoiceClipSchema);
