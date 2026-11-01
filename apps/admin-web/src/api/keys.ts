/**
 * Query keys. Rule: one key = one fetcher = one data shape. Two views that need the same endpoint in different shapes
 * get different keys. The first segment is the area, so `["tenants"]` invalidates every customer variant.
 */
export const keys = {
  overview: ["overview"] as const,
  health: ["health"] as const,
  attention: (limit: number, offset: number) => ["attention", limit, offset] as const,
  search: (q: string) => ["search", q] as const,
  tenants: (f: unknown) => ["tenants", "list", f] as const,
  tenant: (id: string) => ["tenants", id, "detail"] as const,
  tenantUsers: (id: string) => ["tenants", id, "users"] as const,
  timeline: (id: string, s: string, o: number) => ["tenants", id, "timeline", s, o] as const,
  issues: (id: string, kind: string, days: number) => ["tenants", id, "issues", kind, days] as const,
  assets: (id: string) => ["tenants", id, "assets"] as const,
  billing: (id: string) => ["tenants", id, "billing"] as const,
  aiUsage: (id: string, d: number) => ["tenants", id, "ai-usage", d] as const,
  credits: (id: string) => ["tenants", id, "credits"] as const,
  tenantFlags: (id: string) => ["tenants", id, "flags"] as const,
  notes: (id: string) => ["tenants", id, "notes"] as const,
  impersonations: (id: string) => ["tenants", id, "impersonations"] as const,
  allTags: ["tags"] as const,
  deadJobs: (o: number) => ["ops", "dead-jobs", o] as const,
  failedWebhooks: (o: number) => ["ops", "failed-webhooks", o] as const,
  audit: (f: unknown) => ["audit", f] as const,
  admins: ["admins"] as const,
  profiles: ["catalogue", "profiles"] as const,
  rates: ["catalogue", "rates"] as const,
  plans: ["catalogue", "plans"] as const,
  packs: ["catalogue", "packs"] as const,
  flags: ["catalogue", "flags"] as const,
};
