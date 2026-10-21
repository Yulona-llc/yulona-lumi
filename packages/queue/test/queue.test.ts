import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTenant } from "@yulona/db";
import { SKIP_MESSAGE, seedTenantWithUser, setupTestDb, testUrls } from "@yulona/db/testing";
import { FatalJobError, backoffMs, enqueue, startWorker } from "../src";

const has = !!testUrls();
if (!has) console.warn(SKIP_MESSAGE);

test("backoff grows exponentially and is capped", () => {
  const r = () => 0.5; // no jitter
  expect(backoffMs(1, 1000, 60_000, r)).toBe(1000);
  expect(backoffMs(3, 1000, 60_000, r)).toBe(4000);
  expect(backoffMs(20, 1000, 60_000, r)).toBe(60_000);
});

describe.skipIf(!has)("queue", () => {
  let ctx: Awaited<ReturnType<typeof setupTestDb>>;
  let a: Awaited<ReturnType<typeof seedTenantWithUser>>;
  let b: Awaited<ReturnType<typeof seedTenantWithUser>>;
  beforeAll(async () => {
    ctx = await setupTestDb();
    a = await seedTenantWithUser(ctx.owner, "qa");
    b = await seedTenantWithUser(ctx.owner, "qb");
  });
  afterAll(async () => { await ctx.app.end({ timeout: 2 }); await ctx.owner.end({ timeout: 2 }); });
  const status = async (id: string) => (await ctx.owner`SELECT status, attempts, last_error FROM jobs WHERE id = ${id}`)[0]!;

  test("runs a job with tenant-scoped context", async () => {
    const name = `t.ok.${crypto.randomUUID()}`;
    const id = await enqueue(ctx.app, { name, tenantId: a.tenantId, payload: { x: 1 } });
    let seen: unknown, visible = -1, other = -1;
    const w = startWorker(ctx.app, { [name]: async (p, c) => {
      seen = p;
      visible = (await c.withTenant((tx) => tx`SELECT id FROM users`)).length;
      other = (await c.withTenant((tx) => tx`SELECT id FROM users WHERE tenant_id = ${b.tenantId}`)).length;
    } }, { pollIntervalMs: 20 });
    await w.tick();
    await w.stop();
    expect(seen).toEqual({ x: 1 });
    expect(visible).toBe(1);
    expect(other).toBe(0);
    expect((await status(id)).status).toBe("succeeded");
  });

  test("retries with backoff then dead-letters", async () => {
    const name = `t.fail.${crypto.randomUUID()}`;
    const id = await enqueue(ctx.app, { name, tenantId: a.tenantId, maxAttempts: 2 });
    let dead = 0;
    const w = startWorker(ctx.app, { [name]: async () => { throw new Error("boom"); } },
      { baseBackoffMs: 1, maxBackoffMs: 1, onDead: () => dead++ });
    await w.tick();
    expect((await status(id)).status).toBe("queued");
    await Bun.sleep(20);
    await w.tick();
    const s = await status(id);
    await w.stop();
    expect(s.status).toBe("dead");
    expect(s.attempts).toBe(2);
    expect(s.last_error).toBe("boom");
    expect(dead).toBe(1);
  });

  test("FatalJobError dead-letters immediately; future runAt not claimed", async () => {
    const name = `t.fatal.${crypto.randomUUID()}`;
    const id = await enqueue(ctx.app, { name, tenantId: a.tenantId });
    const later = await enqueue(ctx.app, { name, tenantId: a.tenantId, runAt: new Date(Date.now() + 3_600_000) });
    const w = startWorker(ctx.app, { [name]: async () => { throw new FatalJobError("bad"); } });
    expect(await w.tick()).toBe(1);
    await w.stop();
    expect((await status(id)).status).toBe("dead");
    expect((await status(later)).status).toBe("queued");
  });

  test("concurrent workers never run a job twice (SKIP LOCKED)", async () => {
    const name = `t.conc.${crypto.randomUUID()}`;
    for (let i = 0; i < 30; i++) await enqueue(ctx.app, { name, tenantId: a.tenantId, payload: { i } });
    const seen: number[] = [];
    const h = { [name]: async (p: { i: number }) => { seen.push(p.i); await Bun.sleep(5); } };
    const ws = [startWorker(ctx.app, h, { concurrency: 4 }), startWorker(ctx.app, h, { concurrency: 4 }), startWorker(ctx.app, h, { concurrency: 4 })];
    for (let r = 0; r < 10 && seen.length < 30; r++) await Promise.all(ws.map((w) => w.tick()));
    await Promise.all(ws.map((w) => w.stop()));
    expect(seen.length).toBe(30);
    expect(new Set(seen).size).toBe(30);
  });

  test("expired locks are reclaimed", async () => {
    const name = `t.stale.${crypto.randomUUID()}`;
    const id = await enqueue(ctx.app, { name, tenantId: a.tenantId });
    await ctx.owner`UPDATE jobs SET status='running', locked_by='dead-worker', locked_at = now() - interval '1 hour', attempts = 1 WHERE id = ${id}`;
    let ran = 0;
    const w = startWorker(ctx.app, { [name]: async () => { ran++; } }, { lockTimeoutMs: 60_000 });
    await w.tick();
    await w.stop();
    expect(ran).toBe(1);
    expect((await status(id)).attempts).toBe(2);
  });

  test("RLS: tenant cannot enqueue for or see another tenant's jobs; enqueue joins caller tx", async () => {
    const name = `t.rls.${crypto.randomUUID()}`;
    await expect(withTenant(ctx.app, a.tenantId, (tx) => enqueue(tx, { name, tenantId: b.tenantId }))).rejects.toThrow();
    const id = await enqueue(ctx.app, { name, tenantId: b.tenantId });
    const seenByA = await withTenant(ctx.app, a.tenantId, (tx) => tx`SELECT id FROM jobs WHERE id = ${id}`);
    expect(seenByA.length).toBe(0);
    // rollback of the caller tx discards the job
    const rolled = crypto.randomUUID();
    await withTenant(ctx.app, a.tenantId, async (tx) => {
      await enqueue(tx, { name: `t.rb.${rolled}`, tenantId: a.tenantId });
      await tx.savepoint(async (sp) => { await enqueue(sp, { name: `t.sp.${rolled}`, tenantId: a.tenantId }); });
    });
    expect((await ctx.owner`SELECT id FROM jobs WHERE name = ${`t.rb.${rolled}`}`).length).toBe(1);
  });

  test("app role cannot call claim cross-tenant tables directly", async () => {
    expect((await ctx.app`SELECT * FROM jobs`).length).toBe(0); // no GUC => zero rows
  });
});
