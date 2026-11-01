/**
 * Create a platform admin (or reset an existing admin's password and role). Never prints the password.
 *
 *   OWNER_DATABASE_URL=postgres://yulona_owner:...@host/db \
 *   ADMIN_PASSWORD=... bun scripts/seed-admin.ts --email ops@example.com --name "Ops" --role owner
 *
 * Without ADMIN_PASSWORD the password is read from the terminal (type it and press Enter) or from stdin
 * (`printf '%s' "$PW" | bun scripts/seed-admin.ts ...`). Uses the OWNER role because the
 * admin service's role (yulona_admin) deliberately has no table grants; the admin gets `must_change_password` unless --keep-password.
 */
import postgres from "postgres";
import { emailSchema, passwordSchema } from "@yulona/shared";
import { hashPassword } from "../src/security";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const email = emailSchema.safeParse(flag("email") ?? process.env.ADMIN_EMAIL);
const role = flag("role") ?? process.env.ADMIN_ROLE ?? "owner";
const name = flag("name") ?? process.env.ADMIN_NAME ?? "Platform Admin";
const url = process.env.OWNER_DATABASE_URL;
if (!url || !email.success || !["owner", "support", "billing"].includes(role)) {
  console.error("Usage: OWNER_DATABASE_URL=... [ADMIN_PASSWORD=...] bun scripts/seed-admin.ts --email you@example.com [--name Name] --role owner|support|billing [--keep-password]");
  process.exit(1);
}
/** One line from a terminal (Enter ends it). A pipe is read until it closes, so `printf '%s' "$PW" | ...` still works. */
async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write("Password (12-128 characters): ");
    const reader = Bun.stdin.stream().getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (!buf.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    return buf.replace(/\r?\n[\s\S]*$/, "");
  }
  return (await new Response(Bun.stdin.stream()).text()).replace(/\r?\n$/, "");
}

let pw = process.env.ADMIN_PASSWORD;
if (!pw) pw = await readPassword();
const parsed = passwordSchema.safeParse(pw);
if (!parsed.success) {
  console.error("The password must be 12-128 characters.");
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const hash = await hashPassword(parsed.data);
  const mustChange = !args.includes("--keep-password");
  await sql`
    INSERT INTO platform_admins (email, name, role, password_hash, must_change_password) VALUES (${email.data}, ${name}, ${role}, ${hash}, ${mustChange})
    ON CONFLICT ((lower(email))) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, status = 'active', must_change_password = EXCLUDED.must_change_password,
      failed_login_count = 0, locked_until = NULL, updated_at = now()`;
  await sql`UPDATE admin_sessions SET revoked_at = now() WHERE revoked_at IS NULL AND admin_id = (SELECT id FROM platform_admins WHERE lower(email) = lower(${email.data}))`;
  console.log(`platform admin ready: ${email.data} (${role})${mustChange ? "; the password must be changed at first sign-in" : ""}`);
} finally {
  await sql.end({ timeout: 5 });
}
