/**
 * Last line of defence against "AI slop" before a message reaches the client:
 * removes typical assistant openers, markdown, em dashes and emoji spam so the text reads like a person typed it.
 */
const SLOP_OPENERS = [
  /^(ajoyib|zo'r|yaxshi|juda yaxshi|qiziq|ajib) savol[!.,]*\s*/i,
  /^sizga yordam berishdan (mamnunman|xursandman)[!.,]*\s*/i,
  /^hurmatli mijoz[!.,]*\s*/i,
  /^albatta[!]+\s*/i,
  /^(отличный|хороший|прекрасный) вопрос[!.,]*\s*/i,
  /^(рад|рада) (помочь|вам помочь)[!.,]*\s*/i,
  /^конечно[!]+\s*/i,
  /^great question[!.,]*\s*/i,
];

const SLOP_ANYWHERE: Array<[RegExp, string]> = [
  [/\s*(eksklyuziv imkoniyat|ajoyib imkoniyat|noyob imkoniyat)\s*/gi, ' '],
  [/\s*sizning muvaffaqiyatingiz\s*[—-]\s*bizning maqsadimiz[.!]?\s*/gi, ' '],
  [/\s*shoshiling[!.]*\s*/gi, ' '],
];

const EMOJI = /\p{Extended_Pictographic}️?/gu;

export function humanize(raw: string): string {
  let t = raw.replace(/\r/g, '');
  // markdown
  t = t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|$)/g, '$1$2');
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/^\s*(?:[-•*]|\d+[.)])\s+/gm, '');
  // em/en dashes are a typical machine tell; people type a simple hyphen or a comma
  t = t.replace(/\s*[—–]\s*/g, ' - ');
  for (const re of SLOP_OPENERS) t = t.replace(re, '');
  for (const [re, rep] of SLOP_ANYWHERE) t = t.replace(re, rep);
  // at most one emoji per message
  let seen = 0;
  t = t.replace(EMOJI, (m) => (++seen > 1 ? '' : m));
  t = t.replace(/!{2,}/g, '!').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  // re-capitalise if an opener was removed
  if (t && t[0] !== t[0].toUpperCase()) t = t[0].toUpperCase() + t.slice(1);
  return t;
}
