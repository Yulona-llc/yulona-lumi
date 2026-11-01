// Support tooling: notes, tags, invitation resend, impersonation with one-time exchange codes.
import { z } from "zod";
import { createProvidersFromEnv, type Providers } from "@yulona/providers";
import type { Deps } from "../context";
import { Errors } from "../errors";
import { iso, pageTotal, parseBody, parseId, parseQuery } from "../http";
import { ALL, OWNER_SUPPORT, type Registrar } from "../route";
import { newOpaqueToken, sha256 } from "../security";
import { tagSchema } from "./tenants";

const INVITE_TTL_MS = 7 * 86_400_000;
export const CODE_TTL_S = 60;

interface ImpRow {
  id: string; adminId: string | null; adminEmail: string | null; tenantId: string; tenantName: string | null; userId: string; reason: string; readOnly: boolean;
  startedAt: Date; expiresAt: Date; endedAt: Date | null; exchangedAt: Date | null; total: string;
}
const impDto = (r: ImpRow) => ({
  id: r.id, adminId: r.adminId, adminEmail: r.adminEmail, tenantId: r.tenantId, tenantName: r.tenantName, userId: r.userId, reason: r.reason, readOnly: r.readOnly,
  startedAt: iso(r.startedAt), expiresAt: iso(r.expiresAt), endedAt: iso(r.endedAt), exchangedAt: iso(r.exchangedAt),
});

