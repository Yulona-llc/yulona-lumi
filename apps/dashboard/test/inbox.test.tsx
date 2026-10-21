import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { setFetchImpl } from "../src/api/client";
import ConversationView from "../src/features/inbox/ConversationView";
import ConversationList from "../src/features/inbox/ConversationList";
import ContactList from "../src/features/contacts/ContactList";
import { applyEvent } from "../src/features/realtime/hooks";
import { RealtimeClient, backoff } from "../src/features/realtime/socket";

vi.mock("../src/auth/AuthProvider", () => ({ useAuth: () => ({ session: { user: { id: "u1", name: "Ann", email: "a@b.co", role: "agent" }, tenant: { id: "t", name: "T" } } }) }));

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const contact = { id: U(10), name: "Jane Roe", email: "jane@x.co", phone: null };
const conv = (o = {}) => ({ id: U(1), channel: "widget", status: "open", handler: "ai", assignedUserId: null, agentId: null, widgetId: null, contact, lastMessageAt: "2026-01-01T10:00:00Z", lastMessagePreview: "Hello there", lastCustomerMessageAt: "2999-01-01T00:00:00Z", createdAt: "2026-01-01T09:00:00Z", resolvedAt: null, ...o });
const msg = (n: number, o = {}) => ({ id: U(100 + n), conversationId: U(1), senderType: "contact", content: `msg ${n}`, createdAt: "2026-01-01T10:00:00Z", ...o });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const wrap = (ui: React.ReactNode, path = "/inbox/" + U(1)) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { qc, ...render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}><Routes><Route path="/inbox/:id" element={ui} /><Route path="/inbox" element={ui} /><Route path="/contacts" element={ui} /></Routes></MemoryRouter></QueryClientProvider>) };
};

beforeEach(() => localStorage.clear());

describe("conversation list", () => {
  it("shows items, unread dot, and empty state", async () => {
    setFetchImpl((async (u: string) => (u.includes("/users") ? json({ items: [] }) : json({ items: [conv()], nextCursor: null }))) as unknown as typeof fetch);
    wrap(<ConversationList />, "/inbox");
    expect(await screen.findByText("Jane Roe")).toBeInTheDocument();
    expect(screen.getByLabelText("Unread")).toBeInTheDocument();
    expect(screen.getByText("Hello there")).toBeInTheDocument();
  });
  it("renders empty and error states", async () => {
    setFetchImpl((async (u: string) => (u.includes("/users") ? json({ items: [] }) : json({ items: [], nextCursor: null }))) as unknown as typeof fetch);
    const a = wrap(<ConversationList />, "/inbox");
    expect(await screen.findByText("No conversations yet")).toBeInTheDocument();
    a.unmount();
    setFetchImpl((async () => json({ error: { code: "x", message: "boom" } }, 500)) as unknown as typeof fetch);
    wrap(<ConversationList />, "/inbox");
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load conversations");
  });
});

