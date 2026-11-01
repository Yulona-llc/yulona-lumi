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
  it("add URL: follow links on by default (depth 3, 25 pages), stepper is bounded, body carries the crawl settings", async () => {
    const calls = mount(<KnowledgePage />, "admin", { "/knowledge/sources/url": (i?: RequestInit) => json({ id: "n", ...(JSON.parse(String(i?.body))) }, 201), "/knowledge/sources": { items: [] }, "/agents": { items: [] } });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: /add url/i }));
    expect(screen.getByRole("switch", { name: "Follow links on this site" })).toBeChecked();
    expect(screen.getByLabelText("Depth")).toHaveTextContent("3");
    expect(screen.getByText(/How many clicks away from this page/)).toBeInTheDocument();
    expect(screen.getByLabelText("Max pages")).toHaveValue(25);
    expect(screen.getByRole("switch", { name: "Include subdomains" })).not.toBeChecked();
    for (let i = 0; i < 4; i++) await u.click(screen.getByRole("button", { name: "Go deeper" }));
    expect(screen.getByLabelText("Depth")).toHaveTextContent("5");
    expect(screen.getByRole("button", { name: "Go deeper" })).toBeDisabled();
    await u.click(screen.getByRole("button", { name: "Go less deep" }));
    expect(screen.getByLabelText("Depth")).toHaveTextContent("4");
    await u.clear(screen.getByLabelText("Max pages"));
    await u.type(screen.getByLabelText("Max pages"), "999");
    expect(screen.getByLabelText("Max pages")).toHaveValue(50);
    await u.click(screen.getByRole("switch", { name: "Include subdomains" }));
    await u.type(screen.getByLabelText("URL"), "https://example.com/help");
    await u.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/knowledge/sources/url"))).toBe(true));
    const post = calls.find((c) => c.url.endsWith("/knowledge/sources/url"))!;
    expect(JSON.parse(String(post.init?.body))).toEqual({ url: "https://example.com/help", followLinks: true, maxDepth: 4, maxPages: 50, includeSubdomains: true });
  });
  it("add URL: turning Follow links off hides the options and reads one page", async () => {
    const calls = mount(<KnowledgePage />, "admin", { "/knowledge/sources/url": (i?: RequestInit) => json({ id: "n", ...(JSON.parse(String(i?.body))) }, 201), "/knowledge/sources": { items: [] }, "/agents": { items: [] } });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: /add url/i }));
    await u.click(screen.getByRole("switch", { name: "Follow links on this site" }));
    expect(screen.queryByLabelText("Max pages")).toBeNull();
    expect(screen.queryByRole("button", { name: "Go deeper" })).toBeNull();
    await u.type(screen.getByLabelText("URL"), "https://example.com/");
    await u.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/knowledge/sources/url"))).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith("/knowledge/sources/url"))!.init?.body))).toEqual({ url: "https://example.com/", followLinks: false, maxPages: 1 });
  });
  it("shows crawl progress while reading and a summary afterwards, and lists pages read in the sections view", async () => {
    const base = { agentId: null, type: "url", error: null, sourceUrl: "https://x.co", fileName: null, sizeBytes: 10, attempts: 1, lastIngestedAt: null, createdAt: "x", updatedAt: "x", maxPages: 25, maxDepth: 3, followLinks: true, includeSubdomains: false };
    const busy = { ...base, id: "s1", name: "Busy", status: "processing", chunkCount: 0, crawlProgress: { pagesCrawled: 4, pagesFound: 12, pagesSkipped: 0, done: false } };
    const done = { ...base, id: "s2", name: "Done", status: "ready", chunkCount: 2, crawlProgress: { pagesCrawled: 2, pagesFound: 3, pagesSkipped: 1, done: true } };
    const chunks = [{ id: "c1", chunkIndex: 0, title: "/ › Home", content: "a", tokenCount: 5, url: "https://x.co/" }, { id: "c2", chunkIndex: 1, title: "/pricing", content: "b", tokenCount: 5, url: "https://x.co/pricing" }];
    mount(<KnowledgePage />, "admin", { "/knowledge/sources/s2/chunks": { items: chunks }, "/knowledge/sources": { items: [busy, done] }, "/agents": { items: [] } });
    expect(await screen.findByText("Reading pages: 4 read, 12 found so far (up to 25).")).toBeInTheDocument();
    expect(screen.getByText("Read 2 pages, skipped 1.")).toBeInTheDocument();
    const u = userEvent.setup();
    await u.click(screen.getAllByRole("button", { name: /^Sections/ })[1]!);
    expect(await screen.findByText("Pages read (2)")).toBeInTheDocument();
    expect(screen.getAllByText("https://x.co/pricing").length).toBeGreaterThan(0);
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
  it("validates domains before saving", async () => {
    mount(<WidgetConfigPage />, "admin", { [`/widgets/${wid}/embed`]: { snippet: "<script>", widgetKey: "wk_1", apiUrl: "http://x/api/v1", scriptUrl: "http://x/widget.js" }, "/widgets": { items: [widget] }, "/agents": { items: [] } });
    const u = userEvent.setup();
    const dom = await screen.findByLabelText(/add your website/i);
    await u.type(dom, "not a domain!{enter}");
    expect(await screen.findByText(/does not look like a website address/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull(); // nothing was added, nothing to save
  });
  it("preview doc escapes script-breaking content", () => {
    const d = previewDoc({ widgetKey: "</script><b>", apiBase: "x", scriptUrl: "/w.js" });
    expect(d).not.toContain("</script><b>");
  });
});
