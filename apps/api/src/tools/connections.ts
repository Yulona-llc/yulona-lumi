import { Hono } from "hono";
import { withTenant } from "@yulona/db";
import { assertSafeUrl, callConnection, connectionAad, createConnectionResolver, SsrfError } from "@yulona/ai-runtime";
import { encryptJson } from "@yulona/crypto";
import { toolManifestV2Schema } from "@yulona/shared";
import type { AppEnv } from "../context";
import { AppError, Errors } from "../errors";
import { parseBody } from "../http";
import { audit, isUniqueViolation, parseId } from "../platform/util";
import { guard, iso } from "../ops/common";
import { createConnectionSchema, testConnectionSchema, updateConnectionSchema } from "./schemas";
import type { ToolsDeps } from "./register";

interface Row {
  id: string; name: string; kind: string; baseUrl: string; authType: string; authHeaderName: string | null; testPath: string | null;
  secretEncrypted: string | null; createdBy: string | null; createdAt: Date; updatedAt: Date;
}
/** Secrets are write-only: only `hasSecret` is ever exposed. */
export const connectionDto = (r: Row) => ({
  id: r.id, name: r.name, kind: r.kind, baseUrl: r.baseUrl, authType: r.authType, authHeaderName: r.authHeaderName, testPath: r.testPath,
  hasSecret: r.secretEncrypted !== null, createdBy: r.createdBy, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
});
const COLS = ["id", "name", "kind", "base_url", "auth_type", "auth_header_name", "test_path", "secret_encrypted", "created_by", "created_at", "updated_at"];
const PUBLIC_IP = async () => ["93.184.216.34"]; // hostname resolution happens at call time; here only the static rules matter

/** https required in SaaS (http allowed self-hosted); no credentials/query/fragment; no localhost or private literal hosts. */
export async function validateBaseUrl(raw: string, mode: "saas" | "selfhosted"): Promise<string> {
  const bad = (m: string) => Errors.validation([{ path: "baseUrl", message: m }]);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw bad("Invalid URL");
  }
  if (u.protocol === "http:" && mode === "saas") throw bad("https is required");
  if (u.search || u.hash) throw bad("The base URL must not contain a query string or fragment");
  try {
    await assertSafeUrl(raw, PUBLIC_IP);
  } catch (e) {
    throw bad(e instanceof SsrfError ? e.message : "URL not allowed");
  }
  return u.toString().replace(/\/+$/, "");
}

function checkAuth(authType: string, secret: string | null | undefined, hasStored: boolean, headerName: string | null | undefined): string | null {
  if (authType === "none") return secret ? "secret is not allowed with authType none" : null;
  if (!secret && !hasStored) return `secret is required for authType ${authType}`;
  if (authType === "basic" && secret && !secret.includes(":")) return "for basic auth the secret must be \"username:password\"";
  if (headerName && authType !== "api_key") return "authHeaderName only applies to api_key";
  return null;
}

