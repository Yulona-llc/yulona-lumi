import postgres from "postgres";
import { migrate } from "./migrate";

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL (owner role, e.g. yulona_owner) is required");
  process.exit(1);
}
try {
  const applied = await migrate(url, undefined, (m) => console.log(m));
  console.log(applied.length ? `migrations applied: ${applied.length}` : "database is up to date");
  // Optional: make sure the runtime role can log in (e.g. when docker-entrypoint-initdb.d did not run).
  const appPw = process.env.APP_DB_PASSWORD;
  if (appPw) {
    const sql = postgres(url, { max: 1 });
    try {
      await sql.unsafe(`ALTER ROLE yulona_app LOGIN PASSWORD '${appPw.replace(/'/g, "''")}'`);
      console.log("yulona_app login enabled");
    } finally {
      await sql.end();
    }
  }
} catch (e) {
  console.error("migration failed:", e instanceof Error ? e.message : e);
  process.exit(1);
}
