import { z } from "zod";
import { agentConfigSchema, errorEnvelopeSchema } from "@yulona/shared";

const j = (s: z.ZodType, io: "input" | "output" = "input") => z.toJSONSchema(s, { target: "openapi-3.0", io, unrepresentable: "any" });
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", additionalProperties: false, properties: props, required });
const str = { type: "string" };
const body = (schema: unknown) => ({ required: true, content: { "application/json": { schema } } });
const ok = (description: string, schema?: unknown) => ({ description, ...(schema ? { content: { "application/json": { schema } } } : {}) });
const err = (description: string) => ({ description, content: { "application/json": { schema: j(errorEnvelopeSchema, "output") } } });
const idParam = [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }];

type Op = { summary: string; tag: string; auth?: "user" | "admin" | "apikey" | "none"; roles?: string; req?: unknown; params?: unknown[]; res?: number; extra?: number[] };
function op(o: Op) {
  const sec = o.auth === "none" ? [] : o.auth === "admin" ? [{ platformAdminAuth: [] }] : o.auth === "apikey" ? [{ apiKeyAuth: [] }] : [{ bearerAuth: [] }];
  const responses: Record<number, unknown> = { [o.res ?? 200]: ok("Success") };
  if (o.req) responses[400] = err("Validation error");
  if (o.auth !== "none") responses[401] = err("Unauthorized");
  if (o.roles) responses[403] = err("Insufficient role");
  for (const s of o.extra ?? []) responses[s] = err(String(s));
  return {
    summary: o.summary + (o.roles ? ` (min role: ${o.roles})` : ""), tags: [o.tag], security: sec,
    ...(o.params ? { parameters: o.params } : {}), ...(o.req ? { requestBody: body(o.req) } : {}), responses,
  };
}

