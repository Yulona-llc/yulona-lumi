import { Hono } from "hono";
import { z } from "zod";
import { KnowledgeRepository, addUsage, type AiPorts } from "@yulona/ai-runtime";
import { AuditLogRepository, withTenant, type Db, type Tx } from "@yulona/db";
import { enqueue } from "@yulona/queue";
import {
  agentConfigSchema, answerBodySchema, goalsSchema, opsSettingsUpdateSchema, updateProfileSchema, widgetConfigSchema,
  type BundleResult, type Goal, type OnboardingState, type OnboardingStatus, type WorkspaceProfile,
} from "@yulona/shared";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { guard } from "../ops/common";
import { saveOpsSettings, validTz, minutes } from "../ops/settings";
import { assertWithinLimit } from "../platform/limits";
import { audit } from "../platform/util";
import { newWidgetKey } from "../routes/widgets";
import { AgentsRepository } from "../routes/agents";
import { WidgetsRepository } from "../conversations/repos";
import { buildSteps, parseAnswer } from "./onboarding-steps";
import { agentTemplate, opsTemplate, previewLines, widgetTemplate, type Answers } from "./templates";

interface Stored {
  answers?: Record<string, unknown>;
  startedAt?: string; completedAt?: string; skippedAt?: string;
  polishAttempted?: boolean;
  result?: BundleResult;
}

export const POLISH_MAX_TOKENS = 700;
export const POLISH_TIMEOUT_MS = 20_000;

async function loadStored(tx: Tx, tenantId: string, lock = false): Promise<{ stored: Stored; goals: Goal[]; name: string }> {
  const [t] = lock
    ? await tx<{ onboarding: Stored; goals: Goal[]; name: string }[]>`SELECT onboarding, goals, name FROM tenants WHERE id = ${tenantId} FOR UPDATE`
    : await tx<{ onboarding: Stored; goals: Goal[]; name: string }[]>`SELECT onboarding, goals, name FROM tenants WHERE id = ${tenantId}`;
  if (!t) throw Errors.notFound();
  return { stored: t.onboarding ?? {}, goals: t.goals ?? [], name: t.name };
}
const statusOf = (s: Stored): OnboardingStatus =>
  s.completedAt ? "completed" : s.skippedAt ? "skipped" : Object.keys(s.answers ?? {}).length ? "in_progress" : "not_started";

export function toState(s: Stored): OnboardingState {
  const answers = s.answers ?? {};
  const steps = buildSteps(answers).map((st) => (st.component === "preview" ? { ...st, help: [st.help, ...previewLines(answers as Answers)].filter(Boolean).join("\n") } : st));
  const real = steps.filter((x) => x.component !== "preview");
  const done = real.filter((x) => x.id in answers).length;
  const current = real.find((x) => !(x.id in answers))?.id ?? "preview";
  return { status: statusOf(s), currentStepId: current, steps, answers, progress: { done, total: real.length }, result: s.result ?? null };
}

export const profileDto = (name: string, goals: Goal[], s: Stored): WorkspaceProfile => ({
  name, goals, onboarding: { status: statusOf(s), completedAt: s.completedAt ?? null, skippedAt: s.skippedAt ?? null },
});

const POLISH_SYSTEM = "You improve the instructions of a customer-chat assistant for a small business. Return ONLY JSON: {\"systemPrompt\": string (60-1500 chars), \"greeting\": string (max 200 chars)}. Keep every fact and rule of the draft, keep the business name, never add facts, prices or promises. Plain text, no markdown.";

