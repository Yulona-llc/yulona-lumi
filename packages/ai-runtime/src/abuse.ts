import type { AbuseConfig } from "@yulona/shared";

/** Rule-based abuse detection (cheap, deterministic, runs before any model call). */
export type AbuseKind = "blocked_phrase" | "flood" | "repeat" | "gibberish" | "model";

export interface AbuseHit {
  kind: AbuseKind;
  /** short, human-readable reason (shown to the team in the abuse handoff; never includes the full message) */
  reason: string;
}

export interface AbuseContext {
  /** strikes already recorded for this conversation */
  strikes: number;
  /** customer messages in the last 60 seconds, including the current one */
  messagesLastMinute: number;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  const t = ` ${s} `;
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}
/** Jaccard similarity of character trigrams (1 = identical). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const A = trigrams(a), B = trigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

/** Symbol/emoji spam or one character repeated over and over. */
export function looksLikeGibberish(text: string): boolean {
  const t = text.replace(/\s+/g, "");
  if (t.length < 12) return false;
  const letters = (t.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (letters / t.length < 0.3) return true;
  if (/(.)\1{14,}/u.test(t)) return true;
  return false;
}

/**
 * Returns the first rule the message trips, or null. `prior` are the customer's earlier messages in this conversation,
 * oldest first (the current message is not included).
 */
export function detectAbuse(cfg: AbuseConfig, text: string, prior: string[], ctx: AbuseContext): AbuseHit | null {
  if (!cfg.enabled) return null;
  const lowered = text.toLowerCase();
  const phrase = cfg.blockedPhrases.find((p) => p.trim() && lowered.includes(p.trim().toLowerCase()));
  if (phrase) return { kind: "blocked_phrase", reason: "message contained a blocked phrase" };
  if (ctx.messagesLastMinute > cfg.maxMessagesPerMinute) return { kind: "flood", reason: `more than ${cfg.maxMessagesPerMinute} messages in one minute` };
  const n = norm(text);
  if (n.length >= 3) {
    const last2 = prior.slice(-2).map(norm);
    if (last2.length === 2 && last2.every((p) => similarity(p, n) >= 0.9)) return { kind: "repeat", reason: "the same message sent three times in a row" };
  }
  if (looksLikeGibberish(text)) return { kind: "gibberish", reason: "message was symbols or repeated characters" };
  return null;
}
