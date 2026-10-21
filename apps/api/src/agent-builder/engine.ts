import { z } from "zod";
import { KnowledgeRepository, SsrfError, addUsage, assertSafeUrl, creditsRemaining, type AiPorts, type ChatMessage, type ToolCall } from "@yulona/ai-runtime";
import { AuditLogRepository, withTenant, type Db } from "@yulona/db";
import { enqueue } from "@yulona/queue";
import { agentConfigSchema } from "@yulona/shared";
import { AppError, Errors } from "../errors";
import { assertWithinLimit } from "../platform/limits";
import { BUILDER_TOOLS, systemPrompt } from "./prompt";
import { MAX_KNOWLEDGE_PER_SESSION, MAX_SESSION_TOKENS, MAX_TOOL_ROUNDS, MAX_USER_MESSAGES, emptyDraft, type Draft } from "./schemas";

export interface BuilderMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}
export interface SessionRow {
  id: string; status: "open" | "created" | "abandoned"; draft: Draft; agentId: string | null; tokensUsed: number; createdAt: Date; updatedAt: Date;
}

export const ALLOWED_TOOLS = new Set(["qualify_lead", "collect_contact", "escalate_to_human", "check_availability", "book_appointment"]);
const FORBIDDEN_KEYS = ["model", "customTools", "similarityThreshold", "topK"];

const patchSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
const askSchema = z.object({ question: z.string().trim().min(1).max(600), options: z.array(z.string().trim().min(1).max(80)).max(6).optional() });
const knowledgeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url"), name: z.string().trim().min(1).max(200), url: z.string().url().max(2048) }),
  z.object({ type: z.literal("text"), name: z.string().trim().min(1).max(200), content: z.string().min(1).max(100_000) }),
]);

const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));

/** Merge a patch into the draft and validate the whole result; returns the new draft or errors for the model. */
export function applyPatch(draft: Draft, rawPatch: unknown): { ok: true; draft: Draft } | { ok: false; errors: { path: string; message: string }[] } {
  const p = patchSchema.safeParse(rawPatch);
  if (!p.success) return { ok: false, errors: issues(p.error) };
  const patch = p.data;
  const errors: { path: string; message: string }[] = [];
  for (const k of FORBIDDEN_KEYS) if (patch.config && k in patch.config) errors.push({ path: `config.${k}`, message: k === "customTools" ? "Custom tools cannot be created here. Tell the owner to add them in the agent's Tools tab after the draft is created." : "Not settable by the builder" });
  const tools = patch.config?.enabledTools;
  if (Array.isArray(tools)) for (const t of tools) if (typeof t !== "string" || !ALLOWED_TOOLS.has(t)) errors.push({ path: "config.enabledTools", message: `Unknown tool "${String(t)}". Allowed: ${[...ALLOWED_TOOLS].join(", ")}` });
  if (errors.length) return { ok: false, errors };
  const merged: Record<string, unknown> = { ...draft.config, ...(patch.config ?? {}) };
  const curEsc = draft.config.escalationRules, newEsc = patch.config?.escalationRules;
  if (curEsc && newEsc && typeof curEsc === "object" && typeof newEsc === "object") merged.escalationRules = { ...(curEsc as object), ...(newEsc as object) };
  const parsed = agentConfigSchema.safeParse(merged);
  if (!parsed.success) return { ok: false, errors: issues(parsed.error) };
  return {
    ok: true,
    draft: { ...draft, ready: false, name: patch.name ?? draft.name, description: patch.description ?? draft.description, config: merged },
  };
}

/** What is still missing before `finish` is allowed. */
export function missingForFinish(d: Draft): string[] {
  const m: string[] = [];
  if (!d.name) m.push("name");
  if (typeof d.config.systemPrompt !== "string" || d.config.systemPrompt.length < 40) m.push("config.systemPrompt");
  if (typeof d.config.greeting !== "string" || !d.config.greeting) m.push("config.greeting");
  return m;
}

export interface TurnDeps {
  db: Db;
  ports: AiPorts;
  charge: boolean;
  tenantId: string;
  userId: string;
  requestId?: string;
  ip?: string;
}

const inflight = new Set<string>();

export async function loadSession(db: Db, tenantId: string, userId: string, id: string) {
  return withTenant(db, tenantId, async (tx) => {
    const [s] = await tx<SessionRow[]>`
      SELECT id, status, draft, agent_id, tokens_used, created_at, updated_at FROM builder_sessions
      WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND id = ${id}`;
    if (!s) return null;
    const messages = await tx<{ id: string; role: BuilderMessage["role"]; content: string; payload: Record<string, unknown> | null; createdAt: Date }[]>`
      SELECT id, role, content, payload, created_at FROM builder_messages WHERE tenant_id = ${tenantId} AND session_id = ${id} ORDER BY created_at, id`;
    return { session: s, messages: messages.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })) as BuilderMessage[] };
  });
}