/** OpenAPI paths for the platform wave (see docs/api/platform.md for full semantics). */
export function platformPaths() {
  const A = "Agents", U = "Users", K = "API keys";
  const roleEnum = { type: "string", enum: ["owner", "admin", "agent", "viewer"] };
  return {
    "/api/v1/tenant": { get: op({ summary: "Current tenant, plan and limit usage", tag: "Tenant" }), patch: op({ summary: "Rename workspace", tag: "Tenant", roles: "admin", req: obj({ name: str }, ["name"]) }) },
    "/api/v1/users": { get: op({ summary: "List members", tag: U }) },
    "/api/v1/users/{id}": { patch: op({ summary: "Update member name/role/status", tag: U, roles: "admin", params: idParam, req: obj({ name: str, role: roleEnum, status: { type: "string", enum: ["active", "disabled"] } }), extra: [404, 409] }) },
    "/api/v1/invitations": {
      get: op({ summary: "List invitations", tag: U, roles: "admin" }),
      post: op({ summary: "Invite a member (emails a link; token never stored in plaintext)", tag: U, roles: "admin", res: 201, req: obj({ email: str, role: roleEnum }, ["email", "role"]), extra: [402, 409] }),
    },
    "/api/v1/invitations/{id}": { delete: op({ summary: "Revoke a pending invitation", tag: U, roles: "admin", params: idParam, extra: [404] }) },
    "/api/v1/invitations/accept": { post: op({ summary: "Accept an invitation (public; token is the credential)", tag: U, auth: "none", res: 201, req: obj({ token: str, name: str, password: str }, ["token", "name", "password"]), extra: [409, 429] }) },
    "/api/v1/agents": {
      get: op({ summary: "List agents", tag: A }),
      post: op({ summary: "Create agent (draft)", tag: A, roles: "admin", res: 201, req: obj({ name: str, description: str, config: j(agentConfigSchema) }, ["name"]), extra: [402] }),
    },
    "/api/v1/agents/{id}": {
      get: op({ summary: "Get agent", tag: A, params: idParam, extra: [404] }),
      patch: op({ summary: "Update draft name/description/config", tag: A, roles: "admin", params: idParam, req: obj({ name: str, description: str, config: j(agentConfigSchema) }), extra: [404, 409] }),
      delete: op({ summary: "Archive agent", tag: A, roles: "admin", params: idParam, extra: [404] }),
    },
    "/api/v1/agents/{id}/publish": { post: op({ summary: "Snapshot draft as the next version and publish it", tag: A, roles: "admin", params: idParam, req: obj({ note: str }), extra: [404, 409] }) },
    "/api/v1/agents/{id}/rollback": { post: op({ summary: "Publish an old version's config as a new version", tag: A, roles: "admin", params: idParam, req: obj({ version: { type: "integer", minimum: 1 }, note: str }, ["version"]), extra: [404, 409] }) },
    "/api/v1/agents/{id}/versions": { get: op({ summary: "Version history", tag: A, params: idParam, extra: [404] }) },
    "/api/v1/agents/{id}/unarchive": { post: op({ summary: "Unarchive agent", tag: A, roles: "admin", params: idParam, extra: [402, 404] }) },
    "/api/v1/api-keys": {
      get: op({ summary: "List API keys (prefix only)", tag: K, roles: "admin" }),
      post: op({ summary: "Create API key; full key returned once", tag: K, roles: "admin", res: 201, req: obj({ name: str, scopes: { type: "array", items: str }, rateLimitPerMinute: { type: "integer" }, expiresAt: str }, ["name"]), extra: [402] }),
    },
    "/api/v1/api-keys/{id}": { delete: op({ summary: "Revoke API key", tag: K, roles: "admin", params: idParam, extra: [404] }) },
    "/api/v1/key-info": { get: op({ summary: "Introspect the calling API key", tag: K, auth: "apikey", extra: [429] }) },
    "/api/v1/audit-logs": { get: op({ summary: "Audit log (filters: action, actorUserId, resourceType, resourceId, from, to; keyset cursor)", tag: "Audit", roles: "admin" }) },
    "/api/v1/feature-flags": { get: op({ summary: "Effective feature flags for the tenant", tag: "Flags" }) },
    "/api/v1/admin/auth/login": { post: op({ summary: "Platform admin login", tag: "Admin", auth: "none", req: obj({ email: str, password: str }, ["email", "password"]), extra: [429] }) },
    "/api/v1/admin/auth/me": { get: op({ summary: "Current platform admin", tag: "Admin", auth: "admin" }) },
    "/api/v1/admin/tenants": {
      get: op({ summary: "List tenants (q, limit, offset)", tag: "Admin", auth: "admin" }),
      post: op({ summary: "Create tenant + owner", tag: "Admin", auth: "admin", res: 201, req: obj({ name: str, plan: str, ownerEmail: str, ownerName: str, ownerPassword: str }, ["name", "ownerEmail", "ownerName", "ownerPassword"]), extra: [409] }),
    },
    "/api/v1/admin/tenants/{id}": {
      get: op({ summary: "Tenant detail", tag: "Admin", auth: "admin", params: idParam, extra: [404] }),
      patch: op({ summary: "Rename / change plan", tag: "Admin", auth: "admin", params: idParam, req: obj({ name: str, plan: str }), extra: [404] }),
      delete: op({ summary: "Soft-delete (hard-deleted after 30 days)", tag: "Admin", auth: "admin", params: idParam, extra: [404] }),
    },
    "/api/v1/admin/tenants/{id}/suspend": { post: op({ summary: "Suspend tenant", tag: "Admin", auth: "admin", params: idParam, extra: [404] }) },
    "/api/v1/admin/tenants/{id}/unsuspend": { post: op({ summary: "Unsuspend tenant", tag: "Admin", auth: "admin", params: idParam, extra: [404] }) },
    "/api/v1/admin/tenants/{id}/restore": { post: op({ summary: "Restore soft-deleted tenant (within 30 days)", tag: "Admin", auth: "admin", params: idParam, extra: [404, 409] }) },
    "/api/v1/admin/tenants/{id}/flags": { get: op({ summary: "Flag overrides for a tenant", tag: "Admin", auth: "admin", params: idParam }) },
    "/api/v1/admin/tenants/{id}/flags/{key}": { put: op({ summary: "Set/clear (null) a tenant flag override", tag: "Admin", auth: "admin", req: obj({ enabled: { type: "boolean", nullable: true } }, ["enabled"]), extra: [404] }) },
    "/api/v1/admin/feature-flags": { get: op({ summary: "List global flags", tag: "Admin", auth: "admin" }) },
    "/api/v1/admin/feature-flags/{key}": {
      put: op({ summary: "Create/update global flag", tag: "Admin", auth: "admin", req: obj({ description: str, defaultEnabled: { type: "boolean" } }, ["defaultEnabled"]) }),
      delete: op({ summary: "Delete global flag", tag: "Admin", auth: "admin", extra: [404] }),
    },
    "/api/v1/admin/plans": { get: op({ summary: "Plans and limits", tag: "Admin", auth: "admin" }) },
    "/api/v1/admin/plans/{key}/limits/{metric}": { put: op({ summary: "Set plan limit (null = unlimited)", tag: "Admin", auth: "admin", req: obj({ limit: { type: "integer", nullable: true } }, ["limit"]), extra: [404] }) },
    "/api/v1/admin/audit-logs": { get: op({ summary: "Platform audit log", tag: "Admin", auth: "admin" }) },
  };
}

export const platformSecuritySchemes = {
  platformAdminAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT (platform admin realm)" },
  apiKeyAuth: { type: "http", scheme: "bearer", bearerFormat: "yl_<prefix>_<secret>" },
};
