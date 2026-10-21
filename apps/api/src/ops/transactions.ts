import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { withTenant, type Tx } from "@yulona/db";
import { csvRow, decryptJson, encryptJson, signWebhook, verifyWebhook } from "@yulona/ops";
import {
  createTransactionSchema, createWebhookEndpointSchema, listTransactionsQuerySchema, transactionFilterSchema, transactionWebhookBodySchema,
  updateTransactionSchema, updateWebhookEndpointSchema,
} from "@yulona/shared";
import type { z } from "zod";
import type { AppEnv } from "../context";
import { AppError, Errors } from "../errors";
import { parseBody } from "../http";
import { audit, isFkViolation, isUniqueViolation, parseId, parseQuery } from "../platform/util";
import { decodeCur, encodeCur, guard, iso, TS_FMT, type OpsDeps } from "./common";

type Filters = z.infer<typeof transactionFilterSchema>;
interface Row {
  id: string; externalId: string | null; source: string; amountCents: string | number; currency: string; status: string; description: string | null;
  contactId: string | null; contactName: string | null; conversationId: string | null; metadata: unknown; occurredAt: Date; createdAt: Date; updatedAt: Date; ts?: string;
}
const dto = (t: Row) => ({
  id: t.id, externalId: t.externalId, source: t.source, amountCents: Number(t.amountCents), currency: t.currency, status: t.status, description: t.description,
  contactId: t.contactId, contactName: t.contactName, conversationId: t.conversationId, metadata: t.metadata, occurredAt: iso(t.occurredAt), createdAt: iso(t.createdAt), updatedAt: iso(t.updatedAt),
});
const select = (tx: Tx) => tx`
  t.id, t.external_id, t.source, t.amount_cents, t.currency, t.status, t.description, t.contact_id, c.name AS contact_name, t.conversation_id, t.metadata,
  t.occurred_at, t.created_at, t.updated_at, to_char(t.occurred_at AT TIME ZONE 'UTC', ${TS_FMT}) AS ts
  FROM transactions t LEFT JOIN contacts c ON c.tenant_id = t.tenant_id AND c.id = t.contact_id`;
const esc = (s: string) => `%${s.replace(/[\\%_]/g, "\\$&")}%`;
const where = (tx: Tx, tenantId: string, f: Filters) => tx`
  t.tenant_id = ${tenantId}
  ${f.status ? tx`AND t.status = ANY(${tx.array(f.status as string[])}::text[])` : tx``}
  ${f.contactId ? tx`AND t.contact_id = ${f.contactId}` : tx``}
  ${f.conversationId ? tx`AND t.conversation_id = ${f.conversationId}` : tx``}
  ${f.source ? tx`AND t.source = ${f.source}` : tx``}
  ${f.currency ? tx`AND t.currency = ${f.currency}` : tx``}
  ${f.from ? tx`AND t.occurred_at >= ${f.from}::timestamptz` : tx``}
  ${f.to ? tx`AND t.occurred_at <= ${f.to}::timestamptz` : tx``}
  ${f.minAmountCents !== undefined ? tx`AND t.amount_cents >= ${f.minAmountCents}` : tx``}
  ${f.maxAmountCents !== undefined ? tx`AND t.amount_cents <= ${f.maxAmountCents}` : tx``}
  ${f.q ? tx`AND (t.description ILIKE ${esc(f.q)} OR t.external_id ILIKE ${esc(f.q)})` : tx``}`;

const newSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;
const aad = (tenantId: string, id: string) => `txn-webhook:${tenantId}:${id}`;

