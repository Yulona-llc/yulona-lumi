import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider";
import { setFetchImpl } from "../src/api/client";
import UsagePage from "../src/features/usage/UsagePage";
import { CreditAlerts, CreditsBanner, CreditsCard } from "../src/features/usage/CreditAlerts";
import { asCredits, fmtCredits, nextReset } from "../src/features/usage/api";
import AdminRoutes from "../src/features/admin/AdminRoutes";
import { adminApi } from "../src/features/admin/api";
import { TenantCreditsCard } from "../src/features/admin/GrantCredits";

const session = (role: string) => ({ accessToken: "t", expiresIn: 900, user: { id: "11111111-1111-4111-8111-111111111111", email: "a@b.co", name: "A", role }, tenant: { id: "22222222-2222-4222-8222-222222222222", name: "Acme" } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
type H = (init?: RequestInit) => Response;

const credits = (over: Record<string, unknown> = {}) => ({
  mode: "saas", enabled: true, unlimited: false, period: "2026-10-01", allowanceMicro: 50_000_000, usedMicro: 12_000_000, topupMicro: 0, topupUsedMicro: 0,
  remainingMicro: 38_000_000, percentUsed: 24, status: "ok", warnings: [], ...over,
});
const row = (key: string, label: string, o: Record<string, number> = {}) => ({ key, label, promptTokens: 1200, completionTokens: 300, totalTokens: 1500, requests: 9, creditsMicro: 450_000, ...o });
const report = (groupBy: string, items: unknown[]) => ({ from: "2026-09-20", to: "2026-10-19", groupBy, items, totals: { promptTokens: 2400, completionTokens: 600, totalTokens: 3000, requests: 18, creditsMicro: 900_000 } });

function usageRoutes(c: unknown) {
  return {
    "/usage/credits": c,
    "/usage/ai": (_i?: RequestInit, url = "") => json(url.includes("groupBy=day") ? report("day", [row("2026-10-18", "2026-10-18"), row("2026-10-19", "2026-10-19")]) : url.includes("groupBy=model") ? report("model", [row("gpt-4o-mini", "gpt-4o-mini")]) : report("agent", [row("a1", "Support bot")])),
    "/billing/credit-packs": { items: [{ id: "p1", name: "Starter", credits: 500, priceCents: 900, currency: "usd" }, { id: "p2", name: "Growth", credits: 2500, priceCents: 3900, currency: "usd" }] },
    "/billing/credits/checkout": () => json({ url: "https://pay.example/session" }),
  };
}

function mount(ui: React.ReactNode, role: string, routes: Record<string, unknown>, at = "/") {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  setFetchImpl((async (u: string, init?: RequestInit) => {
    calls.push({ url: u, init });
    const p = u.replace(/^.*\/api\/v1/, "");
    if (p === "/auth/refresh") return json(session(role));
    for (const [k, v] of Object.entries(routes)) if (p.startsWith(k)) return typeof v === "function" ? (v as (i?: RequestInit, u?: string) => Response)(init, p) : json(v);
    return json({ error: { code: "not_found", message: "nope" } }, 404);
  }) as unknown as typeof fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[at]}><AuthProvider><Routes><Route path="/*" element={ui} /></Routes></AuthProvider></MemoryRouter>
    </QueryClientProvider>);
  return calls;
}
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => { document.cookie = "yl_csrf=c; path=/"; adminApi.logout(); });

describe("credits helpers", () => {
  it("formats micro-credits and rejects foreign shapes", () => {
    expect(fmtCredits(38_000_000)).toBe("38");
    expect(fmtCredits(1_250_000)).toBe("1.25");
    expect(asCredits({ series: [] })).toBeNull();
    expect(asCredits(credits())?.mode).toBe("saas");
    expect(nextReset("2026-10-01")).toMatch(/November/);
  });
});

