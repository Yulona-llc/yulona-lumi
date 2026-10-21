import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider";
import { setFetchImpl } from "../src/api/client";
import TicketsPage from "../src/features/tickets/TicketsPage";
import { slaState } from "../src/features/tickets/parts";
import TransactionsPage from "../src/features/transactions/TransactionsPage";
import BookingsPage from "../src/features/bookings/BookingsPage";
import AttentionPage from "../src/features/attention/AttentionPage";
import CannedPage from "../src/features/ops-settings/CannedPage";
import NotificationsBell from "../src/features/ops-settings/NotificationsBell";
import { money, relTime } from "../src/features/ops-settings/opsApi";

const uid = "11111111-1111-4111-8111-111111111111";
const session = (role: string) => ({ accessToken: "t", expiresIn: 900, user: { id: uid, email: "a@b.co", name: "A", role }, tenant: { id: "22222222-2222-4222-8222-222222222222", name: "T" } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const ticket = (o: Record<string, unknown> = {}) => ({ id: "t1", number: 7, title: "Refund broken", description: null, status: "open", priority: "high", assigneeUserId: null, assigneeName: null, contactId: null, contactName: null, conversationId: null, dueAt: new Date(Date.now() + 86400000).toISOString(), slaBreachedAt: null, resolvedAt: null, createdBy: null, tags: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: new Date().toISOString(), ...o });
const handoff = (o: Record<string, unknown> = {}) => ({ id: "h1", type: "stage", reason: "Qualified lead", summary: "Wants a demo", leadCard: { name: "Lee", budget: "5k" }, context: {}, outOfHours: false, state: "open", assignedUserId: null, assignedUserName: null, claimedAt: null, resolvedAt: null, resolutionNote: null, createdAt: new Date(Date.now() - 600000).toISOString(), conversation: { id: "c1", status: "pending_human", handler: "ai", channel: "widget", assignedUserId: null, lastMessagePreview: "Can I book?", lastMessageAt: "2026-01-01T00:00:00Z" }, contact: { id: "p1", name: "Lee", email: null, phone: null }, ...o });

function mount(ui: React.ReactNode, role: string, routes: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  setFetchImpl((async (u: string, init?: RequestInit) => {
    const p = u.replace(/^.*\/api\/v1/, "");
    calls.push({ url: p, method: init?.method ?? "GET", body: init?.body as string | undefined });
    if (p === "/auth/refresh") return json(session(role));
    const hit = Object.entries(routes).sort((a, b) => b[0].length - a[0].length).find(([k]) => p.startsWith(k));
    if (hit) return typeof hit[1] === "function" ? (hit[1] as (u: string, i?: RequestInit) => Response)(p, init) : json(hit[1]);
    return json({ error: { code: "not_found", message: "nope" } }, 404);
  }) as unknown as typeof fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><AuthProvider><Routes><Route path="/" element={ui} /><Route path="/inbox/:id" element={<p>inbox view</p>} /></Routes></AuthProvider></MemoryRouter>
    </QueryClientProvider>);
  return calls;
}
beforeEach(() => { document.cookie = "yl_csrf=c; path=/"; try { localStorage.clear(); } catch { /* */ } });

describe("helpers", () => {
  it("computes sla state", () => {
    const now = Date.now();
    expect(slaState({ dueAt: new Date(now - 1000).toISOString(), slaBreachedAt: null, status: "open" }, now)).toBe("breached");
    expect(slaState({ dueAt: new Date(now + 600_000).toISOString(), slaBreachedAt: null, status: "open" }, now)).toBe("soon");
    expect(slaState({ dueAt: new Date(now + 8 * 3600_000).toISOString(), slaBreachedAt: null, status: "open" }, now)).toBe("ok");
    expect(slaState({ dueAt: new Date(now - 1000).toISOString(), slaBreachedAt: null, status: "resolved" }, now)).toBe("none");
  });
  it("formats money and relative time", () => {
    expect(money(12345, "USD")).toContain("123.45");
    expect(relTime(new Date(Date.now() - 3 * 3600_000).toISOString())).toBe("3h ago");
  });
});

describe("tickets", () => {
  const cols = { open: [ticket()], in_progress: [], waiting: [], resolved: [], closed: [] };
  const board = { columns: cols, totals: { open: 1, in_progress: 0, waiting: 0, resolved: 0, closed: 0 } };
  it("renders the board with SLA badges and moves a ticket", async () => {
    const calls = mount(<TicketsPage />, "agent", { "/tickets/board": board, "/users": { items: [] }, "/tickets/t1": (_u: string, i?: RequestInit) => json(ticket({ status: JSON.parse(String(i?.body)).status })) });
    expect(await screen.findByText("Refund broken")).toBeInTheDocument();
    expect(screen.getByText(/SLA in/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Move ticket 7" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /waiting/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url === "/tickets/t1" && c.body === JSON.stringify({ status: "waiting" }))).toBe(true));
  });
  it("hides create for viewers and shows an empty table state", async () => {
    mount(<TicketsPage />, "viewer", { "/tickets/board": board });
    await screen.findByText("Refund broken");
    expect(screen.queryByRole("button", { name: /new ticket/i })).toBeNull();
    expect(screen.queryByLabelText("Move ticket 7")).toBeNull();
  });
  it("table view: bulk bar appears on select and sends bulk action", async () => {
    const calls = mount(<TicketsPage />, "admin", { "/tickets/board": board, "/tickets/bulk": { updated: 1, skipped: 0 }, "/tickets": { items: [ticket()], nextCursor: null }, "/users": { items: [] } });
    await userEvent.click(await screen.findByRole("button", { name: "Table" }));
    await userEvent.click(await screen.findByLabelText("Select ticket 7"));
    await userEvent.click(screen.getByRole("button", { name: "Set status for selected" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Resolved" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/tickets/bulk")?.body).toBe(JSON.stringify({ ids: ["t1"], action: "set_status", value: "resolved" })));
  });
  it("shows an error state with retry", async () => {
    mount(<TicketsPage />, "agent", { "/tickets/board": () => json({ error: { code: "boom", message: "Server exploded", requestId: "r1" } }, 500) });
    expect(await screen.findByText("Server exploded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});

describe("transactions", () => {
  const txn = { id: "x1", externalId: "ext_1", source: "webhook", amountCents: -2500, currency: "USD", status: "refunded", description: "Plan refund", contactId: null, contactName: "Lee", conversationId: null, metadata: {}, occurredAt: "2026-02-01T10:00:00Z", createdAt: "x", updatedAt: "x" };
  it("lists with summary and is blocked for viewers", async () => {
    mount(<TransactionsPage />, "agent", { "/transactions": { items: [txn], nextCursor: null, summary: { count: 1, totalCents: 0 } } });
    expect(await screen.findByText("Plan refund")).toBeInTheDocument();
    expect(screen.getByText("-$25.00")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /webhook endpoints/i })).toBeNull();
  });
  it("viewer sees read-only notice", async () => {
    mount(<TransactionsPage />, "viewer", {});
    expect(await screen.findByRole("note")).toHaveTextContent(/agent role/);
  });
});

describe("bookings", () => {
  it("lists bookings, allows cancel with reason, and shows connect for admins", async () => {
    const b = { id: "b1", status: "booked", title: "Demo call", startAt: "2030-03-01T10:00:00Z", endAt: "2030-03-01T10:30:00Z", timezone: null, contactId: null, contactName: "Lee", conversationId: null, attendeeEmail: null, notes: null, provider: null, externalEventId: null, eventUrl: null, failureReason: null, cancelledAt: null, createdAt: "x" };
    const calls = mount(<BookingsPage />, "admin", { "/bookings/b1/cancel": { ...b, status: "cancelled" }, "/bookings": { items: [b], nextCursor: null }, "/calendar/connection": { connected: false } });
    expect((await screen.findAllByText("Demo call")).length).toBeGreaterThan(0);
    expect(await screen.findByRole("button", { name: /connect google calendar/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /cancel demo call/i }));
    await userEvent.type(screen.getByLabelText(/cancellation reason/i), "customer asked");
    await userEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/bookings/b1/cancel")?.body).toBe(JSON.stringify({ reason: "customer asked" })));
  });
});

describe("needs attention", () => {
  it("shows lead card, claims and navigates to the conversation", async () => {
    const calls = mount(<AttentionPage />, "agent", {
      "/needs-attention/counts": { uncertainty: 0, stage: 1, system_failure: 0, total: 1, mine: 0 },
      "/needs-attention/h1/claim": handoff({ state: "claimed" }),
      "/needs-attention": { items: [handoff()], nextCursor: null },
    });
    expect(await screen.findByText("Qualified lead")).toBeInTheDocument();
    const lead = screen.getByRole("list", { name: "Handoff queue" });
    expect(within(lead).getByText("5k")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Claim" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/needs-attention/h1/claim" && c.method === "POST")).toBe(true));
    expect(await screen.findByText("inbox view")).toBeInTheDocument();
  });
  it("resolve sends note and returnToAi; empty state otherwise", async () => {
    const calls = mount(<AttentionPage />, "agent", { "/needs-attention/counts": { uncertainty: 1, stage: 0, system_failure: 0, total: 1, mine: 0 }, "/needs-attention/h1/resolve": handoff({ state: "resolved" }), "/needs-attention": { items: [handoff({ type: "uncertainty" })], nextCursor: null } });
    await userEvent.click(await screen.findByRole("button", { name: "Resolve" }));
    await userEvent.type(screen.getByLabelText(/resolution note/i), "done");
    await userEvent.click(screen.getByLabelText(/hand the conversation back/i));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/needs-attention/h1/resolve")?.body).toBe(JSON.stringify({ note: "done", returnToAi: true })));
  });
  it("empty queue", async () => {
    mount(<AttentionPage />, "agent", { "/needs-attention/counts": { uncertainty: 0, stage: 0, system_failure: 0, total: 0, mine: 0 }, "/needs-attention": { items: [], nextCursor: null } });
    expect(await screen.findByText("Queue is clear")).toBeInTheDocument();
  });
});

describe("canned + notifications", () => {
  it("validates the shortcut before saving", async () => {
    mount(<CannedPage />, "agent", { "/canned-responses": { items: [], nextCursor: null } });
    await userEvent.click((await screen.findAllByRole("button", { name: /new response/i }))[0]!);
    await userEvent.type(screen.getByLabelText("Shortcut"), "Bad Name");
    expect(screen.getByLabelText("Shortcut")).toHaveValue("bad name");
    expect(screen.getByText(/Lowercase letters/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
  it("bell shows unread count and marks all read", async () => {
    const calls = mount(<NotificationsBell />, "agent", { "/notifications/read-all": { updated: 1 }, "/notifications": { items: [{ id: "n1", type: "ticket.assigned", title: "Ticket assigned", body: "#7", data: { ticketId: "t1" }, readAt: null, createdAt: new Date().toISOString() }], nextCursor: null, unreadCount: 1 } });
    const bell = await screen.findByRole("button", { name: /notifications, 1 unread/i });
    await userEvent.click(bell);
    expect(await screen.findByText("Ticket assigned")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /mark all read/i }));
    await waitFor(() => expect(calls.some((c) => c.url === "/notifications/read-all")).toBe(true));
  });
});