export const sessionDto = (s: SessionRow, messages: BuilderMessage[]) => ({
  id: s.id, status: s.status, agentId: s.agentId, draft: { ...emptyDraft(), ...s.draft },
  limits: { maxUserMessages: MAX_USER_MESSAGES, userMessages: messages.filter((m) => m.role === "user").length },
  messages, createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString(),
});

/**
 * One user turn: persist the message, loop the model with the builder tools (update_draft / ask / create_knowledge_source / finish)
 * until it asks, finishes or answers in plain text, persist everything, meter every call as source "builder".
 */
export async function runBuilderTurn(d: TurnDeps, sessionId: string, input: { text?: string; choice?: string }) {
  const { db, tenantId, userId } = d;
  if (inflight.has(sessionId)) throw Errors.conflict("The assistant is still answering the previous message");
  inflight.add(sessionId);
  try {
    const loaded = await loadSession(db, tenantId, userId, sessionId);
    if (!loaded) throw Errors.notFound("Session not found");
    const { session, messages } = loaded;
    if (session.status !== "open") throw Errors.conflict("This session is closed");
    if (messages.filter((m) => m.role === "user").length >= MAX_USER_MESSAGES) throw new AppError(429, "rate_limited", "This session reached its message limit. Create the draft or start a new session.");
    if (session.tokensUsed >= MAX_SESSION_TOKENS) throw new AppError(429, "rate_limited", "This session reached its AI usage limit. Create the draft or start a new session.");
    if (d.charge) {
      const rem = await withTenant(db, tenantId, (tx) => creditsRemaining(tx, tenantId));
      if (rem !== null && rem <= 0) throw new AppError(402, "credits_exhausted", "AI credits are used up. Buy more credits to keep building.", { remainingMicro: rem });
    }

    const userText = input.text ?? input.choice!;
    const out: BuilderMessage[] = [];
    const save = async (role: BuilderMessage["role"], content: string, payload?: Record<string, unknown>) => {
      const [m] = await withTenant(db, tenantId, (tx) => tx<{ id: string; createdAt: Date }[]>`
        INSERT INTO builder_messages (tenant_id, session_id, role, content, payload)
        VALUES (${tenantId}, ${sessionId}, ${role}, ${content.slice(0, 20000)}, ${payload ? tx.json(payload as never) : null}) RETURNING id, created_at`);
      const msg: BuilderMessage = { id: m!.id, role, content, payload: payload ?? null, createdAt: m!.createdAt.toISOString() };
      out.push(msg);
      return msg;
    };
    await save("user", userText, input.choice !== undefined ? { choice: true } : undefined);

    let draft: Draft = { ...emptyDraft(), ...session.draft };
    let tokens = session.tokensUsed;
    const history: ChatMessage[] = messages.filter((m) => m.role !== "tool").slice(-30).map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    const convo: ChatMessage[] = [...history, { role: "user", content: userText }];
    let terminal: { content: string; payload?: Record<string, unknown> } | null = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS && !terminal; round++) {
      const res = await d.ports.llm.chat({ messages: [{ role: "system", content: systemPrompt(draft) }, ...convo], tools: BUILDER_TOOLS, temperature: 0.3, maxTokens: 2500 })
        .catch(() => { throw new AppError(503, "service_unavailable", "The AI provider is unavailable. Try again in a moment."); });
      const used = res.usage.promptTokens + res.usage.completionTokens;
      tokens += used;
      await withTenant(db, tenantId, async (tx) => {
        await addUsage(tx, tenantId, {
          ...res.usage, requests: 1, source: "builder", model: res.model ?? null, profileId: res.profileId ?? null, agentId: null, charge: d.charge,
        });
        await tx`UPDATE builder_sessions SET tokens_used = ${tokens}, updated_at = now() WHERE tenant_id = ${tenantId} AND id = ${sessionId}`;
      });

      if (!res.toolCalls.length) {
        terminal = { content: (res.content ?? "").trim() || "Could you tell me a bit more about your business?" };
        break;
      }
      convo.push({ role: "assistant", content: res.content ?? "", toolCalls: res.toolCalls });
      let ask: z.output<typeof askSchema> | null = null;
      let finished: string | null = null;
      for (const call of res.toolCalls) {
        const result = await runTool(d, sessionId, call, draft, ask !== null);
        if (result.draft) draft = result.draft;
        if (result.ask) ask = result.ask;
        if (result.finish !== undefined) finished = result.finish;
        convo.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(result.reply) });
        await save("tool", `${call.name}: ${result.ok ? "ok" : "error"}`, { name: call.name, ok: result.ok, reply: result.reply });
      }
      if (ask) terminal = { content: ask.question, payload: { ask: { question: ask.question, options: ask.options ?? [] } } };
      else if (finished !== null) {
        draft = { ...draft, ready: true };
        terminal = { content: finished || (res.content ?? "").trim() || "Your agent draft is ready. Review the sheet, then create the draft.", payload: { ready: true } };
      }
    }
    terminal ??= { content: "I updated the draft. What would you like to adjust or add next?" };
    const assistant = await save("assistant", terminal.content, terminal.payload);
    await withTenant(db, tenantId, (tx) => tx`UPDATE builder_sessions SET draft = ${tx.json(draft as never)}, updated_at = now() WHERE tenant_id = ${tenantId} AND id = ${sessionId}`);
    return { messages: out, assistant, draft, ready: draft.ready };
  } finally {
    inflight.delete(sessionId);
  }
}

