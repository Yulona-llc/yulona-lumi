// Isolation: the api suite asserts on global state (notification email queue, plans, platform settings) while other
// packages' tests run against the same TEST_DATABASE_URL in parallel (`bun run test` fans out), so this package runs
// on its own database: <db>_api (created on demand).
import postgres from "postgres";

const url = process.env.TEST_DATABASE_URL;
if (url && !process.env.YULONA_API_NO_ISOLATE) {
  try {
    const u = new URL(url);
    const name = `${u.pathname.slice(1)}_api`;
    const root = new URL(url);
    root.pathname = "/postgres";
    const sql = postgres(root.toString(), { max: 1, onnotice: () => {} });
    const exists = await sql`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (exists.length === 0) await sql.unsafe(`CREATE DATABASE "${name}"`);
    await sql.end({ timeout: 2 });
    u.pathname = `/${name}`;
    const own = postgres(u.toString(), { max: 1, onnotice: () => {} });
    await own`CREATE EXTENSION IF NOT EXISTS vector`;
    await own.end({ timeout: 2 });
    process.env.TEST_DATABASE_URL = u.toString();
    delete process.env.TEST_APP_DATABASE_URL;
  } catch (e) {
    console.warn("api preload: could not create an isolated database, using TEST_DATABASE_URL as is:", (e as Error).message);
  }
}
