import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider";
import { setFetchImpl } from "../src/api/client";
import { createQueryClient } from "../src/api/queryClient";
import AgentBuilderPage from "../src/features/agent-builder/AgentBuilderPage";
import { activeChips, filledCount, hasDraft, sheetRows } from "../src/features/agent-builder/model";
import type { BuilderDraft, BuilderMessage } from "../src/features/agent-builder/api";

const uid = "11111111-1111-4111-8111-111111111111";
const SID = "44444444-4444-4444-8444-444444444444";
const session = (role: string) => ({ accessToken: "t", expiresIn: 900, user: { id: uid, email: "a@b.co", name: "A", role }, tenant: { id: "22222222-2222-4222-8222-222222222222", name: "T" } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const msg = (id: string, role: BuilderMessage["role"], content: string, payload: BuilderMessage["payload"] = null): BuilderMessage => ({ id, role, content, payload, createdAt: "2026-01-01T00:00:00Z" });
const emptyDraft = (): BuilderDraft => ({ config: {}, knowledge: [], ready: false });

interface State { messages: BuilderMessage[]; draft: BuilderDraft }
function mockApi(role: string, onSend?: (body: { text?: string; choice?: string }, s: State) => Response | undefined) {
  const s: State = { messages: [msg("m1", "assistant", "What does your business do?")], draft: emptyDraft() };
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const view = () => ({ id: SID, status: "open", agentId: null, draft: s.draft, limits: { maxUserMessages: 60, userMessages: 0 }, messages: s.messages });
  setFetchImpl((async (u: string, init?: RequestInit) => {
    const p = u.replace(/^.*\/api\/v1/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: p, method: init?.method ?? "GET", body });
    if (p === "/auth/refresh") return json(session(role));
    if (p === "/agent-builder/sessions" && init?.method === "POST") return json(view(), 201);
    if (p === `/agent-builder/sessions/${SID}` && (init?.method ?? "GET") === "GET") return json(view());
    if (p === `/agent-builder/sessions/${SID}/messages`) {
      const custom = onSend?.(body, s);
      if (custom) return custom;
      s.messages.push(msg(`u${s.messages.length}`, "user", body.text ?? body.choice));
      s.draft = { ...s.draft, name: "Sunrise helper", config: { systemPrompt: "You are the assistant of Sunrise Dental. Answer only from knowledge.", greeting: "Hi there!", enabledTools: ["book_appointment"] } };
      const a = msg(`a${s.messages.length}`, "assistant", "Which tone fits?", { ask: { question: "Which tone fits?", options: ["Friendly", "Formal"] } });
      s.messages.push(a);
      return json({ assistant: a, draft: s.draft, ready: false });
    }
    if (p === `/agent-builder/sessions/${SID}/create`) return json({ agentId: "agent-1", name: "Sunrise helper", status: "draft", sandboxHint: { path: "/agents/agent-1", tab: "sandbox", message: "m" } }, 201);
    return json({ error: { code: "not_found", message: "nope" } }, 404);
  }) as unknown as typeof fetch);
  return { calls, s };
}
function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname}{l.search}</p>; }
function wrap() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/agents/new-ai"]}><AuthProvider>
        <Routes><Route path="/agents/new-ai" element={<AgentBuilderPage />} /><Route path="*" element={<Where />} /></Routes>
      </AuthProvider></MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => { document.cookie = "yl_csrf=c; path=/"; try { sessionStorage.clear(); localStorage.clear(); } catch { /* */ } });

describe("builder model", () => {
  it("derives the sheet rows and completeness from the draft", () => {
    const d: BuilderDraft = { name: "Bot", config: { systemPrompt: "x".repeat(60), greeting: "Hi", enabledTools: ["book_appointment", "qualify_lead"], escalationRules: { keywords: ["human"], maxUnansweredTurns: 3, resumeKeyword: "AI" } }, knowledge: [{ id: "1", name: "Prices", type: "text" }], ready: false };
    const rows = sheetRows(d);
    expect(rows.map((r) => r.key)).toEqual(["name", "persona", "greeting", "handoff", "tools", "knowledge"]);
    expect(rows.find((r) => r.key === "tools")!.value).toBe("Book appointments, Qualify leads");
    expect(rows.find((r) => r.key === "handoff")!.value).toContain("human");
    expect(filledCount(rows)).toBe(6);
    expect(filledCount(sheetRows(emptyDraft()))).toBe(0);
    expect(hasDraft(d)).toBe(true);
    expect(hasDraft(emptyDraft())).toBe(false);
  });
  it("quick replies only belong to the last assistant message", () => {
    const ask = msg("a", "assistant", "Tone?", { ask: { question: "Tone?", options: ["Friendly"] } });
    expect(activeChips([ask])).toEqual(["Friendly"]);
    expect(activeChips([ask, msg("t", "tool", "x")])).toEqual(["Friendly"]);
    expect(activeChips([ask, msg("u", "user", "Friendly")])).toEqual([]);
  });
});