interface ToolOutcome {
  ok: boolean;
  reply: Record<string, unknown>;
  draft?: Draft;
  ask?: z.output<typeof askSchema>;
  finish?: string;
}

async function runTool(d: TurnDeps, sessionId: string, call: ToolCall, draft: Draft, alreadyAsking: boolean): Promise<ToolOutcome> {
  const args = call.arguments ?? {};
  switch (call.name) {
    case "update_draft": {
      const r = applyPatch(draft, (args as { patch?: unknown }).patch);
      return r.ok ? { ok: true, reply: { ok: true }, draft: r.draft } : { ok: false, reply: { ok: false, errors: r.errors } };
    }
    case "ask": {
      const a = askSchema.safeParse(args);
      if (!a.success) return { ok: false, reply: { ok: false, errors: issues(a.error) } };
      if (alreadyAsking) return { ok: false, reply: { ok: false, errors: [{ path: "", message: "Ask only one question per turn" }] } };
      return { ok: true, reply: { ok: true, note: "Question sent; wait for the answer." }, ask: a.data };
    }
    case "finish": {
      const missing = missingForFinish(draft);
      if (missing.length) return { ok: false, reply: { ok: false, errors: missing.map((p) => ({ path: p, message: "Required before finishing" })) } };
      return { ok: true, reply: { ok: true }, finish: typeof (args as { summary?: unknown }).summary === "string" ? String((args as { summary: string }).summary).slice(0, 1000) : "" };
    }
    case "create_knowledge_source": {
      const a = knowledgeSchema.safeParse(args);
      if (!a.success) return { ok: false, reply: { ok: false, errors: issues(a.error) } };
      if (draft.knowledge.length >= MAX_KNOWLEDGE_PER_SESSION) return { ok: false, reply: { ok: false, errors: [{ path: "", message: `At most ${MAX_KNOWLEDGE_PER_SESSION} sources per builder session; tell the owner to add more under Knowledge.` }] } };
      if (a.data.type === "url") {
        try { await assertSafeUrl(a.data.url); } catch (e) {
          if (e instanceof SsrfError) return { ok: false, reply: { ok: false, errors: [{ path: "url", message: e.message }] } };
          throw e;
        }
      }
      try {
        const src = await withTenant(d.db, d.tenantId, async (tx) => {
          const size = a.data.type === "text" ? Buffer.byteLength(a.data.content) : 0;
          await assertWithinLimit(tx, d.tenantId, "storage_mb", Math.floor(size / 1048576));
          const repo = new KnowledgeRepository(tx, d.tenantId);
          const s = a.data.type === "url"
            ? await repo.create({ type: "url", name: a.data.name, sourceUrl: a.data.url, crawlConfig: { maxPages: 1 }, createdBy: d.userId })
            : await repo.create({ type: "text", name: a.data.name, rawText: a.data.content, sizeBytes: size, createdBy: d.userId });
          await enqueue(tx, { name: "knowledge.ingest", tenantId: d.tenantId, payload: { tenantId: d.tenantId, sourceId: s.id }, maxAttempts: 4 });
          await new AuditLogRepository(tx, d.tenantId).record({
            actorUserId: d.userId, action: "knowledge.source.create", resourceType: "knowledge_source", resourceId: s.id,
            metadata: { type: s.type, name: s.name, via: "builder", sessionId }, ip: d.ip, requestId: d.requestId,
          });
          return s;
        });
        return { ok: true, reply: { ok: true, id: src.id, status: "queued" }, draft: { ...draft, knowledge: [...draft.knowledge, { id: src.id, name: src.name, type: a.data.type }] } };
      } catch (e) {
        if (e instanceof AppError) return { ok: false, reply: { ok: false, errors: [{ path: "", message: e.message }] } };
        throw e;
      }
    }
    default:
      return { ok: false, reply: { ok: false, errors: [{ path: "", message: `Unknown tool ${call.name}` }] } };
  }
}
