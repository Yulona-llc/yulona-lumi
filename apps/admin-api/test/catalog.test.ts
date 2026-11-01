// Provider profiles, model rates, credit packs and plan limits (moved from the customer API's credits tests).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE } from "@yulona/db/testing";
import { bootAdmin, call, hasDb, jsonOf, mkAdmin, mkTenant, type AdminBoot, type TestAdmin } from "./support";

if (!hasDb) console.warn(SKIP_MESSAGE);

describe.skipIf(!hasDb)("platform catalogue", () => {
  let b: AdminBoot, sh: AdminBoot, owner: TestAdmin, billing: TestAdmin, support: TestAdmin, shOwner: TestAdmin;
  beforeAll(async () => {
    b = await bootAdmin();
    sh = await bootAdmin({ env: { DEPLOYMENT_MODE: "selfhosted" } });
    owner = await mkAdmin(b, "owner"); billing = await mkAdmin(b, "billing"); support = await mkAdmin(b, "support");
    shOwner = await mkAdmin(sh, "owner");
  });
  afterAll(async () => { await b.close(); await sh.close(); });

  const audit = async (action: string) => b.owner<{ metadata: Record<string, any> }[]>`SELECT metadata FROM platform_audit_logs WHERE action = ${action} ORDER BY created_at DESC`; // eslint-disable-line @typescript-eslint/no-explicit-any

  test("provider profiles: owner-only writes, SSRF on URLs, key is write-only and encrypted, default switching, audit", async () => {
    const mk = (over: Record<string, unknown> = {}) => ({ name: "P-" + crypto.randomUUID().slice(0, 6), baseUrl: "https://93.184.216.34/v1", defaultModel: "m-default", apiKey: "sk-live-very-secret-1234567890", ...over });
    for (const who of [billing, support]) expect((await call(b, "POST", "/llm-profiles", who, mk())).status).toBe(403);
    expect((await call(b, "GET", "/llm-profiles", support)).status).toBe(200); // everyone can read
    for (const baseUrl of ["http://93.184.216.34/v1", "https://localhost/v1", "https://127.0.0.1/v1", "https://10.0.0.5/v1", "https://169.254.169.254/latest", "https://[::1]/v1", "https://192.168.1.1/", "ftp://example.com", "https://user:pw@93.184.216.34/", "https://93.184.216.34/v1?x=1", "not a url"]) {
      const r = await call(b, "POST", "/llm-profiles", owner, mk({ baseUrl }));
      expect([baseUrl, r.status]).toEqual([baseUrl, 400]);
    }
    expect((await call(b, "POST", "/llm-profiles", owner, mk({ extra: 1 }))).status).toBe(400);
    expect((await call(b, "POST", "/llm-profiles", owner, mk({ authScheme: "digest" }))).status).toBe(400);
    expect((await call(b, "POST", "/llm-profiles", owner, mk({ extraHeaders: { Host: "evil" } }))).status).toBe(400);
    expect((await call(b, "POST", "/llm-profiles", owner, mk({ chatPath: "/../x" }))).status).toBe(400);

    const p1 = mk({ authHeader: "api-key", authScheme: "raw", extraHeaders: { "x-org": "acme" }, queryParams: { "api-version": "2024-06-01" }, chatPath: "/deployments/a/chat/completions", enabledModels: ["m1", "m2"], isDefault: true });
    const r1 = await call(b, "POST", "/llm-profiles", owner, p1);
    expect(r1.status).toBe(201);
    const raw1 = await r1.text();
    expect(raw1).not.toContain("sk-live");
    const c1 = JSON.parse(raw1);
    expect(c1).toMatchObject({ name: p1.name, authHeader: "api-key", authScheme: "raw", extraHeaders: { "x-org": "acme" }, queryParams: { "api-version": "2024-06-01" }, enabledModels: ["m1", "m2"], isDefault: true, enabled: true, hasCredentials: true });
    expect(Object.keys(c1)).not.toContain("apiKey");
    const [stored] = await b.owner<{ credentials_encrypted: string }[]>`SELECT credentials_encrypted FROM llm_provider_profiles WHERE id = ${c1.id}`;
    expect(stored!.credentials_encrypted.startsWith("v1.")).toBe(true);
    expect(stored!.credentials_encrypted).not.toContain("sk-live");
    expect((await call(b, "POST", "/llm-profiles", owner, { ...p1, baseUrl: "https://93.184.216.35/v1" })).status).toBe(409); // duplicate name
    expect(JSON.stringify(await jsonOf(await call(b, "GET", "/llm-profiles", support)))).not.toContain("sk-live");
    expect(JSON.stringify(await jsonOf(await call(b, "GET", `/llm-profiles/${c1.id}`, support)))).not.toContain("credentials");

    const c2 = await jsonOf(await call(b, "POST", "/llm-profiles", owner, mk({ isDefault: true })));
    const list = await jsonOf(await call(b, "GET", "/llm-profiles", owner));
    expect(list.items.filter((x: any) => x.isDefault).map((x: any) => x.id)).toEqual([c2.id]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(await jsonOf(await call(b, "PATCH", `/llm-profiles/${c1.id}`, owner, { defaultModel: "m9", apiKey: null, isDefault: true }))).toMatchObject({ defaultModel: "m9", hasCredentials: false, isDefault: true });
    expect((await jsonOf(await call(b, "GET", `/llm-profiles/${c2.id}`, owner))).isDefault).toBe(false);
    expect((await call(b, "PATCH", `/llm-profiles/${c1.id}`, owner, { baseUrl: "https://10.1.1.1/v1" })).status).toBe(400);
    expect((await call(b, "PATCH", `/llm-profiles/${c1.id}`, owner, {})).status).toBe(400);
    expect((await call(b, "PATCH", `/llm-profiles/${crypto.randomUUID()}`, owner, { name: "zz" })).status).toBe(404);
    expect((await jsonOf(await call(b, "PATCH", `/llm-profiles/${c1.id}`, owner, { apiKey: "sk-new-key-abcdefgh" }))).hasCredentials).toBe(true);
    expect((await jsonOf(await call(b, "PATCH", `/llm-profiles/${c1.id}`, owner, { enabled: false }))).isDefault).toBe(false);
    expect((await call(b, "DELETE", `/llm-profiles/${c2.id}`, owner)).status).toBe(200);
    expect((await call(b, "DELETE", `/llm-profiles/${c2.id}`, owner)).status).toBe(404);
    expect((await call(b, "DELETE", `/llm-profiles/${c1.id}`, owner)).status).toBe(200);
    const created = await audit("llm_profile.create");
    expect(created.length).toBeGreaterThanOrEqual(2);
    const all = JSON.stringify([...created, ...(await audit("llm_profile.update")), ...(await audit("llm_profile.delete"))]);
    expect(all).not.toContain("sk-live");
    expect(all).not.toContain("sk-new-key");
    expect((await audit("llm_profile.update")).some((a) => a.metadata.credentialsChanged === true)).toBe(true);
  });

  test("a profile with a key needs ENCRYPTION_KEY (503)", async () => {
    const nb = await bootAdmin({ patch: (c) => { c.encryptionKey = undefined; } });
    try {
      const o = await mkAdmin(nb, "owner");
      const body = { baseUrl: "https://93.184.216.34/v1", defaultModel: "m" };
      expect((await call(nb, "POST", "/llm-profiles", o, { name: "nokey-" + crypto.randomUUID().slice(0, 6), ...body, apiKey: "sk-x" })).status).toBe(503);
      expect((await call(nb, "POST", "/llm-profiles", o, { name: "nokey2-" + crypto.randomUUID().slice(0, 6), ...body })).status).toBe(201);
    } finally { await nb.close(); }
  });

  test("profile test: real HTTP round trip (self-hosted allows private hosts), never leaks the key", async () => {
    const seen: { headers: Headers; path: string; search: string; body: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let mode: "ok" | "fail" = "ok";
    const fake = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        seen.push({ headers: req.headers, path: u.pathname, search: u.search, body: await req.json() });
        if (mode === "fail") return new Response("invalid api key sk-test-ABCDEFGH12345678 and Bearer sk-test-ABCDEFGH12345678", { status: 401 });
        return Response.json({ model: "upstream-model", choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
      },
    });
    try {
      const create = await call(sh, "POST", "/llm-profiles", shOwner, {
        name: "local-" + crypto.randomUUID().slice(0, 6), baseUrl: `http://localhost:${fake.port}/v1`, defaultModel: "local-m", apiKey: "sk-test-ABCDEFGH12345678",
        authHeader: "api-key", authScheme: "raw", extraHeaders: { "x-org": "acme" }, queryParams: { "api-version": "2024-06-01" },
      });
      expect(create.status).toBe(201);
      const id = (await jsonOf(create)).id;
      const ok = await jsonOf(await call(sh, "POST", `/llm-profiles/${id}/test`, shOwner, {}));
      expect(ok).toMatchObject({ ok: true, model: "upstream-model", error: null });
      expect(typeof ok.latencyMs).toBe("number");
      expect(seen[0]).toMatchObject({ path: "/v1/chat/completions", search: "?api-version=2024-06-01" });
      expect(seen[0]!.headers.get("api-key")).toBe("sk-test-ABCDEFGH12345678");
      expect(seen[0]!.headers.get("x-org")).toBe("acme");
      expect(seen[0]!.body.model).toBe("local-m");
      await call(sh, "POST", `/llm-profiles/${id}/test`, shOwner, { model: "other" });
      expect(seen[1]!.body.model).toBe("other");
      mode = "fail";
      const bad = await call(sh, "POST", `/llm-profiles/${id}/test`, shOwner, {});
      const badBody = await bad.text();
      expect(bad.status).toBe(200);
      expect(JSON.parse(badBody)).toMatchObject({ ok: false });
      expect(badBody).toContain("401");
      expect(badBody).not.toContain("sk-test-ABCDEFGH12345678");
      expect((await call(sh, "POST", `/llm-profiles/${crypto.randomUUID()}/test`, shOwner, {})).status).toBe(404);
      expect((await call(b, "POST", `/llm-profiles/${id}/test`, billing, {})).status).toBe(403);
    } finally { fake.stop(true); }
  });

  test("model rates: billing and owner write, support reads; protected default; audited", async () => {
    const model = "test-model-" + crypto.randomUUID().slice(0, 6);
    const list0 = await jsonOf(await call(b, "GET", "/model-rates", support));
    expect(list0.items[0]).toMatchObject({ model: "*", inputMicroPer1k: 250000, outputMicroPer1k: 1000000, enabled: true });
    expect((await call(b, "PUT", "/model-rates", support, { model, inputMicroPer1k: 1, outputMicroPer1k: 1 })).status).toBe(403);
    for (const bad of [{ model, inputMicroPer1k: -1, outputMicroPer1k: 1 }, { model, inputMicroPer1k: 1.5, outputMicroPer1k: 1 }, { model: "bad model!", inputMicroPer1k: 1, outputMicroPer1k: 1 }, { model, inputMicroPer1k: 1, outputMicroPer1k: 1, x: 1 }]) {
      expect((await call(b, "PUT", "/model-rates", billing, bad)).status).toBe(400);
    }
    expect((await call(b, "PUT", "/model-rates", billing, { model, inputMicroPer1k: 3000, outputMicroPer1k: 9000 })).status).toBe(200);
    expect((await call(b, "PUT", "/model-rates", owner, { model, inputMicroPer1k: 4000, outputMicroPer1k: 9000, enabled: false })).status).toBe(200);
    const list = await jsonOf(await call(b, "GET", "/model-rates", billing));
    expect(list.items.find((x: any) => x.model === model)).toMatchObject({ inputMicroPer1k: 4000, outputMicroPer1k: 9000, enabled: false }); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await call(b, "DELETE", "/model-rates?model=*", billing)).status).toBe(400);
    expect((await call(b, "DELETE", `/model-rates?model=${model}`, billing)).status).toBe(200);
    expect((await call(b, "DELETE", `/model-rates?model=${model}`, billing)).status).toBe(404);
    expect((await call(b, "DELETE", "/model-rates", billing)).status).toBe(400);
    expect((await audit("model_rate.set")).some((a) => a.metadata.model === model)).toBe(true);
    expect((await audit("model_rate.delete")).some((a) => a.metadata.model === model)).toBe(true);
  });

  test("plan limits: billing and owner set them (null = unlimited); audited; support cannot", async () => {
    expect((await call(b, "PUT", "/plans/free/limits/seats", support, { limit: 3 })).status).toBe(403);
    expect((await call(b, "PUT", "/plans/free/limits/seats", billing, { limit: 3 })).status).toBe(200);
    expect((await jsonOf(await call(b, "GET", "/plans", support))).items.find((p: { key: string }) => p.key === "free").limits.seats).toBe(3);
    expect((await call(b, "PUT", "/plans/free/limits/seats", owner, { limit: 2 })).status).toBe(200);
    expect((await call(b, "PUT", "/plans/free/limits/seats", owner, { limit: -1 })).status).toBe(400);
    expect((await call(b, "PUT", "/plans/free/limits/nonsense", owner, { limit: 1 })).status).toBe(404);
    expect((await call(b, "PUT", "/plans/nope_plan/limits/seats", owner, { limit: 1 })).status).toBe(404);
    expect((await call(b, "PUT", "/plans/free/limits/llm_credits_monthly", owner, { limit: 50 })).status).toBe(200);
    expect((await audit("plan.limit")).some((a) => a.metadata.metric === "llm_credits_monthly")).toBe(true);
    // Ask Lumi copilot allowance is editable like the other limits (0 locks it, null = unlimited)
    expect((await call(b, "PUT", "/plans/pro/limits/copilot_credits_monthly", owner, { limit: 200 })).status).toBe(200);
    expect((await jsonOf(await call(b, "GET", "/plans", support))).items.find((p: { key: string }) => p.key === "pro").limits.copilot_credits_monthly).toBe(200);
    expect((await call(b, "PUT", "/plans/pro/limits/copilot_credits_monthly", owner, { limit: 150 })).status).toBe(200);
    expect((await audit("plan.limit")).some((a) => a.metadata.metric === "copilot_credits_monthly")).toBe(true);
  });

  test("credit packs: validation, update, delete vs deactivate-when-purchased", async () => {
    const mkPack = { name: "Promo " + crypto.randomUUID().slice(0, 4), credits: 100, priceCents: 500 };
    expect((await call(b, "POST", "/credit-packs", support, mkPack)).status).toBe(403);
    for (const bad of [{ ...mkPack, credits: 0 }, { ...mkPack, credits: 1.5 }, { ...mkPack, priceCents: -1 }, { ...mkPack, name: "" }, { ...mkPack, x: 1 }]) {
      expect((await call(b, "POST", "/credit-packs", billing, bad)).status).toBe(400);
    }
    const created = await jsonOf(await call(b, "POST", "/credit-packs", billing, mkPack));
    expect(created).toMatchObject({ ...mkPack, active: true, currency: "usd" });
    expect(await jsonOf(await call(b, "PATCH", `/credit-packs/${created.id}`, owner, { credits: 150, active: false }))).toMatchObject({ credits: 150, priceCents: 500, active: false });
    expect((await jsonOf(await call(b, "GET", "/credit-packs", support))).items.some((p: any) => p.id === created.id)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await call(b, "PATCH", `/credit-packs/${crypto.randomUUID()}`, billing, { name: "x" })).status).toBe(404);
    expect(await jsonOf(await call(b, "DELETE", `/credit-packs/${created.id}`, billing))).toMatchObject({ ok: true, result: "deleted" });
    const kept = await jsonOf(await call(b, "POST", "/credit-packs", billing, { ...mkPack, name: mkPack.name + "b" }));
    const t = await mkTenant(b);
    await b.owner`INSERT INTO credit_topups (ref, tenant_id, pack_id, credits_micro) VALUES (${"cs_" + crypto.randomUUID()}, ${t.tenantId}, ${kept.id}, 1000000)`;
    expect(await jsonOf(await call(b, "DELETE", `/credit-packs/${kept.id}`, billing))).toMatchObject({ result: "deactivated" });
    expect((await call(b, "DELETE", `/credit-packs/${crypto.randomUUID()}`, billing)).status).toBe(404);
    expect((await audit("credit_pack.upsert")).length).toBeGreaterThanOrEqual(2);
  });
});
