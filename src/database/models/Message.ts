import { Schema, model, type InferSchemaType } from 'mongoose';

const MessageSchema = new Schema(
  {
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    telegramMessageId: Number,
    telegramId: Number,
    direction: { type: String, enum: ['incoming', 'outgoing'], required: true },
    sender: { type: String, enum: ['client', 'temur', 'ai'], required: true },
    kind: { type: String, default: 'text' },
    text: { type: String, default: '' },
    processed: { type: Boolean, default: true },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: true, collection: 'messages' },
);

MessageSchema.index({ leadId: 1, createdAt: 1 });

export type MessageData = InferSchemaType<typeof MessageSchema>;
export const Message = model('Message', MessageSchema);
