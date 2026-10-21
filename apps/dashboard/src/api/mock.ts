import type { Session } from "./contract";

/** Tiny in-browser fake of the Phase 1 API for standalone demos (VITE_MOCK_API=true). Not bundled otherwise. */
interface MockUser { id: string; email: string; password: string; name: string; tenant: { id: string; name: string } }
const users: MockUser[] = [
  { id: "11111111-1111-4111-8111-111111111111", email: "demo@yulona.dev", password: "demo-password-123", name: "Demo Owner", tenant: { id: "22222222-2222-4222-8222-222222222222", name: "Demo Workspace" } },
];
let activeUser: string | null = null;
let token = "";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const err = (status: number, code: string, message: string) =>
  json(status, { error: { code, message, requestId: "mock-" + Math.random().toString(36).slice(2, 8) } });

function session(u: MockUser): Session {
  token = "mock." + Math.random().toString(36).slice(2);
  activeUser = u.id;
  document.cookie = "yl_csrf=mockcsrf; path=/";
  document.cookie = "yl_mock_rt=" + u.id + "; path=/";
  return {
    accessToken: token,
    expiresIn: 900,
    user: { id: u.id, email: u.email, name: u.name, role: "owner" },
    tenant: u.tenant,
  };
}

export const mockFetch: typeof fetch = async (input, init) => {
  await new Promise((r) => setTimeout(r, 250));
  const url = new URL(String(input), window.location.origin);
  const path = url.pathname.replace(/^.*\/api\/v1/, "");
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const headers = new Headers(init?.headers);

  if (path === "/auth/login") {
    const u = users.find((x) => x.email === body.email?.toLowerCase());
    return u && u.password === body.password ? json(200, session(u)) : err(401, "invalid_credentials", "Invalid email or password.");
  }
  if (path === "/auth/register") {
    if (users.some((x) => x.email === body.email)) return err(409, "email_taken", "Unable to create account with those details.");
    const u = { id: `00000000-0000-4000-8000-${String(users.length).padStart(12, "0")}`, email: body.email, password: body.password, name: body.name, tenant: { id: `99999999-0000-4000-8000-${String(users.length).padStart(12, "0")}`, name: body.workspaceName } };
    users.push(u);
    return json(201, session(u));
  }
  if (path === "/auth/refresh") {
    const rt = document.cookie.split("; ").find((c) => c.startsWith("yl_mock_rt="))?.split("=")[1];
    const u = users.find((x) => x.id === rt);
    if (!u || headers.get("X-CSRF-Token") !== "mockcsrf") return err(401, "unauthorized", "Session expired.");
    return json(200, session(u));
  }
  if (path === "/auth/logout") {
    activeUser = null;
    document.cookie = "yl_mock_rt=; path=/; max-age=0";
    return new Response(null, { status: 204 });
  }
  if (path === "/me") {
    const u = users.find((x) => x.id === activeUser);
    if (!u || headers.get("Authorization") !== `Bearer ${token}`) return err(401, "unauthorized", "Unauthorized");
    return json(200, { user: { id: u.id, email: u.email, name: u.name, role: "owner" }, tenant: u.tenant });
  }
  return err(404, "not_found", "Not found");
};