export function connectionRoutes({ cfg, db, limiter, runtime }: ToolsDeps) {
  const r = new Hono<AppEnv>();
  const needKey = () => {
    if (!cfg.encryptionKey) throw new AppError(503, "service_unavailable", "ENCRYPTION_KEY is not configured");
    return cfg.encryptionKey;
  };
  const admin = guard(cfg, "admin");

  r.get("/tool-connections", admin, async (c) => {
    const { tenantId } = c.get("auth");
    const rows = await withTenant(db, tenantId, (tx) => tx<Row[]>`SELECT ${tx(COLS)} FROM tool_connections WHERE tenant_id = ${tenantId} ORDER BY created_at, id`);
    return c.json({ items: rows.map(connectionDto) });
  });

  r.post("/tool-connections", admin, async (c) => {
    const { tenantId, userId } = c.get("auth");
    const b = await parseBody(c, createConnectionSchema);
    const err = checkAuth(b.authType, b.secret, false, b.authHeaderName);
    if (err) throw Errors.validation([{ path: "secret", message: err }]);
    const url = await validateBaseUrl(b.baseUrl, cfg.deploymentMode);
    const id = crypto.randomUUID();
    const sealed = b.secret ? encryptJson(needKey(), { secret: b.secret }, connectionAad(tenantId, id)) : null;
    const header = b.authType === "api_key" ? (b.authHeaderName ?? "X-API-Key") : null;
    try {
      const row = await withTenant(db, tenantId, async (tx) => {
        const [x] = await tx<Row[]>`
          INSERT INTO tool_connections (id, tenant_id, name, kind, base_url, auth_type, auth_header_name, test_path, secret_encrypted, created_by)
          VALUES (${id}, ${tenantId}, ${b.name}, ${b.kind}, ${url}, ${b.authType}, ${header}, ${b.testPath ?? null}, ${sealed}, ${userId})
          RETURNING ${tx(COLS)}`;
        await audit(tx, c, "tool_connection.create", "tool_connection", id, { name: b.name, authType: b.authType, baseUrl: url });
        return x!;
      });
      return c.json(connectionDto(row), 201);
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict("A connection with this name already exists");
      throw e;
    }
  });

  r.get("/tool-connections/:id", admin, async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const [row] = await withTenant(db, tenantId, (tx) => tx<Row[]>`SELECT ${tx(COLS)} FROM tool_connections WHERE tenant_id = ${tenantId} AND id = ${id}`);
    if (!row) throw Errors.notFound();
    return c.json(connectionDto(row));
  });

  r.patch("/tool-connections/:id", admin, async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const b = await parseBody(c, updateConnectionSchema);
    const out = await withTenant(db, tenantId, async (tx) => {
      const [cur] = await tx<Row[]>`SELECT ${tx(COLS)} FROM tool_connections WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
      if (!cur) throw Errors.notFound();
      const authType = b.authType ?? cur.authType;
      const header = authType === "api_key" ? (b.authHeaderName === undefined ? cur.authHeaderName ?? "X-API-Key" : b.authHeaderName ?? "X-API-Key") : null;
      const keepStored = cur.secretEncrypted !== null && b.secret === undefined && authType !== "none";
      if (b.secret === null && authType !== "none") throw Errors.validation([{ path: "secret", message: "cannot remove the secret while authType needs one" }]);
      const err = checkAuth(authType, b.secret ?? undefined, keepStored, authType === "api_key" ? undefined : b.authHeaderName);
      if (err) throw Errors.validation([{ path: "secret", message: err }]);
      const url = b.baseUrl ? await validateBaseUrl(b.baseUrl, cfg.deploymentMode) : cur.baseUrl;
      let sealed: string | null = keepStored ? cur.secretEncrypted : null;
      if (typeof b.secret === "string") sealed = encryptJson(needKey(), { secret: b.secret }, connectionAad(tenantId, id));
      const [x] = await tx<Row[]>`
        UPDATE tool_connections SET name = ${b.name ?? cur.name}, base_url = ${url}, auth_type = ${authType}, auth_header_name = ${header},
          test_path = ${b.testPath === undefined ? cur.testPath : b.testPath}, secret_encrypted = ${sealed}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING ${tx(COLS)}`;
      await audit(tx, c, "tool_connection.update", "tool_connection", id, { fields: Object.keys(b).filter((k) => k !== "secret"), secretRotated: typeof b.secret === "string" });
      return x!;
    }).catch((e) => {
      if (isUniqueViolation(e)) throw Errors.conflict("A connection with this name already exists");
      throw e;
    });
    return c.json(connectionDto(out));
  });

  r.delete("/tool-connections/:id", admin, async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    await withTenant(db, tenantId, async (tx) => {
      const [cur] = await tx<{ name: string }[]>`SELECT name FROM tool_connections WHERE tenant_id = ${tenantId} AND id = ${id}`;
      if (!cur) throw Errors.notFound();
      const users = await tx<{ name: string }[]>`SELECT name FROM agents WHERE tenant_id = ${tenantId} AND (config::text LIKE ${`%${id}%`} OR EXISTS (SELECT 1 FROM agent_versions v WHERE v.tenant_id = agents.tenant_id AND v.agent_id = agents.id AND v.version = agents.published_version AND v.config::text LIKE ${`%${id}%`}))`;
      if (users.length) throw new AppError(409, "conflict", `Connection is used by tools of: ${users.map((u) => u.name).slice(0, 5).join(", ")}`, { agents: users.map((u) => u.name).slice(0, 20) });
      await tx`DELETE FROM tool_connections WHERE tenant_id = ${tenantId} AND id = ${id}`;
      await audit(tx, c, "tool_connection.delete", "tool_connection", id, { name: cur.name });
    });
    return c.json({ ok: true });
  });

  r.post("/tool-connections/:id/test", admin, async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = parseId(c);
    const lim = await limiter.hit(`tools-test:${tenantId}`, 20, 60_000);
    if (!lim.allowed) throw Errors.rateLimited(lim.retryAfterSec);
    const b = await parseBody(c, testConnectionSchema);
    const [meta] = await withTenant(db, tenantId, (tx) => tx<{ testPath: string | null; hasSecret: boolean }[]>`SELECT test_path, secret_encrypted IS NOT NULL AS has_secret FROM tool_connections WHERE tenant_id = ${tenantId} AND id = ${id}`);
    if (!meta) throw Errors.notFound();
    if (meta.hasSecret) needKey();
    const conn = await createConnectionResolver({ db, encryptionKey: cfg.encryptionKey })(tenantId, id);
    if (!conn) throw Errors.notFound();
    const manifest = toolManifestV2Schema.parse({
      version: 2, name: "connection_test", description: "connection test", inputSchema: { type: "object" }, outputSchema: { type: "object" },
      connectionId: id, request: { method: "GET", path: b.path ?? meta.testPath ?? "/", fields: [] }, timeoutMs: 8000,
    });
    const res = await callConnection(manifest, conn, {}, { fetchImpl: runtime.fetchImpl, resolver: runtime.resolver });
    await withTenant(db, tenantId, (tx) => audit(tx, c, "tool_connection.test", "tool_connection", id, { ok: res.ok, status: res.response?.status, by: userId }));
    return c.json({
      ok: res.ok, status: res.response?.status ?? null, latencyMs: res.latencyMs, contentType: res.response?.contentType ?? null,
      request: res.request, excerpt: res.response?.excerpt.slice(0, 512) ?? null, error: res.error ?? null,
    });
  });

  return r;
}
