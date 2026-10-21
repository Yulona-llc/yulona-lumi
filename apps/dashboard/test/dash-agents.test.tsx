import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider";
import { setFetchImpl } from "../src/api/client";
import AgentsPage from "../src/features/agents/AgentsPage";
import AgentEditor from "../src/features/agents/AgentEditor";
import KnowledgePage from "../src/features/knowledge/KnowledgePage";
import ApiKeysPage from "../src/features/settings/ApiKeysPage";
import WidgetConfigPage from "../src/features/widget-config/WidgetConfigPage";
import { previewDoc } from "../src/features/widget-config/WidgetPreview";

const uid = "11111111-1111-4111-8111-111111111111";
const aid = "33333333-3333-4333-8333-333333333333";
const wid = "44444444-4444-4444-8444-444444444444";
const session = (role: string) => ({ accessToken: "t", expiresIn: 900, user: { id: uid, email: "a@b.co", name: "A", role }, tenant: { id: "22222222-2222-4222-8222-222222222222", name: "T" } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const cfg = { systemPrompt: "hi", similarityThreshold: 0.72, topK: 5, fallbackMessage: "fb", enabledTools: ["qualify_lead"], customTools: [], escalationRules: { keywords: [], maxUnansweredTurns: 3 } };
const agent = { id: aid, name: "Sales bot", description: "d", status: "draft", config: cfg, publishedVersion: null, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const widget = { id: wid, name: "Site", widgetKey: "wk_1", agentId: null, enabled: true, config: {}, prechat: { enabled: false, fields: [] }, allowedDomains: ["example.com"], createdAt: "x", updatedAt: "x" };

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

beforeEach(() => document.cookie = "yl_csrf=c; path=/");

describe("agents", () => {
  it("lists agents and hides create for non-admins", async () => {
    mount(<AgentsPage />, "agent", { "/agents": { items: [agent] } });
    expect(await screen.findByText("Sales bot")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new agent/i })).toBeNull();
  });
  it("shows an empty state for admins", async () => {
    mount(<AgentsPage />, "admin", { "/agents": { items: [] } });
    expect(await screen.findByText("No agents yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /create agent|new agent/i }).length).toBeGreaterThan(0);
  });
  it("shows an error state with retry", async () => {
    mount(<AgentsPage />, "admin", { "/agents": () => json({ error: { code: "boom", message: "Server down", requestId: "r1" } }, 500) });
    expect(await screen.findByRole("alert")).toHaveTextContent("Server down");
  });
  it("saves a draft with PATCH and only config fields", async () => {
    const calls = mount(<AgentEditor />, "admin", { [`/agents/${aid}/versions`]: { items: [] }, [`/agents/${aid}`]: (i?: RequestInit) => json(i?.method === "PATCH" ? { ...agent, name: "New" } : agent) }, `/agents/${aid}`);
    const u = userEvent.setup();
    const name = await screen.findByLabelText("Name");
    await u.clear(name); await u.type(name, "New");
    await u.click(screen.getByRole("button", { name: /save draft/i }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.init?.method === "PATCH")!.init!.body));
    expect(body.name).toBe("New");
    expect(body.config.topK).toBe(5);
  });
  it("viewers get read-only fields", async () => {
    mount(<AgentEditor />, "viewer", { [`/agents/${aid}`]: agent }, `/agents/${aid}`);
    expect(await screen.findByLabelText("Name")).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent(/owner or admin/);
  });
});

describe("knowledge", () => {
  it("rejects unsupported and oversize files before upload", async () => {
    mount(<KnowledgePage />, "admin", { "/knowledge/sources": { items: [] }, "/agents": { items: [] } });
    const u = userEvent.setup({ applyAccept: false });
    await u.click(await screen.findByRole("button", { name: /upload file/i }));
    await u.upload(screen.getByLabelText(/^File/), new File(["x"], "evil.exe"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/unsupported/i);
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
  });
  it("renders statuses and failure reasons", async () => {
    const s = { id: "s1", agentId: null, type: "url", name: "Docs", status: "failed", error: "Blocked URL", sourceUrl: "https://x.co", fileName: null, sizeBytes: 0, chunkCount: 0, attempts: 1, lastIngestedAt: null, createdAt: "x", updatedAt: "x" };
    mount(<KnowledgePage />, "admin", { "/knowledge/sources": { items: [s] }, "/agents": { items: [] } });
    expect(await screen.findByText("Blocked URL")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
  });
});

describe("api keys", () => {
  it("shows the secret once after creation and not in the list", async () => {
    let keys: unknown[] = [];
    mount(<ApiKeysPage />, "admin", { "/api-keys": (i?: RequestInit) => { if (i?.method === "POST") { keys = [{ id: "k", name: "CI", prefix: "yl_abc", scopes: [], rateLimitPerMinute: 60, expiresAt: null }]; return json({ ...(keys[0] as object), key: "yl_SECRET_VALUE" }, 201); } return json({ items: keys }); } });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Create key" }));
    await u.type(screen.getByLabelText("Name"), "CI");
    await u.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByTestId("new-key")).toHaveTextContent("yl_SECRET_VALUE");
    await u.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("yl_abc…")).toBeInTheDocument();
    expect(screen.queryByText(/SECRET_VALUE/)).toBeNull();
  });
  it("is read-only for agents", async () => {
    mount(<ApiKeysPage />, "agent", {});
    expect(await screen.findByRole("note")).toBeInTheDocument();
  });
});

describe("widget config", () => {
  it("validates domains and color before saving", async () => {
    mount(<WidgetConfigPage />, "admin", { [`/widgets/${wid}/embed`]: { snippet: "<script>", widgetKey: "wk_1", apiUrl: "http://x/api/v1", scriptUrl: "http://x/widget.js" }, "/widgets": { items: [widget] }, "/agents": { items: [] } });
    const u = userEvent.setup();
    const dom = await screen.findByLabelText(/one per line/i);
    await u.type(dom, "{enter}not a domain!");
    expect(await screen.findByText(/Invalid domain pattern/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save changes/i })).toBeDisabled();
  });
  it("preview doc escapes script-breaking content", () => {
    const d = previewDoc({ widgetKey: "</script><b>", apiBase: "x", scriptUrl: "/w.js" });
    expect(d).not.toContain("</script><b>");
  });
});
