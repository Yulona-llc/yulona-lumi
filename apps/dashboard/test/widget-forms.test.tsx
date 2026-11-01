import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider";
import { setFetchImpl } from "../src/api/client";
import AgentEditor from "../src/features/agents/AgentEditor";
import OpsSettingsPage from "../src/features/ops-settings/OpsSettingsPage";
import WidgetConfigPage from "../src/features/widget-config/WidgetConfigPage";
import { ANGLES, appearanceOf, fillOf, readableOn, withAppearance } from "../src/features/widget-config/brand";
import { cropRect } from "../src/features/widget-config/crop";

vi.mock("../src/features/widget-config/crop", async (orig) => ({ ...(await orig<typeof import("../src/features/widget-config/crop")>()), cropToBlob: async () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }) }));

const uid = "11111111-1111-4111-8111-111111111111";
const aid = "33333333-3333-4333-8333-333333333333";
const wid = "44444444-4444-4444-8444-444444444444";
const session = (role: string) => ({ accessToken: "t", expiresIn: 900, user: { id: uid, email: "a@b.co", name: "A", role }, tenant: { id: "22222222-2222-4222-8222-222222222222", name: "T" } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const widget = { id: wid, name: "Site", widgetKey: "wk_1", agentId: null, enabled: true, config: {}, prechat: { enabled: false, fields: [] }, allowedDomains: ["example.com"], hasTurnstileSecret: false, hasAvatar: false, avatarVersion: null, createdAt: "x", updatedAt: "x" };
const baseCfg = { systemPrompt: "hi", fallbackMessage: "fb", clarifyMessage: "c", handoffMessage: "h", handoffAtQualified: false, enabledTools: ["qualify_lead"], customTools: [], escalationRules: { keywords: [], maxUnansweredTurns: 3, resumeKeyword: "AI" } };
const agent = { id: aid, name: "Sales bot", description: "d", status: "draft", config: baseCfg, publishedVersion: null, createdAt: "2026-01-01", updatedAt: "2026-01-01" };

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
const patchBody = (calls: Array<{ init?: RequestInit }>) => JSON.parse(String(calls.find((c) => c.init?.method === "PATCH")!.init!.body));

const widgetRoutes = (w: typeof widget & Record<string, unknown> = widget) => ({
  [`/widgets/${wid}/embed`]: { snippet: "<script>", widgetKey: "wk_1", apiUrl: "http://x/api/v1", scriptUrl: "http://x/widget.js" },
  [`/widgets/${wid}/avatar`]: (i?: RequestInit) => (i?.method === "POST" ? json({ ...w, hasAvatar: true, avatarVersion: "v1" }) : i?.method === "DELETE" ? json({ ...w, hasAvatar: false, avatarVersion: null }) : new Response(new Blob(["x"]), { status: 200 })),
  [`/widgets/${wid}`]: (i?: RequestInit) => json({ ...w, ...(i?.method === "PATCH" ? { config: JSON.parse(String(i.body)).config ?? w.config } : {}) }),
  "/widgets": { items: [w] }, "/agents": { items: [] },
});

describe("brand helpers", () => {
  it("old configs read as a solid colour; storing keeps primaryColor in step", () => {
    expect(appearanceOf({ primaryColor: "#112233" })).toMatchObject({ mode: "solid", color: "#112233" });
    expect(appearanceOf({})).toMatchObject({ mode: "solid", color: "#f97316" });
    const c = withAppearance({ title: "x" }, { mode: "gradient", color: "#f97316", color2: "#ec4899", angle: 90 });
    expect(c.primaryColor).toBe("#f97316");
    expect(c.appearance?.color2).toBe("#ec4899");
    expect(fillOf(c.appearance!).background).toBe("linear-gradient(90deg, #f97316, #ec4899)");
    expect(readableOn("#ffee00")).toBe("#14161f");
    expect(readableOn("#1e1b4b")).toBe("#fff");
    expect(ANGLES.length).toBeGreaterThan(2);
  });
  it("square crop stays inside the picture", () => {
    expect(cropRect(400, 200, 1, 0, 0)).toEqual({ sx: 100, sy: 0, size: 200 });
    const z = cropRect(400, 200, 2, 1, 1);
    expect(z.size).toBe(100);
    expect(z.sx + z.size).toBeLessThanOrEqual(400);
    expect(z.sy + z.size).toBeLessThanOrEqual(200);
    expect(cropRect(400, 200, 99, -9, 0).size).toBe(50);
  });
});

describe("widget Appearance card", () => {
  it("picks a swatch, switches to a gradient with a preset, and saves appearance with a derived primaryColor", async () => {
    const calls = mount(<WidgetConfigPage />, "admin", widgetRoutes());
    const u = userEvent.setup();
    expect(await screen.findByRole("img", { name: /preview of your colours/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/primary color/i)).toBeNull(); // no hex field
    await u.click(screen.getByRole("button", { name: "Purple" }));
    expect(screen.getByRole("button", { name: "Purple" })).toHaveAttribute("aria-pressed", "true");
    await u.click(screen.getByRole("radio", { name: "Two colours" }));
    expect(screen.getByText("End colour")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Ocean" }));
    await u.click(screen.getByRole("radio", { name: "Top to bottom" }));
    await u.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    const cfg = patchBody(calls).config;
    expect(cfg.appearance).toEqual({ mode: "gradient", color: "#2563eb", color2: "#06b6d4", angle: 180 });
    expect(cfg.primaryColor).toBe("#2563eb");
  });
  it("opens an old config (primaryColor only) as a solid colour without marking it changed", async () => {
    mount(<WidgetConfigPage />, "admin", widgetRoutes({ ...widget, config: { primaryColor: "#0d9488" } }));
    expect(await screen.findByRole("button", { name: "Teal" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull();
  });
  it("the picture web address is under Advanced; read-only roles cannot change colours", async () => {
    mount(<WidgetConfigPage />, "agent", widgetRoutes());
    const url = await screen.findByLabelText(/picture web address/i);
    expect(url.closest("details")).not.toBeNull();
    expect(url.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Orange" })).toBeDisabled();
  });
});

describe("widget avatar upload", () => {
  it("crops client-side, uploads multipart to the avatar route, and can remove it", async () => {
    class FakeImage { width = 640; height = 480; onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_v: string) { queueMicrotask(() => this.onload?.()); } }
    vi.stubGlobal("Image", FakeImage);
    URL.createObjectURL = vi.fn(() => "blob:x"); URL.revokeObjectURL = vi.fn();
    const calls = mount(<WidgetConfigPage />, "admin", widgetRoutes());
    const u = userEvent.setup();
    const input = await screen.findByLabelText("Choose a picture");
    await u.click(screen.getByRole("button", { name: "Purple" })); // an unsaved edit
    // wrong type is refused before anything is sent
    fireEvent.change(input, { target: { files: [new File(["x"], "a.svg", { type: "image/svg+xml" })] } });
    expect(calls.some((c) => c.url.endsWith("/avatar"))).toBe(false);
    fireEvent.change(input, { target: { files: [new File(["x"], "me.png", { type: "image/png" })] } });
    const use = await screen.findByRole("button", { name: "Use this picture" });
    await waitFor(() => expect(use).toBeEnabled());
    await u.click(use);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith(`/widgets/${wid}/avatar`) && c.init?.method === "POST")).toBe(true));
    const post = calls.find((c) => c.init?.method === "POST" && c.url.endsWith("/avatar"))!;
    expect(post.init!.body).toBeInstanceOf(FormData);
    expect((post.init!.body as FormData).get("file")).toBeInstanceOf(File);
    // the picture saves on its own and must not discard the unsaved colour edit
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use this picture" })).toBeNull());
    expect(screen.getByRole("button", { name: "Purple" })).toHaveAttribute("aria-pressed", "true");
    vi.unstubAllGlobals();
  });
});

describe("chip inputs and simpler forms", () => {
  it("allowed domains: add with Enter, normalise a pasted address, reject nonsense, remove", async () => {
    const calls = mount(<WidgetConfigPage />, "admin", widgetRoutes());
    const u = userEvent.setup();
    const box = await screen.findByLabelText("Add your website");
    await u.type(box, "https://Shop.Example.org/pricing?x=1{enter}");
    expect(await screen.findByText("https://shop.example.org")).toBeInTheDocument();
    await u.type(box, "bad domain!{enter}");
    expect(await screen.findByText(/does not look like a website address/)).toBeInTheDocument();
    await u.clear(box);
    await u.click(screen.getByRole("button", { name: "Remove example.com" }));
    await u.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    expect(patchBody(calls).allowedDomains).toEqual(["https://shop.example.org"]);
  });
  it("Advanced protection is collapsed until Turnstile is on", async () => {
    mount(<WidgetConfigPage />, "admin", widgetRoutes());
    const sw = await screen.findByRole("switch", { name: /honeypot field/i });
    expect(sw.closest("details")).not.toHaveAttribute("open");
  });
});

describe("agent editor simplified fields", () => {
  const routes = (models: unknown) => ({ "/models": models, [`/agents/${aid}/versions`]: { items: [] }, "/knowledge": { items: [] }, [`/agents/${aid}`]: () => json(agent) });
  it("SaaS: Model is a select of enabled models; temperature is a slider with plain words", async () => {
    const calls = mount(<AgentEditor />, "admin", routes({ mode: "saas", models: ["deepseek-chat", "gpt-x"] }), `/agents/${aid}`);
    const u = userEvent.setup();
    await u.click(await screen.findByRole("tab", { name: "Knowledge" }));
    const sel = await screen.findByLabelText("Model");
    expect(sel.tagName).toBe("SELECT");
    await u.selectOptions(sel, "gpt-x");
    const slider = screen.getByLabelText("Reply style");
    expect(slider).toHaveAttribute("type", "range");
    expect(screen.getByText("Workspace default", { selector: "span.font-medium" })).toBeInTheDocument();
    fireEvent.change(slider, { target: { value: "0.2" } });
    expect(screen.getByText("Precise", { selector: "span.font-medium" })).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: /save draft/i }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    expect(patchBody(calls).config).toMatchObject({ model: "gpt-x", temperature: 0.2 });
  });
  it("self-hosted: Model is free text", async () => {
    mount(<AgentEditor />, "admin", routes({ mode: "selfhosted", models: [] }), `/agents/${aid}`);
    const u = userEvent.setup();
    await u.click(await screen.findByRole("tab", { name: "Knowledge" }));
    await waitFor(() => expect(screen.getByLabelText("Model").tagName).toBe("INPUT"));
  });
  it("escalation words and blocked phrases are chips", async () => {
    const calls = mount(<AgentEditor />, "admin", routes({ mode: "selfhosted", models: [] }), `/agents/${aid}`);
    const u = userEvent.setup();
    await u.click(await screen.findByRole("tab", { name: "Escalation" }));
    await u.type(await screen.findByLabelText("Words that call a person"), "refund, complaint{enter}");
    expect(screen.getByText("refund")).toBeInTheDocument();
    expect(screen.getByText("complaint")).toBeInTheDocument();
    await u.type(screen.getByLabelText("Blocked phrases"), "buy pills{enter}");
    await u.click(screen.getByRole("button", { name: /save draft/i }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PATCH")).toBe(true));
    const c = patchBody(calls).config;
    expect(c.escalationRules.keywords).toEqual(["refund", "complaint"]);
    expect(c.abuse.blockedPhrases).toContain("buy pills");
  });
});

describe("ops settings time zone", () => {
  const settings = { timezone: "UTC", businessHours: [], holidays: [], slaMinutes: { urgent: 15, high: 60, normal: 240, low: 1440 }, outOfHours: { mode: "ai_only", message: null }, assignment: { mode: "manual" } };
  it("starts from this computer's time zone for a workspace that never set one, as a searchable select", async () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation((() => ({ resolvedOptions: () => ({ timeZone: "Africa/Addis_Ababa" }) })) as never);
    mount(<OpsSettingsPage />, "admin", { "/ops/settings": settings, "/settings": settings });
    const combo = await screen.findByRole("combobox", { name: /time zone/i }, { timeout: 4000 });
    await waitFor(() => expect(combo).toHaveTextContent("Africa/Addis_Ababa"));
    vi.restoreAllMocks();
  });
});
