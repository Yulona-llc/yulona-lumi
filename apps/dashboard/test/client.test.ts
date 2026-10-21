import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, getAccessToken, readCsrfCookie, setFetchImpl, clearAccessToken } from "../src/api/client";

const session = { accessToken: "tok1", expiresIn: 900, user: { id: "11111111-1111-4111-8111-111111111111", email: "a@b.co", name: "A", role: "owner" }, tenant: { id: "22222222-2222-4222-8222-222222222222", name: "T" } };
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

describe("api client", () => {
  beforeEach(() => { clearAccessToken(); localStorage.clear(); document.cookie = "yl_csrf=csrf123; path=/"; });

  it("keeps access token in memory only", async () => {
    setFetchImpl(vi.fn(async () => ok(session)) as unknown as typeof fetch);
    await api.login({ email: "a@b.co", password: "x" });
    expect(getAccessToken()).toBe("tok1");
    expect(JSON.stringify({ ...localStorage })).not.toContain("tok1");
    expect(document.cookie).not.toContain("tok1");
  });

  it("reads csrf cookie", () => expect(readCsrfCookie()).toBe("csrf123"));

  it("refreshes on 401 with CSRF header and retries once", async () => {
    const calls: Array<[string, RequestInit]> = [];
    setFetchImpl((async (u: string, i: RequestInit) => {
      calls.push([u, i]);
      if (u.endsWith("/me")) {
        const h = i.headers as Record<string, string>;
        return h.Authorization === "Bearer tok2"
          ? ok({ user: session.user, tenant: session.tenant })
          : new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), { status: 401 });
      }
      return ok({ ...session, accessToken: "tok2" });
    }) as unknown as typeof fetch);
    const me = await api.me();
    expect(me.user.email).toBe("a@b.co");
    const refresh = calls.find(([u]) => u.endsWith("/auth/refresh"))!;
    expect((refresh[1].headers as Record<string, string>)["X-CSRF-Token"]).toBe("csrf123");
    expect(refresh[1].credentials).toBe("include");
    expect(calls.filter(([u]) => u.endsWith("/me"))).toHaveLength(2);
  });

  it("maps error envelope to ApiError", async () => {
    setFetchImpl((async () => new Response(JSON.stringify({ error: { code: "invalid_credentials", message: "Invalid", requestId: "r1" } }), { status: 401 })) as unknown as typeof fetch);
    await expect(api.login({ email: "a@b.co", password: "x" })).rejects.toMatchObject({ code: "invalid_credentials", requestId: "r1" });
    await expect(api.login({ email: "a@b.co", password: "x" })).rejects.toBeInstanceOf(ApiError);
  });
});
