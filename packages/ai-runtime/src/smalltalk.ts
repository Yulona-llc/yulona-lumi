/**
 * Detects pure pleasantries ("hi", "thanks", "good morning", "who are you?") so they are answered conversationally
 * instead of hitting the knowledge-base guard. Conservative on purpose: the WHOLE message must be small talk, so
 * "hi, what are your prices?" still goes through retrieval.
 */
const GREETING = String.raw`(?:hi+|hello+|hey+|hiya|howdy|greetings|yo|hola|salam|selam|sup|good\s+(?:morning|afternoon|evening|day)|morning|evening|ሰላም|ታዲያስ|ሃይ|ሄሎ)`;
const THANKS = String.raw`(?:thanks?(?:\s+you)?(?:\s+(?:so|very))?(?:\s+much)?|thank\s+you(?:\s+(?:so|very))?(?:\s+much)?|thx|ty|cheers|አመሰግናለሁ|እናመሰግናለን)`;
const BYE = String.raw`(?:bye+|goodbye|good\s*night|see\s+you(?:\s+later)?|take\s+care|ciao|ቻው)`;
const ACK = String.raw`(?:ok(?:ay)?|k|cool|great|nice|alright|got\s+it|understood|perfect|fine|good|awesome)`;
const HOW = String.raw`(?:how\s+are\s+you(?:\s+(?:doing|today))?|how'?s\s+it\s+going|how\s+do\s+you\s+do|what'?s\s+up|how\s+r\s+u|እንዴት\s+ነህ|እንዴት\s+ነሽ|እንዴት\s+ነዎት)`;
const ABOUT = String.raw`(?:who\s+are\s+you|what\s+are\s+you|are\s+you\s+(?:a\s+)?(?:bot|human|real|ai|robot|person)|what\s+can\s+you\s+do|what\s+do\s+you\s+do|can\s+you\s+help(?:\s+me)?|i\s+need\s+(?:some\s+)?help|help(?:\s+me)?|anyone\s+(?:there|here)|are\s+you\s+there|is\s+anyone\s+there)`;
const ADDRESS = String.raw`(?:\s+(?:there|everyone|all|team|friend|bot|sir|madam))?`;
const PART = `(?:${GREETING}${ADDRESS}|${THANKS}|${BYE}|${ACK}|${HOW}|${ABOUT})`;
const WHOLE = new RegExp(`^(?:${PART})(?:\\s*(?:[,;&]|and)?\\s*${PART}){0,3}$`, "iu");

export function isSmallTalk(text: string): boolean {
  const t = text
    .toLowerCase()
    .replace(/[\p{Extended_Pictographic}‍️]/gu, " ") // emoji
    .replace(/[!?.¡¿…~"'`]+(?=\s|$)/gu, " ") // trailing punctuation
    .replace(/[!?.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > 80) return false;
  return WHOLE.test(t);
}
