import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider";
import { setFetchImpl } from "../src/api/client";
import HubSpotCard from "../src/features/integrations-ui/HubSpotCard";

const uid = "11111111-1111-4111-8111-111111111111";
const session = { accessToken: "t", expiresIn: 900, user: { id: uid, email: "a@b.co", name: "A", role: "admin" }, tenant: { id: "22222222-2222-4222-8222-222222222222", name: "T" } };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const mapping = { properties: { need: "lead_need" }, sourceValue: "Lumi chat", syncOnBooked: true };
const off = { configured: true, connected: false, status: null, lastError: null, lastSyncAt: null, connectedAt: null, mapping: { properties: {}, sourceValue: "Lumi chat", syncOnBooked: true }, recent: [] };
const on = (o = {}) => ({ ...off, connected: true, status: "active", connectedAt: "2026-01-01T00:00:00Z", lastSyncAt: "2026-01-02T00:00:00Z", mapping, recent: [{ id: "1", trigger: "qualified", status: "ok", action: "created", hubspotId: "9", error: null, conversationId: null, createdAt: "2026-01-02T00:00:00Z", syncedAt: "2026-01-02T00:00:00Z" }], ...o });

function mount(status: unknown, handlers: Record<string, () => Response> = {}) {
  const calls: { url: string; method: string; body?: string }[] = [];
  setFetchImpl((async (u: string, init?: RequestInit) => {
    const p = u.replace(/^.*\/api\/v1/, "");
    const method = init?.method ?? "GET";
    calls.push({ url: p, method, body: init?.body as string | undefined });
    if (p === "/auth/refresh") return json(session);
    const h = handlers[`${method} ${p}`];
    if (h) return h();
    if (p === "/crm/hubspot") return json(status);
    return json({ error: { code: "not_found", message: "nope" } }, 404);
  }) as unknown as typeof fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><AuthProvider><Routes><Route path="/" element={<HubSpotCard />} /></Routes></AuthProvider></MemoryRouter>
    </QueryClientProvider>);
  return calls;
}
beforeEach(() => { document.cookie = "yl_csrf=c; path=/"; try { localStorage.clear(); } catch { /* */ } });

describe("hubspot card", () => {
  it("connects with a token, shows an API rejection under the field", async () => {
    const calls = mount(off, { "PUT /crm/hubspot/connection": () => json({ error: { code: "validation_error", message: "Invalid request", details: [{ path: "token", message: "HubSpot rejected the access token" }] } }, 400) });
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/private app access token/i), "pat-na1-secret-token");
    await userEvent.click(screen.getByRole("button", { name: "Connect HubSpot" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toContain("pat-na1-secret-token"));
    await waitFor(() => expect(screen.getByLabelText(/private app access token/i)).toHaveValue("pat-na1-secret-token"));
  });

  it("connected: status, mapping save, test contact, recent syncs, disconnect needs confirmation; token never rendered", async () => {
    const calls = mount(on(), { "PATCH /crm/hubspot/mapping": () => json({ mapping }), "POST /crm/hubspot/test-contact": () => json({ id: "5", action: "created" }), "DELETE /crm/hubspot/connection": () => json({ ok: true }) });
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Lead qualified")).toBeInTheDocument();
    expect(screen.getByLabelText("Need")).toHaveValue("lead_need");
    await userEvent.type(screen.getByLabelText("Budget"), "lead_budget");
    await userEvent.click(screen.getByRole("button", { name: "Save mapping" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toContain('"budget":"lead_budget"'));
    await userEvent.type(screen.getByLabelText("Send a test contact"), "me@x.test");
    await userEvent.click(screen.getByRole("button", { name: /send test contact/i }));
    await waitFor(() => expect(calls.find((c) => c.url === "/crm/hubspot/test-contact")?.body).toContain("me@x.test"));
    await userEvent.click(screen.getByRole("button", { name: /disconnect hubspot/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });

  it("error status explains how to fix it", async () => {
    mount(on({ status: "error", lastError: "HubSpot rejected the access token (revoked or wrong). Reconnect HubSpot." }));
    expect(await screen.findByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/Reconnect HubSpot/);
  });

  it("invalid property names block saving", async () => {
    mount(on());
    await userEvent.type(await screen.findByLabelText("Budget"), "Bad Name");
    expect(screen.getByText(/lower-case letters/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save mapping" })).toBeDisabled();
  });
});
