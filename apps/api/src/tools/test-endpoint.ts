import { Hono } from "hono";
import { withTenant } from "@yulona/db";
import { buildFieldTree, callConnection, createConnectionResolver, validateJsonSchema } from "@yulona/ai-runtime";
import { toolManifestSchema } from "@yulona/shared";
import { AppError, Errors } from "../errors";
import type { AppEnv } from "../context";
import { parseBody } from "../http";
import { audit } from "../platform/util";
import { guard } from "../ops/common";
import { testToolSchema } from "./schemas";
import type { ToolsDeps } from "./register";

/**
 * POST /tools/test: runs the REAL call of a manifest v2 with sample values and returns everything the builder needs:
 * status, latency, the redacted request, a response excerpt (first 4 KB) and a field tree for click-to-map.
 * Connection secrets are resolved server-side and never appear in the response.
 */
export function toolTestRoutes({ cfg, db, limiter, runtime }: ToolsDeps) {
  const r = new Hono<AppEnv>();
  r.post("/tools/test", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const lim = await limiter.hit(`tools-test:${tenantId}`, 20, 60_000);
    if (!lim.allowed) throw Errors.rateLimited(lim.retryAfterSec);
    const b = await parseBody(c, testToolSchema);
    const parsed = toolManifestSchema.safeParse(b.manifest);
    if (!parsed.success) throw Errors.validation(parsed.error.issues.map((i) => ({ path: `manifest.${i.path.join(".")}`, message: i.message })));
    const manifest = parsed.data;
    if (manifest.version !== 2) throw Errors.validation([{ path: "manifest.version", message: "Only manifest version 2 can be tested here" }]);
    if (cfg.encryptionKey === undefined) {
      const [x] = await withTenant(db, tenantId, (tx) => tx<{ s: boolean }[]>`SELECT secret_encrypted IS NOT NULL AS s FROM tool_connections WHERE tenant_id = ${tenantId} AND id = ${manifest.connectionId}`);
      if (x?.s) throw new AppError(503, "service_unavailable", "ENCRYPTION_KEY is not configured");
    }
    const conn = await createConnectionResolver({ db, encryptionKey: cfg.encryptionKey })(tenantId, manifest.connectionId);
    if (!conn) throw Errors.notFound("Connection not found");

    const invalid = validateJsonSchema(manifest.inputSchema, b.sampleValues);
    const res = invalid
      ? { ok: false as const, latencyMs: 0, attempts: 0, error: { code: "invalid_input", message: invalid } }
      : await callConnection(manifest, conn, b.sampleValues, { fetchImpl: runtime.fetchImpl, resolver: runtime.resolver });
    await withTenant(db, tenantId, (tx) => audit(tx, c, "tool.test", "tool", manifest.name, { connectionId: manifest.connectionId, ok: res.ok, status: "response" in res ? res.response?.status : undefined, code: res.error?.code }));
    const full = res as Awaited<ReturnType<typeof callConnection>>;
    return c.json({
      ok: full.ok,
      status: full.response?.status ?? null,
      latencyMs: full.latencyMs,
      attempts: full.attempts,
      request: full.request ?? null,
      response: full.response ?? null,
      /** what the model would receive (after responseMapping) */
      mapped: full.ok && manifest.responseMapping ? full.output : null,
      fieldTree: full.json !== undefined ? buildFieldTree(full.json) : null,
      error: full.error ?? null,
    });
  });
  return r;
}
