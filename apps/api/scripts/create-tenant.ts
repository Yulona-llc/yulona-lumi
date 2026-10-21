/**
 * Create the first tenant + owner user (self-hosting bootstrap). Uses the OWNER database role (the app role
 * cannot call auth_register for arbitrary tenants without going through the API, and public signup is closed
 * in selfhosted mode). Safe to re-run only for NEW tenants; an existing owner email is rejected.
 *
 *   flags:  --workspace "Acme" --email admin@acme.com --name "Ada" [--password ...] [--plan self_hosted] [--json]
 *   env:    MIGRATION_DATABASE_URL (or OWNER_DATABASE_URL); ADMIN_PASSWORD may replace --password.
 * Without --password a strong one is generated and printed ONCE. Interactive prompts for missing values on a TTY.
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import postgres from "postgres";
import { emailSchema, passwordSchema } from "@yulona/shared";
import { hashPassword } from "../src/security";

const { values } = parseArgs({
  options: {
    workspace: { type: "string" }, email: { type: "string" }, name: { type: "string" },
    password: { type: "string" }, plan: { type: "string", default: "self_hosted" }, json: { type: "boolean", default: false },
  },
});

async function ask(q: string, v?: string): Promise<string | undefined> {
  if (v) return v;
  if (!process.stdin.isTTY) return undefined;
  process.stdout.write(q);
  for await (const line of console) return line.trim() || undefined;
  return undefined;
}

const url = process.env.OWNER_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL;
const workspace = await ask("Workspace name: ", values.workspace);
const emailRaw = await ask("Admin email: ", values.email);
const name = (await ask("Admin name [Admin]: ", values.name)) ?? "Admin";
const generated = !(values.password ?? process.env.ADMIN_PASSWORD);
const pw = values.password ?? process.env.ADMIN_PASSWORD ?? randomBytes(18).toString("base64url");
const email = emailSchema.safeParse(emailRaw);
const password = passwordSchema.safeParse(pw);
if (!url || !workspace || !email.success || !password.success) {
  console.error("Need MIGRATION_DATABASE_URL (owner role), --workspace, --email (valid) and a password of >= 12 chars.");
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {}, transform: postgres.toCamel });
try {
  const hash = await hashPassword(password.data);
  const [row] = await sql<{ rTenantId: string; rUserId: string }[]>`
    SELECT * FROM auth_register(${workspace}, ${email.data}, ${hash}, ${name}, ${null}, ${null})`;
  if (values.plan) await sql`UPDATE tenants SET plan_key = ${values.plan} WHERE id = ${row!.rTenantId}`;
  const out = { tenantId: row!.rTenantId, userId: row!.rUserId, email: email.data, password: generated ? password.data : undefined };
  if (values.json) console.log(JSON.stringify(out));
  else {
    console.log(`tenant ready: ${workspace} (${out.tenantId})`);
    console.log(`admin: ${email.data}${generated ? `\npassword (shown once): ${password.data}` : ""}`);
  }
} catch (e) {
  if ((e as { code?: string }).code === "23505") console.error("A user with that email already exists.");
  else console.error(`create-tenant failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