describe("conversation view", () => {
  it("sends optimistically and reconciles; failed send offers retry", async () => {
    let sends = 0;
    setFetchImpl((async (u: string, i: RequestInit) => {
      if (u.endsWith(`/conversations/${U(1)}`)) return json(conv());
      if (u.includes("/messages") && i.method === "POST") {
        sends++;
        if (sends === 1) return json({ error: { code: "x", message: "Nope" } }, 500);
        return json(msg(2, { senderType: "human", content: "hi back" }), 201);
      }
      if (u.includes("/messages")) return json({ items: [msg(1)], nextCursor: null });
      if (u.includes("/ai-state")) return json({ error: { code: "not_found", message: "n" } }, 404);
      if (u.includes("/contacts/")) return json({ ...contact, customAttributes: {}, identities: [], firstSeenAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
      if (u.includes("/canned")) return json({ items: [] });
      return json({ items: [] });
    }) as unknown as typeof fetch);
    const user = userEvent.setup();
    wrap(<ConversationView />);
    expect(await screen.findByText("msg 1")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Message"), "hi back");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Not sent")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("Not sent")).not.toBeInTheDocument());
    expect(screen.getAllByText("hi back")).toHaveLength(1);
    expect(sends).toBe(2);
  });

  it("internal note toggle changes the action label", async () => {
    setFetchImpl((async (u: string) => {
      if (u.endsWith(`/conversations/${U(1)}`)) return json(conv({ handler: "human" }));
      if (u.includes("/messages")) return json({ items: [], nextCursor: null });
      return json({ items: [] });
    }) as unknown as typeof fetch);
    const user = userEvent.setup();
    wrap(<ConversationView />);
    await screen.findByLabelText("Message");
    await user.click(screen.getByRole("radio", { name: "Internal note" }));
    expect(screen.getByRole("button", { name: "Add note" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hand back to AI" }).closest("header")).toBeTruthy();
  });

  it("shows a not-found state", async () => {
    setFetchImpl((async () => json({ error: { code: "not_found", message: "no" } }, 404)) as unknown as typeof fetch);
    wrap(<ConversationView />);
    expect(await screen.findByText("Conversation not found")).toBeInTheDocument();
  });
});

describe("contacts", () => {
  it("lists contacts in an accessible table", async () => {
    const c = { ...contact, customAttributes: {}, identities: [{ channel: "widget", externalId: "v" }], firstSeenAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
    setFetchImpl((async () => json({ items: [c], nextCursor: null })) as unknown as typeof fetch);
    // desktop viewport: the list renders as a table (phones get stacked cards)
    const mm = vi.spyOn(window, "matchMedia").mockImplementation(((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as never);
    wrap(<ContactList />, "/contacts");
    const row = (await screen.findByRole("link", { name: "Jane Roe" })).closest("tr")!;
    expect(within(row).getByText("jane@x.co")).toBeInTheDocument();
    mm.mockRestore();
  });
  it("renders stacked cards on a phone viewport", async () => {
    const c = { ...contact, customAttributes: {}, identities: [{ channel: "widget", externalId: "v" }], firstSeenAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
    setFetchImpl((async () => json({ items: [c], nextCursor: null })) as unknown as typeof fetch);
    wrap(<ContactList />, "/contacts");
    const link = await screen.findByRole("link", { name: /Jane Roe/ });
    expect(link.closest("tr")).toBeNull();
    expect(within(link).getByText("jane@x.co")).toBeInTheDocument();
  });
});

describe("realtime", () => {
  it("applyEvent appends a message once and drops the optimistic duplicate", () => {
    const qc = new QueryClient();
    qc.setQueryData(["messages", U(1)], { items: [msg(1), { ...msg(9, { senderType: "human", content: "yo" }), id: "tmp-1", pending: true }], nextCursor: null });
    const real = msg(2, { senderType: "human", content: "yo" });
    applyEvent(qc, { type: "message.created", conversationId: U(1), message: real as never });
    applyEvent(qc, { type: "message.created", conversationId: U(1), message: real as never });
    const items = (qc.getQueryData(["messages", U(1)]) as { items: Array<{ id: string }> }).items;
    expect(items.map((m) => m.id)).toEqual([U(101), U(102)]);
  });

  it("backoff grows and is capped", () => {
    expect(backoff(0, () => 0)).toBe(500);
    expect(backoff(3, () => 1)).toBe(8000);
    expect(backoff(20, () => 1)).toBe(30000);
  });

  it("sends the token in the first frame (not the URL) and reconnects", async () => {
    vi.useFakeTimers();
    const sockets: FakeWs[] = [];
    class FakeWs {
      static OPEN = 1; readyState = 1; sent: string[] = [];
      onopen?: () => void; onmessage?: (m: { data: string }) => void; onclose?: (e: { code: number }) => void; onerror?: () => void;
      constructor(public url: string) { sockets.push(this); }
      send(s: string) { this.sent.push(s); }
      close() { this.onclose?.({ code: 1006 }); }
    }
    vi.stubGlobal("WebSocket", FakeWs);
    const { setFetchImpl: _s, ...client } = await import("../src/api/client");
    void client;
    const rc = new RealtimeClient((u) => new FakeWs(u) as unknown as WebSocket);
    const seen: string[] = [];
    rc.on((e) => seen.push(e.type));
    rc.start();
    sockets[0]!.onopen!();
    // no access token in memory => closes instead of sending a credential-less frame
    expect(sockets[0]!.url).not.toMatch(/token/);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets.length).toBeGreaterThan(1);
    sockets[1]!.onmessage!({ data: JSON.stringify({ type: "ready", kind: "agent" }) });
    expect(rc.state).toBe("open");
    sockets[1]!.onmessage!({ data: JSON.stringify({ type: "typing", conversationId: U(1), from: "contact", typing: true }) });
    expect(seen).toContain("typing");
    rc.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
