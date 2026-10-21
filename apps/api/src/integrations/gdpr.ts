import { Hono } from "hono";
import { z } from "zod";
import { withTenant, type Tx } from "@yulona/db";
import { enqueue } from "@yulona/queue";
import { GDPR_ERASE_JOB, GDPR_EXPORT_JOB } from "@yulona/integrations";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { requireAuth } from "../middleware";
import { requireMinRole } from "../platform/authz";
import { audit, parseId, parseQuery } from "../platform/util";
import type { AppEnv } from "../context";
import { cursorOf } from "../conversations/common";
import { encodeCursor } from "../conversations/dto";
import { iso, type IntegrationsDeps } from "./common";

const MAX_OPEN_REQUESTS = 5;
const SIGNED_URL_TTL_SEC = 900;

export const exportRequestSchema = z.strictObject({ contactId: z.uuid().optional() });
export const erasureRequestSchema = z.strictObject({ contactId: z.uuid(), confirm: z.literal(true) });
const listQuery = z.strictObject({
  kind: z.enum(["export", "erasure"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(200).optional(),
});

interface ReqRow {
  id: string; kind: string; subjectContactId: string | null; status: string; requestedBy: string | null; sizeBytes: string | number | null;
  result: unknown; error: string | null; expiresAt: Date | null; createdAt: Date; completedAt: Date | null; hasFile: boolean; cursorTs?: string;
}
const cols = (tx: Tx) => tx`id, kind, subject_contact_id, status, requested_by, size_bytes, result, error, expires_at, created_at, completed_at,
  (storage_key IS NOT NULL AND expires_at > now()) AS has_file,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`;
const dto = (r: ReqRow) => ({
  id: r.id, kind: r.kind, contactId: r.subjectContactId, status: r.status, requestedBy: r.requestedBy,
  sizeBytes: r.sizeBytes == null ? null : Number(r.sizeBytes), result: r.result, error: r.error,
  downloadAvailable: r.kind === "export" && r.status === "completed" && r.hasFile,
  expiresAt: iso(r.expiresAt), createdAt: iso(r.createdAt)!, completedAt: iso(r.completedAt),
});

export function gdprRoutes({ cfg, db, providers }: IntegrationsDeps) {
  const r = new Hono<AppEnv>();
  const guard = [requireAuth(cfg), requireMinRole("admin")] as const;
  r.use("/gdpr", ...guard);
  r.use("/gdpr/*", ...guard);

  async function create(c: Parameters<typeof audit>[1], kind: "export" | "erasure", contactId: string | null) {
    const { tenantId, userId } = c.get("auth");
    return withTenant(db, tenantId, async (tx) => {
      if (contactId) {
        const [ct] = await tx`SELECT 1 FROM contacts WHERE tenant_id = ${tenantId} AND id = ${contactId}`;
        if (!ct) throw Errors.notFound("Contact not found");
      }
      const [open] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM gdpr_requests WHERE tenant_id = ${tenantId} AND status IN ('queued','processing')`;
      if (open!.n >= MAX_OPEN_REQUESTS) throw Errors.conflict("Too many GDPR requests in progress; wait for them to finish");
      const [row] = await tx<ReqRow[]>`
        INSERT INTO gdpr_requests (tenant_id, kind, subject_contact_id, requested_by) VALUES (${tenantId}, ${kind}, ${contactId}, ${userId})
        RETURNING ${cols(tx)}`;
      await enqueue(tx, { name: kind === "export" ? GDPR_EXPORT_JOB : GDPR_ERASE_JOB, tenantId, payload: { requestId: row!.id }, maxAttempts: 3 });
      await audit(tx, c, kind === "export" ? "gdpr.export.requested" : "gdpr.erasure.requested", "gdpr_request", row!.id, { contactId });
      return row!;
    });
  }

  r.post("/gdpr/exports", async (c) => {
    const body = await parseBody(c, exportRequestSchema);
    return c.json(dto(await create(c, "export", body.contactId ?? null)), 202);
  });

  r.post("/gdpr/erasures", async (c) => {
    const body = await parseBody(c, erasureRequestSchema);
    return c.json(dto(await create(c, "erasure", body.contactId)), 202);
  });

  r.get("/gdpr/requests", async (c) => {
    const { tenantId } = c.get("auth");
    const q = parseQuery(c, listQuery);
    const cursor = cursorOf(q.cursor);
    const rows = await withTenant(db, tenantId, (tx) => tx<ReqRow[]>`
      SELECT ${cols(tx)} FROM gdpr_requests WHERE tenant_id = ${tenantId}
        ${q.kind ? tx`AND kind = ${q.kind}` : tx``}
        ${cursor ? tx`AND (created_at, id) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)` : tx``}
      ORDER BY created_at DESC, id DESC LIMIT ${q.limit + 1}`);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return c.json({ items: page.map(dto), nextCursor: rows.length > q.limit && last ? encodeCursor(last.cursorTs!, last.id) : null });
  });

  r.get("/gdpr/requests/:id", async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const [row] = await withTenant(db, tenantId, (tx) => tx<ReqRow[]>`SELECT ${cols(tx)} FROM gdpr_requests WHERE tenant_id = ${tenantId} AND id = ${id}`);
    if (!row) throw Errors.notFound("Request not found");
    return c.json(dto(row));
  });

  /**
   * Signed link when the storage backend can presign (S3/MinIO); otherwise the file is streamed through the
   * API (still authenticated). Links expire after 15 minutes; the file itself after 7 days.
   */
  r.get("/gdpr/requests/:id/download", async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const row = await withTenant(db, tenantId, async (tx) => {
      const [x] = await tx<{ storageKey: string | null; status: string; expired: boolean }[]>`
        SELECT storage_key, status, (expires_at IS NULL OR expires_at <= now()) AS expired FROM gdpr_requests
        WHERE tenant_id = ${tenantId} AND id = ${id} AND kind = 'export'`;
      if (x?.storageKey && x.status === "completed" && !x.expired) await audit(tx, c, "gdpr.export.downloaded", "gdpr_request", id);
      return x;
    });
    if (!row) throw Errors.notFound("Request not found");
    if (row.status !== "completed" || !row.storageKey || row.expired) throw Errors.notFound("Export is not available (not ready or expired)");
    c.header("Cache-Control", "no-store");
    const url = await providers.storage.signedUrl(row.storageKey, { expiresInSec: SIGNED_URL_TTL_SEC });
    if (url) return c.json({ url, expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SEC * 1000).toISOString() });
    const obj = await providers.storage.get(row.storageKey);
    if (!obj) throw Errors.notFound("Export file not found");
    return new Response(obj.body as unknown as BodyInit, {
      headers: { "content-type": obj.contentType ?? "application/json", "content-disposition": `attachment; filename="yulona-export-${id}.json"`, "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  });

  return r;
}
