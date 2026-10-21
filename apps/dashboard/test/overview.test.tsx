import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider";
import { setFetchImpl } from "../src/api/client";
import OverviewPage from "../src/features/overview/OverviewPage";
import { buildFunnel, waitLabel } from "../src/features/overview/api";

const session = { accessToken: "t", expiresIn: 900, user: { id: "11111111-1111-4111-8111-111111111111", email: "a@b.co", name: "Ada Obi", role: "owner" }, tenant: { id: "22222222-2222-4222-8222-222222222222", name: "Acme" } };
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
const conv = (n: number, extra: Record<string, unknown> = {}) => ({ id: `c${n}`, status: "open", handler: "ai", createdAt: new Date().toISOString(), lastMessageAt: new Date().toISOString(), lastCustomerMessageAt: new Date().toISOString(), contact: { id: "x", name: null, email: n % 2 ? "a@b.co" : null, phone: null }, ...extra });

function mount(routes: Record<string, unknown>) {
  setFetchImpl((async (u: string) => {
    const p = u.replace(/^.*\/api\/v1/, "");
    if (p === "/auth/refresh") return json(session);
    for (const [k, v] of Object.entries(routes)) if (p.startsWith(k)) return json(v);
    return new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), { status: 404 });
  }) as unknown as typeof fetch);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><AuthProvider><Routes><Route path="/*" element={<OverviewPage />} /></Routes></AuthProvider></MemoryRouter></QueryClientProvider>);
}

describe("overview", () => {
  it("builds a narrowing funnel", () => {
    const steps = buildFunnel([conv(1), conv(2), conv(3, { lastCustomerMessageAt: null })] as never, [{ id: "b", status: "booked", conversationId: "c1", startAt: "" }], 0);
    expect(steps.map((s) => s.count)).toEqual([3, 2, 1, 1]);
    expect(waitLabel(new Date(Date.now() - 5 * 60000).toISOString())).toBe("5 min");
  });
  it("shows the setup checklist and empty funnel for a new workspace", async () => {
    mount({ "/usage": { series: [] }, "/conversations": { items: [], nextCursor: null }, "/needs-attention": { items: [] }, "/bookings": { items: [] }, "/agents": { items: [] }, "/knowledge": { items: [] }, "/channels": { items: [] }, "/widgets": { items: [] } });
    expect(await screen.findByTestId("setup-checklist")).toHaveTextContent("Create an agent");
    expect(await screen.findByText(/no conversations yet/i)).toBeInTheDocument();
  });
  it("renders the funnel, right-now strip and needs-you list", async () => {
    mount({
      "/usage": { series: [{ day: new Date().toISOString().slice(0, 10), metric: "conversations", value: 4 }] },
      "/conversations": { items: [conv(1), conv(2)], nextCursor: null },
      "/needs-attention": { items: [{ id: "h1", type: "stage", reason: "pricing", summary: "Wants a quote", state: "open", createdAt: new Date(Date.now() - 600000).toISOString(), conversation: { id: "c1", channel: "widget", lastMessagePreview: null }, contact: { id: "x", name: "Sam", email: null, phone: null } }] },
      "/bookings": { items: [] }, "/agents": { items: [{ id: "a", status: "published" }] }, "/knowledge": { items: [{ id: "s", status: "ready" }] }, "/channels": { items: [{ id: "c" }] }, "/widgets": { items: [] },
    });
    expect(await screen.findByTestId("funnel-engaged")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /sam/i })).toHaveAttribute("href", "/inbox/c1");
    expect(screen.queryByTestId("setup-checklist")).toBeNull();
    expect(await screen.findByTestId("right-now")).toHaveTextContent("AI is handling");
  });
});
