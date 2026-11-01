import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider";
import { ApiError, setFetchImpl } from "../src/api/client";
import ChannelsPage from "../src/features/channels/ChannelsPage";
import BillingPage from "../src/features/billing/BillingPage";
import { UpgradePrompt, planLimitFrom } from "../src/features/billing/UpgradePrompt";
import WebhooksPage from "../src/features/integrations-ui/WebhooksPage";
import { ImpersonationBanner } from "../src/features/impersonation/ImpersonationBanner";
import ImpersonatePage from "../src/features/impersonation/ImpersonatePage";
import { useAuth } from "../src/auth/AuthProvider";
import { API_KEY_SCOPES } from "../src/features/integrations-ui/scopes";

const session = (role: string) => ({ accessToken: "t", expiresIn: 900, user: { id: "11111111-1111-4111-8111-111111111111", email: "a@b.co", name: "A", role }, tenant: { id: "22222222-2222-4222-8222-222222222222", name: "Acme" } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
type H = (init?: RequestInit) => Response;

function mount(ui: React.ReactNode, role: string, routes: Record<string, unknown | H>, entries?: string[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  setFetchImpl((async (u: string, init?: RequestInit) => {
    calls.push({ url: u, init });
    const p = u.replace(/^.*\/api\/v1/, "");
    if (p === "/auth/refresh") return json(session(role));
    for (const [k, v] of Object.entries(routes)) if (p.startsWith(k)) return typeof v === "function" ? (v as H)(init) : json(v);
    return json({ error: { code: "not_found", message: "nope" } }, 404);
  }) as unknown as typeof fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={entries}><AuthProvider><Routes><Route path="/*" element={ui} /></Routes></AuthProvider></MemoryRouter>
    </QueryClientProvider>);
  return calls;
}
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => { document.cookie = "yl_csrf=c; path=/"; });

const available = { items: [{ channel: "telegram", credentialFields: [{ name: "botToken", label: "Bot token", secret: true, required: true }, { name: "webhookSecret", label: "Webhook secret", secret: true, required: true }] }] };
const conn = { id: "c1", channel: "telegram", name: "Support bot", externalId: null, agentId: null, status: "active", credentialsMasked: { botToken: "••••1234" }, webhookUrl: "https://api.x/api/v1/webhooks/channels/telegram/c1", health: null, createdAt: "x", updatedAt: "x" };

describe("channels", () => {
  it("shows masked credentials and reveals generated secrets once after connecting", async () => {
    const calls = mount(<ChannelsPage />, "admin", {
      "/channels/available": available,
      "/channels/connections": (i?: RequestInit) => (i?.method === "POST" ? json({ ...conn, generatedSecrets: { webhookSecret: "gen-secret-xyz" } }, 201) : json({ items: [conn] })),
      "/channels/merge-suggestions": { items: [] }, "/agents": { items: [] },
    });
    expect(await screen.findByText("••••1234")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /telegram/i }));
    await userEvent.type(screen.getByLabelText("Bot token"), "123:abc");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByTestId("secret-webhookSecret")).toHaveTextContent("gen-secret-xyz");
    const post = calls.find((c) => c.init?.method === "POST" && c.url.endsWith("/channels/connections"))!;
    expect(JSON.parse(post.init!.body as string)).toEqual({ channel: "telegram", name: "Telegram", credentials: { botToken: "123:abc" } });
  });
  it("is read-only for non-admins", async () => {
    mount(<ChannelsPage />, "agent", { "/channels/available": available, "/channels/connections": { items: [conn] }, "/channels/merge-suggestions": { items: [] } });
    expect(await screen.findByText("Support bot")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /test connection/i })).toBeNull();
  });
});

describe("billing", () => {
  const info = (state: string) => ({ provider: "stripe", plan: { key: "pro", name: "Pro" }, state, subscription: { status: "past_due", currentPeriodEnd: null, graceUntil: "2026-02-01T00:00:00Z", cancelAtPeriodEnd: false }, limits: [{ metric: "seats", limit: 5, used: 5, warning: true }], checkoutPlans: ["pro"] });
  it("warns during the grace period and shows limit usage", async () => {
    mount(<BillingPage />, "owner", { "/billing": info("grace"), "/usage": { limits: [], series: [] } });
    expect(await screen.findByText(/last payment failed/i)).toBeInTheDocument();
    expect(screen.getByText("At limit")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /manage payment/i })).toBeInTheDocument();
  });
  it("hides billing from agents", async () => {
    mount(<BillingPage />, "agent", {});
    expect(await screen.findByText(/requires an owner or admin/i)).toBeInTheDocument();
  });
  it("UpgradePrompt renders only for 402 plan_limit_exceeded", () => {
    const e = new ApiError(402, "plan_limit_exceeded", "x", undefined, { metric: "agents", limit: 3, used: 3 });
    expect(planLimitFrom(e)?.metric).toBe("agents");
    expect(planLimitFrom(new ApiError(400, "bad", "x"))).toBeNull();
    render(<MemoryRouter><UpgradePrompt error={e} /></MemoryRouter>);
    expect(screen.getByRole("dialog")).toHaveTextContent("3 of 3");
  });
});

