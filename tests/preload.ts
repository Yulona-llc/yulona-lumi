// Isolation: the e2e/security suites create tenants, queue jobs and notifications. Other packages' tests run against
// the same TEST_DATABASE_URL in parallel (`bun run test` fans out), and some of them assert on global state
// (e.g. "email dispatch sent N"), so this package runs on its own database: <db>_qa (created on demand).
import postgres from "postgres";

const url = process.env.TEST_DATABASE_URL;
if (url && !process.env.YULONA_QA_NO_ISOLATE) {
  try {
    const u = new URL(url);
    const name = `${u.pathname.slice(1)}_qasuite`;
    const admin = new URL(url);
    admin.pathname = "/postgres";
    const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
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
    console.warn("qa preload: could not create isolated database, using TEST_DATABASE_URL as is:", (e as Error).message);
  }
}
