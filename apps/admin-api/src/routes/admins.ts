// Admin management (owner only): invite, role, deactivate, reset 2FA / password. Last-owner protection lives in SQL.
import { z } from "zod";
import { emailSchema } from "@yulona/shared";
import type { Deps } from "../context";
import { Errors } from "../errors";
import { isUniqueViolation, iso, parseBody, parseId } from "../http";
import { OWNER, type Registrar } from "../route";
import { hashPassword, temporaryPassword } from "../security";

const role = z.enum(["owner", "support", "billing"]);
interface AdminRow { id: string; email: string; name: string; role: string; status: string; totpEnabled: boolean; lastLoginAt: Date | null; createdAt: Date }
const dto = (a: AdminRow) => ({ id: a.id, email: a.email, name: a.name, role: a.role, status: a.status, twoFactorEnabled: a.totpEnabled, lastLoginAt: iso(a.lastLoginAt), createdAt: iso(a.createdAt) });

export function registerAdminRoutes(reg: Registrar, d: Deps) {
  const { db } = d;
  const load = async (id: string) => {
    const [a] = await db<AdminRow[]>`SELECT * FROM sa_admin_get(${id})`;
    if (!a) throw Errors.notFound("Admin not found");
    return a;
  };
  const lastOwner = () => Errors.conflict("This is the last active owner; promote another owner first");

  reg.route({ method: "GET", path: "/admins", roles: OWNER, tag: "Admins", summary: "List platform admins" }, async (c) => {
    const rows = await db<AdminRow[]>`SELECT * FROM sa_admin_list()`;
    return c.json({ items: rows.map(dto) });
  });
  const createBody = z.strictObject({ email: emailSchema, name: z.string().trim().min(1).max(100), role });
  reg.route({ method: "POST", path: "/admins", roles: OWNER, tag: "Admins", summary: "Invite an admin: returns a temporary password once (changed at first login)", body: createBody, status: 201 }, async (c) => {
    const b = await parseBody(c, createBody);
    const pw = temporaryPassword();
    try {
      const [r] = await db<{ saAdminCreate: string }[]>`SELECT sa_admin_create(${c.get("admin").id}, ${b.email}, ${b.name}, ${b.role}, ${await hashPassword(pw)}, true)`;
      return c.json({ id: r!.saAdminCreate, email: b.email, role: b.role, temporaryPassword: pw }, 201);
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict("An admin with this email already exists");
      throw e;
    }
  });
  const patchBody = z.strictObject({ name: z.string().trim().min(1).max(100).optional(), role: role.optional() }).refine((b) => Object.keys(b).length > 0, "At least one field required");
  reg.route({ method: "PATCH", path: "/admins/:id", roles: OWNER, tag: "Admins", summary: "Change an admin's name or role", body: patchBody }, async (c) => {
    const id = parseId(c);
    const b = await parseBody(c, patchBody);
    const [r] = await db<{ saAdminUpdate: string }[]>`SELECT sa_admin_update(${c.get("admin").id}, ${id}, ${b.name ?? null}, ${b.role ?? null})`;
    if (r?.saAdminUpdate === "not_found") throw Errors.notFound("Admin not found");
    if (r?.saAdminUpdate === "last_owner") throw lastOwner();
    return c.json(dto(await load(id)));
  });
  const status = (to: "active" | "disabled") => async (c: import("hono").Context<import("../route").AdminEnv>) => {
    const id = parseId(c);
    const [r] = await db<{ saAdminSetStatus: string }[]>`SELECT sa_admin_set_status(${c.get("admin").id}, ${id}, ${to})`;
    if (r?.saAdminSetStatus === "not_found") throw Errors.notFound("Admin not found");
    if (r?.saAdminSetStatus === "last_owner") throw lastOwner();
    if (r?.saAdminSetStatus === "self") throw Errors.conflict("You cannot deactivate yourself");
    return c.json(dto(await load(id)));
  };
  reg.route({ method: "POST", path: "/admins/:id/deactivate", roles: OWNER, tag: "Admins", summary: "Deactivate an admin (sessions revoked)" }, status("disabled"));
  reg.route({ method: "POST", path: "/admins/:id/activate", roles: OWNER, tag: "Admins", summary: "Reactivate an admin" }, status("active"));
  reg.route({ method: "POST", path: "/admins/:id/reset-2fa", roles: OWNER, tag: "Admins", summary: "Clear an admin's TOTP and recovery codes (sessions revoked)" }, async (c) => {
    const id = parseId(c);
    const [r] = await db<{ saAdminReset2fa: boolean }[]>`SELECT sa_admin_reset_2fa(${c.get("admin").id}, ${id})`;
    if (!r?.saAdminReset2fa) throw Errors.notFound("Admin not found");
    return c.json(dto(await load(id)));
  });
  reg.route({ method: "POST", path: "/admins/:id/reset-password", roles: OWNER, tag: "Admins", summary: "Issue a new temporary password once (sessions revoked, change forced)" }, async (c) => {
    const id = parseId(c);
    const pw = temporaryPassword();
    const [r] = await db<{ saAdminResetPassword: boolean }[]>`SELECT sa_admin_reset_password(${c.get("admin").id}, ${id}, ${await hashPassword(pw)})`;
    if (!r?.saAdminResetPassword) throw Errors.notFound("Admin not found");
    return c.json({ temporaryPassword: pw });
  });
}
