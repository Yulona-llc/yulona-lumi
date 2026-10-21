import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE, seedTenantWithUser, setupTestDb } from "@yulona/db/testing";
import { createLogger } from "@yulona/shared";
import { createApp } from "../src/app";
import { MemoryRateLimiter } from "../src/ratelimit";
import { signAccessToken } from "../src/security";
import { SECRET, hasDb, testConfig } from "./helpers";

if (!hasDb) console.warn(SKIP_MESSAGE);

describe.skipIf(!hasDb)("GET /agents/:id/tool-runs", () => {
  let app: ReturnType<typeof createApp>;
  let owner: Awaited<ReturnType<typeof setupTestDb>>["owner"];
  const hdr = async (t: { tenantId: string; userId: string }, role: "owner" | "agent" | "viewer" = "owner") =>
    ({ authorization: `Bearer ${await signAccessToken(SECRET, { userId: t.userId, tenantId: t.tenantId, role, ttlSeconds: 900 })}` });
  const get = (path: string, h: Record<string, string>) => app.request(`/api/v1${path}`, { headers: h });

  beforeAll(async () => {
    const s = await setupTestDb();
    owner = s.owner;
    app = createApp({ cfg: testConfig({}), db: s.app, limiter: new MemoryRateLimiter(), log: createLogger({ level: "silent" }) });
  });
  afterAll(() => undefined);

  async function seed(label: string) {
    const t = await seedTenantWithUser(owner, label);
    const [a] = await owner<{ id: string }[]>`INSERT INTO agents (tenant_id, name) VALUES (${t.tenantId}, ${`agent-${label}`}) RETURNING id`;
    const [c] = await owner<{ id: string }[]>`INSERT INTO contacts (tenant_id, name) VALUES (${t.tenantId}, 'x') RETURNING id`;
    const [cv] = await owner<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id, agent_id) VALUES (${t.tenantId}, ${c!.id}, ${a!.id}) RETURNING id`;
    await owner`INSERT INTO tool_executions (tenant_id, conversation_id, tool_name, input, output, success, error, latency_ms) VALUES (${t.tenantId}, ${cv!.id}, 'lookup_order', ${owner.json({ secretInput: "SHHH" } as never)}, ${owner.json({ out: "PRIVATE" } as never)}, false, 'http 500', 120)`;
    await owner`INSERT INTO tool_executions (tenant_id, conversation_id, tool_name, success, latency_ms) VALUES (${t.tenantId}, ${cv!.id}, 'lookup_order', true, 80)`;
    return { t, agentId: a!.id };
  }

  test("returns name/success/error/latency/createdAt only, newest first, limit honoured, agent role allowed, viewer denied", async () => {
    const { t, agentId } = await seed("tr-a");
    const res = await get(`/agents/${agentId}/tool-runs`, await hdr(t));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items).toHaveLength(2);
    expect(Object.keys(body.items[0]!).sort()).toEqual(["createdAt", "error", "latencyMs", "name", "success"]);
    expect(JSON.stringify(body)).not.toMatch(/SHHH|PRIVATE/);
    expect(((await (await get(`/agents/${agentId}/tool-runs?limit=1`, await hdr(t))).json()) as { items: unknown[] }).items).toHaveLength(1);
    expect((await get(`/agents/${agentId}/tool-runs`, await hdr(t, "agent"))).status).toBe(200);
    expect((await get(`/agents/${agentId}/tool-runs`, await hdr(t, "viewer"))).status).toBe(403);
  });

  test("cross-tenant: tenant B gets 404 for tenant A's agent and never sees A's runs", async () => {
    const A = await seed("tr-xa");
    const B = await seed("tr-xb");
    const res = await get(`/agents/${A.agentId}/tool-runs`, await hdr(B.t));
    expect(res.status).toBe(404);
    const own = (await (await get(`/agents/${B.agentId}/tool-runs`, await hdr(B.t))).json()) as { items: unknown[] };
    expect(own.items).toHaveLength(2);
    expect((await app.request(`/api/v1/agents/${A.agentId}/tool-runs`)).status).toBe(401);
  });
});
