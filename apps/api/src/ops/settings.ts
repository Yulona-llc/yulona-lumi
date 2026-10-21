import { Hono } from "hono";
import { withTenant } from "@yulona/db";
import { opsSettingsUpdateSchema, setAvailabilitySchema } from "@yulona/shared";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { audit } from "../platform/util";
import { guard, type OpsDeps } from "./common";

const DEFAULT_SLA = { urgent: 60, high: 240, normal: 1440, low: 4320 };
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const minutes = (s: string) => (s === "24:00" ? 1440 : Number(s.slice(0, 2)) * 60 + Number(s.slice(3)));
const validTz = (tz: string) => {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
};

export function settingsRoutes({ cfg, db }: OpsDeps) {
  const r = new Hono<AppEnv>();

  const load = (tenantId: string) =>
    withTenant(db, tenantId, async (tx) => {
      const [s] = await tx<{ timezone: string; slaMinutes: typeof DEFAULT_SLA; outOfHoursMode: string; outOfHoursMessage: string | null; assignmentMode: string; holidays: string[] }[]>`
        SELECT timezone, sla_minutes, out_of_hours_mode, out_of_hours_message, assignment_mode,
               COALESCE((SELECT array_agg(to_char(d, 'YYYY-MM-DD') ORDER BY d) FROM unnest(holidays) d), '{}') AS holidays
        FROM ops_settings WHERE tenant_id = ${tenantId}`;
      const hours = await tx<{ weekday: number; startMinute: number; endMinute: number }[]>`
        SELECT weekday, start_minute, end_minute FROM business_hours WHERE tenant_id = ${tenantId} ORDER BY weekday, start_minute`;
      return {
        timezone: s?.timezone ?? "UTC",
        slaMinutes: { ...DEFAULT_SLA, ...(s?.slaMinutes ?? {}) },
        outOfHours: { mode: s?.outOfHoursMode ?? "ai_only", message: s?.outOfHoursMessage ?? null },
        assignment: { mode: s?.assignmentMode ?? "manual" },
        holidays: s?.holidays ?? [],
        businessHours: hours.map((h) => ({ weekday: h.weekday, start: hhmm(h.startMinute), end: hhmm(h.endMinute) })),
      };
    });

  r.get("/ops/settings", guard(cfg, "viewer"), async (c) => c.json(await load(c.get("auth").tenantId)));

  r.put("/ops/settings", guard(cfg, "admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const b = await parseBody(c, opsSettingsUpdateSchema);
    if (b.timezone && !validTz(b.timezone)) throw Errors.validation([{ path: "timezone", message: "Unknown IANA timezone" }]);
    for (const [i, h] of (b.businessHours ?? []).entries()) {
      if (minutes(h.start) >= minutes(h.end)) throw Errors.validation([{ path: `businessHours.${i}`, message: "start must be before end" }]);
    }
    await withTenant(db, tenantId, async (tx) => {
      await tx`INSERT INTO ops_settings (tenant_id) VALUES (${tenantId}) ON CONFLICT (tenant_id) DO NOTHING`;
      if (b.timezone !== undefined) await tx`UPDATE ops_settings SET timezone = ${b.timezone}, updated_at = now() WHERE tenant_id = ${tenantId}`;
      if (b.slaMinutes) await tx`UPDATE ops_settings SET sla_minutes = ${tx.json(b.slaMinutes as never)}, updated_at = now() WHERE tenant_id = ${tenantId}`;
      if (b.outOfHours) {
        await tx`UPDATE ops_settings SET out_of_hours_mode = ${b.outOfHours.mode},
                   out_of_hours_message = ${b.outOfHours.message ?? null}, updated_at = now() WHERE tenant_id = ${tenantId}`;
      }
      if (b.assignment) await tx`UPDATE ops_settings SET assignment_mode = ${b.assignment.mode}, updated_at = now() WHERE tenant_id = ${tenantId}`;
      if (b.holidays) await tx`UPDATE ops_settings SET holidays = ${tx.array([...new Set(b.holidays)])}::date[], updated_at = now() WHERE tenant_id = ${tenantId}`;
      if (b.businessHours) {
        await tx`DELETE FROM business_hours WHERE tenant_id = ${tenantId}`;
        for (const h of b.businessHours) {
          await tx`INSERT INTO business_hours (tenant_id, weekday, start_minute, end_minute) VALUES (${tenantId}, ${h.weekday}, ${minutes(h.start)}, ${minutes(h.end)})`;
        }
      }
      await audit(tx, c, "ops_settings.update", "ops_settings", tenantId, { fields: Object.keys(b) });
    });
    return c.json(await load(tenantId));
  });

  r.get("/business-hours/status", guard(cfg, "viewer"), async (c) => {
    const { tenantId } = c.get("auth");
    const row = await withTenant(db, tenantId, async (tx) => {
      const [x] = await tx<{ open: boolean; timezone: string }[]>`
        SELECT ops_in_business_hours(${tenantId}::uuid, now()) AS open,
               COALESCE((SELECT timezone FROM ops_settings WHERE tenant_id = ${tenantId}), 'UTC') AS timezone`;
      return x!;
    });
    return c.json({ open: row.open, timezone: row.timezone, now: new Date().toISOString() });
  });

  const availItem = (tenantId: string, userId?: string) =>
    withTenant(db, tenantId, (tx) => tx<{ userId: string; name: string; role: string; status: string; updatedAt: Date | null; openConversations: number }[]>`
      SELECT u.id AS user_id, u.name, u.role, COALESCE(a.status, 'offline') AS status, a.updated_at,
             (SELECT count(*)::int FROM conversations c WHERE c.tenant_id = u.tenant_id AND c.assigned_user_id = u.id AND c.status <> 'resolved') AS open_conversations
      FROM users u LEFT JOIN agent_availability a ON a.tenant_id = u.tenant_id AND a.user_id = u.id
      WHERE u.tenant_id = ${tenantId} AND u.status = 'active' AND u.role IN ('owner','admin','agent')
        ${userId ? tx`AND u.id = ${userId}` : tx``}
      ORDER BY u.name, u.id`);
  const dto = (x: Awaited<ReturnType<typeof availItem>>[number]) => ({ ...x, updatedAt: x.updatedAt ? x.updatedAt.toISOString() : null });

  r.get("/availability", guard(cfg, "viewer"), async (c) => c.json({ items: (await availItem(c.get("auth").tenantId)).map(dto) }));

  r.put("/availability/me", guard(cfg, "agent"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const b = await parseBody(c, setAvailabilitySchema);
    await withTenant(db, tenantId, (tx) => tx`
      INSERT INTO agent_availability (tenant_id, user_id, status) VALUES (${tenantId}, ${userId}, ${b.status})
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`);
    const [me] = await availItem(tenantId, userId);
    if (!me) throw Errors.notFound();
    return c.json(dto(me));
  });
  return r;
}
