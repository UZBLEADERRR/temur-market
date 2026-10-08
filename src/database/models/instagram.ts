import { Schema, model, type InferSchemaType } from 'mongoose';

/** The connected Instagram professional account (one per bot). Token can be pasted in the panel or set via env. */
const IgAccountSchema = new Schema(
  {
    _id: { type: String, default: 'main' },
    accessToken: String,
    appSecret: String,
    /** Instagram professional account id (entry.id in webhooks). */
    userId: String,
    username: String,
    name: String,
    pictureUrl: String,
    tokenExpiresAt: Date,
    tokenRefreshedAt: Date,
    lastWebhookAt: Date,
    lastError: String,
  },
  { timestamps: true, collection: 'ig_account' },
);
export type IgAccountData = InferSchemaType<typeof IgAccountSchema>;
export const IgAccount = model('IgAccount', IgAccountSchema);

/**
 * Comment automation rule (what ManyChat does): on which post, which words trigger it,
 * what to reply publicly and what to send in Direct.
 */
const IgRuleSchema = new Schema(
  {
    name: { type: String, default: '' },
    /** null = every post / reel. */
    mediaId: { type: String, default: null },
    mediaThumb: String,
    mediaCaption: String,
    mediaPermalink: String,
    /** Comma / newline separated; empty = any comment. */
    keywords: { type: String, default: '' },
    publicReplies: { type: [String], default: [] },
    dmText: { type: String, default: '' },
    enabled: { type: Boolean, default: true },
    triggered: { type: Number, default: 0 },
    dmsSent: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'ig_rules' },
);
export type IgRuleData = InferSchemaType<typeof IgRuleSchema>;
export const IgRule = model('IgRule', IgRuleSchema);

export const IG_COMMENT_STATUSES = ['pending', 'done', 'skipped', 'failed'] as const;

/** Every comment the bot saw, with what it did (shown in the panel). */
const IgCommentSchema = new Schema(
  {
    commentId: { type: String, required: true, unique: true },
    parentId: String,
    mediaId: String,
    mediaProductType: String,
    fromId: String,
    fromUsername: String,
    text: { type: String, default: '' },
    status: { type: String, enum: IG_COMMENT_STATUSES, default: 'pending', index: true },
    skipReason: String,
    ruleId: { type: Schema.Types.ObjectId, ref: 'IgRule' },
    dueAt: Date,
    publicReply: String,
    publicReplyId: String,
    dmText: String,
    dmSent: { type: Boolean, default: false },
    hidden: { type: Boolean, default: false },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    error: String,
  },
  { timestamps: true, collection: 'ig_comments' },
);
IgCommentSchema.index({ createdAt: -1 });
IgCommentSchema.index({ fromId: 1, createdAt: -1 });
export type IgCommentData = InferSchemaType<typeof IgCommentSchema>;
export const IgComment = model('IgComment', IgCommentSchema);
