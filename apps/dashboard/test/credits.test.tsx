import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider";
import { setFetchImpl } from "../src/api/client";
import UsagePage from "../src/features/usage/UsagePage";
import { CreditAlerts, CreditsBanner, CreditsCard } from "../src/features/usage/CreditAlerts";
import BillingPage from "../src/features/billing/BillingPage";
import { asCredits, fmtCredits, messagesLeftText, nextReset, typicalMessageCredits } from "../src/features/usage/api";

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
beforeEach(() => { document.cookie = "yl_csrf=c; path=/"; });

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

describe("message estimates and the paid plan card", () => {
  const est = { creditsPerMessage: 2.1, estimatedMessages: 2371, estimateBasis: "typical" };
  it("formats the estimate", () => {
    expect(messagesLeftText(2371)).toBe("about 2,371 messages left");
    expect(messagesLeftText(1)).toBe("about 1 message left");
    expect(messagesLeftText(null)).toBeNull();
    expect(typicalMessageCredits(250_000, 1_000_000)).toBe(2.1);
  });
  it("usage page shows 'about N messages left' with its basis", async () => {
    mount(<UsagePage />, "admin", usageRoutes(credits({ ...est, remainingMicro: 4_980_000_000 })));
    expect(await screen.findByTestId("messages-left")).toHaveTextContent("about 2,371 messages left");
    expect(screen.getByTestId("messages-left")).toHaveTextContent(/typical message/i);
  });
  it("billing plan card shows credits, tokens and estimated messages", async () => {
    const info = { provider: "stripe", plan: { key: "pro", name: "Pro" }, state: "ok", subscription: { status: "active", currentPeriodEnd: null, graceUntil: null, cancelAtPeriodEnd: false },
      limits: [{ metric: "llm_credits_monthly", limit: 4980, used: 0, warning: false }, { metric: "llm_tokens_monthly", limit: 15_480_000, used: 0, warning: false }], checkoutPlans: ["pro"] };
    mount(<BillingPage />, "owner", { "/usage/credits": credits({ ...est, allowanceMicro: 4_980_000_000, remainingMicro: 4_980_000_000 }), "/billing": info, "/usage": { limits: [], series: [] } });
    const line = await screen.findByTestId("plan-allowance");
    await waitFor(() => expect(line).toHaveTextContent("4,980 credits a month and 15,480,000 tokens, about 2,371 messages left"));
  });
});
