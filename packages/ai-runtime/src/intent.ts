/** Explicit "let me talk to a person" requests. Phrase-based on purpose: a bare "agent" must not escalate. */
const NOUN = String.raw`(?:human|real\s+person|live\s+(?:agent|person|chat)|person|people|agent|representative|rep|operator|manager|supervisor|staff|someone|somebody|team\s+member|customer\s+(?:care|service|support)|support\s+(?:team|agent|staff))`;
const PATTERNS = [
  new RegExp(String.raw`\b(?:talk|speak|chat|connect|transfer|escalate|hand|put|get|pass)\s+(?:me\s+)?(?:over\s+)?(?:to|with|through\s+to)\s+(?:a\s+|an\s+|the\s+|your\s+)?${NOUN}\b`, "i"),
  new RegExp(String.raw`\b(?:i\s+(?:want|need|would\s+like|d\s+like|prefer)|can\s+i\s+(?:get|have|talk\s+to|speak\s+to)|let\s+me\s+(?:talk|speak)\s+to|give\s+me)\s+(?:to\s+(?:talk|speak)\s+(?:to|with)\s+)?(?:a\s+|an\s+|the\s+)?${NOUN}\b`, "i"),
  new RegExp(String.raw`^\s*(?:a\s+|an\s+|the\s+)?${NOUN}\s*(?:please|pls|now)?\s*[.!?]*\s*$`, "i"),
  /\b(?:not\s+a\s+bot|no\s+bots?|stop\s+(?:the\s+)?bot)\b/i,
];

export function wantsHuman(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 300 && PATTERNS.some((p) => p.test(t));
}

/** Customer replied with the agent's resume keyword (whole message, case/punctuation-insensitive). */
export function isResumeKeyword(text: string, keyword: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, " ").trim();
  const k = norm(keyword);
  return k.length > 0 && norm(text) === k;
}

/** Text appended to a handoff message so the customer is never stuck waiting for a person. */
export function buildHandoffNotice(o: { keyword: string; outOfHours: boolean; offlineNoticeSent: boolean }): string {
  if (!o.keyword.trim()) return "";
  const k = `"${o.keyword.trim()}"`;
  if (o.outOfHours && !o.offlineNoticeSent) {
    return `Our team is currently offline and will reply when they are back. You don't have to wait: reply ${k} to keep chatting with the assistant right now.`;
  }
  return `You don't have to wait: reply ${k} at any time to keep chatting with the assistant instead.`;
}
