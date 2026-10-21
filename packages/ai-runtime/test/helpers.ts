import postgres from "postgres";
import { createDb, migrate, type Db } from "@yulona/db";
import { testUrls } from "@yulona/db/testing";

/** Unique per process so parallel test runs (ai-runtime + api packages) never collide. */
export const DB_NAME = `yulona_airuntime_${process.pid}`;

export function swapDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export interface TestEnv {
  owner: postgres.Sql;
  app: Db;
  close(): Promise<void>;
}

/** Fresh private database (yulona_airuntime) per run: all migrations, plus shims for tables of other agents if missing. */
export async function setupAiDb(): Promise<TestEnv | null> {
  const urls = testUrls();
  if (!urls) return null;
  const admin = postgres(swapDb(urls.owner, "postgres"), { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();
  const ownerUrl = swapDb(urls.owner, DB_NAME);
  await migrate(ownerUrl);
  const owner = postgres(ownerUrl, { max: 3, onnotice: () => {}, transform: { column: { from: postgres.toCamel } } });
  const [row] = await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'agents' AND table_schema = 'public'`;
  const n = row?.n ?? 0;
  if (n === 0) {
    // platform's `agents` migration has not landed yet: minimal stand-in with the same access pattern
    await owner.unsafe(`
      CREATE TABLE agents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
        name text NOT NULL, config jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
      GRANT SELECT, INSERT, UPDATE ON agents TO yulona_app;`);
  }
  const appUrl = new URL(ownerUrl);
  appUrl.username = "yulona_app";
  appUrl.password = "yulona_app";
  const app = createDb(appUrl.toString(), { max: 5 });
  return { owner, app, close: async () => {
      await app.end({ timeout: 2 });
      await owner.end({ timeout: 2 });
      const a = postgres(swapDb(urls.owner, "postgres"), { max: 1, onnotice: () => {} });
      await a.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
      await a.end();
    } };
}

export async function seedTenant(owner: postgres.Sql, label = "t") {
  const [t] = await owner<{ id: string }[]>`INSERT INTO tenants (name) VALUES (${label + "-" + crypto.randomUUID().slice(0, 6)}) RETURNING id`;
  return t!.id;
}

export async function seedAgent(owner: postgres.Sql, tenantId: string, config: Record<string, unknown> = {}) {
  const cfg = { similarityThreshold: 0.3, topK: 4, ...config };
  const [a] = await owner<{ id: string }[]>`INSERT INTO agents (tenant_id, name, config) VALUES (${tenantId}, 'Test Agent', ${JSON.stringify(cfg)}::text::jsonb) RETURNING id`;
  return a!.id;
}

export async function seedConversation(owner: postgres.Sql, tenantId: string, agentId: string, userText: string, metadata: Record<string, unknown> = {}) {
  const [c] = await owner<{ id: string }[]>`INSERT INTO contacts (tenant_id) VALUES (${tenantId}) RETURNING id`;
  const [conv] = await owner<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id, agent_id) VALUES (${tenantId}, ${c!.id}, ${agentId}) RETURNING id`;
  const messageId = await addCustomerMessage(owner, tenantId, conv!.id, userText, metadata);
  return { contactId: c!.id, conversationId: conv!.id, messageId };
}

export async function addCustomerMessage(owner: postgres.Sql, tenantId: string, conversationId: string, text: string, metadata: Record<string, unknown> = {}) {
  const [m] = await owner<{ id: string }[]>`
    INSERT INTO messages (tenant_id, conversation_id, sender_type, content, metadata)
    VALUES (${tenantId}, ${conversationId}, 'contact', ${text}, ${JSON.stringify(metadata)}::text::jsonb) RETURNING id`;
  return m!.id;
}

import type { KnowledgePort, SkillSection } from "../src/knowledge";

/** In-memory KnowledgePort for turn tests: one skill per distinct `skill` id, substring-based search. */
export function fakeKnowledge(sections: { skill?: string; title?: string; content: string }[] = []): KnowledgePort & { calls: string[] } {
  const calls: string[] = [];
  const all: SkillSection[] = sections.map((s, i) => ({
    id: `c${i}`, sourceId: `s-${s.skill ?? "faq"}`, skill: s.skill ?? "faq", skillName: s.skill ?? "FAQ", section: i, title: s.title ?? `Section ${i + 1}`, content: s.content, score: 1,
  }));
  const summaries = () => [...new Set(all.map((a) => a.skill))].map((slug) => {
    const own = all.filter((a) => a.skill === slug);
    return { sourceId: `s-${slug}`, slug, name: own[0]!.skillName, description: `About ${slug}`, sections: own.length, chars: own.reduce((n, a) => n + a.content.length, 0) };
  });
  return {
    calls,
    index: async () => (calls.push("index"), summaries()),
    all: async () => (calls.push("all"), all),
    search: async (q, o) => (calls.push(`search:${q}`), all.filter((a) => (!o?.skill || a.skill === o.skill) && q.toLowerCase().split(/\W+/).some((w) => w.length > 3 && a.content.toLowerCase().includes(w)))),
    read: async (skill, section) => {
      calls.push(`read:${skill}:${section ?? ""}`);
      const own = all.filter((a) => a.skill === skill);
      if (!own.length) return null;
      return { skill: summaries().find((s) => s.slug === skill)!, sections: section === undefined ? own : own.filter((a) => a.section === section) };
    },
  };
}
