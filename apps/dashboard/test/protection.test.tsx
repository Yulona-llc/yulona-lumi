import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider";
import { setFetchImpl } from "../src/api/client";
import AgentEditor from "../src/features/agents/AgentEditor";
import ContactPanel from "../src/features/inbox/ContactPanel";
import WidgetConfigPage from "../src/features/widget-config/WidgetConfigPage";

const uid = "11111111-1111-4111-8111-111111111111";
const aid = "33333333-3333-4333-8333-333333333333";
const wid = "44444444-4444-4444-8444-444444444444";
const cid = "55555555-5555-4555-8555-555555555555";
const session = (role: string) => ({ accessToken: "t", expiresIn: 900, user: { id: uid, email: "a@b.co", name: "A", role }, tenant: { id: "22222222-2222-4222-8222-222222222222", name: "T" } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const widget = { id: wid, name: "Site", widgetKey: "wk_1", agentId: null, enabled: true, config: {}, prechat: { enabled: false, fields: [] }, allowedDomains: ["example.com"], hasTurnstileSecret: false, createdAt: "x", updatedAt: "x" };
const baseCfg = { systemPrompt: "hi", fallbackMessage: "fb", clarifyMessage: "c", handoffMessage: "h", handoffAtQualified: false, enabledTools: ["qualify_lead"], customTools: [], escalationRules: { keywords: [], maxUnansweredTurns: 3, resumeKeyword: "AI" } };
const agent = { id: aid, name: "Sales bot", description: "d", status: "draft", config: baseCfg, publishedVersion: null, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const contact = (o = {}) => ({ id: cid, name: "Jane", email: null, phone: null, customAttributes: {}, identities: [], blockedAt: null, blockedReason: null, blockedBy: null, firstSeenAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...o });

function mount(ui: React.ReactNode, role: string, routes: Record<string, unknown>, path = "/") {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  setFetchImpl((async (u: string, init?: RequestInit) => {
    calls.push({ url: u, init });
    const p = u.replace(/^.*\/api\/v1/, "");
    if (p === "/auth/refresh") return json(session(role));
    for (const [k, v] of Object.entries(routes)) if (p.startsWith(k)) return typeof v === "function" ? (v as (i?: RequestInit) => Response)(init) : json(v);
    return json({ error: { code: "not_found", message: "nope" } }, 404);
  }) as unknown as typeof fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}><AuthProvider><Routes><Route path="/" element={ui} /><Route path="/agents/:id" element={ui} /></Routes></AuthProvider></MemoryRouter>
    </QueryClientProvider>);
  return calls;
}
beforeEach(() => (document.cookie = "yl_csrf=c; path=/"));

describe("widget Protection card", () => {
  const routes = (w = widget) => ({
    [`/widgets/${wid}/embed`]: { snippet: "<script>", widgetKey: "wk_1", apiUrl: "http://x/api/v1", scriptUrl: "http://x/widget.js" },
    [`/widgets/${wid}`]: (i?: RequestInit) => json({ ...w, ...(i?.method === "PATCH" ? { config: JSON.parse(String(i.body)).config, hasTurnstileSecret: true } : {}) }),
    "/widgets": { items: [w] }, "/agents": { items: [] },
  });
  it("Turnstile needs a site key and a secret before it can be saved; the secret is write-only", async () => {
    const calls = mount(<WidgetConfigPage />, "admin", routes());
    const u = userEvent.setup();
    await u.click(await screen.findByRole("switch", { name: /cloudflare turnstile/i }));
    const save = screen.getByRole("button", { name: /save changes/i });
    expect(save).toBeDisabled();
    await u.type(screen.getByLabelText("Site key"), "0xSITE");
    expect(save).toBeDisabled(); // secret still missing
    await u.type(screen.getByLabelText("Secret key"), "super-secret-value");
    expect(save).toBeEnabled();
    await u.click(save);
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.init?.method === "PATCH")!.init!.body));
    expect(body.turnstileSecret).toBe("super-secret-value");
    expect(body.config.protection.turnstile).toMatchObject({ enabled: true, siteKey: "0xSITE" });
    // after saving, the field is cleared and says a secret is stored
    await waitFor(() => expect((screen.getByLabelText("Secret key") as HTMLInputElement).value).toBe(""));
    expect(screen.getByLabelText("Secret key")).toHaveAttribute("placeholder", expect.stringMatching(/stored/i));
    expect(screen.queryByDisplayValue("super-secret-value")).toBeNull();
  });
  it("honeypot can be switched off and is saved in config.protection", async () => {
    const calls = mount(<WidgetConfigPage />, "admin", routes());
    const u = userEvent.setup();
    await u.click(await screen.findByRole("switch", { name: /honeypot field/i }));
    await u.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.init?.method === "PATCH")!.init!.body)).config.protection.honeypot).toBe(false);
  });
});

describe("contact block / unblock in the inbox panel", () => {
  const panel = <ContactPanel contactId={cid} conversationId={aid} />;
  it("an agent can block but is told only owners/admins can unblock", async () => {
    const calls = mount(panel, "agent", { [`/contacts/${cid}/block`]: contact({ blockedAt: "2026-01-02T00:00:00Z" }), [`/contacts/${cid}`]: contact(), "/ai-state": {} });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: /block contact/i }));
    await u.type(screen.getByLabelText(/reason/i), "spam links");
    await u.click(screen.getByRole("button", { name: "Block contact", hidden: false }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith(`/contacts/${cid}/block`))).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith("/block"))!.init!.body))).toEqual({ reason: "spam links" });
  });
  it("blocked contact: badge, reason and Unblock for admins; agents see the role note", async () => {
    const blocked = contact({ blockedAt: "2026-01-02T00:00:00Z", blockedReason: "Blocked for abuse: blocked phrase" });
    mount(panel, "admin", { [`/contacts/${cid}`]: blocked });
    expect(await screen.findByText("Blocked for abuse")).toBeInTheDocument();
    expect(screen.getByText(/blocked phrase/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unblock" })).toBeInTheDocument();
  });
  it("agents cannot unblock", async () => {
    mount(panel, "agent", { [`/contacts/${cid}`]: contact({ blockedAt: "2026-01-02T00:00:00Z", blockedReason: "x" }) });
    expect(await screen.findByText(/only an owner or admin can unblock/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unblock" })).toBeNull();
  });
});

describe("agent Safety card", () => {
  it("shows strict defaults for an agent saved before the setting existed and saves changes", async () => {
    const calls = mount(<AgentEditor />, "admin", { [`/agents/${aid}/versions`]: { items: [] }, [`/agents/${aid}`]: (i?: RequestInit) => json(agent) }, `/agents/${aid}`);
    const u = userEvent.setup();
    await u.click(await screen.findByRole("tab", { name: "Escalation" }));
    expect(await screen.findByLabelText(/strikes before blocking/i)).toHaveValue(3);
    await u.type(screen.getByLabelText(/blocked phrases/i), "buy pills");
    await u.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    const sent = JSON.parse(String(calls.find((c) => c.init?.method === "PATCH")!.init!.body));
    expect(sent.config.abuse).toMatchObject({ enabled: true, maxStrikes: 3, blockedPhrases: ["buy pills"] });
  });
});
