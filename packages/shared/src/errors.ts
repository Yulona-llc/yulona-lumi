import { z } from "zod";

export const ERROR_CODES = [
  "validation_error",
  "invalid_json",
  "unsupported_media_type",
  "payload_too_large",
  "unauthorized",
  "invalid_credentials",
  "invalid_refresh_token",
  "csrf_failed",
  "forbidden",
  "signup_disabled",
  "not_found",
  "conflict",
  "rate_limited",
  "service_unavailable",
  "plan_limit_exceeded",
  "credits_exhausted",
  "copilot_requires_plan",
  "copilot_limit_reached",
  "tenant_suspended",
  "contact_blocked",
  "turnstile_failed",
  "internal_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** `{ error: { code, message, requestId, details? } }` */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
