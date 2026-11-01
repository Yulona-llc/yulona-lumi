import { z } from "zod";
import { errorEnvelopeSchema } from "@yulona/shared";
import type { Config } from "./config";
import type { Deps } from "./context";
import { API_PREFIX } from "./app";
import type { Registrar, RouteMeta } from "./route";
import { registerAll } from "./routes";
import { MemoryRateLimiter } from "./ratelimit";

const j = (s: z.ZodType, io: "input" | "output" = "input") => z.toJSONSchema(s, { target: "openapi-3.0", io, unrepresentable: "any" });
const err = (d: string) => ({ description: d, content: { "application/json": { schema: j(errorEnvelopeSchema, "output") } } });

/** Collects the route table (handlers are never invoked) so the spec can be generated without a database. */
export function collectRoutes(): RouteMeta[] {
  const metas: RouteMeta[] = [];
  const reg: Registrar = { route: (m) => void metas.push(m) };
  const limiter = new MemoryRateLimiter();
  limiter.close();
  registerAll(reg, { cfg: {} as Config, db: null as never, limiter, log: null as never } as Deps);
  return metas;
}

const toOpenApiPath = (p: string) => p.replace(/:([A-Za-z]+)/g, "{$1}");

/** OpenAPI 3.0 document of the platform-admin API (docs/admin-openapi.json). */
export function buildAdminOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {
    "/healthz": { get: { summary: "Liveness", responses: { 200: { description: "OK" } } } },
    "/readyz": { get: { summary: "Readiness (database)", responses: { 200: { description: "Ready" }, 503: { description: "Not ready" } } } },
  };
  for (const m of collectRoutes()) {
    const path = `${API_PREFIX}${toOpenApiPath(m.path)}`;
    const params = [...m.path.matchAll(/:([A-Za-z]+)/g)].map((x) => ({ name: x[1]!, in: "path", required: true, schema: x[1]!.toLowerCase().endsWith("id") ? { type: "string", format: "uuid" } : { type: "string" } }));
    const query = m.query ? Object.entries((j(m.query) as { properties?: Record<string, object> }).properties ?? {}).map(([name, schema]) => ({ name, in: "query", required: false, schema })) : [];
    const roles = m.roles === "public" ? "public" : m.roles.join(", ");
    const ok = m.status ?? 200;
    (paths[path] ??= {})[m.method.toLowerCase()] = {
      summary: m.summary, description: `Roles: ${roles}.${m.write ? " Counts against the write rate limit." : ""}`, tags: [m.tag],
      security: m.roles === "public" ? [] : [{ adminBearer: [] }],
      parameters: [...params, ...query],
      ...(m.body ? { requestBody: { required: true, content: { "application/json": { schema: j(m.body) } } } } : {}),
      responses: {
        [ok]: m.contentType ? { description: m.contentType, content: { [m.contentType]: { schema: { type: "string" } } } } : { description: "OK" },
        400: err("Validation error"), 401: err("Unauthorized"), 403: err("Forbidden (role, IP or restricted session)"), 429: err("Rate limited"),
      },
    };
  }
  return {
    openapi: "3.0.3",
    info: { title: "Lumi platform admin API", version: "0.1.0", description: "Separate service for platform operators. Not part of the customer API." },
    servers: [{ url: "http://localhost:4100" }],
    components: { securitySchemes: { adminBearer: { type: "http", scheme: "bearer", bearerFormat: "JWT (admin realm, ADMIN_JWT_SECRET)" } } },
    paths,
  };
}
