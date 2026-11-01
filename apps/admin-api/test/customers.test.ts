import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE } from "@yulona/db/testing";
import { bootAdmin, call, hasDb, jsonOf, mkAdmin, mkTenant, uniq, type AdminBoot, type TestAdmin } from "./support";

if (!hasDb) console.warn(SKIP_MESSAGE);

describe.skipIf(!hasDb)("customers: health score", () => {
  let b: AdminBoot, a: TestAdmin;
  beforeAll(async () => { b = await bootAdmin(); a = await mkAdmin(b, "owner"); });
  afterAll(async () => b.close());

  // read through the list: the detail endpoint also syncs the credits period row (sa_tenant_credits), which would reset test-set allowances
  const health = async (id: string) => {
    const [row] = await b.owner<{ name: string }[]>`SELECT name FROM tenants WHERE id = ${id}`;
    const r = await jsonOf(await call(b, "GET", `/tenants?q=${encodeURIComponent(row!.name)}`, a));
    return r.items.find((x: { id: string }) => x.id === id).health as { score: number; bucket: string; reasons: { code: string; points: number; label: string }[] };
  };
  const codes = (h: { reasons: { code: string }[] }) => h.reasons.map((r) => r.code);
  const points = (h: { reasons: { code: string; points: number }[] }, c: string) => h.reasons.find((r) => r.code === c)?.points;
  const tenant = async (ageDays = 0) => {
    const t = await mkTenant(b);
    if (ageDays) await b.owner`UPDATE tenants SET created_at = now() - make_interval(days => ${ageDays}) WHERE id = ${t.tenantId}`;
    await b.owner`UPDATE users SET last_login_at = now() WHERE id = ${t.userId}`; // active unless a case says otherwise
    return t;
  };
  const dead = (tid: string, n: number, ageDays = 0) => b.owner`
    INSERT INTO jobs (tenant_id, name, status, attempts, last_error, updated_at) SELECT ${tid}, 'conversation.reply', 'dead', 5, 'provider 500', now() - make_interval(days => ${ageDays}) FROM generate_series(1, ${n})`;

  test("a fresh, active customer is 100 and healthy with no reasons", async () => {
    const t = await tenant();
    expect(await health(t.tenantId)).toEqual({ score: 100, bucket: "healthy", reasons: [] });
  });

  test("failed jobs: 5 points each in the last 7 days, capped at 20; older failures are ignored", async () => {
    const t = await tenant();
    await dead(t.tenantId, 2);
    await dead(t.tenantId, 3, 10);
    let h = await health(t.tenantId);
    expect([h.score, points(h, "failed_jobs")]).toEqual([90, 10]);
    await dead(t.tenantId, 10);
    h = await health(t.tenantId);
    expect([h.score, points(h, "failed_jobs")]).toEqual([80, 20]);
    expect(h.bucket).toBe("healthy");
  });

  test("failed webhook deliveries, channel errors and failed channel deliveries, failed ingests", async () => {
    const t = await tenant();
    const [w] = await b.owner<{ id: string }[]>`INSERT INTO webhooks (tenant_id, name, url, secret_encrypted, events) VALUES (${t.tenantId}, 'hook', 'https://h.example.test/x', 'v1.x', ${["message.created"]}) RETURNING id`;
    for (let i = 0; i < 3; i++) await b.owner`INSERT INTO webhook_deliveries (tenant_id, webhook_id, event_id, event_type, payload, status, last_error) VALUES (${t.tenantId}, ${w!.id}, ${crypto.randomUUID()}, 'message.created', '{}'::jsonb, 'failed', 'HTTP 500')`;
    const [c] = await b.owner<{ id: string }[]>`INSERT INTO channel_connections (tenant_id, channel, name, credentials_encrypted, last_health_ok, last_health_error, last_health_at) VALUES (${t.tenantId}, 'telegram', 'bot', 'v1.c', false, 'token revoked', now()) RETURNING id`;
    const [ct] = await b.owner<{ id: string }[]>`INSERT INTO contacts (tenant_id) VALUES (${t.tenantId}) RETURNING id`;
    const [cv] = await b.owner<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id) VALUES (${t.tenantId}, ${ct!.id}) RETURNING id`;
    for (let i = 0; i < 3; i++) {
      const [mi] = await b.owner<{ id: string }[]>`INSERT INTO messages (tenant_id, conversation_id, sender_type, content) VALUES (${t.tenantId}, ${cv!.id}, 'ai', 'x') RETURNING id`;
      await b.owner`INSERT INTO channel_deliveries (tenant_id, message_id, conversation_id, connection_id, channel, status, error) VALUES (${t.tenantId}, ${mi!.id}, ${cv!.id}, ${c!.id}, 'telegram', 'failed', 'blocked by user')`;
    }
    await b.owner`INSERT INTO knowledge_sources (tenant_id, type, name, status, error) VALUES (${t.tenantId}, 'url', 'docs', 'failed', 'blocked url'), (${t.tenantId}, 'url', 'docs2', 'failed', 'empty')`;
    const h = await health(t.tenantId);
    expect(points(h, "failed_webhooks")).toBe(9);
    expect(points(h, "channel_errors")).toBe(16); // 10 for the broken connection + 2 x 3 failed deliveries
    expect(points(h, "failed_ingests")).toBe(10);
    expect(h.score).toBe(100 - 9 - 16 - 10);
    expect(h.bucket).toBe("watch");
  });

  test("credits exhausted (25) and low (10), payment failed (25), unlimited plans never lose points", async () => {
    const t = await tenant();
    await b.owner`INSERT INTO tenant_credits (tenant_id, period, allowance_micro, used_micro) VALUES (${t.tenantId}, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 1000000, 1000000)`;
    let h = await health(t.tenantId);
    expect([codes(h), points(h, "credits_exhausted"), h.score]).toEqual([["credits_exhausted"], 25, 75]);
    await b.owner`UPDATE tenant_credits SET used_micro = 950000 WHERE tenant_id = ${t.tenantId}`;
    h = await health(t.tenantId);
    expect([codes(h), points(h, "credits_low")]).toEqual([["credits_low"], 10]);
    await b.owner`UPDATE tenant_credits SET used_micro = 100000, topup_micro = 0 WHERE tenant_id = ${t.tenantId}`;
    expect(codes(await health(t.tenantId))).toEqual([]);
    await b.owner`INSERT INTO billing_customers (tenant_id, customer_id, status) VALUES (${t.tenantId}, ${uniq("cus")}, 'past_due')`;
    h = await health(t.tenantId);
    expect([codes(h), points(h, "payment_failed"), h.score]).toEqual([["payment_failed"], 25, 75]);
    const ent = await tenant();
    await b.owner`UPDATE tenants SET plan_key = 'enterprise' WHERE id = ${ent.tenantId}`;
    expect(codes(await health(ent.tenantId))).toEqual([]);
  });

  test("inactivity (14+ days) counts only for customers older than 14 days; activity and logins reset it", async () => {
    const young = await tenant(3);
    await b.owner`UPDATE users SET last_login_at = NULL WHERE id = ${young.userId}`;
    expect(codes(await health(young.tenantId))).toEqual([]);
    const old = await tenant(30);
    await b.owner`UPDATE users SET last_login_at = now() - interval '20 days' WHERE id = ${old.userId}`;
    const h = await health(old.tenantId);
    expect([codes(h), points(h, "inactive"), h.score]).toEqual([["inactive"], 15, 85]);
    await b.owner`UPDATE users SET last_login_at = now() WHERE id = ${old.userId}`;
    expect(codes(await health(old.tenantId))).toEqual([]);
    await b.owner`UPDATE users SET last_login_at = now() - interval '20 days' WHERE id = ${old.userId}`;
    const [ct] = await b.owner<{ id: string }[]>`INSERT INTO contacts (tenant_id) VALUES (${old.tenantId}) RETURNING id`;
    await b.owner`INSERT INTO conversations (tenant_id, contact_id, last_message_at) VALUES (${old.tenantId}, ${ct!.id}, now() - interval '1 day')`;
    expect(codes(await health(old.tenantId))).toEqual([]);
  });

  test("agents that were never published (10) and recent abuse blocks (2 each, max 10)", async () => {
    const t = await tenant(5);
    await b.owner`INSERT INTO agents (tenant_id, name) VALUES (${t.tenantId}, 'Draft bot')`;
    expect(points(await health(t.tenantId), "no_published_agent")).toBe(10);
    await b.owner`UPDATE agents SET published_version = 1 WHERE tenant_id = ${t.tenantId}`;
    expect(codes(await health(t.tenantId))).toEqual([]);
    for (let i = 0; i < 3; i++) await b.owner`INSERT INTO contacts (tenant_id, blocked_at, blocked_reason) VALUES (${t.tenantId}, now(), 'abuse')`;
    expect(points(await health(t.tenantId), "abuse_blocks")).toBe(6);
    for (let i = 0; i < 5; i++) await b.owner`INSERT INTO contacts (tenant_id, blocked_at, blocked_reason) VALUES (${t.tenantId}, now(), 'abuse')`;
    expect(points(await health(t.tenantId), "abuse_blocks")).toBe(10);
  });

  test("combined penalties: buckets and reasons sorted by points", async () => {
    const t = await tenant(30);
    await b.owner`UPDATE users SET last_login_at = now() - interval '40 days' WHERE id = ${t.userId}`;
    await b.owner`INSERT INTO billing_customers (tenant_id, customer_id, status) VALUES (${t.tenantId}, ${uniq("cus")}, 'past_due')`;
    await b.owner`INSERT INTO tenant_credits (tenant_id, period, allowance_micro, used_micro) VALUES (${t.tenantId}, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 1000000, 1000000)`;
    await dead(t.tenantId, 4);
    const h = await health(t.tenantId); // 25 + 25 + 15 + 20 = 85 off
    expect(h.score).toBe(15);
    expect(h.bucket).toBe("at_risk");
    const pts = h.reasons.map((r) => r.points);
    expect(pts).toEqual([...pts].sort((x, y) => y - x));
    expect(h.reasons.every((r) => r.label.length > 3)).toBe(true);
    const w = await tenant();
    await b.owner`INSERT INTO billing_customers (tenant_id, customer_id, status) VALUES (${w.tenantId}, ${uniq("cus")}, 'past_due')`;
    expect((await health(w.tenantId)).bucket).toBe("watch"); // 75
  });
});

describe.skipIf(!hasDb)("customers: list, search, filters, sort, pagination", () => {
  let b: AdminBoot, a: TestAdmin;
  const P = uniq("lt");
  const ids = {} as Record<string, string> & { alpha: string; bravo: string; charlie: string; delta: string; echo: string };
  beforeAll(async () => {
    b = await bootAdmin();
    a = await mkAdmin(b, "owner");
    const mk = async (key: string, over: { plan?: string; status?: string; ageDays?: number; tags?: string[]; deadJobs?: number }) => {
      const t = await mkTenant(b, key, over.plan ?? "free");
      await b.owner`UPDATE tenants SET name = ${`${P}-${key}`}, status = ${over.status ?? "active"}, created_at = now() - make_interval(days => ${over.ageDays ?? 1}) WHERE id = ${t.tenantId}`;
      await b.owner`UPDATE users SET last_login_at = now() WHERE id = ${t.userId}`;
      for (const tag of over.tags ?? []) await b.owner`INSERT INTO tenant_tags (tenant_id, tag) VALUES (${t.tenantId}, ${tag})`;
      if (over.deadJobs) await b.owner`INSERT INTO jobs (tenant_id, name, status, attempts, last_error) SELECT ${t.tenantId}, 'x', 'dead', 5, 'boom' FROM generate_series(1, ${over.deadJobs})`;
      ids[key] = t.tenantId;
      return t;
    };
    await mk("alpha", { plan: "pro", ageDays: 10, tags: ["vip", "emea"] });
    const br = await mk("bravo", { plan: "free", ageDays: 8, deadJobs: 4 });
    await b.owner`INSERT INTO billing_customers (tenant_id, customer_id, status) VALUES (${br.tenantId}, ${uniq("cus")}, 'past_due')`; // 20 + 25 => 55: watch
    await mk("charlie", { plan: "pro", status: "suspended", ageDays: 6, tags: ["vip"] });
    await mk("delta", { plan: "enterprise", ageDays: 4 });
    const e = await mk("echo", { plan: "free", ageDays: 2, deadJobs: 12 });
    await b.owner`INSERT INTO tenant_credits (tenant_id, period, allowance_micro, used_micro) VALUES (${e.tenantId}, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 1000000, 1000000)`;
    await b.owner`UPDATE users SET last_login_at = now() - interval '30 days' WHERE id = ${e.userId}`;
    await b.owner`UPDATE tenants SET created_at = now() - interval '40 days' WHERE id = ${e.tenantId}`;
  });
  afterAll(async () => b.close());

  const list = async (qs: string) => jsonOf(await call(b, "GET", `/tenants?q=${P}&${qs}`, a));
  const names = (r: { items: { name: string }[] }) => r.items.map((x) => x.name.replace(`${P}-`, ""));

  test("item shape: owner email, health, credits, tags, error count", async () => {
    const r = await list("sort=name&order=asc");
    expect(names(r)).toEqual(["alpha", "bravo", "charlie", "delta", "echo"]);
    const alpha = r.items[0];
    expect(alpha).toMatchObject({ id: ids.alpha, plan: "pro", status: "active", userCount: 1, tags: ["emea", "vip"], errorCount7d: 0, credits: { state: "ok" }, health: { score: 100, bucket: "healthy", reasons: [] } });
    expect(alpha.ownerEmail).toContain("@customer.example.test");
    expect(typeof alpha.createdAt).toBe("string");
    expect(r.items[4]).toMatchObject({ credits: { state: "exhausted", remainingMicro: 0 }, errorCount7d: 12 });
  });

  test("filters: status, plan, health, tag, hasErrors, credits, dates, inactiveDays, q by id/email", async () => {
    expect(names(await list("status=suspended"))).toEqual(["charlie"]);
    expect(names(await list("plan=pro&sort=name&order=asc"))).toEqual(["alpha", "charlie"]);
    expect(names(await list("health=at_risk"))).toEqual(["echo"]);
    expect(names(await list("health=healthy&sort=name&order=asc"))).toEqual(["alpha", "charlie", "delta"]);
    expect(names(await list("health=watch"))).toEqual(["bravo"]);
    expect(names(await list("tag=vip&sort=name&order=asc"))).toEqual(["alpha", "charlie"]);
    expect(names(await list("tag=emea"))).toEqual(["alpha"]);
    expect(names(await list("hasErrors=true&sort=name&order=asc"))).toEqual(["bravo", "echo"]);
    expect(names(await list("hasErrors=false&sort=name&order=asc"))).toEqual(["alpha", "charlie", "delta"]);
    expect(names(await list("credits=exhausted"))).toEqual(["echo"]);
    expect(names(await list("credits=unlimited"))).toEqual(["delta"]);
    const d = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    expect(names(await list(`createdFrom=${d(7)}&sort=name&order=asc`))).toEqual(["charlie", "delta"]);
    expect(names(await list(`createdTo=${d(9)}&sort=name&order=asc`))).toEqual(["alpha", "echo"]);
    expect(names(await list("inactiveDays=14"))).toEqual(["echo"]);
    // q: tenant id prefix and owner email
    const byId = await jsonOf(await call(b, "GET", `/tenants?q=${ids.delta.slice(0, 13)}`, a));
    expect(byId.items.map((x: { id: string }) => x.id)).toContain(ids.delta);
    const [o] = await b.owner<{ email: string }[]>`SELECT email FROM users WHERE tenant_id = ${ids.bravo}`;
    const byEmail = await jsonOf(await call(b, "GET", `/tenants?q=${encodeURIComponent(o!.email)}`, a));
    expect(byEmail.items.map((x: { id: string }) => x.id)).toEqual([ids.bravo]);
    expect((await jsonOf(await call(b, "GET", `/tenants?q=${encodeURIComponent("%")}`, a))).total).toBe(0); // wildcards are literal
  });

  test("sort by name, health, createdAt, errors, credits; pagination totals stay stable", async () => {
    expect(names(await list("sort=name&order=desc"))).toEqual(["echo", "delta", "charlie", "bravo", "alpha"]);
    expect(names(await list("sort=health&order=asc"))[0]).toBe("echo");
    expect(names(await list("sort=health&order=asc"))[1]).toBe("bravo");
    expect(names(await list("sort=createdAt&order=asc"))[0]).toBe("echo"); // 40 days old
    expect(names(await list("sort=errors&order=desc")).slice(0, 2)).toEqual(["echo", "bravo"]);
    expect(names(await list("sort=credits&order=asc"))[0]).toBe("echo");
    const seen: string[] = [];
    for (const offset of [0, 2, 4]) {
      const page = await list(`sort=name&order=asc&limit=2&offset=${offset}`);
      expect(page.total).toBe(5);
      expect(page).toMatchObject({ limit: 2, offset });
      seen.push(...names(page));
    }
    expect(seen).toEqual(["alpha", "bravo", "charlie", "delta", "echo"]);
    expect((await list("limit=2&offset=10")).items).toEqual([]);
    expect((await list("limit=2&offset=10")).total).toBe(5);
    expect((await list("plan=pro&limit=1")).total).toBe(2);
    for (const bad of ["limit=0", "limit=500", "offset=-1", "sort=password", "order=sideways", "status=nope", "health=great", "createdFrom=yesterday", "tag=Bad Tag", "credits=lots"]) {
      expect([bad, (await call(b, "GET", `/tenants?${bad}`, a)).status]).toEqual([bad, 400]);
    }
  });

  test("CSV export honours the filters, is injection-safe and audited", async () => {
    const r = await call(b, "GET", `/tenants/export?q=${P}&plan=pro&sort=name&order=asc`, a);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/csv");
    expect(r.headers.get("content-disposition")).toContain("customers-");
    const lines = (await r.text()).trim().split("\r\n");
    expect(lines[0]).toBe("id,name,status,plan,createdAt,ownerEmail,userCount,lastActiveAt,healthScore,healthBucket,errorCount7d,creditsState,tags");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(`${P}-alpha`);
    await b.owner`UPDATE tenants SET name = '=HYPERLINK("x")' WHERE id = ${ids.delta}`;
    const evil = await (await call(b, "GET", `/tenants/export?plan=enterprise`, a)).text();
    expect(evil).toContain(`"'=HYPERLINK(""x"")"`);
    await b.owner`UPDATE tenants SET name = ${`${P}-delta`} WHERE id = ${ids.delta}`;
    expect((await b.owner`SELECT 1 FROM platform_audit_logs WHERE admin_id = ${a.id} AND action = 'customers.export'`).length).toBe(2);
  });

  test("search finds customers by name, id, member email and users by email", async () => {
    const [o] = await b.owner<{ email: string; id: string }[]>`SELECT email, id FROM users WHERE tenant_id = ${ids.charlie}`;
    const s = await jsonOf(await call(b, "GET", `/search?q=${encodeURIComponent(o!.email)}`, a));
    expect(s.tenants).toEqual([expect.objectContaining({ id: ids.charlie, matchedOn: "member_email", status: "suspended" })]);
    expect(s.users).toEqual([expect.objectContaining({ id: o!.id, tenantId: ids.charlie, email: o!.email, role: "owner" })]);
    const byName = await jsonOf(await call(b, "GET", `/search?q=${P}-alp`, a));
    expect(byName.tenants.map((t: { id: string }) => t.id)).toEqual([ids.alpha]);
    expect(byName.tenants[0].matchedOn).toBe("name");
    const byId = await jsonOf(await call(b, "GET", `/search?q=${ids.echo.slice(0, 13)}`, a));
    expect(byId.tenants.map((t: { id: string }) => t.id)).toContain(ids.echo);
    expect((await call(b, "GET", "/search?q=a", a)).status).toBe(400);
    expect((await jsonOf(await call(b, "GET", "/search?q=zzzz-no-match-zzzz", a))).tenants).toEqual([]);
  });

  test("needs-attention queue lists active, non-healthy customers worst first; overview carries buckets and series", async () => {
    const r = await jsonOf(await call(b, "GET", "/attention?limit=200", a));
    const mine = r.items.filter((x: { name: string }) => x.name.startsWith(P)).map((x: { name: string }) => x.name.replace(`${P}-`, ""));
    expect(mine).toEqual(["echo", "bravo"]); // suspended charlie is not listed; healthy ones neither
    expect(r.items[0].health.score).toBeLessThanOrEqual(r.items[r.items.length - 1].health.score);
    expect(r.items.find((x: { name: string }) => x.name.endsWith("-echo"))).toMatchObject({ plan: "free", errorCount7d: 12 });
    const o = await jsonOf(await call(b, "GET", "/overview", a));
    expect(o.tenants.total).toBeGreaterThanOrEqual(5);
    expect(o.healthBuckets.at_risk + o.healthBuckets.watch + o.healthBuckets.healthy).toBe(o.tenants.active);
    expect(Array.isArray(o.series.signups)).toBe(true);
    expect(o.attention.length).toBeLessThanOrEqual(10);
    expect(typeof o.mrrCents).toBe("number");
    expect(o.tenants.new30d).toBeGreaterThanOrEqual(4);
  });
});

describe.skipIf(!hasDb)("customer 360: reads, no customer content, read audit", () => {
  let b: AdminBoot, a: TestAdmin;
  let t: Awaited<ReturnType<typeof mkTenant>>;
  const SECRETS = ["PIINAME", "pii-contact@leak.test", "+15550PII", "PIICUSTOM", "PIIMESSAGE", "PIIPAYLOAD", "PIIJOBPAYLOAD", "PIITOOLINPUT", "PIISUMMARY", "PIIREASON", "PIIRAW", "PIINOTIF",
    "CIPHERWEBHOOK", "CIPHERCHANNEL", "CIPHERCRM", "CIPHERTOOL", "CIPHERCAL", "CIPHERTURN", "URLSECRET", "PIILEAD", "PIIBOOKING"];

  beforeAll(async () => {
    b = await bootAdmin();
    a = await mkAdmin(b, "support");
    t = await mkTenant(b, "rich", "pro");
    const tid = t.tenantId, o = b.owner;
    const [ct] = await o<{ id: string }[]>`INSERT INTO contacts (tenant_id, name, email, phone, custom_attributes) VALUES (${tid}, 'PIINAME Customer', 'pii-contact@leak.test', '+15550PII', ${o.json({ k: "PIICUSTOM" })}) RETURNING id`;
    const [cv] = await o<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id, last_message_preview, last_message_at) VALUES (${tid}, ${ct!.id}, 'PIIMESSAGE preview', now()) RETURNING id`;
    await o`INSERT INTO messages (tenant_id, conversation_id, sender_type, content) VALUES (${tid}, ${cv!.id}, 'contact', 'PIIMESSAGE please call me')`;
    await o`INSERT INTO agents (tenant_id, name, status, published_version) VALUES (${tid}, 'Support bot', 'published', 1)`;
    await o`INSERT INTO widgets (tenant_id, name, widget_key, allowed_domains, turnstile_secret_enc) VALUES (${tid}, 'Site widget', ${`wk_${crypto.randomUUID().replace(/-/g, "")}`}, ${["shop.example.test"]}, 'v1.CIPHERTURN')`;
    const [wh] = await o<{ id: string }[]>`INSERT INTO webhooks (tenant_id, name, url, secret_encrypted, events, consecutive_failures, disabled_reason) VALUES (${tid}, 'Orders hook', 'https://hooks.example.test/in?token=URLSECRET', 'v1.CIPHERWEBHOOK', ${["message.created"]}, 3, 'too many failures') RETURNING id`;
    await o`INSERT INTO webhook_deliveries (tenant_id, webhook_id, event_id, event_type, payload, status, attempts, response_status, last_error) VALUES (${tid}, ${wh!.id}, ${crypto.randomUUID()}, 'message.created', ${o.json({ text: "PIIPAYLOAD" })}, 'failed', 5, 500, 'HTTP 500 from endpoint')`;
    await o`INSERT INTO channel_connections (tenant_id, channel, name, credentials_encrypted, status, last_health_ok, last_health_error, last_health_at) VALUES (${tid}, 'telegram', 'Telegram bot', 'v1.CIPHERCHANNEL', 'error', false, 'token revoked by provider', now())`;
    await o`INSERT INTO knowledge_sources (tenant_id, type, name, status, error, raw_text) VALUES (${tid}, 'url', 'Help centre', 'failed', 'blocked by robots.txt', 'PIIRAW'), (${tid}, 'text', 'FAQ', 'ready', NULL, 'PIIRAW')`;
    await o`INSERT INTO notifications (tenant_id, user_id, type, title, body, email_status, email_error) VALUES (${tid}, ${t.userId}, 'handoff', 'PIINOTIF', 'PIINOTIF', 'failed', 'smtp 550 mailbox unavailable')`;
    await o`INSERT INTO crm_connections (tenant_id, provider, token_encrypted, status, last_error) VALUES (${tid}, 'hubspot', 'v1.CIPHERCRM', 'error', 'hubspot token expired')`;
    await o`INSERT INTO crm_sync_log (tenant_id, provider, conversation_id, contact_id, trigger, status, error) VALUES (${tid}, 'hubspot', ${cv!.id}, ${ct!.id}, 'qualified', 'failed', 'hubspot 401 unauthorized')`;
    await o`INSERT INTO tool_connections (tenant_id, name, base_url, auth_type, secret_encrypted) VALUES (${tid}, 'ERP', 'https://erp.example.test/api?key=URLSECRET', 'bearer', 'v1.CIPHERTOOL')`;
    await o`INSERT INTO tool_executions (tenant_id, conversation_id, tool_name, input, output, success, error) VALUES (${tid}, ${cv!.id}, 'lookup_order', ${o.json({ q: "PIITOOLINPUT" })}, ${o.json({ r: "PIILEAD" })}, false, 'timeout after 8s')`;
    await o`INSERT INTO calendar_connections (tenant_id, provider, credentials_encrypted, status, last_error) VALUES (${tid}, 'google', 'v1.CIPHERCAL', 'error', 'invalid_grant')`;
    await o`INSERT INTO handoffs (tenant_id, conversation_id, type, reason, summary) VALUES (${tid}, ${cv!.id}, 'system_failure', 'ai_credits_exhausted', 'PIISUMMARY'), (${tid}, ${cv!.id}, 'uncertainty', 'PIIREASON customer asked about refunds', 'PIISUMMARY'), (${tid}, ${cv!.id}, 'abuse', 'PIIREASON abusive words', 'PIISUMMARY')`;
    await o`INSERT INTO jobs (tenant_id, name, status, attempts, payload, last_error) VALUES (${tid}, 'conversation.reply', 'dead', 5, ${o.json({ text: "PIIJOBPAYLOAD" })}, 'provider returned 500')`;
    await o`INSERT INTO audit_logs (tenant_id, action, resource_type, resource_id, metadata) VALUES (${tid}, 'agent.published', 'agent', 'a1', ${o.json({ note: "PIILEAD" })})`;
    await o`INSERT INTO invitations (tenant_id, email, role, token_hash, expires_at) VALUES (${tid}, 'invitee@customer.example.test', 'agent', ${uniq("h")}, now() + interval '3 days')`;
  });
  afterAll(async () => b.close());

  const GETS = (id: string) => ["", "/users", "/timeline", "/errors", "/assets", "/billing", "/ai-usage", "/usage", "/credits", "/flags", "/notes", "/tags", "/impersonations"].map((p) => `/tenants/${id}${p}`);

  test("no endpoint returns message text, contact PII, secrets or ciphertext", async () => {
    const bodies: string[] = [];
    for (const p of [...GETS(t.tenantId), "/tenants", "/attention", "/overview", `/search?q=${t.name}`, "/ops/dead-jobs", "/ops/failed-webhooks", `/tenants/${t.tenantId}/errors/export`, `/tenants/export`, "/audit-logs", "/audit-logs?limit=200", "/impersonations"]) {
      const r = await call(b, "GET", p, a);
      expect([p, r.status]).toEqual([p, 200]);
      bodies.push(await r.text());
    }
    const all = bodies.join("\n");
    for (const s of SECRETS) expect([s, all.includes(s)]).toEqual([s, false]);
    expect(all).not.toMatch(/v1\.[A-Za-z0-9_-]{4,}/); // no ciphertext envelope anywhere
    // the same holds at the SQL layer
    const raw = JSON.stringify(await b.db`SELECT sa_tenant_assets(${t.tenantId}) AS x`) + JSON.stringify(await b.db`SELECT * FROM sa_tenant_error_rows(${t.tenantId}, 30)`)
      + JSON.stringify(await b.db`SELECT * FROM sa_tenant_timeline(${t.tenantId}, NULL, 100, 0)`) + JSON.stringify(await b.db`SELECT sa_tenant_overview(${t.tenantId}) AS x`);
    for (const s of SECRETS) expect([s, raw.includes(s)]).toEqual([s, false]);
  });

  test("users, assets, billing and timeline", async () => {
    const users = await jsonOf(await call(b, "GET", `/tenants/${t.tenantId}/users`, a));
    expect(users.items).toEqual([expect.objectContaining({ id: t.userId, email: t.email, role: "owner", status: "active", locked: false })]);
    expect(users.invitations).toEqual([expect.objectContaining({ email: "invitee@customer.example.test", role: "agent", status: "pending" })]);
    const assets = await jsonOf(await call(b, "GET", `/tenants/${t.tenantId}/assets`, a));
    expect(assets.agents).toEqual([expect.objectContaining({ name: "Support bot", status: "published", publishedVersion: 1 })]);
    expect(assets.widgets).toEqual([expect.objectContaining({ name: "Site widget", enabled: true, domains: 1 })]);
    expect(assets.channels).toEqual([expect.objectContaining({ channel: "telegram", status: "error", lastHealthOk: false, lastHealthError: "token revoked by provider" })]);
    expect(assets.knowledge.map((k: { name: string; status: string }) => `${k.name}:${k.status}`).sort()).toEqual(["FAQ:ready", "Help centre:failed"]);
    expect(assets.knowledge.find((k: { name: string }) => k.name === "Help centre").error).toBe("blocked by robots.txt");
    expect(assets.connections).toEqual([expect.objectContaining({ name: "ERP", authType: "bearer", host: "erp.example.test" })]);
    expect(assets.webhooks).toEqual([expect.objectContaining({ name: "Orders hook", host: "hooks.example.test", enabled: true, consecutiveFailures: 3, disabledReason: "too many failures" })]);
    expect(assets.calendar).toEqual([{ provider: "google", status: "error", lastError: "invalid_grant" }]);
    expect(assets.crm[0]).toMatchObject({ provider: "hubspot", status: "error", lastError: "hubspot token expired" });
    const billing = await jsonOf(await call(b, "GET", `/tenants/${t.tenantId}/billing`, a));
    expect(billing).toMatchObject({ plan: "pro", subscription: null, events: [], topups: [] });
    const tl = await jsonOf(await call(b, "GET", `/tenants/${t.tenantId}/timeline`, a));
    expect(tl.items.map((x: { action: string }) => x.action)).toEqual(expect.arrayContaining(["agent.published", "handoff.system_failure", "handoff.abuse"]));
    expect(tl.items.find((x: { action: string }) => x.action === "agent.published")).toMatchObject({ source: "tenant_audit", detail: null });
    expect((await jsonOf(await call(b, "GET", `/tenants/${t.tenantId}/timeline?source=handoff`, a))).items.every((x: { source: string }) => x.source === "handoff")).toBe(true);
    expect((await jsonOf(await call(b, "GET", `/tenants/${t.tenantId}/timeline?limit=1`, a))).total).toBeGreaterThan(1);
  });

  test("errors: every kind appears with a hint; kind filter, counts and totals agree", async () => {
    const r = await jsonOf(await call(b, "GET", `/tenants/${t.tenantId}/errors?limit=200`, a));
    const kinds = new Set(r.items.map((x: { kind: string }) => x.kind));
    for (const k of ["job_failed", "webhook_delivery_failed", "channel_error", "knowledge_ingest_failed", "notification_email_failed", "crm_sync_failed", "handoff_system_failure", "abuse_handoff", "tool_failed"]) {
      expect([k, kinds.has(k)]).toEqual([k, true]);
    }
    expect(r.items.every((x: { hint: string }) => x.hint.length > 20)).toBe(true);
    expect(r.total).toBe(r.items.length);
    expect(Object.values(r.counts).reduce((n: number, v) => n + (v as number), 0)).toBe(r.total);
    expect(r.items.find((x: { kind: string }) => x.kind === "job_failed")).toMatchObject({ title: "conversation.reply", detail: "provider returned 500" });
    expect(r.items.find((x: { kind: string }) => x.kind === "handoff_system_failure").detail).toBe("ai_credits_exhausted");
    expect(r.items.find((x: { kind: string }) => x.kind === "abuse_handoff").detail).toBe("");
    const one = await jsonOf(await call(b, "GET", `/tenants/${t.tenantId}/errors?kind=webhook_delivery_failed`, a));
    expect(one.items).toHaveLength(1);
    expect(one).toMatchObject({ total: 1 });
    expect(one.items[0]).toMatchObject({ title: "Orders hook - message.created", detail: "HTTP 500 from endpoint" });
    expect((await call(b, "GET", `/tenants/${t.tenantId}/errors?kind=nope`, a)).status).toBe(400);
    expect((await jsonOf(await call(b, "GET", `/tenants/${t.tenantId}/errors?limit=2&offset=2`, a))).items).toHaveLength(2);
    const csv = await (await call(b, "GET", `/tenants/${t.tenantId}/errors/export?days=30`, a)).text();
    expect(csv.split("\r\n")[0]).toBe("kind,at,refId,title,detail");
    expect(csv).toContain("job_failed");
    // failures older than the window are dropped
    await b.owner`UPDATE jobs SET updated_at = now() - interval '20 days' WHERE tenant_id = ${t.tenantId}`;
    expect((await jsonOf(await call(b, "GET", `/tenants/${t.tenantId}/errors?kind=job_failed&days=7`, a))).total).toBe(0);
    expect((await jsonOf(await call(b, "GET", `/tenants/${t.tenantId}/errors?kind=job_failed&days=30`, a))).total).toBe(1);
  });

  test("detail: counts, limits, credits, health reasons; unknown ids are 404", async () => {
    const d = await jsonOf(await call(b, "GET", `/tenants/${t.tenantId}`, a));
    expect(d.tenant).toMatchObject({ id: t.tenantId, plan: "pro", status: "active", deletedAt: null });
    expect(d.owner).toEqual({ email: t.email, name: "Olive Owner" });
    expect(d.counts).toMatchObject({ users: 1, agents: 1, widgets: 1, channels: 1, contacts: 1, conversations: 1, knowledgeSources: 2 });
    expect(d.limits.find((l: { metric: string }) => l.metric === "seats")).toMatchObject({ limit: 10, used: 2 }); // owner + pending invitation
    expect(d.credits).toMatchObject({ planKey: "pro", status: "ok", unlimited: false });
    expect(d.health.reasons.length).toBeGreaterThan(0);
    expect(d.errorCount7d).toBeGreaterThan(0);
    expect(typeof d.lastActivityAt).toBe("string");
    expect(d.lastActivityAt.endsWith("Z")).toBe(true);
    expect(d).toMatchObject({ notesCount: 0, tags: [], billing: null });
    for (const p of ["", "/users", "/errors", "/assets", "/billing", "/credits", "/flags", "/timeline", "/ai-usage", "/usage", "/notes", "/tags"]) {
      expect([p, (await call(b, "GET", `/tenants/${crypto.randomUUID()}${p}`, a)).status]).toEqual([p, 404]);
      expect([p, (await call(b, "GET", `/tenants/not-a-uuid${p}`, a)).status]).toEqual([p, 404]);
    }
    expect((await call(b, "GET", `/tenants/${t.tenantId}/ai-usage?days=0`, a)).status).toBe(400);
  });

  test("ai usage by day/model/source and totals", async () => {
    const o = b.owner;
    await o`INSERT INTO ai_usage_events (tenant_id, source, model, prompt_tokens, completion_tokens, credits_micro) VALUES
      (${t.tenantId}, 'turn', 'gpt-x', 100, 20, 5000), (${t.tenantId}, 'turn', 'gpt-x', 50, 10, 2500), (${t.tenantId}, 'sandbox', 'gpt-y', 10, 1, 100)`;
    const u = await jsonOf(await call(b, "GET", `/tenants/${t.tenantId}/ai-usage?days=7`, a));
    const x = u.series.find((s: { model: string; source: string }) => s.model === "gpt-x" && s.source === "turn");
    expect(x).toMatchObject({ requests: 2, promptTokens: 150, completionTokens: 30, creditsMicro: 7500 });
    expect(u.totals).toEqual({ requests: 3, promptTokens: 160, completionTokens: 31, creditsMicro: 7600 });
  });

  test("read audit: tenant.view is debounced per admin and tenant; exports are audited", async () => {
    const x = await mkAdmin(b, "support"), y = await mkAdmin(b, "billing");
    const rows = async (admin: string, action: string) => (await b.owner`SELECT 1 FROM platform_audit_logs WHERE admin_id = ${admin} AND action = ${action} AND tenant_id = ${t.tenantId}`).length;
    for (let i = 0; i < 4; i++) await call(b, "GET", `/tenants/${t.tenantId}`, x);
    expect(await rows(x.id, "tenant.view")).toBe(1);
    await call(b, "GET", `/tenants/${t.tenantId}`, y);
    expect(await rows(y.id, "tenant.view")).toBe(1);
    expect(await rows(x.id, "tenant.view")).toBe(1);
    // outside the debounce window a new view is recorded again
    await b.owner`UPDATE platform_audit_logs SET created_at = now() - interval '11 minutes' WHERE admin_id = ${x.id} AND action = 'tenant.view'`;
    await call(b, "GET", `/tenants/${t.tenantId}`, x);
    expect(await rows(x.id, "tenant.view")).toBe(2);
    // other tenants are separate keys; the list itself is not audited per row
    const t2 = await mkTenant(b);
    await call(b, "GET", `/tenants/${t2.tenantId}`, x);
    expect((await b.owner`SELECT 1 FROM platform_audit_logs WHERE admin_id = ${x.id} AND action = 'tenant.view' AND tenant_id = ${t2.tenantId}`).length).toBe(1);
    await call(b, "GET", `/tenants/${t.tenantId}/errors/export`, x);
    await call(b, "GET", `/tenants/${t.tenantId}/errors/export`, x);
    expect((await b.owner`SELECT 1 FROM platform_audit_logs WHERE admin_id = ${x.id} AND action = 'errors.export'`).length).toBe(2); // exports are never debounced
    // the timeline shows the platform-side view with the admin's email
    const tl = await jsonOf(await call(b, "GET", `/tenants/${t.tenantId}/timeline?source=platform_audit`, x));
    expect(tl.items.map((i: { action: string; actor: string }) => i.action)).toContain("errors.export");
  });
});
