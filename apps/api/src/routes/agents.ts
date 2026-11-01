import { Hono } from "hono";
import { z } from "zod";
import { TenantRepository, withTenant, type Db, type Tx } from "@yulona/db";
import { agentConfigSchema, type AgentConfig } from "@yulona/shared";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import { parseBody } from "../http";
import { requireAuth } from "../middleware";
import { requireMinRole } from "../platform/authz";
import { assertWithinLimit } from "../platform/limits";
import { audit, parseId } from "../platform/util";

interface AgentRow {
  id: string; name: string; description: string; status: "draft" | "published" | "archived";
  config: AgentConfig; publishedVersion: number | null; createdAt: Date; updatedAt: Date;
}
const dto = (a: AgentRow) => ({
  id: a.id, name: a.name, description: a.description, status: a.status, config: a.config,
  publishedVersion: a.publishedVersion, createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString(),
});
const COLS = (tx: Tx) => tx`id, name, description, status, config, published_version, created_at, updated_at`;

export class AgentsRepository extends TenantRepository {
  list() {
    return this.tx<AgentRow[]>`SELECT ${COLS(this.tx)} FROM agents WHERE tenant_id = ${this.tenantId} ORDER BY created_at DESC`;
  }
  async get(id: string, lock = false) {
    const [r] = lock
      ? await this.tx<AgentRow[]>`SELECT ${COLS(this.tx)} FROM agents WHERE tenant_id = ${this.tenantId} AND id = ${id} FOR UPDATE`
      : await this.tx<AgentRow[]>`SELECT ${COLS(this.tx)} FROM agents WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
    return r;
  }
  async create(i: { name: string; description: string; config: AgentConfig; by: string }) {
    const [r] = await this.tx<AgentRow[]>`
      INSERT INTO agents (tenant_id, name, description, config, created_by)
      VALUES (${this.tenantId}, ${i.name}, ${i.description}, ${this.tx.json(i.config as never)}, ${i.by})
      RETURNING ${COLS(this.tx)}`;
    return r!;
  }
  async update(id: string, p: { name?: string; description?: string; config?: AgentConfig }) {
    const [r] = await this.tx<AgentRow[]>`
      UPDATE agents SET name = COALESCE(${p.name ?? null}, name), description = COALESCE(${p.description ?? null}, description),
        config = COALESCE(${p.config ? this.tx.json(p.config as never) : null}, config), updated_at = now()
      WHERE tenant_id = ${this.tenantId} AND id = ${id} RETURNING ${COLS(this.tx)}`;
    return r;
  }
  /** Snapshot `config` as the next version and mark the agent published. Caller must hold the row lock. */
  async publish(id: string, config: AgentConfig, note: string, by: string) {
    const [v] = await this.tx<{ version: number }[]>`
      SELECT COALESCE(max(version), 0) + 1 AS version FROM agent_versions WHERE tenant_id = ${this.tenantId} AND agent_id = ${id}`;
    const version = Number(v!.version);
    await this.tx`INSERT INTO agent_versions (tenant_id, agent_id, version, config, note, created_by)
      VALUES (${this.tenantId}, ${id}, ${version}, ${this.tx.json(config as never)}, ${note}, ${by})`;
    const [a] = await this.tx<AgentRow[]>`
      UPDATE agents SET status = 'published', published_version = ${version}, config = ${this.tx.json(config as never)}, updated_at = now()
      WHERE tenant_id = ${this.tenantId} AND id = ${id} RETURNING ${COLS(this.tx)}`;
    return { agent: a!, version };
  }
  versions(id: string) {
    return this.tx<{ version: number; note: string; createdBy: string | null; createdAt: Date }[]>`
      SELECT version, note, created_by, created_at FROM agent_versions
      WHERE tenant_id = ${this.tenantId} AND agent_id = ${id} ORDER BY version DESC`;
  }
  async version(id: string, version: number) {
    const [r] = await this.tx<{ config: AgentConfig }[]>`
      SELECT config FROM agent_versions WHERE tenant_id = ${this.tenantId} AND agent_id = ${id} AND version = ${version}`;
    return r;
  }
  /** Widgets and channel connections that still point at this agent (customers there get the "not available" reply once it is archived). */
  async attachments(id: string) {
    const widgets = await this.tx<{ id: string; name: string }[]>`SELECT id, name FROM widgets WHERE tenant_id = ${this.tenantId} AND agent_id = ${id} ORDER BY name`;
    const channels = await this.tx<{ id: string; name: string; channel: string }[]>`SELECT id, name, channel FROM channel_connections WHERE tenant_id = ${this.tenantId} AND agent_id = ${id} ORDER BY name`;
    return { widgets, channels };
  }
  async archive(id: string, archived: boolean) {
    const [r] = await this.tx<AgentRow[]>`
      UPDATE agents SET status = CASE WHEN ${archived} THEN 'archived' WHEN published_version IS NOT NULL THEN 'published' ELSE 'draft' END, updated_at = now()
      WHERE tenant_id = ${this.tenantId} AND id = ${id} RETURNING ${COLS(this.tx)}`;
    return r;
  }
}

const nameSchema = z.string().trim().min(1).max(100);
const createSchema = z.strictObject({
  name: nameSchema,
  description: z.string().trim().max(500).default(""),
  config: agentConfigSchema.default(agentConfigSchema.parse({})),
});
const patchSchema = z.strictObject({
  name: nameSchema.optional(),
  description: z.string().trim().max(500).optional(),
  config: agentConfigSchema.optional(),
}).refine((v) => Object.keys(v).length > 0, "At least one field required");
const publishSchema = z.strictObject({ note: z.string().trim().max(500).default("") });
const rollbackSchema = z.strictObject({ version: z.number().int().min(1), note: z.string().trim().max(500).optional() });

export function agentRoutes({ cfg, db }: { cfg: Config; db: Db }) {
  const r = new Hono<AppEnv>();
  r.use("/agents/*", requireAuth(cfg));

  r.get("/agents", async (c) => {
    const { tenantId } = c.get("auth");
    const rows = await withTenant(db, tenantId, (tx) => new AgentsRepository(tx, tenantId).list());
    return c.json({ items: rows.map(dto) });
  });
  r.get("/agents/:id", async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const a = await withTenant(db, tenantId, (tx) => new AgentsRepository(tx, tenantId).get(id));
    if (!a) throw Errors.notFound("Agent not found");
    return c.json(dto(a));
  });
  r.get("/agents/:id/versions", async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const out = await withTenant(db, tenantId, async (tx) => {
      const repo = new AgentsRepository(tx, tenantId);
      return (await repo.get(id)) ? repo.versions(id) : undefined;
    });
    if (!out) throw Errors.notFound("Agent not found");
    return c.json({ items: out.map((v) => ({ version: v.version, note: v.note, createdBy: v.createdBy, createdAt: v.createdAt.toISOString() })) });
  });

  r.post("/agents", requireMinRole("admin"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const body = await parseBody(c, createSchema);
    const a = await withTenant(db, tenantId, async (tx) => {
      await assertWithinLimit(tx, tenantId, "agents");
      const created = await new AgentsRepository(tx, tenantId).create({ name: body.name, description: body.description, config: body.config, by: userId });
      await audit(tx, c, "agent.created", "agent", created.id, { name: body.name });
      return created;
    });
    return c.json(dto(a), 201);
  });

  r.patch("/agents/:id", requireMinRole("admin"), async (c) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const body = await parseBody(c, patchSchema);
    const a = await withTenant(db, tenantId, async (tx) => {
      const repo = new AgentsRepository(tx, tenantId);
      const cur = await repo.get(id, true);
      if (!cur) throw Errors.notFound("Agent not found");
      if (cur.status === "archived") throw Errors.conflict("Agent is archived");
      const updated = await repo.update(id, body);
      await audit(tx, c, "agent.updated", "agent", id, { fields: Object.keys(body) });
      return updated!;
    });
    return c.json(dto(a));
  });

  r.post("/agents/:id/publish", requireMinRole("admin"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = parseId(c);
    const body = await parseBody(c, publishSchema);
    const out = await withTenant(db, tenantId, async (tx) => {
      const repo = new AgentsRepository(tx, tenantId);
      const cur = await repo.get(id, true);
      if (!cur) throw Errors.notFound("Agent not found");
      if (cur.status === "archived") throw Errors.conflict("Agent is archived");
      const res = await repo.publish(id, agentConfigSchema.parse(cur.config), body.note, userId);
      await audit(tx, c, "agent.published", "agent", id, { version: res.version });
      return res;
    });
    return c.json({ ...dto(out.agent), version: out.version });
  });

  /** Restores an old version's config as a NEW published version (history is never rewritten). */
  r.post("/agents/:id/rollback", requireMinRole("admin"), async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = parseId(c);
    const body = await parseBody(c, rollbackSchema);
    const out = await withTenant(db, tenantId, async (tx) => {
      const repo = new AgentsRepository(tx, tenantId);
      const cur = await repo.get(id, true);
      if (!cur) throw Errors.notFound("Agent not found");
      if (cur.status === "archived") throw Errors.conflict("Agent is archived");
      const old = await repo.version(id, body.version);
      if (!old) throw Errors.notFound("Version not found");
      const res = await repo.publish(id, agentConfigSchema.parse(old.config), body.note ?? `Rollback to v${body.version}`, userId);
      await audit(tx, c, "agent.rolled_back", "agent", id, { toVersion: body.version, newVersion: res.version });
      return res;
    });
    return c.json({ ...dto(out.agent), version: out.version });
  });

  const setArchived = (archived: boolean) => async (c: import("hono").Context<AppEnv>) => {
    const { tenantId } = c.get("auth");
    const id = parseId(c);
    const a = await withTenant(db, tenantId, async (tx) => {
      const repo = new AgentsRepository(tx, tenantId);
      if (!(await repo.get(id, true))) throw Errors.notFound("Agent not found");
      if (!archived) await assertWithinLimit(tx, tenantId, "agents");
      const res = await repo.archive(id, archived);
      await audit(tx, c, archived ? "agent.archived" : "agent.unarchived", "agent", id);
      const used = archived ? await repo.attachments(id) : null;
      const warning = used && (used.widgets.length || used.channels.length)
        ? { code: "agent_in_use", message: "This agent is still attached to a widget or channel. Visitors there get a \"not available\" reply and a team member is notified until you attach another agent.", ...used }
        : undefined;
      return { res: res!, warning };
    });
    return c.json({ ...dto(a.res), ...(a.warning ? { warning: a.warning } : {}) });
  };
  r.delete("/agents/:id", requireMinRole("admin"), setArchived(true));
  r.post("/agents/:id/unarchive", requireMinRole("admin"), setArchived(false));
  return r;
}
