import postgres from "postgres";
import { createDb, type Db } from "./client";
import { migrate } from "./migrate";

/**
 * Test helpers. TEST_DATABASE_URL = OWNER role URL (migrations + seeding). The app-role URL is
 * TEST_APP_DATABASE_URL, or derived from the owner URL with user/password `yulona_app`.
 */
export function testUrls(): { owner: string; app: string } | null {
  const owner = process.env.TEST_DATABASE_URL;
  if (!owner) return null;
  let app = process.env.TEST_APP_DATABASE_URL;
  if (!app) {
    const u = new URL(owner);
    u.username = "yulona_app";
    u.password = "yulona_app";
    app = u.toString();
  }
  return { owner, app };
}

export const SKIP_MESSAGE = "TEST_DATABASE_URL not set: skipping DB tests (docker compose -f deploy/docker-compose.dev.yml up -d postgres; TEST_DATABASE_URL=postgres://yulona_owner:yulona_owner@localhost:5433/yulona)";

export async function setupTestDb(): Promise<{ owner: postgres.Sql; app: Db; urls: { owner: string; app: string } }> {
  const urls = testUrls();
  if (!urls) throw new Error(SKIP_MESSAGE);
  await migrate(urls.owner);
  return { owner: postgres(urls.owner, { max: 2, onnotice: () => {} }), app: createDb(urls.app, { max: 5 }), urls };
}

/** Seed a tenant + user as the owner (bypasses the app path on purpose). */
export async function seedTenantWithUser(owner: postgres.Sql, label: string) {
  const id = crypto.randomUUID().slice(0, 8);
  const [t] = await owner<{ id: string }[]>`INSERT INTO tenants (name) VALUES (${`${label}-${id}`}) RETURNING id`;
  const [u] = await owner<{ id: string }[]>`
    INSERT INTO users (tenant_id, email, name, role, password_hash)
    VALUES (${t!.id}, ${`${label}-${id}@example.test`}, ${label}, 'owner', 'x') RETURNING id`;
  return { tenantId: t!.id, userId: u!.id, email: `${label}-${id}@example.test` };
}