describe("integrations", () => {
  it("creates a webhook and shows the signing secret once", async () => {
    mount(<WebhooksPage />, "admin", {
      "/webhooks/events": { events: ["*", "message.created"] },
      "/webhooks": (i?: RequestInit) => (i?.method === "POST" ? json({ id: "w1", name: "n", url: "https://e.co", events: ["*"], enabled: true, secret: "whsec_abc" }, 201) : json({ items: [] })),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Add webhook" }));
    await userEvent.type(screen.getByLabelText("Name"), "CRM");
    await userEvent.type(screen.getByLabelText("Endpoint URL"), "https://example.com/h");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByTestId("webhook-secret")).toHaveTextContent("whsec_abc");
  });
  it("API key scopes include bookings", () => {
    expect(API_KEY_SCOPES).toEqual(expect.arrayContaining(["bookings:read", "bookings:write"]));
  });
});

const exchanged = (readOnly: boolean) => ({ accessToken: "imp-token", expiresIn: 900, sessionId: "s1", readOnly, user: { id: "11111111-1111-4111-8111-111111111111", email: "boss@acme.test", name: "Boss", role: "admin" }, tenant: { id: "22222222-2222-4222-8222-222222222222", name: "Acme" } });

describe("platform impersonation (customer side)", () => {
  function WhoAmI() { const { session } = useAuth(); return <p>{session ? `signed in as ${session.user.email}` : "anonymous"}</p>; }
  function mountImpersonate(hash: string, exchange: unknown | H) {
    window.history.replaceState(null, "", `/impersonate${hash}`);
    const calls = mount(<Routes><Route path="impersonate" element={<ImpersonatePage />} /><Route path="overview" element={<><ImpersonationBanner /><WhoAmI /></>} /><Route path="login" element={<p>login page</p>} /></Routes>, "admin", {
      "/auth/impersonation/exchange": exchange, "/me": { user: {}, tenant: {}, impersonation: null }, "/auth/logout": { ok: true },
    }, ["/impersonate"]);
    return calls;
  }

  it("redeems the fragment code once, removes it from the address bar and starts a read-only session with a banner", async () => {
    const calls = mountImpersonate("#code=abcdefghijklmnop1234", () => json(exchanged(true)));
    expect(await screen.findByText("signed in as boss@acme.test")).toBeInTheDocument();
    const post = calls.filter((c) => c.url.endsWith("/auth/impersonation/exchange"));
    expect(post).toHaveLength(1);
    expect(JSON.parse(post[0]!.init!.body as string)).toEqual({ code: "abcdefghijklmnop1234" });
    expect(window.location.hash).toBe("");
    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText("Impersonating, read-only")).toBeInTheDocument();
    expect(within(banner).getByText(/look but not change/i)).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: /stop impersonating/i })).toBeInTheDocument();
  });

  it("marks write-mode sessions as such and the stop button signs out", async () => {
    const calls = mountImpersonate("#code=abcdefghijklmnop1234", () => json(exchanged(false)));
    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText("Impersonating, write mode")).toBeInTheDocument();
    await userEvent.click(within(banner).getByRole("button", { name: /stop impersonating/i }));
    expect(await screen.findByText("login page")).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/auth/logout"))).toBe(true);
  });

  it("explains an invalid, used or expired code", async () => {
    mountImpersonate("#code=abcdefghijklmnop1234", () => json({ error: { code: "validation_error", message: "Code is invalid, expired or already used" } }, 400));
    expect(await screen.findByText(/invalid, expired or was already used/i)).toBeInTheDocument();
  });

  it("explains a link without a code and never calls the API", async () => {
    const calls = mountImpersonate("", { ok: true });
    expect(await screen.findByText(/no impersonation code/i)).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/auth/impersonation/exchange"))).toBe(false);
  });
});
