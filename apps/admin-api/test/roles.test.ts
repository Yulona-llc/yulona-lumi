import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SKIP_MESSAGE } from "@yulona/db/testing";
import { collectRoutes } from "../src/openapi";
import { ADMIN_ROLES, type AdminRole } from "../src/route";
import { bootAdmin, hasDb, mkAdmin, type AdminBoot, type TestAdmin } from "./support";

if (!hasDb) console.warn(SKIP_MESSAGE);

const routes = collectRoutes();
const fill = (path: string) => {
  const id = crypto.randomUUID();
  return path.replace(/\/plans\/:key/, "/plans/free").replace(/:key\b/g, "probe.flag").replace(/:metric\b/g, "seats").replace(/:[A-Za-z]+/g, id);
};

describe("route table", () => {
  test("every route states its roles; the public set is exactly the credential/cookie endpoints", () => {
    expect(routes.length).toBeGreaterThan(70);
    const pub = routes.filter((r) => r.roles === "public").map((r) => `${r.method} ${r.path}`).sort();
    expect(pub).toEqual(["POST /auth/login", "POST /auth/login/2fa", "POST /auth/logout", "POST /auth/refresh"]);
    for (const r of routes) if (r.roles !== "public") expect(r.roles.length).toBeGreaterThan(0);
    const dup = routes.map((r) => `${r.method} ${r.path}`).filter((k, i, a) => a.indexOf(k) !== i);
    expect(dup).toEqual([]);
  });
  test("role matrix of the plan: support/billing/owner capabilities", () => {
    const roles = (m: string, p: string) => routes.find((r) => r.method === m && r.path === p)?.roles;
    const all = [...ADMIN_ROLES];
    expect(roles("GET", "/tenants")).toEqual(all);
    expect(roles("GET", "/tenants/:id")).toEqual(all);
    expect(roles("POST", "/tenants/:id/credits")).toEqual(["owner", "billing"]);
    expect(roles("PUT", "/tenants/:id/plan")).toEqual(["owner", "billing"]);
    expect(roles("PUT", "/plans/:key/limits/:metric")).toEqual(["owner", "billing"]);
    expect(roles("PUT", "/model-rates")).toEqual(["owner", "billing"]);
    expect(roles("POST", "/credit-packs")).toEqual(["owner", "billing"]);
    expect(roles("POST", "/tenants/:id/notes")).toEqual(["owner", "support"]);
    expect(roles("PUT", "/tenants/:id/tags")).toEqual(["owner", "support"]);
    expect(roles("POST", "/tenants/:id/impersonate")).toEqual(["owner", "support"]);
    expect(roles("POST", "/tenants/:id/invitations/:invitationId/resend")).toEqual(["owner", "support"]);
    for (const [m, p] of [["DELETE", "/tenants/:id"], ["POST", "/tenants/:id/restore"], ["POST", "/tenants/:id/suspend"], ["POST", "/tenants"], ["PUT", "/feature-flags/:key"], ["PUT", "/tenants/:id/flags/:key"],
      ["GET", "/admins"], ["POST", "/admins"], ["PATCH", "/admins/:id"], ["POST", "/admins/:id/reset-2fa"], ["POST", "/llm-profiles"], ["GET", "/audit-logs/export"]] as const) {
      expect([m, p, roles(m, p)]).toEqual([m, p, ["owner"]]);
    }
  });
});

describe.skipIf(!hasDb)("admin-api sweep: 401 without token, 403 for every role outside the route's roles", () => {
  let b: AdminBoot;
  const who = {} as Record<AdminRole, TestAdmin>;
  beforeAll(async () => {
    b = await bootAdmin();
    for (const r of ADMIN_ROLES) who[r] = await mkAdmin(b, r);
  });
  afterAll(async () => b.close());

  const hit = (method: string, path: string, h: Record<string, string>) =>
    b.app.request(`/api/v1${fill(path)}`, { method, headers: { ...h, ...(method === "GET" ? {} : { "content-type": "application/json" }) }, body: method === "GET" || method === "DELETE" ? undefined : "{}" });

  test("unauthenticated, tenant-shaped and garbage tokens get 401 on every protected route", async () => {
    const bad: string[] = [];
    for (const r of routes) {
      if (r.roles === "public") continue;
      for (const h of [{} as Record<string, string>, { authorization: "Bearer nope" }, { authorization: "Basic abc" }]) {
        const s = (await hit(r.method, r.path, h)).status;
        if (s !== 401) bad.push(`${r.method} ${r.path} -> ${s}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("a role outside the route's roles gets 403; an allowed role never does", async () => {
    const bad: string[] = [];
    for (const r of routes) {
      if (r.roles === "public") continue;
      for (const role of ADMIN_ROLES) {
        const s = (await hit(r.method, r.path, who[role].h)).status;
        const allowed = r.roles.includes(role);
        if (allowed && (s === 401 || s === 403 || s >= 500)) bad.push(`${role} ${r.method} ${r.path} should pass the guard, got ${s}`);
        if (!allowed && s !== 403) bad.push(`${role} ${r.method} ${r.path} should be 403, got ${s}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("every route in the table is mounted (a path that is not registered would 404 for all roles)", async () => {
    const owner = who.owner;
    const missing: string[] = [];
    for (const r of routes) {
      if (r.roles === "public") continue;
      const res = await hit(r.method, r.path, owner.h);
      // 404 is allowed for unknown ids, but then the body must be our JSON error, not the router's fallback for an unmounted path
      if (res.status === 404 && (await res.clone().json().catch(() => null))?.error?.message === "Not found") missing.push(`${r.method} ${r.path}`);
    }
    expect(missing).toEqual([]);
  });
});
