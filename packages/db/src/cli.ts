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
  const rolePassword = (name: string) => {
    const value = process.env[name]?.trim();
    // The example file ships CHANGE_ME. Applying that would lock the local dev role out of DATABASE_URL.
    if (!value || value === "CHANGE_ME") return undefined;
    return value;
  };
  const appPw = rolePassword("APP_DB_PASSWORD");
  // Optional: the platform-admin service's login role (EXECUTE on sa_* functions only, no table grants). Only set when you run apps/admin-api.
  const adminPw = rolePassword("ADMIN_DB_PASSWORD");
  if (appPw || adminPw) {
    const sql = postgres(url, { max: 1 });
    try {
      if (appPw) {
        await sql.unsafe(`ALTER ROLE yulona_app LOGIN PASSWORD '${appPw.replace(/'/g, "''")}'`);
        console.log("yulona_app login enabled");
      }
      if (adminPw) {
        await sql.unsafe(`ALTER ROLE yulona_admin LOGIN PASSWORD '${adminPw.replace(/'/g, "''")}'`);
        console.log("yulona_admin login enabled");
      }
    } finally {
      await sql.end();
    }
  }
} catch (e) {
  console.error("migration failed:", e instanceof Error ? e.message : e);
  process.exit(1);
}
