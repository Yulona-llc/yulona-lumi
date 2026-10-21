import { beforeAll, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE, seedTenantWithUser, setupTestDb } from "@yulona/db/testing";
import { createLogger } from "@yulona/shared";
import { createApp } from "../src/app";
import { MemoryRateLimiter } from "../src/ratelimit";
import { signAccessToken } from "../src/security";
import { SECRET, hasDb, testConfig } from "./helpers";

if (!hasDb) console.warn(SKIP_MESSAGE);

describe.skipIf(!hasDb)("GET /conversations/:id/ai-state", () => {
  let app: ReturnType<typeof createApp>;
  let owner: Awaited<ReturnType<typeof setupTestDb>>["owner"];
  const hdr = async (t: { tenantId: string; userId: string }, role: "owner" | "viewer" = "owner") => ({ authorization: `Bearer ${await signAccessToken(SECRET, { userId: t.userId, tenantId: t.tenantId, role, ttlSeconds: 900 })}` });

  beforeAll(async () => {
    const s = await setupTestDb();
    owner = s.owner;
    const cfg = testConfig({}, (c) => { c.rateLimits.global = { limit: 1e6, windowMs: 60_000 }; });
    app = createApp({ cfg, db: s.app, limiter: new MemoryRateLimiter(), log: createLogger({ level: "silent" }) });
  });

  test("returns stage, lead and active handoff; tenant isolated", async () => {
    const A = await seedTenantWithUser(owner, "ai-A");
    const B = await seedTenantWithUser(owner, "ai-B");
    const [ct] = await owner<{ id: string }[]>`INSERT INTO contacts (tenant_id, name) VALUES (${A.tenantId}, 'Lee') RETURNING id`;
    const [cv] = await owner<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id, status, handler) VALUES (${A.tenantId}, ${ct!.id}, 'open', 'ai') RETURNING id`;
    const id = cv!.id;
    const get = (cid: string, h: Record<string, string>) => app.request(`/api/v1/conversations/${cid}/ai-state`, { headers: h });

    // no ai-state row yet
    let res = await get(id, await hdr(A));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stage: null, lead: {}, handoff: null });

    await owner`INSERT INTO conversation_ai_state (tenant_id, conversation_id, stage, lead) VALUES (${A.tenantId}, ${id}, 'qualified', ${owner.json({ name: "Lee", budget: "5k", secretInternal: "x" })})`;
    await owner`INSERT INTO handoffs (tenant_id, conversation_id, type, reason, lead_card) VALUES (${A.tenantId}, ${id}, 'stage', 'Qualified lead', ${owner.json({ summary: "Wants a demo" })})`;
    res = await get(id, await hdr(A, "viewer"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stage: "qualified", lead: { name: "Lee", budget: "5k", summary: "Wants a demo" }, handoff: { type: "stage", reason: "Qualified lead" } });

    await owner`UPDATE handoffs SET resolved_at = now() WHERE conversation_id = ${id}`;
    expect(((await (await get(id, await hdr(A))).json()) as { handoff: unknown }).handoff).toBeNull();

    // cross-tenant, unauthenticated, bad id
    expect((await get(id, await hdr(B))).status).toBe(404);
    expect((await get(id, {})).status).toBe(401);
    expect((await get("not-a-uuid", await hdr(A))).status).toBe(404);
  });
});
