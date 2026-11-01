/** jsonb timestamps arrive as "...+00:00"; normalise every such string to ISO 8601 UTC ("...Z"). */
export function normalizeDates<T>(v: T): T {
  if (typeof v === "string") {
    return (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(\+00:00|Z)$/.test(v) ? new Date(v).toISOString() : v) as T;
  }
  if (Array.isArray(v)) return v.map(normalizeDates) as T;
  if (v && typeof v === "object" && !(v instanceof Date)) {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, normalizeDates(x)])) as T;
  }
  return v;
}