export function transactionRoutes({ cfg, db }: OpsDeps) {
  const r = new Hono<AppEnv>();
  const needKey = () => {
    if (!cfg.encryptionKey) throw new AppError(503, "service_unavailable", "ENCRYPTION_KEY is not configured");
    return cfg.encryptionKey;
  };

  r.get("/transactions", guard(cfg, "agent"), async (c) => {
    const { tenantId } = c.get("auth");
    const q = parseQuery(c, listTransactionsQuerySchema);
    const cur = decodeCur(q.cursor);
    const out = await withTenant(db, tenantId, async (tx) => {
      const rows = await tx<Row[]>`
        SELECT ${select(tx)} WHERE ${where(tx, tenantId, q)}
        ${cur ? tx`AND (t.occurred_at, t.id) < (${cur.ts}::timestamptz, ${cur.id}::uuid)` : tx``}
        ORDER BY t.occurred_at DESC, t.id DESC LIMIT ${q.limit + 1}`;
      const sums = await tx<{ currency: string; n: number; total: string }[]>`
        SELECT t.currency, count(*)::int AS n, COALESCE(sum(t.amount_cents) FILTER (WHERE t.status = 'completed'), 0)::text AS total
        FROM transactions t WHERE ${where(tx, tenantId, q)} GROUP BY t.currency ORDER BY t.currency`;
      return { rows, sums };
    });
    const page = out.rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const byCurrency = out.sums.map((s) => ({ currency: s.currency, count: s.n, totalCents: Number(s.total) }));
    return c.json({
      items: page.map(dto),
      nextCursor: out.rows.length > q.limit && last ? encodeCur(last.ts!, last.id) : null,
      summary: { count: byCurrency.reduce((a, s) => a + s.count, 0), totalCents: byCurrency.length === 1 ? byCurrency[0]!.totalCents : null, byCurrency },
    });
  });

  r.get("/transactions/export.csv", guard(cfg, "agent"), async (c) => {
    const { tenantId } = c.get("auth");
    const f = parseQuery(c, transactionFilterSchema);
    await withTenant(db, tenantId, (tx) => audit(tx, c, "transaction.export", "transaction", tenantId, { filters: Object.keys(f) }));
    const header = ["id", "external_id", "source", "amount_cents", "currency", "status", "description", "contact_id", "contact_name", "conversation_id", "occurred_at", "created_at"];
    let cur: { ts: string; id: string } | null = null;
    let done = false;
    let sentHeader = false;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        if (!sentHeader) {
          sentHeader = true;
          ctrl.enqueue(enc.encode(csvRow(header)));
          return;
        }
        if (done) return ctrl.close();
        const rows = await withTenant(db, tenantId, (tx) => tx<Row[]>`
          SELECT ${select(tx)} WHERE ${where(tx, tenantId, f)}
          ${cur ? tx`AND (t.occurred_at, t.id) < (${cur.ts}::timestamptz, ${cur.id}::uuid)` : tx``}
          ORDER BY t.occurred_at DESC, t.id DESC LIMIT 500`);
        if (rows.length < 500) done = true;
        const last = rows[rows.length - 1];
        if (last) cur = { ts: last.ts!, id: last.id };
        if (!rows.length) return ctrl.close();
        ctrl.enqueue(enc.encode(rows.map((t) => csvRow([t.id, t.externalId, t.source, Number(t.amountCents), t.currency, t.status, t.description, t.contactId, t.contactName, t.conversationId, iso(t.occurredAt), iso(t.createdAt)])).join("")));
      },
    });
    return new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="transactions.csv"`, "cache-control": "no-store" } });
  });

  // ---- webhook endpoint management (declared before /transactions/:id) -------------------------
  const endpointDto = (e: { id: string; name: string; enabled: boolean; lastUsedAt: Date | null; createdAt: Date }) => ({
    id: e.id, name: e.name, enabled: e.enabled, url: `${(cfg.publicApiUrl ?? "").replace(/\/+$/, "")}/api/v1/webhooks/transactions/${e.id}`,
    lastUsedAt: iso(e.lastUsedAt), createdAt: iso(e.createdAt),
  });
  r.get("/transactions/webhook-endpoints", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const rows = await withTenant(db, tenantId, (tx) => tx<Parameters<typeof endpointDto>[0][]>`
      SELECT id, name, enabled, last_used_at, created_at FROM transaction_webhook_endpoints WHERE tenant_id = ${tenantId} ORDER BY created_at, id`);
    return c.json({ items: rows.map(endpointDto) });
  });
  r.post("/transactions/webhook-endpoints", guard(cfg, "admin"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const b = await parseBody(c, createWebhookEndpointSchema);
    const key = needKey();
    const id = crypto.randomUUID();
    const secret = newSecret();
    const row = await withTenant(db, tenantId, async (tx) => {
      const [x] = await tx<Parameters<typeof endpointDto>[0][]>`
        INSERT INTO transaction_webhook_endpoints (id, tenant_id, name, secret_encrypted, created_by)
        VALUES (${id}, ${tenantId}, ${b.name}, ${encryptJson(key, { secret }, aad(tenantId, id))}, ${userId})
        RETURNING id, name, enabled, last_used_at, created_at`;
      await audit(tx, c, "transaction_webhook.create", "transaction_webhook", id, { name: b.name });
      return x!;
    });
    return c.json({ ...endpointDto(row), secret }, 201);
  });
  r.post("/transactions/webhook-endpoints/:id/rotate-secret", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const key = needKey();
    const secret = newSecret();
    const ok = await withTenant(db, tenantId, async (tx) => {
      const rows = await tx`UPDATE transaction_webhook_endpoints SET secret_encrypted = ${encryptJson(key, { secret }, aad(tenantId, id))} WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING id`;
      if (rows.length) await audit(tx, c, "transaction_webhook.rotate", "transaction_webhook", id);
      return rows.length > 0;
    });
    if (!ok) throw Errors.notFound("Endpoint not found");
    return c.json({ secret });
  });
  r.patch("/transactions/webhook-endpoints/:id", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const b = await parseBody(c, updateWebhookEndpointSchema);
    const row = await withTenant(db, tenantId, async (tx) => {
      const [x] = await tx<Parameters<typeof endpointDto>[0][]>`
        UPDATE transaction_webhook_endpoints SET name = COALESCE(${b.name ?? null}, name), enabled = COALESCE(${b.enabled ?? null}, enabled)
        WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING id, name, enabled, last_used_at, created_at`;
      if (x) await audit(tx, c, "transaction_webhook.update", "transaction_webhook", id, { fields: Object.keys(b) });
      return x;
    });
    if (!row) throw Errors.notFound("Endpoint not found");
    return c.json(endpointDto(row));
  });
  r.delete("/transactions/webhook-endpoints/:id", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const ok = await withTenant(db, tenantId, async (tx) => {
      const rows = await tx`DELETE FROM transaction_webhook_endpoints WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING id`;
      if (rows.length) await audit(tx, c, "transaction_webhook.delete", "transaction_webhook", id);
      return rows.length > 0;
    });
    if (!ok) throw Errors.notFound("Endpoint not found");
    return c.json({ ok: true as const });
  });

  // ---- CRUD ---------------------------------------------------------------------------------------
  r.post("/transactions", guard(cfg, "agent"), async (c) => {
    const { tenantId } = c.get("auth");
    const b = await parseBody(c, createTransactionSchema);
    try {
      const t = await withTenant(db, tenantId, async (tx) => {
        const [x] = await tx<{ id: string }[]>`
          INSERT INTO transactions (tenant_id, external_id, source, amount_cents, currency, status, description, contact_id, conversation_id, metadata, occurred_at)
          VALUES (${tenantId}, ${b.externalId ?? null}, 'manual', ${b.amountCents}, ${b.currency}, ${b.status ?? "completed"}, ${b.description ?? null},
                  ${b.contactId ?? null}, ${b.conversationId ?? null}, ${tx.json((b.metadata ?? {}) as never)}, COALESCE(${b.occurredAt ?? null}::timestamptz, now()))
          RETURNING id`;
        await audit(tx, c, "transaction.create", "transaction", x!.id, { amountCents: b.amountCents, currency: b.currency });
        return (await tx<Row[]>`SELECT ${select(tx)} WHERE t.tenant_id = ${tenantId} AND t.id = ${x!.id}`)[0]!;
      });
      return c.json(dto(t), 201);
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict("A transaction with this externalId already exists");
      if (isFkViolation(e)) throw Errors.validation([{ path: "reference", message: "contact or conversation not found" }]);
      throw e;
    }
  });

  r.get("/transactions/:id", guard(cfg, "agent"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const [t] = await withTenant(db, tenantId, (tx) => tx<Row[]>`SELECT ${select(tx)} WHERE t.tenant_id = ${tenantId} AND t.id = ${id}`);
    if (!t) throw Errors.notFound("Transaction not found");
    return c.json(dto(t));
  });

  r.patch("/transactions/:id", guard(cfg, "agent"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const b = await parseBody(c, updateTransactionSchema);
    try {
      const t = await withTenant(db, tenantId, async (tx) => {
        const [cur] = await tx<{ description: string | null; contactId: string | null; conversationId: string | null }[]>`
          SELECT description, contact_id, conversation_id FROM transactions WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
        if (!cur) return null;
        await tx`
          UPDATE transactions SET
            amount_cents = COALESCE(${b.amountCents ?? null}, amount_cents), status = COALESCE(${b.status ?? null}, status),
            description = ${b.description !== undefined ? b.description : cur.description},
            contact_id = ${b.contactId !== undefined ? b.contactId : cur.contactId},
            conversation_id = ${b.conversationId !== undefined ? b.conversationId : cur.conversationId},
            metadata = ${b.metadata !== undefined ? tx.json(b.metadata as never) : tx`metadata`},
            occurred_at = COALESCE(${b.occurredAt ?? null}::timestamptz, occurred_at), updated_at = now()
          WHERE tenant_id = ${tenantId} AND id = ${id}`;
        await audit(tx, c, "transaction.update", "transaction", id, { fields: Object.keys(b) });
        return (await tx<Row[]>`SELECT ${select(tx)} WHERE t.tenant_id = ${tenantId} AND t.id = ${id}`)[0]!;
      });
      if (!t) throw Errors.notFound("Transaction not found");
      return c.json(dto(t));
    } catch (e) {
      if (isFkViolation(e)) throw Errors.validation([{ path: "reference", message: "contact or conversation not found" }]);
      throw e;
    }
  });

  r.delete("/transactions/:id", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const ok = await withTenant(db, tenantId, async (tx) => {
      const rows = await tx`DELETE FROM transactions WHERE tenant_id = ${tenantId} AND id = ${id} RETURNING id`;
      if (rows.length) await audit(tx, c, "transaction.delete", "transaction", id);
      return rows.length > 0;
    });
    if (!ok) throw Errors.notFound("Transaction not found");
    return c.json({ ok: true as const });
  });
  return r;
}

