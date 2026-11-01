/**
 * Per-turn cost controls. Every value has a safe default and can be tuned per deployment with an environment
 * variable (read on each turn, so changes apply after a restart and tests can toggle them). Documented in
 * `apps/docs/self-hosting/configuration.mdx` and `deploy/.env.example`.
 */
export interface TurnLimits {
  /** rounds in which the model may call tools; after them one tool-free call produces the final answer */
  maxToolRounds: number;
  /** total prompt+completion tokens a turn may spend before the next call is forced to be the tool-free final answer */
  turnTokenBudget: number;
  /** whole knowledge base at most this many characters => inlined in the prompt, no tools */
  inlineAllChars: number;
  /** sections pre-loaded into the prompt by keyword search when the knowledge base is bigger */
  preloadSections: number;
  /** read_skill output cap (characters) */
  readCapChars: number;
  /** search_skills snippet length (characters per hit) */
  searchSnippetChars: number;
  /** earlier-round tool results are shortened to this many characters once the model has seen them */
  staleToolResultChars: number;
  /** messages of conversation history sent to the model */
  historyMessages: number;
  /** characters kept per history message */
  historyChars: number;
  /** completion cap per model call */
  maxOutputTokens: number;
  /** optional `reasoning_effort` sent to the provider (none | minimal | low | medium | high); unset = not sent */
  reasoningEffort?: string;
}

const int = (v: string | undefined, d: number, lo: number, hi: number): number => {
  const n = v === undefined || v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};

export function turnLimits(env: Record<string, string | undefined> = process.env): TurnLimits {
  const effort = env.AI_REASONING_EFFORT?.trim().toLowerCase();
  return {
    maxToolRounds: int(env.AI_MAX_TOOL_ROUNDS, 2, 0, 6),
    turnTokenBudget: int(env.AI_TURN_TOKEN_BUDGET, 12_000, 1_000, 200_000),
    inlineAllChars: int(env.AI_INLINE_ALL_CHARS, 4_000, 0, 60_000),
    preloadSections: int(env.AI_PRELOAD_SECTIONS, 2, 0, 12),
    readCapChars: int(env.AI_READ_SKILL_MAX_CHARS, 3_000, 500, 20_000),
    searchSnippetChars: int(env.AI_SEARCH_SNIPPET_CHARS, 160, 40, 600),
    staleToolResultChars: int(env.AI_STALE_TOOL_RESULT_CHARS, 300, 0, 4_000),
    historyMessages: int(env.AI_HISTORY_MESSAGES, 6, 0, 40),
    historyChars: int(env.AI_HISTORY_MESSAGE_CHARS, 600, 100, 4_000),
    maxOutputTokens: int(env.AI_MAX_OUTPUT_TOKENS, 700, 100, 4_000),
    ...(effort && ["none", "minimal", "low", "medium", "high"].includes(effort) ? { reasoningEffort: effort } : {}),
  };
}

/** Cheap token estimate (about 4 characters per token) for billed attempts that returned no usage. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);
