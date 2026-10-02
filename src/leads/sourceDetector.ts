import { Campaign } from '../database/models/misc';
import { normalize } from '../utils/text';

export interface DetectedSource {
  source: string;
  /** Message text with the tracking code removed (what the AI sees). */
  cleanedText: string;
}

/**
 * Detects the advertising source from the first message prefilled by a Telegram Business chat link.
 * 1. Campaign codes configured by the admin (e.g. code "#v3" → source "video_03").
 * 2. Generic hashtag "#video_03".
 * 3. Phrases like "3-videodan keldim" / "из видео 3" → video_03.
 */
export async function detectSource(text: string): Promise<DetectedSource> {
  const n = normalize(text);
  const campaigns = await Campaign.find().lean();
  // longest codes first so "#v10" wins over "#v1"
  campaigns.sort((a, b) => b.code.length - a.code.length);
  for (const c of campaigns) {
    const code = normalize(c.code);
    if (code && n.includes(code)) {
      const re = new RegExp(escapeRe(c.code), 'i');
      return { source: c.source, cleanedText: text.replace(re, '').trim() };
    }
  }
  const tag = text.match(/#([\p{L}\d_-]{2,40})/u);
  if (tag) return { source: tag[1].toLowerCase(), cleanedText: text.replace(tag[0], '').trim() };

  const vid = n.match(/(\d{1,3})\s*-?\s*(?:video|видео)/) ?? n.match(/(?:video|видео)\w*\s*(?:№|#)?\s*(\d{1,3})/);
  if (vid) return { source: `video_${vid[1].padStart(2, '0')}`, cleanedText: text };

  return { source: 'unknown', cleanedText: text };
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
