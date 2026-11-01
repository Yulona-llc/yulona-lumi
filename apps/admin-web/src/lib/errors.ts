import { ApiError } from "@/api/client";

export function errMsg(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "rate_limited") return `Too many attempts. Try again${e.retryAfter ? ` in ${e.retryAfter} seconds` : " in a moment"}.`;
    if (e.code === "validation_error" && Array.isArray(e.details) && e.details.length) {
      return (e.details as Array<{ path?: string; message?: string }>).map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join("; ");
    }
    if (e.code === "forbidden") return e.message || "Your role does not allow this action.";
    return e.message;
  }
  return e instanceof Error ? e.message : "Something went wrong";
}