/** One capped model call; returns null on any failure so the template text stays. Metered as source "onboarding", never charged. */
async function polish(ports: AiPorts, d: { db: Db; tenantId: string; agentId: string; prompt: string; greeting: string; name: string }): Promise<{ systemPrompt: string; greeting: string } | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), POLISH_TIMEOUT_MS);
  try {
    const res = await ports.llm.chat({
      messages: [{ role: "system", content: POLISH_SYSTEM }, { role: "user", content: `Business: ${d.name}\nDraft instructions:\n${d.prompt.slice(0, 2400)}\nDraft greeting: ${d.greeting.slice(0, 300)}` }],
      temperature: 0.3, maxTokens: POLISH_MAX_TOKENS, signal: ac.signal,
    });
    await withTenant(d.db, d.tenantId, (tx) => addUsage(tx, d.tenantId, { ...res.usage, requests: 1, source: "onboarding", model: res.model ?? null, profileId: res.profileId ?? null, agentId: d.agentId, charge: false }));
    const m = /\{[\s\S]*\}/.exec(res.content ?? "");
    if (!m) return null;
    const out = z.object({ systemPrompt: z.string().trim().min(60).max(1500), greeting: z.string().trim().min(2).max(200) }).safeParse(JSON.parse(m[0]));
    return out.success ? out.data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface OnboardingDeps { cfg: Config; db: Db; ports: () => AiPorts }

export function onboardingRoutes({ cfg, db, ports }: OnboardingDeps) {
  const r = new Hono<AppEnv>();
  const admin = guard(cfg, "admin");

  // ---- workspace profile ----
  r.get("/workspace/profile", guard(cfg, "viewer"), async (c) => {
    const { tenantId } = c.get("auth");
    const p = await withTenant(db, tenantId, async (tx) => { const x = await loadStored(tx, tenantId); return profileDto(x.name, x.goals, x.stored); });
    return c.json(p);
  });
  r.put("/workspace/profile", admin, async (c) => {
    const { tenantId } = c.get("auth");
    const b = await parseBody(c, updateProfileSchema);
    const p = await withTenant(db, tenantId, async (tx) => {
      await tx`UPDATE tenants SET goals = ${tx.array(b.goals)}::text[], updated_at = now() WHERE id = ${tenantId}`;
      await audit(tx, c, "workspace.profile.update", "tenant", tenantId, { goals: b.goals });
      const x = await loadStored(tx, tenantId);
      return profileDto(x.name, x.goals, x.stored);
    });
    return c.json(p);
  });

  // ---- onboarding ----
  r.get("/onboarding", admin, async (c) => {
    const { tenantId } = c.get("auth");
    return c.json(toState((await withTenant(db, tenantId, (tx) => loadStored(tx, tenantId))).stored));
  });

  r.put("/onboarding/answers", admin, async (c) => {
    const { tenantId } = c.get("auth");
    const b = await parseBody(c, answerBodySchema);
    const step = buildSteps({}).find((s) => s.id === b.stepId)!;
    let value: unknown;
    if (b.value === null) {
      if (!step.skippable) throw Errors.validation([{ path: "value", message: "This step cannot be skipped" }]);
      value = null;
    } else {
      try { value = parseAnswer(b.stepId, b.value); } catch (e) {
        if (e instanceof z.ZodError) throw Errors.validation(e.issues.map((i) => ({ path: ["value", ...i.path].join("."), message: i.message })));
        throw e;
      }
      if (b.stepId === "hours" && (value as { mode: string }).mode === "custom") {
        const h = value as { timezone: string; days: { start: string; end: string }[] };
        if (!validTz(h.timezone)) throw Errors.validation([{ path: "value.timezone", message: "Unknown IANA timezone" }]);
        for (const [i, d] of h.days.entries()) if (minutes(d.start) >= minutes(d.end)) throw Errors.validation([{ path: `value.days.${i}`, message: "start must be before end" }]);
      }
      if (b.stepId === "website" && value === "") value = null;
    }
    const state = await withTenant(db, tenantId, async (tx) => {
      const { stored } = await loadStored(tx, tenantId, true);
      if (stored.completedAt) throw Errors.conflict("Onboarding is already completed");
      const next: Stored = { ...stored, answers: { ...(stored.answers ?? {}), [b.stepId]: value }, startedAt: stored.startedAt ?? new Date().toISOString() };
      delete next.skippedAt;
      await tx`UPDATE tenants SET onboarding = ${tx.json(next as never)}, updated_at = now() WHERE id = ${tenantId}`;
      return toState(next);
    });
    return c.json(state);
  });

  r.post("/onboarding/skip", admin, async (c) => {
    const { tenantId } = c.get("auth");
    const state = await withTenant(db, tenantId, async (tx) => {
      const { stored } = await loadStored(tx, tenantId, true);
      if (stored.completedAt) return toState(stored);
      const next: Stored = { ...stored, skippedAt: new Date().toISOString() };
      await tx`UPDATE tenants SET onboarding = ${tx.json(next as never)}, updated_at = now() WHERE id = ${tenantId}`;
      await audit(tx, c, "onboarding.skipped", "tenant", tenantId);
      return toState(next);
    });
    return c.json(state);
  });

  r.post("/onboarding/finish", admin, async (c) => {
    const { tenantId, userId } = c.get("auth");
    const meta = { via: "onboarding" };
    const out = await withTenant(db, tenantId, async (tx) => {
      const { stored, name: tenantName } = await loadStored(tx, tenantId, true);
      if (stored.result) return { result: stored.result, created: false as const };
      const a = (stored.answers ?? {}) as Answers;
      const missing = (["businessType", "businessName", "goals"] as const).filter((k) => !a[k]);
      if (missing.length) throw Errors.validation(missing.map((k) => ({ path: k, message: "Answer this step before finishing" })));
      const goals = goalsSchema.parse(a.goals);
      const audits = new AuditLogRepository(tx, tenantId);
      const rec = (action: string, resourceType: string, resourceId: string, metadata: Record<string, unknown> = {}) =>
        audits.record({ actorUserId: userId, action, resourceType, resourceId, metadata: { ...metadata, ...meta }, ip: c.get("ip"), requestId: c.get("requestId") });

      await assertWithinLimit(tx, tenantId, "agents");
      await assertWithinLimit(tx, tenantId, "widgets");
      const tpl = agentTemplate(a);
      const agent = await new AgentsRepository(tx, tenantId).create({ name: tpl.name, description: tpl.description, config: tpl.config, by: userId });
      await rec("agent.created", "agent", agent.id, { name: agent.name });

      const wt = widgetTemplate(a, tpl.config.greeting ?? "");
      const config = widgetConfigSchema.safeParse(wt.config);
      const widget = await new WidgetsRepository(tx, tenantId).create({ name: wt.name, widgetKey: newWidgetKey(), agentId: agent.id, config: config.success ? config.data : { title: wt.config.title } });
      await rec("widget.create", "widget", widget.id);

      let knowledgeSourceId: string | null = null;
      if (typeof a.website === "string" && a.website) {
        const { assertSafeUrl, SsrfError } = await import("@yulona/ai-runtime");
        let safe = true;
        try { await assertSafeUrl(a.website); } catch (e) { if (e instanceof SsrfError) safe = false; else throw e; }
        if (safe) {
          await assertWithinLimit(tx, tenantId, "storage_mb", 0);
          const src = await new KnowledgeRepository(tx, tenantId).create({
            type: "url", name: new URL(a.website).hostname, sourceUrl: a.website,
            crawlConfig: { maxPages: 25, followLinks: true, maxDepth: 3, includeSubdomains: false }, createdBy: userId,
          });
          await enqueue(tx, { name: "knowledge.ingest", tenantId, payload: { tenantId, sourceId: src.id }, maxAttempts: 4 });
          await rec("knowledge.source.create", "knowledge_source", src.id, { type: "url", name: src.name });
          knowledgeSourceId = src.id;
        }
      }

      const ops = opsTemplate(a);
      if (Object.keys(ops).length) {
        const parsed = opsSettingsUpdateSchema.parse(ops);
        await saveOpsSettings(tx, tenantId, parsed);
        await rec("ops_settings.update", "ops_settings", tenantId, { fields: Object.keys(parsed) });
      }

      const result: BundleResult = {
        agentId: agent.id, widgetId: widget.id, knowledgeSourceId, usedModel: false, goals,
        nextStep: { label: "Try your assistant, then publish it", path: `/agents/${agent.id}` },
      };
      const next: Stored = { ...stored, completedAt: new Date().toISOString(), polishAttempted: true, result };
      delete next.skippedAt;
      await tx`UPDATE tenants SET goals = ${tx.array(goals)}::text[], onboarding = ${tx.json(next as never)}, updated_at = now() WHERE id = ${tenantId}`;
      await rec("onboarding.completed", "tenant", tenantId, { agentId: agent.id, widgetId: widget.id });
      return { result, created: true as const, tpl, tenantName: a.businessName ?? tenantName };
    });
    if (!out.created) return c.json(out.result, 200);

    // After commit: the single, capped, uncharged model call that polishes the prompt and greeting (never required).
    let result = out.result;
    let p: Awaited<ReturnType<typeof polish>> = null;
    try {
      p = await polish(ports(), { db, tenantId, agentId: result.agentId, prompt: out.tpl.config.systemPrompt, greeting: out.tpl.config.greeting ?? "", name: out.tenantName });
    } catch { p = null; }
    if (p) {
      const next = agentConfigSchema.safeParse({ ...out.tpl.config, systemPrompt: p.systemPrompt, greeting: p.greeting });
      if (next.success) {
        result = { ...result, usedModel: true };
        await withTenant(db, tenantId, async (tx) => {
          await tx`UPDATE agents SET config = ${tx.json(next.data as never)}, updated_at = now() WHERE tenant_id = ${tenantId} AND id = ${result.agentId} AND status = 'draft'`;
          await tx`UPDATE widgets SET config = jsonb_set(config, '{welcomeMessage}', to_jsonb(${p!.greeting.slice(0, 500)}::text)), updated_at = now() WHERE tenant_id = ${tenantId} AND id = ${result.widgetId}`;
          await tx`UPDATE tenants SET onboarding = jsonb_set(onboarding, '{result,usedModel}', 'true'::jsonb) WHERE id = ${tenantId}`;
          await new AuditLogRepository(tx, tenantId).record({ actorUserId: userId, action: "onboarding.polished", resourceType: "agent", resourceId: result.agentId, metadata: meta });
        });
      }
    }
    return c.json(result, 201);
  });
  return r;
}

