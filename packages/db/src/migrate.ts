import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

export const defaultMigrationsDir = process.env.MIGRATIONS_DIR ?? join(import.meta.dir, "..", "migrations");

/**
 * Idempotent, ordered, checksum-verified migration runner. Takes an advisory lock so concurrent
 * runners (e.g. several containers) serialize. Connect with the OWNER role URL.
 */
export async function migrate(ownerUrl: string, dir = defaultMigrationsDir, log: (m: string) => void = () => {}): Promise<string[]> {
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {}, connect_timeout: 10 });
  const applied: string[] = [];
  try {
    await sql`SELECT pg_advisory_lock(727274001)`;
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done = new Map((await sql<{ version: string; checksum: string }[]>`SELECT version, checksum FROM schema_migrations`).map((r) => [r.version, r.checksum]));
    const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const body = readFileSync(join(dir, file), "utf8");
      const checksum = createHash("sha256").update(body).digest("hex");
      const prev = done.get(file);
      if (prev) {
        if (prev !== checksum) throw new Error(`Migration ${file} was modified after being applied`);
        continue;
      }
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO schema_migrations (version, checksum) VALUES (${file}, ${checksum})`;
      });
      applied.push(file);
      log(`applied ${file}`);
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(727274001)`.catch(() => {});
    await sql.end({ timeout: 5 });
  }
  return applied;
}
