export type AdminErrorCode =
  | "validation_error" | "invalid_json" | "unsupported_media_type" | "payload_too_large" | "unauthorized" | "invalid_credentials"
  | "invalid_refresh_token" | "csrf_failed" | "forbidden" | "session_restricted" | "not_found" | "conflict" | "rate_limited"
  | "service_unavailable" | "internal_error";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: AdminErrorCode,
    message: string,
    public readonly details?: unknown,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const Errors = {
  unauthorized: (msg = "Authentication required") => new AppError(401, "unauthorized", msg, undefined, { "WWW-Authenticate": "Bearer" }),
  invalidCredentials: () => new AppError(401, "invalid_credentials", "Invalid email or password"),
  invalidRefresh: () => new AppError(401, "invalid_refresh_token", "Session expired, please sign in again"),
  csrf: () => new AppError(403, "csrf_failed", "Missing X-Admin-Request header"),
  forbidden: (msg = "Forbidden") => new AppError(403, "forbidden", msg),
  restricted: (reason: string) => new AppError(403, "session_restricted", "Finish the required account step first", { reason }),
  notFound: (msg = "Not found") => new AppError(404, "not_found", msg),
  conflict: (msg: string) => new AppError(409, "conflict", msg),
  rateLimited: (retryAfterSec: number) =>
    new AppError(429, "rate_limited", "Too many requests", undefined, { "Retry-After": String(Math.max(1, retryAfterSec)) }),
  validation: (details: unknown) => new AppError(400, "validation_error", "Invalid request", details),
  unavailable: (msg: string) => new AppError(503, "service_unavailable", msg),
};