describe("usage page", () => {
  it("shows the credits hero, token totals and breakdowns (SaaS, healthy)", async () => {
    mount(<UsagePage />, "admin", usageRoutes(credits()));
    expect(await screen.findByRole("img", { name: /38 credits left, 24% used/i })).toBeInTheDocument();
    expect(screen.getByText("Monthly allowance")).toBeInTheDocument();
    expect(await screen.findByText("Total tokens")).toBeInTheDocument();
    expect(await screen.findByText("3,000")).toBeInTheDocument();
    expect(await screen.findByText("Support bot")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buy credits" })).toBeInTheDocument();
    expect(screen.queryByText(/AI replies are paused/)).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "By model" }));
    expect(await screen.findByText("gpt-4o-mini")).toBeInTheDocument();
  });

  it("warns at 80% with the remaining credits", async () => {
    mount(<UsagePage />, "admin", usageRoutes(credits({ usedMicro: 41_000_000, remainingMicro: 9_000_000, percentUsed: 82, status: "warning", warnings: ["warning_80"] })));
    expect(await screen.findByText(/used 82% of your AI credits/i)).toBeInTheDocument();
    expect(screen.getByText(/9 credits left\. AI replies pause at zero/)).toBeInTheDocument();
  });

  it("says AI replies are paused at 100% and links to Needs attention", async () => {
    mount(<UsagePage />, "admin", usageRoutes(credits({ usedMicro: 50_000_000, remainingMicro: 0, percentUsed: 100, status: "exhausted", warnings: ["warning_80", "exhausted"] })));
    expect(await screen.findByText("AI replies are paused")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open needs attention" })).toHaveAttribute("href", "/attention");
  });

  it("buys a pack: lists packs, posts the pack id and redirects to the checkout url", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const calls = mount(<UsagePage />, "admin", usageRoutes(credits()));
    await userEvent.click(await screen.findByRole("button", { name: "Buy credits" }));
    const dlg = await screen.findByRole("dialog");
    expect(await within(dlg).findByText("500 credits")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("radio", { name: /Starter/ }));
    await userEvent.click(within(dlg).getByRole("button", { name: "Buy credits" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://pay.example/session"));
    const post = calls.find((c) => c.url.endsWith("/billing/credits/checkout"))!;
    expect(JSON.parse(post.init!.body as string)).toEqual({ packId: "p1" });
  });

  it("shows only tokens and an honest note in self-hosted mode", async () => {
    mount(<UsagePage />, "admin", usageRoutes(credits({ mode: "selfhosted", enabled: false, unlimited: true, allowanceMicro: null, remainingMicro: null, percentUsed: null })));
    expect(await screen.findByText(/not charged/i)).toBeInTheDocument();
    expect(await screen.findByText("Total tokens")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /buy credits/i })).toBeNull();
    expect(screen.queryByTestId("credits-hero")).toBeNull();
    expect(screen.queryByText("Credits")).toBeNull();
  });

  it("hides the breakdown from non-admins but keeps the meter", async () => {
    mount(<UsagePage />, "agent", usageRoutes(credits()));
    expect(await screen.findByTestId("credits-hero")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/owner or admin/i);
    expect(screen.queryByRole("button", { name: "Buy credits" })).toBeNull();
  });
});

describe("credit surfaces", () => {
  it("global banner shows only when exhausted", async () => {
    mount(<CreditsBanner />, "admin", { "/usage/credits": credits({ status: "exhausted", remainingMicro: 0, percentUsed: 100 }) });
    expect(await screen.findByText("AI replies are paused until you add credits")).toBeInTheDocument();
  });
  it("global banner stays hidden for healthy and self-hosted workspaces", async () => {
    const calls = mount(<CreditsBanner />, "admin", { "/usage/credits": credits() });
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/usage/credits"))).toBe(true));
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("overview card shows remaining credits and links to usage; alerts render at 80%", async () => {
    mount(<><CreditsCard /><CreditAlerts /></>, "owner", { "/usage/credits": credits({ percentUsed: 85, status: "warning", remainingMicro: 7_500_000 }) });
    expect(await screen.findByTestId("credits-card")).toHaveTextContent("85% used");
    expect(screen.getAllByRole("link", { name: "View usage" }).length).toBeGreaterThan(0);
    expect(await screen.findByText(/used 85% of your AI credits/i)).toBeInTheDocument();
  });
  it("ignores a response that is not a credits object", async () => {
    mount(<CreditsCard />, "owner", { "/usage/credits": { series: [] } });
    await waitFor(() => expect(screen.queryByTestId("credits-card")).toBeNull());
  });
});

/* ------------------------------ platform admin ------------------------------ */
const profile = { id: "pr1", name: "OpenAI prod", baseUrl: "https://api.openai.com/v1", authHeader: "Authorization", authScheme: "bearer", extraHeaders: { "x-org": "abc" }, queryParams: {}, chatPath: "/chat/completions", defaultModel: "gpt-4o-mini", enabledModels: ["gpt-4o-mini", "gpt-4o"], isDefault: true, enabled: true, hasCredentials: true, createdAt: "x", updatedAt: "x" };

function mountAdmin(routes: Record<string, unknown>, at: string) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", (async (u: string, init?: RequestInit) => {
    calls.push({ url: u, init });
    const p = u.replace(/^.*\/api\/v1/, "");
    if (p === "/admin/auth/login") return json({ accessToken: "adm", admin: { id: "a", email: "root@y.co" } });
    for (const [k, v] of Object.entries(routes)) if (p.startsWith(k)) return typeof v === "function" ? (v as H)(init) : json(v);
    return json({ error: { code: "not_found", message: "nope" } }, 404);
  }) as unknown as typeof fetch);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[at]}><Routes><Route path="/admin/*" element={<AdminRoutes />} /></Routes></MemoryRouter></QueryClientProvider>);
  return calls;
}
async function signIn() {
  await userEvent.type(screen.getByLabelText("Email"), "root@y.co");
  await userEvent.type(screen.getByLabelText("Password"), "pw");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
}
const isWrite = (c: { url: string; init?: RequestInit }) => c.init?.method === "POST" && !c.url.includes("/auth/");
const bodyOf = (c?: { init?: RequestInit }) => JSON.parse(c!.init!.body as string);

