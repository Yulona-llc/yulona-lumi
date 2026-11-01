import { z } from "zod";
import { sessionSchema as baseSessionSchema } from "@yulona/shared";

/** Single import point for the API contract; sourced from @yulona/shared (packages/shared/src/auth.ts). */
export {
  loginSchema as loginRequestSchema,
  registerSchema as registerRequestSchema,
  sessionSchema,
  meSchema,
  userSchema,
  tenantSchema,
  errorEnvelopeSchema,
  CSRF_COOKIE,
  CSRF_HEADER,
} from "@yulona/shared";
export type { LoginInput as LoginRequest, RegisterInput as RegisterRequest, Session, Me, User, Tenant } from "@yulona/shared";

/** POST /auth/impersonation/exchange: a normal session plus which impersonation it is and whether writes are blocked. */
export const impersonationSessionSchema = baseSessionSchema.extend({ sessionId: z.string(), readOnly: z.boolean() });
export type ImpersonationSession = z.infer<typeof impersonationSessionSchema>;
