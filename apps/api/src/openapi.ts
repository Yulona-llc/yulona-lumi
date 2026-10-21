import { z } from "zod";
import { errorEnvelopeSchema, loginSchema, meSchema, okSchema, registerSchema, sessionSchema } from "@yulona/shared";

import { conversationPaths } from "./conversations/openapi";
import { channelPaths } from "./channels/openapi";
import { platformPaths, platformSecuritySchemes } from "./platform/openapi";
import { opsPaths } from "./ops/openapi";
import { toolsPaths } from "./tools/openapi";
import { agentBuilderPaths } from "./agent-builder/openapi";
import { integrationsPaths } from "./integrations/openapi";
import { knowledgePaths, polishOpenApi } from "./integrations/openapi-extra";
import { usagePaths } from "./usage/openapi";

const j = (s: z.ZodType, io: "input" | "output") => z.toJSONSchema(s, { target: "openapi-3.0", io, unrepresentable: "any" });
const body = (s: z.ZodType) => ({ required: true, content: { "application/json": { schema: j(s, "input") } } });
const resp = (description: string, s?: z.ZodType) => ({
  description,
  ...(s ? { content: { "application/json": { schema: j(s, "output") } } } : {}),
});
const err = (d: string) => resp(d, errorEnvelopeSchema);

/** OpenAPI 3.0 document generated from the same Zod schemas used for validation. */
export function buildOpenApi() {
  const secured = [{ bearerAuth: [] }];
  return polishOpenApi({
    openapi: "3.0.3",
    info: { title: "Yulona API", version: "0.1.0" },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" }, widgetSession: { type: "http", scheme: "bearer", bearerFormat: "JWT" }, ...platformSecuritySchemes } },
    paths: {
      "/healthz": { get: { summary: "Liveness", responses: { 200: resp("OK") } } },
      "/readyz": { get: { summary: "Readiness (DB, Redis if configured)", responses: { 200: resp("Ready"), 503: resp("Not ready") } } },
      "/api/v1/auth/register": {
        post: { summary: "Create tenant + owner (ALLOW_PUBLIC_SIGNUP=true)", requestBody: body(registerSchema),
          responses: { 201: resp("Session; sets yl_rt (httpOnly) and yl_csrf cookies", sessionSchema), 400: err("Validation error"), 403: err("Signup disabled"), 409: err("Conflict"), 429: err("Rate limited") } },
      },
      "/api/v1/auth/login": {
        post: { summary: "Login", requestBody: body(loginSchema),
          responses: { 200: resp("Session; sets yl_rt and yl_csrf cookies", sessionSchema), 400: err("Validation error"), 401: err("Invalid credentials"), 429: err("Rate limited") } },
      },
      "/api/v1/auth/refresh": {
        post: { summary: "Rotate refresh token (cookie yl_rt + X-CSRF-Token header)",
          responses: { 200: resp("Session", sessionSchema), 401: err("Invalid/reused refresh token"), 403: err("CSRF failed"), 429: err("Rate limited") } },
      },
      "/api/v1/auth/logout": {
        post: { summary: "Revoke refresh family and clear cookies (X-CSRF-Token header)", responses: { 200: resp("OK", okSchema), 403: err("CSRF failed") } },
      },
      ...conversationPaths(),
      ...channelPaths(),
      ...platformPaths(),
      ...opsPaths(),
      ...toolsPaths(),
      ...integrationsPaths(),
      ...knowledgePaths(),
      ...usagePaths(),
      ...agentBuilderPaths(),
      "/api/v1/me": { get: { summary: "Current user and tenant", security: secured, responses: { 200: resp("Me", meSchema), 401: err("Unauthorized") } } },
    },
  });
}
