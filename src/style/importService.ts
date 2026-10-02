import { parseChatExport } from './chatImport';
import { buildPairs, saveExamples } from './examples';

export interface ImportResult {
  chats: number;
  messages: number;
  examples: number;
}

/** Import a Telegram export file (HTML / JSON / TXT) → anonymized style examples in MongoDB. */
export async function importChatExport(
  fileName: string,
  content: string,
  opts: { coachId?: number; coachName?: string },
): Promise<ImportResult> {
  const chats = parseChatExport(fileName, content);
  let examples = 0;
  let messages = 0;
  for (const chat of chats) {
    messages += chat.messages.length;
    examples += await saveExamples(buildPairs(chat, opts), fileName.slice(0, 80));
  }
  return { chats: chats.length, messages, examples };
}