describe("Create with AI page", () => {
  it("starts a session, sends an answer, shows chips and fills the agent sheet; chips send a choice", async () => {
    const { calls } = mockApi("owner");
    wrap();
    expect(await screen.findByText("What does your business do?")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Your answer"), "A dental clinic{Enter}");
    expect(await screen.findByText("Which tone fits?")).toBeInTheDocument();
    expect(calls.find((c) => c.url.endsWith("/messages"))!.body).toEqual({ text: "A dental clinic" });
    await waitFor(() => expect(screen.getAllByTestId("sheet-name")[0]).toHaveTextContent("Sunrise helper"));
    expect(screen.getAllByTestId("sheet-greeting")[0]).toHaveTextContent("Hi there!");
    await user.click(screen.getByRole("button", { name: "Friendly" }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/messages")).at(-1)!.body).toEqual({ choice: "Friendly" }));
  });

  it("shows the typing indicator while the assistant answers", async () => {
    let release: (r: Response) => void = () => {};
    const slow = new Promise<Response>((r) => { release = r; });
    setFetchImpl((async (u: string, init?: RequestInit) => {
      const p = String(u).replace(/^.*\/api\/v1/, "");
      if (p === "/auth/refresh") return json(session("owner"));
      if (p === "/agent-builder/sessions") return json({ id: SID, status: "open", agentId: null, draft: emptyDraft(), limits: { maxUserMessages: 60, userMessages: 0 }, messages: [msg("m1", "assistant", "Hello?")] }, 201);
      if (p.endsWith("/messages")) return slow;
      void init;
      return json({}, 404);
    }) as unknown as typeof fetch);
    wrap();
    const user = userEvent.setup();
    await screen.findByText("Hello?");
    await user.type(screen.getByLabelText("Your answer"), "hi{Enter}");
    expect(await screen.findByTestId("typing")).toBeInTheDocument();
    expect(screen.getByText("hi")).toBeInTheDocument();
    release(json({ assistant: msg("a", "assistant", "ok"), draft: emptyDraft(), ready: false }));
    await waitFor(() => expect(screen.queryByTestId("typing")).not.toBeInTheDocument());
  });

  it("Create draft is disabled until the draft has a name, persona and greeting, then navigates to the editor; Try it opens the sandbox tab", async () => {
    mockApi("owner");
    wrap();
    const user = userEvent.setup();
    await screen.findByText("What does your business do?");
    const create = () => screen.getAllByRole("button", { name: "Create draft" })[0]!;
    expect(create()).toBeDisabled();
    await user.type(screen.getByLabelText("Your answer"), "A clinic{Enter}");
    await waitFor(() => expect(create()).toBeEnabled());
    await user.click(screen.getAllByRole("button", { name: /Try it in the sandbox/ })[0]!);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/agents/agent-1?tab=sandbox"));
  });

  it("credits exhausted blocks the composer and points to buying credits", async () => {
    mockApi("owner", () => json({ error: { code: "credits_exhausted", message: "AI credits are used up.", requestId: "r1" } }, 402));
    wrap();
    const user = userEvent.setup();
    await screen.findByText("What does your business do?");
    await user.type(screen.getByLabelText("Your answer"), "hello{Enter}");
    expect(await screen.findByRole("link", { name: "Buy credits" })).toHaveAttribute("href", "/settings/usage");
    expect(screen.getByLabelText("Your answer")).toBeDisabled();
  });

  it("viewers and agents get a read-only notice and no session is started", async () => {
    const { calls } = mockApi("viewer");
    wrap();
    expect(await screen.findByText(/requires an owner or admin role/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith("/agent-builder"))).toBe(false);
  });
});
