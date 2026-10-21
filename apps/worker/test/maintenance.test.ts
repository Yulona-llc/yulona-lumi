import { describe, expect, test } from "bun:test";
import { SKIP_MESSAGE, seedTenantWithUser, setupTestDb, testUrls } from "@yulona/db/testing";
import { enqueue, startWorker } from "@yulona/queue";
import { pruneJobs, purgeDeletedTenants } from "../src/maintenance";

const has = !!testUrls();
if (!has) console.warn(SKIP_MESSAGE);

describe.skipIf(!has)("worker maintenance + wiring", () => {
  test("prunes old finished jobs; purges tenants deleted > 30 days; worker runs registered handler", async () => {
    const { owner, app } = await setupTestDb();
    try {
      const t = await seedTenantWithUser(owner, "wm");
      // handler registry round trip through the real worker loop
      let got: unknown;
      const name = `wm.${crypto.randomUUID()}`;
      await enqueue(app, { name, tenantId: t.tenantId, payload: { hello: "world" } });
      const w = startWorker(app, { [name]: async (p) => { got = p; } });
      await w.tick();
      await w.stop();
      expect(got).toEqual({ hello: "world" });

      await owner`UPDATE jobs SET finished_at = now() - interval '10 days' WHERE tenant_id = ${t.tenantId} AND status = 'succeeded'`;
      expect(await pruneJobs(app, 7)).toBeGreaterThanOrEqual(1);

      await owner`UPDATE tenants SET status = 'deleted', deleted_at = now() - interval '29 days' WHERE id = ${t.tenantId}`;
      await purgeDeletedTenants(app);
      expect((await owner`SELECT 1 FROM tenants WHERE id = ${t.tenantId}`).length).toBe(1);
      await owner`UPDATE tenants SET deleted_at = now() - interval '31 days' WHERE id = ${t.tenantId}`;
      await purgeDeletedTenants(app);
      expect((await owner`SELECT 1 FROM tenants WHERE id = ${t.tenantId}`).length).toBe(0);
    } finally {
      await app.end({ timeout: 2 });
      await owner.end({ timeout: 2 });
    }
  });
});
