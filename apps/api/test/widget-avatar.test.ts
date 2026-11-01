import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE, seedTenantWithUser, setupTestDb } from "@yulona/db/testing";
import { createLogger } from "@yulona/shared";
import { createApp } from "../src/app";
import { createRealtime } from "../src/realtime/service";
import { signAccessToken } from "../src/security";
import { MemoryRateLimiter } from "../src/ratelimit";
import { SECRET, hasDb, testConfig } from "./helpers";

if (!hasDb) console.warn(SKIP_MESSAGE);

const ORIGIN = "https://site.test";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);
const WEBP = new Uint8Array([...new TextEncoder().encode("RIFF"), 4, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 ")]);
type Tenant = { tenantId: string; userId: string; h: Record<string, string> };

describe.skipIf(!hasDb)("widget avatar upload and public route", () => {
  let app: ReturnType<typeof createApp>;
  let owner: Awaited<ReturnType<typeof setupTestDb>>["owner"];
  let db: Awaited<ReturnType<typeof setupTestDb>>["app"];
  let rt: ReturnType<typeof createRealtime>;
  let limiter: MemoryRateLimiter;
  let A: Tenant, B: Tenant;
  let widget: { id: string; widgetKey: string };
  let scanner: ReturnType<typeof Bun.serve>;
  let infected = false;
  const prevClam = process.env.CLAMAV_URL;

  const userOf = async (t: Tenant, role: "admin" | "agent" | "viewer"): Promise<Tenant> => {
    const [u] = await owner<{ id: string }[]>`
      INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (${t.tenantId}, ${`${role}-${crypto.randomUUID()}@example.test`}, ${role}, ${role}, 'x') RETURNING id`;
    const token = await signAccessToken(SECRET, { userId: u!.id, tenantId: t.tenantId, role, ttlSeconds: 900 });
    return { tenantId: t.tenantId, userId: u!.id, h: { authorization: `Bearer ${token}` } };
  };
  const mkTenant = async (label: string): Promise<Tenant> => {
    const t = await seedTenantWithUser(owner, label);
    await owner`UPDATE tenants SET plan_key = 'enterprise' WHERE id = ${t.tenantId}`;
    const token = await signAccessToken(SECRET, { userId: t.userId, tenantId: t.tenantId, role: "owner", ttlSeconds: 900 });
    return { ...t, h: { authorization: `Bearer ${token}` } };
  };
  const send = (method: string, path: string, h: Record<string, string>, body?: unknown) =>
    app.request(`/api/v1${path}`, { method, headers: { ...h, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const upload = (id: string, h: Record<string, string>, bytes: Uint8Array | string, type = "image/png", name = "a.png") => {
    const fd = new FormData();
    fd.set("file", new File([bytes as BlobPart], name, { type }));
    return app.request(`/api/v1/widgets/${id}/avatar`, { method: "POST", headers: h, body: fd });
  };
  const avatar = (key: string, h: Record<string, string> = {}) => app.request(`/api/v1/public/widgets/${key}/avatar`, { headers: h });

  beforeAll(async () => {
    scanner = Bun.serve({
      port: 0,
      fetch: () => Response.json({ success: true, data: { result: [{ is_infected: infected }] } }, { status: infected ? 406 : 200 }),
    });
    process.env.CLAMAV_URL = `http://localhost:${scanner.port}`;
    const s = await setupTestDb();
    owner = s.owner; db = s.app;
    limiter = new MemoryRateLimiter();
    const cfg = testConfig({}, (c) => { c.rateLimits.global = { limit: 1e6, windowMs: 60_000 }; });
    const log = createLogger({ level: "silent" });
    rt = createRealtime({ db, log });
    app = createApp({ cfg, db, limiter, log, realtime: rt });
    A = await mkTenant("A");
    B = await mkTenant("B");
    const res = await send("POST", "/widgets", A.h, { name: "Main", allowedDomains: [ORIGIN] });
    expect(res.status).toBe(201);
    widget = await res.json();
  });
  afterAll(async () => {
    scanner?.stop(true);
    if (prevClam === undefined) delete process.env.CLAMAV_URL; else process.env.CLAMAV_URL = prevClam;
    await rt?.stop();
    limiter?.close();
    await db?.end({ timeout: 2 });
    await owner?.end({ timeout: 2 });
  });

  test("validation: type, magic bytes, size, SVG, unknown fields, infected", async () => {
    expect((await upload(widget.id, A.h, "<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml", "a.svg")).status).toBe(400);
    // a claimed image type with the wrong bytes is refused
    expect((await upload(widget.id, A.h, "GIF89a not really", "image/png", "a.png")).status).toBe(400);
    expect((await upload(widget.id, A.h, "<script>alert(1)</script>", "image/png", "a.png")).status).toBe(400);
    const big = new Uint8Array(512 * 1024 + 1); big.set(PNG);
    expect((await upload(widget.id, A.h, big)).status).toBe(413);
    const fd = new FormData(); fd.set("file", new File([PNG as BlobPart], "a.png")); fd.set("extra", "x");
    expect((await app.request(`/api/v1/widgets/${widget.id}/avatar`, { method: "POST", headers: A.h, body: fd })).status).toBe(400);
    expect((await app.request(`/api/v1/widgets/${widget.id}/avatar`, { method: "POST", headers: { ...A.h, "content-type": "application/json" }, body: "{}" })).status).toBe(415);
    infected = true;
    expect((await upload(widget.id, A.h, PNG)).status).toBe(400);
    infected = false;
    const dto = await (await send("GET", `/widgets/${widget.id}`, A.h)).json() as { hasAvatar: boolean };
    expect(dto.hasAvatar).toBe(false);
  });

  test("upload, serve with cache headers, ETag 304, origin policy, replace, remove", async () => {
    for (const [bytes, type] of [[PNG, "image/png"], [JPEG, "image/jpeg"], [WEBP, "image/webp"]] as const) {
      const r = await upload(widget.id, A.h, bytes, "application/octet-stream", "x.bin");
      expect(r.status).toBe(200);
      const dto = await r.json() as { hasAvatar: boolean; avatarVersion: string };
      expect(dto.hasAvatar).toBe(true);
      const g = await avatar(widget.widgetKey, { origin: ORIGIN });
      expect(g.status).toBe(200);
      expect(g.headers.get("content-type")).toBe(type);
      expect(g.headers.get("x-content-type-options")).toBe("nosniff");
      expect(g.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
      expect(g.headers.get("cache-control")).toContain("max-age");
      expect(g.headers.get("etag")).toBe(`"${dto.avatarVersion}"`);
      expect(new Uint8Array(await g.arrayBuffer())).toEqual(bytes);
    }
    const etag = (await avatar(widget.widgetKey)).headers.get("etag")!;
    expect((await avatar(widget.widgetKey, { "if-none-match": etag })).status).toBe(304);
    expect((await avatar(widget.widgetKey, { origin: "https://evil.test" })).status).toBe(403);
    expect((await avatar(widget.widgetKey, { referer: "https://evil.test/page" })).status).toBe(403);
    expect((await avatar(widget.widgetKey, { referer: `${ORIGIN}/page` })).status).toBe(200);
    expect((await avatar("wk_unknownunknownunknown")).status).toBe(404);
    expect((await avatar("bad")).status).toBe(404);
    // the public config advertises the uploaded image
    const cfgRes = await app.request("/api/v1/public/widget/config", { headers: { "x-widget-key": widget.widgetKey, origin: ORIGIN } });
    const cfg = await cfgRes.json() as { config: { avatarUrl: string } };
    expect(cfg.config.avatarUrl).toContain(`/public/widgets/${widget.widgetKey}/avatar?v=`);
    // disabled widgets serve nothing
    await send("PATCH", `/widgets/${widget.id}`, A.h, { enabled: false });
    expect((await avatar(widget.widgetKey)).status).toBe(404);
    await send("PATCH", `/widgets/${widget.id}`, A.h, { enabled: true });
    const del = await send("DELETE", `/widgets/${widget.id}/avatar`, A.h);
    expect(del.status).toBe(200);
    expect((await del.json() as { hasAvatar: boolean }).hasAvatar).toBe(false);
    expect((await avatar(widget.widgetKey)).status).toBe(404);
    const actions = await owner<{ action: string }[]>`SELECT action FROM audit_logs WHERE tenant_id = ${A.tenantId} AND action LIKE 'widget.avatar.%'`;
    expect(actions.map((a) => a.action)).toContain("widget.avatar.upload");
    expect(actions.map((a) => a.action)).toContain("widget.avatar.remove");
  });

  test("roles and tenants", async () => {
    const agent = await userOf(A, "agent");
    const viewer = await userOf(A, "viewer");
    const admin = await userOf(A, "admin");
    expect((await upload(widget.id, agent.h, PNG)).status).toBe(403);
    expect((await upload(widget.id, viewer.h, PNG)).status).toBe(403);
    expect((await send("DELETE", `/widgets/${widget.id}/avatar`, agent.h)).status).toBe(403);
    expect((await upload(widget.id, admin.h, PNG)).status).toBe(200);
    // another tenant cannot touch it, and the bytes are invisible to its RLS scope
    expect((await upload(widget.id, B.h, PNG)).status).toBe(404);
    expect((await send("DELETE", `/widgets/${widget.id}/avatar`, B.h)).status).toBe(404);
    expect((await app.request(`/api/v1/widgets/${widget.id}/avatar`, { method: "POST", body: new FormData() })).status).toBe(401);
    const seen = await db.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${B.tenantId}, true)`;
      return tx`SELECT 1 FROM widget_avatars`;
    });
    expect(seen.length).toBe(0);
  });

  test("appearance: stored, primaryColor derived, old config still valid", async () => {
    const r = await send("PATCH", `/widgets/${widget.id}`, A.h, { config: { primaryColor: "#111111", appearance: { mode: "gradient", color: "#f97316", color2: "#ec4899", angle: 135 } } });
    expect(r.status).toBe(200);
    const dto = await r.json() as { config: { primaryColor: string; appearance: { mode: string } } };
    expect(dto.config.primaryColor).toBe("#f97316");
    expect(dto.config.appearance.mode).toBe("gradient");
    expect((await send("PATCH", `/widgets/${widget.id}`, A.h, { config: { appearance: { mode: "gradient", color: "red" } } })).status).toBe(400);
    await owner`UPDATE widgets SET config = '{"primaryColor":"#123456","title":"Old"}'::jsonb WHERE id = ${widget.id}`;
    const old = await (await send("GET", `/widgets/${widget.id}`, A.h)).json() as { config: { primaryColor: string } };
    expect(old.config.primaryColor).toBe("#123456");
  });

  test("GET /models lists enabled models in SaaS and nothing for self-hosted", async () => {
    await owner`INSERT INTO llm_model_rates (model, input_micro_per_1k, output_micro_per_1k, enabled) VALUES ('wj-on', 1, 1, true), ('wj-off', 1, 1, false) ON CONFLICT (model) DO UPDATE SET enabled = EXCLUDED.enabled`;
    const r = await send("GET", "/models", A.h);
    const j = await r.json() as { mode: string; models: string[] };
    expect(j.mode).toBe("saas");
    expect(j.models).toContain("wj-on");
    expect(j.models).not.toContain("wj-off");
    expect(j.models).not.toContain("*");
    await owner`DELETE FROM llm_model_rates WHERE model IN ('wj-on','wj-off')`;
    expect((await app.request("/api/v1/models")).status).toBe(401);
  });
});
