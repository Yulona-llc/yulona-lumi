import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { OverviewDto } from "@yulona/shared";
import { AuthProvider } from "../src/auth/AuthProvider";
import { setFetchImpl } from "../src/api/client";
import OverviewPage from "../src/features/overview/OverviewPage";
import { waitLabel } from "../src/features/overview/api";

const session = (role: string) => ({ accessToken: "t", expiresIn: 900, user: { id: "11111111-1111-4111-8111-111111111111", email: "a@b.co", name: "Ada Obi", role }, tenant: { id: "22222222-2222-4222-8222-222222222222", name: "Acme" } });
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
const common = (over: Partial<OverviewDto["common"]> = {}): OverviewDto["common"] => ({
  conversations: { last30d: 12, open: 3, today: 2 }, credits: { remainingMicro: null, allowanceMicro: null }, channels: { total: 1, connected: 1, unhealthy: 0 },
  setup: { items: [{ key: "agent", label: "Create your agent", done: true, path: "/agents" }, { key: "knowledge", label: "Add knowledge", done: true, path: "/knowledge" }, { key: "channel", label: "Add the chat", done: true, path: "/channels" }, { key: "publish", label: "Try it, then publish your agent", done: true, path: "/agents" }], doneCount: 4, total: 4 },
  ...over,
});
const overview = (over: Partial<OverviewDto>): OverviewDto => ({ goals: [], order: [], common: common(), ...over });
const support = { aiResolvedPct: 82.5, handoffs: 4, medianFirstResponseSeconds: 9, unanswered: { count: 2, items: [{ id: "h1", conversationId: "c1", createdAt: new Date(Date.now() - 600000).toISOString() }, { id: "h2", conversationId: null, createdAt: new Date().toISOString() }] } };
const leads = { funnel: [{ stage: "visitor", count: 10 }, { stage: "engaged", count: 6 }, { stage: "qualified", count: 3 }, { stage: "booking_offered", count: 2 }, { stage: "booked", count: 1 }], qualified: 3, hubspot: { connected: true, lastSyncAt: new Date().toISOString(), failed: 2 } };
const bookings = { upcoming: 5, booked30d: 9, cancelled30d: 1, calendar: { connected: false, provider: null } };

function mount(o: OverviewDto, opts: { role?: string; onboarding?: unknown; onPut?: (b: unknown) => void } = {}) {
  setFetchImpl((async (u: string, init?: RequestInit) => {
    const p = u.replace(/^.*\/api\/v1/, "");
    if (p === "/auth/refresh") return json(session(opts.role ?? "owner"));
    if (p === "/overview") return json(o);
    if (p === "/workspace/profile" && init?.method === "PUT") { opts.onPut?.(JSON.parse(String(init.body))); return json({ goals: JSON.parse(String(init.body)).goals }); }
    if (p === "/onboarding") return json(opts.onboarding ?? { status: "completed", currentStepId: "preview", steps: [], answers: {}, progress: { done: 10, total: 10 }, result: null });
    if (p.startsWith("/usage/credits")) return json({ mode: "saas", enabled: false, unlimited: true, period: "2026-01-01", allowanceMicro: null, usedMicro: 0, topupMicro: 0, topupUsedMicro: 0, remainingMicro: null, percentUsed: null, status: "ok", warnings: [] });
    if (p.startsWith("/usage")) return json({ series: [] });
    if (p.startsWith("/conversations")) return json({ items: [], nextCursor: null });
    if (p.startsWith("/needs-attention")) return json({ items: [] });
    return new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), { status: 404 });
  }) as unknown as typeof fetch);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><AuthProvider><Routes><Route path="/*" element={<OverviewPage />} /></Routes></AuthProvider></MemoryRouter></QueryClientProvider>);
}

