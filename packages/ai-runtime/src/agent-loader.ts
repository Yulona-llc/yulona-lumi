import type { Tx } from "@yulona/db";
import { BUILTIN_TOOLS } from "./stage";
import type { ToolManifest } from "@yulona/shared";
import type { AgentConfig, CustomToolConfig } from "./types";

export const DEFAULT_FALLBACK = "I'm not sure about that, so I'm connecting you with a teammate who can help.";
export const DEFAULT_CLARIFY = "I couldn't find that in the information I have. Could you rephrase it or share a bit more detail? If you'd rather talk to a person, just say so.";
export const DEFAULT_HANDOFF = "Thanks! I'm handing you over to a teammate who will be with you shortly.";

const num = (v: unknown, d: number, lo: number, hi: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const s = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** Defensive mapping from an `agents` row (platform schema) to the runtime's AgentConfig. */
export function mapAgentRow(row: Record<string, unknown>, tenantId: string): AgentConfig {
  const cfg = (row.config ?? row.settings ?? {}) as Record<string, unknown>;
  const pickv = (k: string) => cfg[k] ?? row[k];
  const enabled = Array.isArray(pickv("enabledTools")) ? (pickv("enabledTools") as unknown[]).filter((x): x is string => typeof x === "string") : [...BUILTIN_TOOLS];
  // dashboard-saved configs hold bare manifests; { manifest, secret? } is also accepted (resolveTools normalises both)
  const custom = Array.isArray(pickv("customTools")) ? (pickv("customTools") as unknown[]).filter((x): x is CustomToolConfig | ToolManifest => typeof x === "object" && x !== null) : [];
  const rules = (pickv("escalationRules") ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id),
    tenantId,
    name: s(row.name) ?? "Assistant",
    systemPrompt: s(pickv("systemPrompt")) ?? "",
    ...(s(pickv("greeting")) ? { greeting: s(pickv("greeting"))!.trim() } : {}),
    similarityThreshold: num(pickv("similarityThreshold"), 0.15, 0, 1),
    topK: Math.round(num(pickv("topK"), 5, 1, 20)),
    fallbackMessage: s(pickv("fallbackMessage")) ?? DEFAULT_FALLBACK,
    clarifyMessage: s(pickv("clarifyMessage")) ?? DEFAULT_CLARIFY,
    handoffMessage: s(pickv("handoffMessage")) ?? DEFAULT_HANDOFF,
    escalationKeywords: Array.isArray(rules.keywords) ? rules.keywords.filter((k): k is string => typeof k === "string" && k.trim() !== "").map((k) => k.trim().toLowerCase()) : [],
    maxUnansweredTurns: Math.round(num(rules.maxUnansweredTurns, 3, 1, 20)),
    resumeKeyword: typeof rules.resumeKeyword === "string" ? rules.resumeKeyword.trim() : "AI",
    model: s(pickv("model")),
    enabledTools: enabled,
    customTools: custom,
    handoffAtQualified: pickv("handoffAtQualified") === true,
  };
}

export async function loadAgent(tx: Tx, tenantId: string, agentId: string | null, opts: { draft?: boolean } = {}): Promise<AgentConfig | null> {
  const rows = agentId
    ? await tx<Record<string, unknown>[]>`SELECT * FROM agents WHERE tenant_id = ${tenantId} AND id = ${agentId}`
    : await tx<Record<string, unknown>[]>`SELECT * FROM agents WHERE tenant_id = ${tenantId} ORDER BY created_at ASC LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  // Published agents run their published version; `draft: true` (sandbox only) uses the saved draft in agents.config.
  if (!opts.draft && row.publishedVersion != null) {
    const [v] = await tx<{ config: unknown }[]>`
      SELECT config FROM agent_versions WHERE tenant_id = ${tenantId} AND agent_id = ${String(row.id)} AND version = ${row.publishedVersion as number}`;
    if (v) return mapAgentRow({ ...row, config: v.config }, tenantId);
  }
  return mapAgentRow(row, tenantId);
}
