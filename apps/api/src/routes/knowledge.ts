import { Hono } from "hono";
import { z } from "zod";
import {
  CreditsExhaustedError, DEFAULT_CRAWL_DEPTH, DEFAULT_CRAWL_PAGES, KnowledgeRepository, MAX_CRAWL_DEPTH, MAX_CRAWL_PAGES, MAX_FILE_BYTES, SsrfError, UnsupportedFileError, VirusFoundError, assertSafeUrl, createLlmResolver, detectFileKind,
  normalizeInline, portsFromResolver, resolveCrawlConfig, runSandbox, scanUpload, type AiPorts, type SourceRow,
} from "@yulona/ai-runtime";
import { AuditLogRepository, withTenant, type Db } from "@yulona/db";
import { enqueue } from "@yulona/queue";
import { CONVERSION_STAGES } from "@yulona/shared";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { AppError, Errors } from "../errors";
import { parseBody } from "../http";
import { requireAuth } from "../middleware";
import type { RateLimiter } from "../ratelimit";
import { idParam, parseQuery, requireRoles } from "../conversations/common";
import { assertWithinLimit } from "../platform/limits";

export interface KnowledgeDeps {
  cfg: Config;
  db: Db;
  limiter: RateLimiter;
  /** inject for tests; defaults to the LlmResolver (platform provider profile in SaaS, env otherwise) */
  ports?: AiPorts;
}


const uuid = z.string().uuid();
const MAX_TEXT_CHARS = 900_000;

