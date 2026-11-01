import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE } from "@yulona/db/testing";
import { bootAdmin, call, hasDb, jsonOf, mkAdmin, mkTenant, type AdminBoot } from "./support";

if (!hasDb) console.warn(SKIP_MESSAGE);
describe.skipIf(!hasDb)("smoke", () => {
  let b: AdminBoot;
  beforeAll(async () => { b = await bootAdmin(); });
  afterAll(async () => b.close());
  test("health and list", async () => {
    expect((await b.app.request("/healthz")).status).toBe(200);
    const a = await mkAdmin(b, "owner");
    const t = await mkTenant(b);
    const r = await call(b, "GET", "/tenants", a);
    expect(r.status).toBe(200);
    const j = await jsonOf(r);
    expect(j.items.find((x: { id: string }) => x.id === t.tenantId)).toBeTruthy();
    const d = await call(b, "GET", `/tenants/${t.tenantId}`, a);
    expect(d.status).toBe(200);
    for (const p of ["users", "timeline", "errors", "assets", "billing", "ai-usage", "usage", "credits", "flags", "notes", "tags", "impersonations"]) {
      const x = await call(b, "GET", `/tenants/${t.tenantId}/${p}`, a);
      expect([p, x.status]).toEqual([p, 200]);
    }
    for (const p of ["/overview", "/analytics", "/health", "/search?q=acme", "/attention", "/plans", "/feature-flags", "/model-rates", "/credit-packs", "/llm-profiles", "/ops/dead-jobs", "/ops/failed-webhooks", "/audit-logs", "/admins", "/tags", "/impersonations"]) {
      const x = await call(b, "GET", p, a);
      expect([p, x.status]).toEqual([p, 200]);
    }
  });
});