describe("admin credits", () => {
  it("lists providers, never shows the key, and reports a failing connection test", async () => {
    const calls = mountAdmin({ "/admin/llm-profiles/pr1/test": () => json({ ok: false, latencyMs: 0, model: null, error: "401 invalid key" }), "/admin/llm-profiles": { items: [profile] } }, "/admin/credits");
    await signIn();
    expect((await screen.findAllByText("OpenAI prod")).length).toBeGreaterThan(0);
    expect(screen.getByText("Key saved")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /test connection for OpenAI prod/i }));
    expect(await screen.findByText("401 invalid key")).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/admin/llm-profiles/pr1/test") && isWrite(c))).toBe(true);
    expect(document.body.textContent).not.toMatch(/sk-/);
  });

  it("switches between credits tabs without looping (absolute tab links)", async () => {
    mountAdmin({ "/admin/llm-profiles": { items: [] }, "/admin/model-rates": { items: [{ model: "*", inputMicroPer1k: 250000, outputMicroPer1k: 1000000, enabled: true, updatedAt: "x" }] } }, "/admin/credits");
    await signIn();
    await userEvent.click(await screen.findByRole("link", { name: "Model rates" }));
    expect(await screen.findByText("Default (*)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Providers" }));
    expect(await screen.findByText("No providers yet")).toBeInTheDocument();
  });

  it("creates a provider with a write-only key and header rows", async () => {
    const calls = mountAdmin({ "/admin/llm-profiles": (i?: RequestInit) => (i?.method === "POST" ? json(profile, 201) : json({ items: [] })) }, "/admin/credits/providers");
    await signIn();
    await userEvent.click((await screen.findAllByRole("button", { name: /add provider/i }))[0]!);
    const dlg = await screen.findByRole("dialog");
    await userEvent.type(within(dlg).getByLabelText("Name"), "Azure");
    await userEvent.type(within(dlg).getByLabelText("Default model"), "gpt-4o");
    await userEvent.type(within(dlg).getByLabelText("API key"), "secret-key");
    await userEvent.click(within(dlg).getByRole("button", { name: /add header/i }));
    await userEvent.type(within(dlg).getByLabelText(/extra headers header 1/i), "x-org");
    await userEvent.type(within(dlg).getByLabelText(/extra headers value 1/i), "abc");
    await userEvent.click(within(dlg).getByRole("button", { name: "Create provider" }));
    await waitFor(() => expect(calls.some((c) => isWrite(c))).toBe(true));
    const b = bodyOf(calls.find((c) => isWrite(c)));
    expect(b).toMatchObject({ name: "Azure", defaultModel: "gpt-4o", apiKey: "secret-key", authScheme: "bearer", extraHeaders: { "x-org": "abc" }, enabledModels: [] });
  });

  it("edits a model rate in credits and sends micro-credits", async () => {
    const calls = mountAdmin({ "/admin/model-rates": (i?: RequestInit) => (i?.method === "PUT" ? json({}) : json({ items: [{ model: "*", inputMicroPer1k: 250000, outputMicroPer1k: 1000000, enabled: true, updatedAt: "x" }, { model: "gpt-4o", inputMicroPer1k: 2500000, outputMicroPer1k: 10000000, enabled: true, updatedAt: "x" }] })) }, "/admin/credits/rates");
    await signIn();
    expect(await screen.findByText("Default (*)")).toBeInTheDocument();
    expect(screen.getByText("0.25")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /edit rate for gpt-4o/i }));
    const input = screen.getByLabelText("Input credits per 1k for gpt-4o");
    await userEvent.clear(input); await userEvent.type(input, "1.5");
    await userEvent.click(screen.getByRole("button", { name: /save rate for gpt-4o/i }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.init?.method === "PUT"))).toEqual({ model: "gpt-4o", inputMicroPer1k: 1_500_000, outputMicroPer1k: 10_000_000, enabled: true });
    expect(screen.queryByRole("button", { name: /delete rate for \*/i })).toBeNull();
  });

  it("saves a plan allowance as whole credits, and unlimited as null", async () => {
    const calls = mountAdmin({ "/admin/plans/": () => json({}), "/admin/plans": { items: [{ key: "free", name: "Free", limits: { llm_credits_monthly: 50 } }, { key: "enterprise", name: "Enterprise", limits: { llm_credits_monthly: null } }] } }, "/admin/credits/plans");
    await signIn();
    const free = await screen.findByLabelText("Monthly credits for Free");
    expect(free).toHaveValue("50");
    await userEvent.clear(free); await userEvent.type(free, "75");
    await userEvent.click(screen.getByRole("button", { name: /save allowance for free/i }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.init?.method === "PUT")!;
    expect(put.url).toMatch(/\/admin\/plans\/free\/limits\/llm_credits_monthly$/);
    expect(bodyOf(put)).toEqual({ limit: 75 });
    expect(screen.getByLabelText("Monthly credits for Enterprise")).toBeDisabled();
  });

  it("creates a credit pack with the price in cents", async () => {
    const calls = mountAdmin({ "/admin/credit-packs": (i?: RequestInit) => (i?.method === "POST" ? json({}, 201) : json({ items: [{ id: "k1", name: "Starter", credits: 500, priceCents: 900, active: true, sortOrder: 0, createdAt: "x" }] })) }, "/admin/credits/packs");
    await signIn();
    expect(await screen.findByText(/500 credits for \$9/)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: /add pack/i })[0]!);
    const dlg = await screen.findByRole("dialog");
    await userEvent.type(within(dlg).getByLabelText("Name"), "Big");
    await userEvent.type(within(dlg).getByLabelText("Credits"), "10000");
    await userEvent.type(within(dlg).getByLabelText("Price (USD)"), "129.5");
    await userEvent.click(within(dlg).getByRole("button", { name: "Create pack" }));
    await waitFor(() => expect(calls.some((c) => isWrite(c))).toBe(true));
    expect(bodyOf(calls.find((c) => isWrite(c)))).toEqual({ name: "Big", credits: 10000, priceCents: 12950, active: true, sortOrder: 0 });
  });

  it("grants credits to a tenant with a reason", async () => {
    adminApi.logout();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", (async (u: string, init?: RequestInit) => {
      calls.push({ url: u, init });
      const p = u.replace(/^.*\/api\/v1/, "");
      if (p === "/admin/auth/login") return json({ accessToken: "adm", admin: { id: "a", email: "r@y.co" } });
      if (p.endsWith("/credits")) return json(init?.method === "POST" ? credits({ topupMicro: 100_000_000 }) : credits({ planKey: "free" }));
      return json({}, 404);
    }) as unknown as typeof fetch);
    await adminApi.login("r@y.co", "pw");
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TenantCreditsCard id="t1" /></QueryClientProvider>);
    expect(await screen.findByText("Top-up balance")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Adjust credits" }));
    const dlg = await screen.findByRole("dialog");
    const submit = within(dlg).getByRole("button", { name: "Adjust credits" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dlg).getByLabelText(/^Credits/), "100");
    await userEvent.type(within(dlg).getByLabelText(/^Reason/), "Goodwill after outage");
    await userEvent.click(submit);
    await waitFor(() => expect(calls.some((c) => c.init?.method === "POST" && c.url.endsWith("/admin/tenants/t1/credits"))).toBe(true));
    expect(bodyOf(calls.find((c) => c.init?.method === "POST" && c.url.includes("/credits")))).toEqual({ credits: 100, reason: "Goodwill after outage" });
  });
});
