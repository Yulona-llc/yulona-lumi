import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { createPreauth, type Db } from "@yulona/db";
import { CSRF_HEADER, type Logger } from "@yulona/shared";
import type { Config } from "./config";
import type { AppEnv } from "./context";
import { AppError } from "./errors";
import { errorResponse, globalRateLimit, requestId, requestLogger, requireDocsAuth, resolveIp } from "./middleware";
import { Scalar } from "@scalar/hono-api-reference";
import { buildOpenApi } from "./openapi";
import type { RateLimiter } from "./ratelimit";
import { authRoutes } from "./routes/auth";
import { healthRoutes } from "./routes/health";
import { meRoutes } from "./routes/me";
import { registerConversations } from "./conversations/register";
import { registerChannels } from "./channels/register";
import { registerKnowledge } from "./routes/knowledge";
import { registerPlatform } from "./platform/register";
import { registerOps, type OpsRuntime } from "./ops/register";
import { registerTools, type ToolsRuntime } from "./tools/register";
import { registerIntegrations } from "./integrations/register";
import { impersonationAudit, registerBillingAdmin } from "./billing/register";
import { registerUsage } from "./usage/register";
import { registerAgentBuilder } from "./agent-builder/register";
import { registerCopilot } from "./copilot/register";
import { impersonationGuard } from "./impersonation-guard";
import type { Providers } from "@yulona/providers";
import { createRealtime, type Realtime } from "./realtime/service";

export interface AppDeps {
  cfg: Config;
  db: Db;
  limiter: RateLimiter;
  log: Logger;
  /** Optional shared realtime service (the server passes its own so it can start/stop it). */
  realtime?: Realtime;
  /** Optional provider set (tests inject mocks); defaults to createProvidersFromEnv(). */
  providers?: Providers;
  /** Optional channel adapter registry (tests point adapters at mock servers). */
  channelRegistry?: import("@yulona/channels").ChannelRegistry;
  /** Optional ops runtime overrides (tests point Google Calendar at a mock server). */
  ops?: OpsRuntime;
  /** Optional tool-engine overrides (tests point outbound tool calls at a local server). */
  tools?: ToolsRuntime;
  /** Optional LLM ports for the agent builder chat (tests inject a scripted LLM). */
  builderPorts?: import("@yulona/ai-runtime").AiPorts;
}

export function createApp({ cfg, db, limiter, log, realtime, providers, channelRegistry, ops, tools, builderPorts }: AppDeps) {
  const app = new Hono<AppEnv>();
  const preauth = createPreauth(db);
  const allowed = new Set(cfg.corsOrigins);

  app.use("*", requestId());
  app.use("*", resolveIp(cfg.trustProxy));
  app.use("*", requestLogger(log)); // outermost after request-id so 4xx from later middleware are logged
  const secure = secureHeaders({ crossOriginResourcePolicy: "same-site" });
  // The public widget avatar is an image customer sites embed cross-origin.
  const secureEmbeddable = secureHeaders({ crossOriginResourcePolicy: "cross-origin" });
  app.use("*", (c, next) => (/^(\/api\/v1)?\/public\/widgets\/[^/]+\/avatar$/.test(c.req.path) ? secureEmbeddable(c, next) : secure(c, next)));
  const corsMw = cors({
    origin: (origin) => (allowed.has(origin) ? origin : null),
    credentials: true,
    allowHeaders: ["Authorization", "Content-Type", CSRF_HEADER, "X-Request-Id"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: [CSRF_HEADER, "X-Request-Id", "Retry-After"],
    maxAge: 600,
  });
  // The public widget API has its own per-widget Origin allowlist + CORS (routes/public-widget.ts).
  app.use("*", (c, next) =>
    c.req.path.startsWith("/public/") || c.req.path.startsWith("/api/v1/public/") ? next() : corsMw(c, next));
  const onTooLarge = (c: Parameters<typeof errorResponse>[0]) => errorResponse(c, 413, "payload_too_large", "Request body too large");
  const defaultLimit = bodyLimit({ maxSize: cfg.bodyLimitBytes, onError: onTooLarge });
  const uploadLimit = bodyLimit({ maxSize: 11 * 1024 * 1024, onError: onTooLarge }); // route enforces 10 MB on the file itself
  // Only the authenticated knowledge file upload may exceed the global cap.
  app.use("*", (c, next) =>
    c.req.method === "POST" && c.req.path === "/api/v1/knowledge/sources/file" ? uploadLimit(c, next) : defaultLimit(c, next));
  app.use("*", globalRateLimit(limiter, cfg));
  app.use("*", impersonationGuard(db, cfg.jwtSecret)); // suspended tenants and ended impersonation sessions are rejected before any route
  app.use("*", impersonationAudit(db)); // tenant-side audit of impersonated writes

  app.route("/", healthRoutes(db, limiter as RateLimiter & { ping?: () => Promise<boolean> }, !!cfg.redisUrl));
  if (cfg.openapiEnabled && cfg.docsPassword) {
    const doc = buildOpenApi();
    const guard = requireDocsAuth(cfg.docsUsername, cfg.docsPassword, limiter, cfg.rateLimits.docs);
    app.get("/api/v1/openapi.json", guard, (c) => c.json(doc));
    app.get("/docs/", guard, (c) => c.redirect("/docs", 301));
    app.get("/docs", guard, Scalar({ url: "/api/v1/openapi.json", pageTitle: "Lumi API" }));
  } else if (cfg.openapiEnabled) {
    log.warn("openapi docs not mounted; set DOCS_PASSWORD to enable /docs");
  }
  app.route("/api/v1/auth", authRoutes({ cfg, db, preauth, limiter }));
  // NOTE: registered before meRoutes on purpose: meRoutes does `use("*", requireAuth)` under /api/v1, which would
  // otherwise wrap every later route, including the unauthenticated public widget API.
  registerConversations(app, { cfg, db, limiter, realtime: realtime ?? createRealtime({ db, log, redisUrl: cfg.redisUrl }) });
  registerChannels(app, { cfg, db, limiter, log, registry: channelRegistry });
  registerPlatform(app, { cfg, db, limiter, log, providers });
  registerOps(app, { cfg, db, limiter, log, runtime: ops });
  registerTools(app, { cfg, db, limiter, log, runtime: tools });
  registerIntegrations(app, { cfg, db, limiter, providers });
  registerBillingAdmin(app, { cfg, db, log, providers });
  registerUsage(app, { cfg, db });
  registerAgentBuilder(app, { cfg, db, limiter, ports: builderPorts });
  registerCopilot(app, { cfg, db, limiter, ports: builderPorts }); // onboarding, Ask Lumi, /overview, /workspace/profile
  app.route("/api/v1", meRoutes(cfg, db));
  registerKnowledge(app, { cfg, db, limiter });

  app.notFound((c) => errorResponse(c, 404, "not_found", "Not found"));
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return errorResponse(c, err.status, err.code, err.message, err.details, err.headers);
    }
    log.error("unhandled error", { requestId: c.get("requestId"), path: c.req.path, err: err.message, stack: err.stack });
    return errorResponse(c, 500, "internal_error", "Internal server error");
  });
  return app;
}
