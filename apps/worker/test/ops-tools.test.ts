import { describe, expect, test } from "bun:test";
import { SKIP_MESSAGE, seedTenantWithUser, setupTestDb, testUrls } from "@yulona/db/testing";
import { sealCalendlyTokens } from "@yulona/ops";
import { buildCalendarExternalTools } from "../src/jobs/ops-tools";

const has = !!testUrls();
if (!has) console.warn(SKIP_MESSAGE);
const KEY = Buffer.alloc(32, 7).toString("base64");

describe.skipIf(!has)("calendar tools resolve the provider per tenant", () => {
  test("Calendly tenant uses Calendly, tenant without a calendar is told so, Google row is skipped when Google is unconfigured", async () => {
    const { owner, app } = await setupTestDb();
    try {
      const calls: string[] = [];
      const fetchImpl = async (url: string) => {
        const u = new URL(url);
        calls.push(u.pathname);
        if (u.pathname === "/event_types/ET1") return Response.json({ resource: { uri: "https://api.calendly.com/event_types/ET1", name: "x", duration: 20, active: true } });
        if (u.pathname === "/event_type_available_times") return Response.json({ collection: [{ status: "available", invitees_remaining: 1, start_time: "2031-03-03T10:00:00Z" }] });
        return new Response("no", { status: 404 });
      };
      const env = { ENCRYPTION_KEY: KEY, CALENDLY_CLIENT_ID: "id", CALENDLY_CLIENT_SECRET: "secret" };
      const tools = buildCalendarExternalTools(app, env, fetchImpl);
      const cal = await seedTenantWithUser(owner, "wcal");
      const none = await seedTenantWithUser(owner, "wnone");
      const g = await seedTenantWithUser(owner, "wgoogle");
      const sealed = sealCalendlyTokens(KEY, cal.tenantId, { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 });
      await owner`INSERT INTO calendar_connections (tenant_id, provider, calendar_id, credentials_encrypted, is_default) VALUES (${cal.tenantId}, 'calendly', 'https://api.calendly.com/event_types/ET1', ${sealed}, true)`;
      await owner`INSERT INTO calendar_connections (tenant_id, provider, calendar_id, credentials_encrypted, is_default) VALUES (${g.tenantId}, 'google', 'primary', 'v1.x.y', true)`;
      const [ct] = await owner<{ id: string }[]>`INSERT INTO contacts (tenant_id, name) VALUES (${cal.tenantId}, 'C') RETURNING id`;
      const [cv] = await owner<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id, status, handler) VALUES (${cal.tenantId}, ${ct!.id}, 'open', 'ai') RETURNING id`;

      // the mock Calendly host is api.calendly.com (default apiBase), reached through the injected fetch
      const r = await tools.execute({ tenantId: cal.tenantId, conversationId: cv!.id }, "check_availability", { from: "2031-03-03T09:00:00Z", to: "2031-03-03T12:00:00Z" });
      expect(r.kind).toBe("ok");
      expect((r.output as any).slots).toEqual([{ start: "2031-03-03T10:00:00.000Z", end: "2031-03-03T10:20:00.000Z" }]);
      expect(calls).toContain("/event_type_available_times");

      const n = await tools.execute({ tenantId: none.tenantId, conversationId: crypto.randomUUID() }, "check_availability", {});
      expect(n).toMatchObject({ kind: "rejected", error: "calendar_not_connected" });
      const gg = await tools.execute({ tenantId: g.tenantId, conversationId: crypto.randomUUID() }, "check_availability", {});
      expect(gg).toMatchObject({ kind: "rejected", error: "calendar_not_connected" });
      // tenant isolation: the Calendly tenant's connection is not visible to the others (RLS), proven above
    } finally {
      await app.end({ timeout: 2 });
      await owner.end({ timeout: 2 });
    }
  });
});