export const createTextSourceSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).transform(normalizeInline),
  text: z.string().min(1).max(MAX_TEXT_CHARS),
  description: z.string().trim().min(1).max(500).transform(normalizeInline).optional(),
  agentId: uuid.optional(),
});
export const updateSourceSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).transform(normalizeInline).optional(),
  /** one line the agent sees in its skill index; null restores the automatic description */
  description: z.string().trim().min(1).max(500).transform(normalizeInline).nullable().optional(),
}).refine((b) => b.name !== undefined || b.description !== undefined, { message: "Nothing to update" });
export const createUrlSourceSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).transform(normalizeInline).optional(),
  url: z.string().url().max(2048),
  description: z.string().trim().min(1).max(500).transform(normalizeInline).optional(),
  agentId: uuid.optional(),
  /** pages to read in total (the first page counts); 1 reads only the page you gave */
  maxPages: z.number().int().min(1).max(MAX_CRAWL_PAGES).default(DEFAULT_CRAWL_PAGES),
  /** follow links to other pages of the same site; defaults to true when maxPages > 1 */
  followLinks: z.boolean().optional(),
  /** how many link-clicks away from the first page to go (1 to 5) */
  maxDepth: z.number().int().min(1).max(MAX_CRAWL_DEPTH).default(DEFAULT_CRAWL_DEPTH),
  /** also read pages on subdomains (blog.example.com for example.com) */
  includeSubdomains: z.boolean().default(false),
});
export const listSourcesQuery = z.strictObject({
  agentId: uuid.optional(),
  status: z.enum(["pending", "processing", "ready", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export const chunksQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export const sandboxSchema = z.strictObject({
  agentId: uuid,
  message: z.string().trim().min(1).max(2000),
  stage: z.enum(CONVERSION_STAGES).optional(),
  history: z.array(z.strictObject({ role: z.enum(["user", "assistant"]), content: z.string().max(2000) })).max(10).optional(),
  lead: z.strictObject({
    name: z.string().max(100).optional(), email: z.string().max(254).optional(), phone: z.string().max(32).optional(),
    need: z.string().max(500).optional(), budget: z.string().max(100).optional(), timeline: z.string().max(100).optional(),
  }).optional(),
});

export function toSourceDto(s: SourceRow) {
  return {
    id: s.id, agentId: s.agentId, type: s.type, name: s.name, skill: s.slug, description: s.description, status: s.status, error: s.error, sourceUrl: s.sourceUrl,
    fileName: s.fileName, sizeBytes: Number(s.sizeBytes), chunkCount: s.chunkCount, attempts: s.attempts,
    ...(s.type === "url" ? (() => {
      const c = resolveCrawlConfig(s.crawlConfig);
      return { maxPages: c.maxPages, maxDepth: c.maxDepth, followLinks: c.followLinks, includeSubdomains: c.includeSubdomains, crawlProgress: s.crawlConfig.progress ?? null };
    })() : {}),
    lastIngestedAt: s.lastIngestedAt ? new Date(s.lastIngestedAt).toISOString() : null,
    createdAt: new Date(s.createdAt).toISOString(), updatedAt: new Date(s.updatedAt).toISOString(),
  };
}

const INGEST = "knowledge.ingest";

export function knowledgeRoutes(deps: KnowledgeDeps) {
  const { cfg, db, limiter } = deps;
  let resolved: AiPorts | undefined;
  const ports = () => deps.ports ?? (resolved ??= portsFromResolver(createLlmResolver({ db, mode: cfg.deploymentMode, encryptionKey: cfg.encryptionKey })));
  const r = new Hono<AppEnv>();
  r.use("/knowledge/*", requireAuth(cfg));
  const writer = requireRoles("owner", "admin");

  const audit = (tx: Parameters<Parameters<typeof withTenant>[2]>[0], c: import("hono").Context<AppEnv>, action: string, id: string, metadata: Record<string, unknown> = {}) =>
    new AuditLogRepository(tx, c.get("auth").tenantId).record({ actorUserId: c.get("auth").userId, action, resourceType: "knowledge_source", resourceId: id, metadata, ip: c.get("ip"), requestId: c.get("requestId") });

  /** An agent can only be referenced if it belongs to the caller's tenant (RLS + explicit filter). */
  async function assertAgent(tx: Parameters<Parameters<typeof withTenant>[2]>[0], tenantId: string, agentId?: string) {
    if (!agentId) return;
    const rows = await tx`SELECT 1 FROM agents WHERE tenant_id = ${tenantId} AND id = ${agentId}`;
    if (!rows.length) throw Errors.validation([{ path: "agentId", message: "Unknown agent" }]);
  }

  async function createAndQueue(c: import("hono").Context<AppEnv>, input: Parameters<KnowledgeRepository["create"]>[0], blob?: Uint8Array) {
    const { tenantId, userId } = c.get("auth");
    const s = await withTenant(db, tenantId, async (tx) => {
      await assertAgent(tx, tenantId, input.agentId ?? undefined);
      await assertWithinLimit(tx, tenantId, "storage_mb", Math.floor((input.sizeBytes ?? 0) / 1048576)); // plan limit (402); sub-MB sources only blocked once usage is over
      const repo = new KnowledgeRepository(tx, tenantId);
      const src = await repo.create({ ...input, createdBy: userId });
      if (blob) await repo.putBlob(src.id, blob);
      await enqueue(tx, { name: INGEST, tenantId, payload: { tenantId, sourceId: src.id }, maxAttempts: 4 });
      await audit(tx, c, "knowledge.source.create", src.id, { type: src.type, name: src.name });
      return src;
    });
    return c.json(toSourceDto(s), 201);
  }

  r.get("/knowledge/sources", async (c) => {
    const q = parseQuery(c, listSourcesQuery);
    const { tenantId } = c.get("auth");
    const rows = await withTenant(db, tenantId, (tx) => new KnowledgeRepository(tx, tenantId).list(q));
    return c.json({ items: rows.map(toSourceDto), limit: q.limit, offset: q.offset });
  });

  r.get("/knowledge/sources/:id", async (c) => {
    const { tenantId } = c.get("auth");
    const id = idParam(c);
    const s = await withTenant(db, tenantId, (tx) => new KnowledgeRepository(tx, tenantId).get(id));
    if (!s) throw Errors.notFound();
    return c.json(toSourceDto(s));
  });

  r.get("/knowledge/sources/:id/chunks", async (c) => {
    const { tenantId } = c.get("auth");
    const id = idParam(c);
    const q = parseQuery(c, chunksQuery);
    const out = await withTenant(db, tenantId, async (tx) => {
      const repo = new KnowledgeRepository(tx, tenantId);
      if (!(await repo.get(id))) return null;
      return repo.listChunks(id, q.limit, q.offset);
    });
    if (!out) throw Errors.notFound();
    return c.json({ items: out, limit: q.limit, offset: q.offset });
  });

  r.patch("/knowledge/sources/:id", writer, async (c) => {
    const { tenantId } = c.get("auth");
    const id = idParam(c);
    const b = await parseBody(c, updateSourceSchema);
    const s = await withTenant(db, tenantId, async (tx) => {
      const out = await new KnowledgeRepository(tx, tenantId).update(id, b);
      if (out) await audit(tx, c, "knowledge.source.update", id, { fields: Object.keys(b) });
      return out;
    });
    if (!s) throw Errors.notFound();
    return c.json(toSourceDto(s));
  });

  r.post("/knowledge/sources/text", writer, async (c) => {
    const b = await parseBody(c, createTextSourceSchema);
    return createAndQueue(c, { type: "text", name: b.name, rawText: b.text, sizeBytes: Buffer.byteLength(b.text), agentId: b.agentId, description: b.description });
  });

  r.post("/knowledge/sources/url", writer, async (c) => {
    const b = await parseBody(c, createUrlSourceSchema);
    try {
      await assertSafeUrl(b.url); // fail fast; the worker re-validates every hop
    } catch (e) {
      if (e instanceof SsrfError) throw Errors.validation([{ path: "url", message: e.message }]);
      throw e;
    }
    return createAndQueue(c, { type: "url", name: b.name ?? new URL(b.url).hostname, sourceUrl: b.url, crawlConfig: { maxPages: b.maxPages, maxDepth: b.maxDepth, followLinks: b.followLinks ?? b.maxPages > 1, includeSubdomains: b.includeSubdomains }, agentId: b.agentId, description: b.description });
  });

  r.post("/knowledge/sources/file", writer, async (c) => {
    const ct = c.req.header("content-type") ?? "";
    if (!/^multipart\/form-data/i.test(ct)) throw new AppError(415, "unsupported_media_type", "Content-Type must be multipart/form-data");
    let form: Record<string, string | File | (string | File)[]>;
    try {
      form = await c.req.parseBody();
    } catch {
      throw new AppError(400, "validation_error", "Malformed multipart body");
    }
    const extra = Object.keys(form).filter((k) => !["file", "name", "agentId", "description"].includes(k));
    if (extra.length) throw Errors.validation(extra.map((k) => ({ path: k, message: "Unknown field" })));
    const file = form.file;
    if (!(file instanceof File)) throw Errors.validation([{ path: "file", message: "A single file is required" }]);
    if (file.size > MAX_FILE_BYTES) throw new AppError(413, "payload_too_large", `File exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    const meta = z.strictObject({ name: z.string().trim().min(1).max(200).optional(), agentId: uuid.optional(), description: z.string().trim().min(1).max(500).transform(normalizeInline).optional() })
      .safeParse({ name: typeof form.name === "string" ? form.name : undefined, agentId: typeof form.agentId === "string" ? form.agentId : undefined, description: typeof form.description === "string" && form.description ? form.description : undefined });
    if (!meta.success) throw Errors.validation(meta.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    const bytes = new Uint8Array(await file.arrayBuffer());
    const fileName = file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 200) || "upload";
    try {
      detectFileKind(fileName, bytes); // extension allowlist + magic-byte check
      await scanUpload(bytes);
    } catch (e) {
      if (e instanceof UnsupportedFileError || e instanceof VirusFoundError) throw Errors.validation([{ path: "file", message: e.message }]);
      throw new AppError(503, "service_unavailable", "Upload scanning unavailable, try again later");
    }
    return createAndQueue(c, { type: "file", name: meta.data.name ?? fileName, fileName, mimeType: file.type.slice(0, 100) || undefined, sizeBytes: bytes.length, agentId: meta.data.agentId, description: meta.data.description }, bytes);
  });

  r.post("/knowledge/sources/:id/reingest", writer, async (c) => {
    const { tenantId } = c.get("auth");
    const id = idParam(c);
    const s = await withTenant(db, tenantId, async (tx) => {
      const repo = new KnowledgeRepository(tx, tenantId);
      const cur = await repo.get(id);
      if (!cur) return null;
      if (cur.type === "file" && !(await repo.getBlob(id)) && cur.status === "failed") throw Errors.conflict("Uploaded file is no longer stored; upload it again");
      if (!(await repo.requeue(id))) throw Errors.conflict("Source is already queued or processing");
      await enqueue(tx, { name: INGEST, tenantId, payload: { tenantId, sourceId: id }, maxAttempts: 4 });
      await audit(tx, c, "knowledge.source.reingest", id);
      return repo.get(id);
    });
    if (!s) throw Errors.notFound();
    return c.json(toSourceDto(s), 202);
  });

  r.delete("/knowledge/sources/:id", writer, async (c) => {
    const { tenantId } = c.get("auth");
    const id = idParam(c);
    const ok = await withTenant(db, tenantId, async (tx) => {
      const done = await new KnowledgeRepository(tx, tenantId).delete(id);
      if (done) await audit(tx, c, "knowledge.source.delete", id);
      return done;
    });
    if (!ok) throw Errors.notFound();
    return c.json({ ok: true });
  });

  r.post("/knowledge/sandbox", async (c) => {
    const { tenantId, userId } = c.get("auth");
    const lim = await limiter.hit(`sandbox:${tenantId}:${userId}`, 20, 60_000);
    if (!lim.allowed) throw Errors.rateLimited(lim.retryAfterSec);
    const b = await parseBody(c, sandboxSchema);
    const out = await runSandbox({ db, ports: ports(), credits: { enabled: cfg.deploymentMode !== "selfhosted" } }, { tenantId, agentId: b.agentId, message: b.message, stage: b.stage, history: b.history, lead: b.lead })
      .catch((e) => { throw e instanceof CreditsExhaustedError ? new AppError(402, "credits_exhausted", "AI credits are used up. Buy more credits to keep testing.", { remainingMicro: e.remainingMicro }) : e; });
    if (!out) throw Errors.notFound("Agent not found");
    return c.json(out);
  });

  return r;
}

/** Single registration point for app.ts. */
export function registerKnowledge(app: Hono<AppEnv>, deps: KnowledgeDeps): void {
  app.route("/api/v1", knowledgeRoutes(deps));
}
