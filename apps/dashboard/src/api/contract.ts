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
