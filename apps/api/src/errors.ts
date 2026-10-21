import type { ErrorCode } from "@yulona/shared";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const Errors = {
  unauthorized: (msg = "Authentication required") =>
    new AppError(401, "unauthorized", msg, undefined, { "WWW-Authenticate": "Bearer" }),
  invalidCredentials: () => new AppError(401, "invalid_credentials", "Invalid email or password"),
  invalidRefresh: () => new AppError(401, "invalid_refresh_token", "Session expired, please sign in again"),
  csrf: () => new AppError(403, "csrf_failed", "CSRF validation failed"),
  forbidden: (msg = "Forbidden") => new AppError(403, "forbidden", msg),
  signupDisabled: () => new AppError(403, "signup_disabled", "Public sign-up is disabled"),
  notFound: (msg = "Not found") => new AppError(404, "not_found", msg),
  conflict: (msg: string) => new AppError(409, "conflict", msg),
  rateLimited: (retryAfterSec: number) =>
    new AppError(429, "rate_limited", "Too many requests", undefined, { "Retry-After": String(Math.max(1, retryAfterSec)) }),
  validation: (details: unknown) => new AppError(400, "validation_error", "Invalid request", details),
};