export function registerSupportRoutes(reg: Registrar, d: Deps) {
  const { cfg, db, log } = d;
  let providers: Providers | undefined = d.providers;
  const email = () => (providers ??= createProvidersFromEnv()).email;
  const exists = async (id: string) => { const [t] = await db`SELECT id FROM sa_get_tenant(${id})`; if (!t) throw Errors.notFound("Tenant not found"); };
  const adminId = (c: { get(k: "admin"): { id: string } }) => c.get("admin").id;

  // ---------------------------------------------------------------- notes
  const noteDto = (n: { id: string; body: string; adminId: string | null; adminEmail: string; createdAt: Date }) => ({ id: n.id, body: n.body, adminId: n.adminId, adminEmail: n.adminEmail, createdAt: iso(n.createdAt) });
  reg.route({ method: "GET", path: "/tenants/:id/notes", roles: ALL, tag: "Support", summary: "Internal notes about a customer" }, async (c) => {
    const id = parseId(c);
    await exists(id);
    const rows = await db<{ id: string; body: string; adminId: string | null; adminEmail: string; createdAt: Date }[]>`SELECT * FROM sa_tenant_notes(${id})`;
    return c.json({ items: rows.map(noteDto) });
  });
  const noteBody = z.strictObject({ body: z.string().trim().min(1).max(2000) });
  reg.route({ method: "POST", path: "/tenants/:id/notes", roles: OWNER_SUPPORT, tag: "Support", summary: "Add an internal note", body: noteBody, status: 201 }, async (c) => {
    const id = parseId(c);
    const b = await parseBody(c, noteBody);
    const [r] = await db<{ saAddNote: string | null }[]>`SELECT sa_add_note(${adminId(c)}, ${id}, ${b.body})`;
    if (!r?.saAddNote) throw Errors.notFound("Tenant not found");
    const [n] = await db<{ id: string; body: string; adminId: string | null; adminEmail: string; createdAt: Date }[]>`SELECT * FROM sa_get_note(${id}, ${r.saAddNote})`;
    return c.json(noteDto(n!), 201);
  });
  reg.route({ method: "DELETE", path: "/tenants/:id/notes/:noteId", roles: OWNER_SUPPORT, tag: "Support", summary: "Delete a note (support: own notes only; owner: any)" }, async (c) => {
    const [r] = await db<{ saDeleteNote: boolean }[]>`
      SELECT sa_delete_note(${adminId(c)}, ${parseId(c)}, ${parseId(c, "noteId")}, ${c.get("admin").role === "owner"})`;
    if (!r?.saDeleteNote) throw Errors.notFound("Note not found");
    return c.json({ ok: true as const });
  });

  // ---------------------------------------------------------------- tags
  const tags = z.array(tagSchema).max(20).transform((a) => [...new Set(a)]);
  const tagsBody = z.strictObject({ tags });
  reg.route({ method: "GET", path: "/tenants/:id/tags", roles: ALL, tag: "Support", summary: "Tags of a customer" }, async (c) => {
    const id = parseId(c);
    await exists(id);
    const [r] = await db<{ saTenantTags: string[] }[]>`SELECT sa_tenant_tags(${id})`;
    return c.json({ tags: r!.saTenantTags });
  });
  reg.route({ method: "PUT", path: "/tenants/:id/tags", roles: OWNER_SUPPORT, tag: "Support", summary: "Replace the tags of a customer", body: tagsBody }, async (c) => {
    const id = parseId(c);
    const b = await parseBody(c, tagsBody);
    const [r] = await db<{ saSetTenantTags: boolean }[]>`SELECT sa_set_tenant_tags(${adminId(c)}, ${id}, ${db.array(b.tags)}::text[])`;
    if (!r?.saSetTenantTags) throw Errors.notFound("Tenant not found");
    return c.json({ tags: b.tags });
  });
  reg.route({ method: "GET", path: "/tags", roles: ALL, tag: "Support", summary: "All tags with customer counts" }, async (c) => {
    const rows = await db<{ tag: string; n: string }[]>`SELECT * FROM sa_list_tags()`;
    return c.json({ items: rows.map((r) => ({ tag: r.tag, count: Number(r.n) })) });
  });
  const bulkBody = z.strictObject({ tenantIds: z.array(z.uuid()).min(1).max(200), add: z.array(tagSchema).max(20).optional(), remove: z.array(tagSchema).max(20).optional() })
    .refine((b) => (b.add?.length ?? 0) + (b.remove?.length ?? 0) > 0, "Send add and/or remove");
  reg.route({ method: "POST", path: "/tenants/tags/bulk", roles: OWNER_SUPPORT, tag: "Support", summary: "Add and remove tags on many customers", body: bulkBody }, async (c) => {
    const b = await parseBody(c, bulkBody);
    const [r] = await db<{ saBulkTags: number }[]>`SELECT sa_bulk_tags(${adminId(c)}, ${db.array(b.tenantIds)}::uuid[], ${db.array(b.add ?? [])}::text[], ${db.array(b.remove ?? [])}::text[])`;
    return c.json({ updated: r!.saBulkTags });
  });

  // ---------------------------------------------------------------- invitation resend
  reg.route({ method: "POST", path: "/tenants/:id/invitations/:invitationId/resend", roles: OWNER_SUPPORT, tag: "Support", summary: "Re-issue and email a pending invitation (no link is returned)" }, async (c) => {
    const tenantId = parseId(c);
    const token = newOpaqueToken(32);
    const expires = new Date(Date.now() + INVITE_TTL_MS);
    const [r] = await db<{ rEmail: string; rRole: string; rTenantName: string }[]>`
      SELECT * FROM sa_reissue_invitation(${adminId(c)}, ${tenantId}, ${parseId(c, "invitationId")}, ${sha256(token)}, ${expires})`;
    if (!r) throw Errors.notFound("Pending invitation not found");
    let emailSent = true;
    try {
      await email().send({
        to: r.rEmail, subject: `You're invited to join ${r.rTenantName} on Lumi`,
        text: `You have been invited to join ${r.rTenantName} as ${r.rRole}.\n\nAccept the invitation (valid 7 days): ${cfg.customerAppUrl}/accept-invite?token=${token}\n`,
      });
    } catch (e) {
      emailSent = false;
      log.warn("invitation resend email failed", { tenantId, err: (e as Error).message });
    }
    return c.json({ ok: true as const, emailSent });
  });

  // ---------------------------------------------------------------- impersonation
  const impBody = z.strictObject({ reason: z.string().trim().min(5).max(500), userId: z.uuid().optional(), readOnly: z.boolean().default(true) });
  reg.route({ method: "POST", path: "/tenants/:id/impersonate", roles: OWNER_SUPPORT, tag: "Impersonation", status: 201, body: impBody,
    summary: "Start an impersonation: returns a one-time code (60 s) for the customer app; write mode is owner only" }, async (c) => {
    const tenantId = parseId(c);
    const b = await parseBody(c, impBody);
    const me = c.get("admin");
    if (!b.readOnly && me.role !== "owner") throw Errors.forbidden("Only owners can impersonate in write mode");
    const code = newOpaqueToken(32);
    const [s] = await db<{ rStatus: string; rSession: string; rUser: string; rRole: string; rEmail: string; rName: string; rTenantName: string }[]>`
      SELECT * FROM sa_start_impersonation_v2(${me.id}, ${tenantId}, ${b.userId ?? null}, ${b.reason}, ${sha256(code)}, ${b.readOnly}, ${CODE_TTL_S})`;
    if (!s || s.rStatus === "not_found") throw Errors.notFound("Tenant not found");
    if (s.rStatus === "tenant_inactive") throw Errors.conflict("Tenant is not active");
    if (s.rStatus === "user_not_found") throw Errors.notFound("User not found in this tenant");
    return c.json({
      sessionId: s.rSession, code, codeExpiresIn: CODE_TTL_S, customerUrl: `${cfg.customerAppUrl}/impersonate#code=${code}`, readOnly: b.readOnly,
      user: { id: s.rUser, email: s.rEmail, name: s.rName, role: s.rRole }, tenant: { id: tenantId, name: s.rTenantName },
    }, 201);
  });
  reg.route({ method: "POST", path: "/impersonation/:sessionId/end", roles: OWNER_SUPPORT, tag: "Impersonation", summary: "End an impersonation session now" }, async (c) => {
    const [x] = await db<{ saEndImpersonation: boolean }[]>`SELECT sa_end_impersonation(${adminId(c)}, ${parseId(c, "sessionId")})`;
    if (!x?.saEndImpersonation) throw Errors.notFound("Session not found or already ended");
    return c.json({ ok: true as const });
  });
  const pageQ = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });
  reg.route({ method: "GET", path: "/tenants/:id/impersonations", roles: ALL, tag: "Impersonation", summary: "Impersonation history of a customer", query: pageQ }, async (c) => {
    const id = parseId(c);
    const q = parseQuery(c, pageQ);
    await exists(id);
    const fetchRows = (limit: number, offset: number) => db<ImpRow[]>`SELECT * FROM sa_list_impersonations(${id}, NULL, ${limit}, ${offset})`;
    const rows = await fetchRows(q.limit, q.offset);
    return c.json({ items: rows.map(impDto), total: await pageTotal(rows, q.offset, () => fetchRows(1, 0)), limit: q.limit, offset: q.offset });
  });
  const allQ = pageQ.extend({ tenantId: z.uuid().optional(), adminId: z.uuid().optional() });
  reg.route({ method: "GET", path: "/impersonations", roles: ALL, tag: "Impersonation", summary: "Platform-wide impersonation history", query: allQ }, async (c) => {
    const q = parseQuery(c, allQ);
    const fetchRows = (limit: number, offset: number) => db<ImpRow[]>`SELECT * FROM sa_list_impersonations(${q.tenantId ?? null}, ${q.adminId ?? null}, ${limit}, ${offset})`;
    const rows = await fetchRows(q.limit, q.offset);
    return c.json({ items: rows.map(impDto), total: await pageTotal(rows, q.offset, () => fetchRows(1, 0)), limit: q.limit, offset: q.offset });
  });
}