/** Public receiver: `/api/v1/webhooks/transactions/:endpointId` (HMAC-signed, no JWT). */
export function transactionWebhookReceiver({ cfg, db, limiter }: OpsDeps) {
  const r = new Hono<AppEnv>();
  const reject = () => new AppError(401, "unauthorized", "Invalid webhook signature or endpoint");
  r.post("/transactions/:endpointId", async (c) => {
    const id = c.req.param("endpointId");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw reject();
    const lim = await limiter.hit(`txn-webhook:${id}`, 300, 60_000);
    if (!lim.allowed) throw Errors.rateLimited(lim.retryAfterSec);
    const lenHeader = Number(c.req.header("content-length") ?? 0);
    if (lenHeader > 65_536) throw new AppError(413, "payload_too_large", "Request body too large");
    const raw = await c.req.text();
    if (raw.length > 65_536) throw new AppError(413, "payload_too_large", "Request body too large");
    const [ep] = await db<{ tenantId: string; secretEncrypted: string; enabled: boolean; tenantStatus: string }[]>`SELECT * FROM ops_txn_endpoint_resolve(${id}::uuid)`;
    if (!ep || !ep.enabled || ep.tenantStatus !== "active" || !cfg.encryptionKey) throw reject();
    let secret: string;
    try {
      secret = decryptJson<{ secret: string }>(cfg.encryptionKey, ep.secretEncrypted, aad(ep.tenantId, id)).secret;
    } catch {
      throw reject();
    }
    const verdict = verifyWebhook(secret, raw, { timestamp: c.req.header("x-yulona-timestamp"), signature: c.req.header("x-yulona-signature") });
    if (verdict !== "ok") throw reject();
    let json: unknown;
    try { json = JSON.parse(raw); } catch { throw new AppError(400, "invalid_json", "Malformed JSON body"); }
    const parsed = transactionWebhookBodySchema.safeParse(json);
    if (!parsed.success) throw Errors.validation(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    const b = parsed.data;
    const out = await withTenant(db, ep.tenantId, async (tx) => {
      let contactId: string | null = null;
      if (b.contactEmail) {
        const [ct] = await tx<{ id: string }[]>`
          SELECT id FROM contacts WHERE tenant_id = ${ep.tenantId} AND lower(email) = lower(${b.contactEmail}) AND merged_into IS NULL ORDER BY created_at LIMIT 1`;
        contactId = ct?.id ?? null;
      }
      const [row] = await tx<{ id: string; created: boolean }[]>`
        INSERT INTO transactions (tenant_id, external_id, source, amount_cents, currency, status, description, contact_id, metadata, occurred_at)
        VALUES (${ep.tenantId}, ${b.externalId}, 'webhook', ${b.amountCents}, ${b.currency}, ${b.status ?? "completed"}, ${b.description ?? null}, ${contactId},
                ${tx.json((b.metadata ?? {}) as never)}, COALESCE(${b.occurredAt ?? null}::timestamptz, now()))
        ON CONFLICT (tenant_id, source, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
          amount_cents = EXCLUDED.amount_cents, status = EXCLUDED.status, description = COALESCE(EXCLUDED.description, transactions.description),
          contact_id = COALESCE(EXCLUDED.contact_id, transactions.contact_id), metadata = transactions.metadata || EXCLUDED.metadata, updated_at = now()
        RETURNING id, (xmax = 0) AS created`;
      await tx`UPDATE transaction_webhook_endpoints SET last_used_at = now() WHERE tenant_id = ${ep.tenantId} AND id = ${id}`;
      return row!;
    });
    return c.json({ id: out.id, created: out.created });
  });
  return r;
}
export { signWebhook };
