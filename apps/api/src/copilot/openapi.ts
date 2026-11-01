import { z } from "zod";
import { answerBodySchema, copilotMessageSchema, copilotTokenSchema, errorEnvelopeSchema, updateProfileSchema } from "@yulona/shared";

const j = (s: z.ZodType, io: "input" | "output") => z.toJSONSchema(s, { target: "openapi-3.0", io, unrepresentable: "any" });
const body = (s: z.ZodType) => ({ required: true, content: { "application/json": { schema: j(s, "input") } } });
const err = (d: string) => ({ description: d, content: { "application/json": { schema: j(errorEnvelopeSchema, "output") } } });
const id = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const E = { 400: err("Validation error"), 401: err("Unauthorized"), 403: err("Requires owner/admin"), 404: err("Not found") };
const op = (tag: string, summary: string, extra: Record<string, unknown> = {}) => ({ summary, tags: [tag], security: [{ bearerAuth: [] }], responses: { 200: { description: "OK" }, ...E }, ...extra });

/** Workspace profile, onboarding wizard, Ask Lumi copilot and overview (see docs/api/copilot.md). */
export function copilotPaths(): Record<string, unknown> {
  const P = "Workspace profile", O = "Onboarding", C = "Copilot", V = "Overview";
  return {
    "/api/v1/workspace/profile": {
      get: op(P, "Workspace name, goals (support, leads, bookings, other) and onboarding status (any role)"),
      put: op(P, "Set the workspace goals (owner/admin)", { requestBody: body(updateProfileSchema) }),
    },
    "/api/v1/onboarding": { get: op(O, "Wizard state: typed step schema with suggested options, saved answers, current step and result (owner/admin)") },
    "/api/v1/onboarding/answers": { put: op(O, "Save one step's answer (validated per step; null skips an optional step). Resumable from any device", { requestBody: body(answerBodySchema), responses: { 200: { description: "New wizard state" }, 409: err("Already completed"), ...E } }) },
    "/api/v1/onboarding/skip": { post: op(O, "Skip the wizard for now (answers are kept)") },
    "/api/v1/onboarding/finish": { post: op(O, "Build the starter bundle (draft agent, widget, website knowledge source depth 3, business hours, goals) plus one capped, uncharged model call to polish the wording. Never publishes. Idempotent", { responses: { 201: { description: "Created: agentId, widgetId, knowledgeSourceId, usedModel, nextStep" }, 200: { description: "Already finished: the stored result" }, 402: err("Plan limit reached"), ...E } }) },
    "/api/v1/copilot/status": { get: op(C, "Access (allowed or locked by plan), the separate monthly Ask Lumi allowance and the open session (owner/admin)") },
    "/api/v1/copilot/sessions": { post: op(C, "Start an Ask Lumi session (10/min)", { responses: { 201: { description: "Created" }, 402: err("copilot_requires_plan or copilot_limit_reached"), 429: err("Rate limited"), ...E } }) },
    "/api/v1/copilot/sessions/{id}": { get: op(C, "Your own session and its messages (tool messages are hidden)", { parameters: [id] }) },
    "/api/v1/copilot/sessions/{id}/messages": { post: op(C, "Send a message; Lumi answers using at most 3 tool rounds (20/min). Assistant payload.blocks come from a whitelist (chips, checklist, diff, preview, confirm, link)", { parameters: [id], requestBody: body(copilotMessageSchema), responses: { 200: { description: "New messages, assistant reply and remaining allowance" }, 402: err("copilot_requires_plan or copilot_limit_reached"), 409: err("Session closed or busy"), 429: err("Rate limited or caps reached"), 503: err("AI provider unavailable"), ...E } }) },
    "/api/v1/copilot/sessions/{id}/confirm": { post: op(C, "Confirm a pending high-impact action (publish) with the token shown in the confirm card. Single use, expires after 15 minutes", { parameters: [id], requestBody: body(copilotTokenSchema), responses: { 200: { description: "Executed" }, 409: err("Expired or already used"), ...E } }) },
    "/api/v1/copilot/sessions/{id}/cancel": { post: op(C, "Cancel a pending action", { parameters: [id], requestBody: body(copilotTokenSchema), responses: { 200: { description: "Cancelled" }, 409: err("Expired or already used"), ...E } }) },
    "/api/v1/overview": { get: op(V, "One call for the dashboard Overview: common block plus support, leads and bookings blocks for the workspace goals (last 30 days, any role)") },
  };
}
