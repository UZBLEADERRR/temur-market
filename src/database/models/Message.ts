import { defineModel, type Doc } from '../odm';

export interface MessageData {
  leadId: string;
  telegramMessageId?: number | null;
  telegramId?: number | null;
  direction: 'incoming' | 'outgoing';
  sender: 'client' | 'temur' | 'ai';
  kind: string;
  text: string;
  processed: boolean;
  meta?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export type MessageDoc = Doc<MessageData>;

export const Message = defineModel<MessageData>('messages', { json: ['meta'] });
