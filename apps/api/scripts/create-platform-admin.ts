/**
 * Create (or reset the password of) a platform super admin. Uses the OWNER database role because
 * the app role intentionally cannot touch platform_admins.
 *   OWNER_DATABASE_URL=... PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... bun scripts/create-platform-admin.ts
 */
import postgres from "postgres";
import { emailSchema, passwordSchema } from "@yulona/shared";
import { hashPassword } from "../src/security";

const url = process.env.OWNER_DATABASE_URL;
const email = emailSchema.safeParse(process.env.PLATFORM_ADMIN_EMAIL);
const password = passwordSchema.safeParse(process.env.PLATFORM_ADMIN_PASSWORD);
if (!url || !email.success || !password.success) {
  console.error("Set OWNER_DATABASE_URL, PLATFORM_ADMIN_EMAIL (valid email) and PLATFORM_ADMIN_PASSWORD (min 12 chars).");
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const hash = await hashPassword(password.data);
  await sql`INSERT INTO platform_admins (email, name, password_hash) VALUES (${email.data}, ${process.env.PLATFORM_ADMIN_NAME ?? "Platform Admin"}, ${hash})
    ON CONFLICT ((lower(email))) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active', failed_login_count = 0, locked_until = NULL`;
  console.log(`platform admin ready: ${email.data}`);
} finally {
  await sql.end({ timeout: 5 });
}