describe("overview by goal", () => {
  it("formats waits", () => { expect(waitLabel(new Date(Date.now() - 5 * 60000).toISOString())).toBe("5 min"); });

  it("asks an admin to pick a goal when none is set, and saves it", async () => {
    let put: unknown;
    mount(overview({}), { onPut: (b) => { put = b; } });
    const card = await screen.findByTestId("no-goal");
    expect(card).toHaveTextContent("Tell Lumi your goal");
    await userEvent.click(within(card).getByRole("button", { name: "Capture leads" }));
    await screen.findByTestId("no-goal");
    expect(put).toEqual({ goals: ["leads"] });
  });

  it("viewers see the empty state without goal buttons", async () => {
    mount(overview({}), { role: "viewer" });
    const card = await screen.findByTestId("no-goal");
    expect(card).toHaveTextContent("Ask a workspace admin");
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("support goal: resolved %, handoffs, first reply and the unanswered questions", async () => {
    mount(overview({ goals: ["support"], order: ["support"], support }));
    const block = await screen.findByTestId("block-support");
    await waitFor(() => expect(within(block).getByTestId("kpi-resolved")).toHaveTextContent("82.5%"));
    await waitFor(() => expect(within(block).getByTestId("kpi-handoffs")).toHaveTextContent("4"));
    await waitFor(() => expect(within(block).getByTestId("kpi-response")).toHaveTextContent("9 s"));
    expect(block).toHaveTextContent("could not answer: 2");
    expect(within(block).getAllByRole("link", { name: /chat from/i })[0]).toHaveAttribute("href", "/inbox/c1");
    expect(screen.queryByTestId("block-leads")).toBeNull();
    expect(screen.queryByTestId("block-bookings")).toBeNull();
  });

  it("support goal with no data says so instead of zeros", async () => {
    mount(overview({ goals: ["support"], order: ["support"], support: { aiResolvedPct: null, handoffs: 0, medianFirstResponseSeconds: null, unanswered: { count: 0, items: [] } } }));
    expect(await screen.findByTestId("kpi-resolved")).toHaveTextContent("No data yet");
    expect(screen.getByTestId("block-support")).toHaveTextContent("Nothing yet");
  });

  it("leads goal: server funnel, qualified count and HubSpot sync state", async () => {
    mount(overview({ goals: ["leads"], order: ["leads"], leads }));
    await screen.findByTestId("funnel-engaged");
    await waitFor(() => expect(screen.getByTestId("funnel-engaged")).toHaveTextContent("6"));
    await waitFor(() => expect(screen.getByTestId("funnel-booked")).toHaveTextContent("1"));
    await waitFor(() => expect(screen.getByTestId("kpi-qualified")).toHaveTextContent("3"));
    expect(screen.getByTestId("hubspot-status")).toHaveTextContent(/2 failed to sync/);
  });

  it("leads goal without HubSpot links to Connectors", async () => {
    mount(overview({ goals: ["leads"], order: ["leads"], leads: { ...leads, hubspot: { connected: false, lastSyncAt: null, failed: 0 } } }));
    expect(await screen.findByRole("link", { name: /connect hubspot/i })).toHaveAttribute("href", "/settings/integrations");
  });

  it("bookings goal: counts and calendar connection state", async () => {
    mount(overview({ goals: ["bookings"], order: ["bookings"], bookings }));
    await screen.findByTestId("block-bookings");
    await waitFor(() => expect(screen.getByTestId("kpi-upcoming")).toHaveTextContent("5"));
    await waitFor(() => expect(screen.getByTestId("kpi-cancelled")).toHaveTextContent("1"));
    expect(screen.getByTestId("calendar-status")).toHaveTextContent(/no calendar connected/i);
  });

  it("mixed goals show every block in priority order", async () => {
    mount(overview({ goals: ["bookings", "support", "leads"], order: ["bookings", "support", "leads"], support, leads, bookings }));
    await screen.findByTestId("block-leads");
    const ids = screen.getAllByTestId(/^block-/).map((e) => e.getAttribute("data-testid"));
    expect(ids).toEqual(["block-bookings", "block-support", "block-leads"]);
  });

  it("shows the setup checklist with the try-then-publish step after onboarding, for admins only", async () => {
    const c = common({ setup: { items: [{ key: "agent", label: "Create your agent", done: true, path: "/agents" }, { key: "publish", label: "Try it, then publish your agent", done: false, path: "/agents" }], doneCount: 1, total: 2 } });
    mount(overview({ goals: ["support"], order: ["support"], support, common: c }), { onboarding: { status: "completed", currentStepId: "preview", steps: [], answers: {}, progress: { done: 10, total: 10 }, result: { agentId: "a1", nextStep: { label: "Try your assistant, then publish it", path: "/agents/a1" } } } });
    expect(await screen.findByTestId("setup-checklist")).toHaveTextContent("Create your agent");
    expect(await screen.findByTestId("try-then-publish")).toHaveTextContent("Try your assistant");
    expect(screen.getByRole("link", { name: "Try it now" })).toHaveAttribute("href", "/agents/a1?tab=sandbox");
  });

  it("prompts to finish setup when onboarding was skipped, and hides it for viewers", async () => {
    const ob = { status: "skipped", currentStepId: "businessType", steps: [], answers: {}, progress: { done: 0, total: 10 }, result: null };
    mount(overview({ goals: ["support"], order: ["support"], support }), { onboarding: ob });
    expect(await screen.findByTestId("setup-prompt")).toHaveTextContent("Finish your setup");
  });
  it("viewers never see the setup checklist or prompt", async () => {
    const c = common({ setup: { items: [{ key: "agent", label: "Create your agent", done: false, path: "/agents" }], doneCount: 0, total: 1 } });
    mount(overview({ goals: ["support"], order: ["support"], support, common: c }), { role: "viewer" });
    await screen.findByTestId("block-support");
    expect(screen.queryByTestId("setup-checklist")).toBeNull();
    expect(screen.queryByTestId("setup-prompt")).toBeNull();
  });
});
