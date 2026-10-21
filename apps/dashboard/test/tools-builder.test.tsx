import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toolManifestV2Schema } from "@yulona/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider";
import { setFetchImpl } from "../src/api/client";
import ConnectionsPage from "../src/features/tools/ConnectionsPage";
import { ConnectionForm } from "../src/features/tools/ConnectionForm";
import { ToolBuilder } from "../src/features/tools/ToolBuilder";
import { TEMPLATES, buildManifest, draftFromManifest, draftFromTemplate, matchTemplate, previewRequest, problems, snake, uniqueName } from "../src/features/tools/model";

const CID = "33333333-3333-4333-8333-333333333333";
const uid = "11111111-1111-4111-8111-111111111111";
const session = (role: string) => ({ accessToken: "t", expiresIn: 900, user: { id: uid, email: "a@b.co", name: "A", role }, tenant: { id: "22222222-2222-4222-8222-222222222222", name: "T" } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const conn = (o = {}) => ({ id: CID, name: "Orders system", kind: "http", baseUrl: "https://shop.example/v1", authType: "bearer", authHeaderName: null, testPath: "/health", hasSecret: true, createdBy: uid, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...o });

type Handler = (url: string, init: { method: string; body?: string }) => Response | undefined;
function mockApi(role: string, handler: Handler) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  setFetchImpl((async (u: string, init?: RequestInit) => {
    const p = u.replace(/^.*\/api\/v1/, "");
    const c = { url: p, method: init?.method ?? "GET", body: init?.body as string | undefined };
    calls.push(c);
    if (p === "/auth/refresh") return json(session(role));
    return handler(p, c) ?? json({ error: { code: "not_found", message: "nope" } }, 404);
  }) as unknown as typeof fetch);
  return calls;
}
function wrap(ui: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><AuthProvider>{ui}</AuthProvider></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => { document.cookie = "yl_csrf=c; path=/"; try { localStorage.clear(); } catch { /* */ } });

describe("tool model", () => {
  it("every template pre-fills a draft that builds a manifest valid against toolManifestV2Schema", () => {
    for (const t of TEMPLATES) {
      const d = draftFromTemplate(t, [], CID);
      d.title = d.title || "My tool"; d.name = d.name || "my_tool";
      const r = toolManifestV2Schema.safeParse(buildManifest(d));
      expect(r.success, `${t.id}: ${JSON.stringify(r.success ? "" : r.error.issues)}`).toBe(true);
      expect(problems(d, [])).toEqual([]);
    }
  });
  it("generates unique snake_case field names and a model-facing description, and path fields stay in sync", () => {
    expect(snake("Phone number!")).toBe("phone_number");
    expect(snake("3rd floor")).toBe("field_3rd_floor");
    expect(uniqueName("date", ["date"])).toBe("date_2");
    const d = draftFromTemplate(TEMPLATES.find((t) => t.id === "lookup")!, [], CID);
    const m = toolManifestV2Schema.parse(buildManifest(d));
    expect(m.request.path).toBe("/orders/{{order_number}}");
    expect(m.request.fields).toEqual([{ name: "order_number", in: "path" }]);
    expect(m.description).toMatch(/Ask the customer for: Order number/);
    expect((m.inputSchema as { required: string[] }).required).toEqual(["order_number"]);
    expect(m.allowedStages).toContain("engaged");
  });
  it("round-trips a manifest through the draft (edit) and masks secrets in the request preview", () => {
    const d = draftFromTemplate(TEMPLATES.find((t) => t.id === "book")!, [], CID);
    const m = toolManifestV2Schema.parse(buildManifest(d));
    const back = draftFromManifest(m);
    expect(toolManifestV2Schema.parse(buildManifest(back))).toEqual(m);
    const pv = previewRequest(d, { baseUrl: "https://x.test", authType: "bearer", authHeaderName: null });
    expect(JSON.stringify(pv)).not.toMatch(/Bearer [a-z0-9]{8}/i);
    expect(pv.headers).toContainEqual(["Authorization", expect.stringMatching(/^Bearer •+$/)]);
  });
  it("keyword prefill is local and picks the closest template", () => {
    expect(matchTemplate("where is my order?")?.id).toBe("lookup");
    expect(matchTemplate("book a haircut")?.id).toBe("book");
    expect(matchTemplate("zzz")).toBeNull();
  });
});

describe("connection secrets are write-only", () => {
  it("after save only a masked state shows; the typed secret never appears, and replacing starts empty", async () => {
    const calls = mockApi("admin", (p, c) => (p === "/tool-connections" && c.method === "POST" ? json(conn(), 201) : undefined));
    const done = vi.fn();
    const { unmount } = wrap(<ConnectionForm onDone={done} />);
    await userEvent.type(screen.getByLabelText("Connection name"), "Orders system");
    await userEvent.clear(screen.getByLabelText(/Web address/));
    await userEvent.type(screen.getByLabelText(/Web address/), "https://shop.example/v1");
    await userEvent.type(screen.getByLabelText("Token"), "tok_SUPERSECRET");
    expect(screen.getByLabelText("Token")).toHaveAttribute("type", "password");
    await userEvent.click(screen.getByRole("button", { name: "Save connection" }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(JSON.parse(calls.find((c) => c.url === "/tool-connections" && c.method === "POST")!.body!)).toMatchObject({ authType: "bearer", secret: "tok_SUPERSECRET" });
    unmount();
    const saved = conn();
    wrap(<ConnectionForm initial={saved as never} onDone={() => {}} />);
    expect(screen.getByText(/Secret saved/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Token")).toBeNull();
    expect(document.body.innerHTML).not.toContain("tok_SUPERSECRET");
    await userEvent.click(screen.getByRole("button", { name: /Replace secret/ }));
    expect(screen.getByLabelText("Token")).toHaveValue("");
  });
});

describe("connections screen", () => {
  it("explains a 409 'still used by agent' in plain words and keeps the connection", async () => {
    mockApi("admin", (p, c) => {
      if (p === "/tool-connections" && c.method === "GET") return json({ items: [conn()] });
      if (p === `/tool-connections/${CID}` && c.method === "DELETE") return json({ error: { code: "conflict", requestId: "r1", message: "Connection is used by tools of: Sales bot", details: { agents: ["Sales bot"] } } }, 409);
      return undefined;
    });
    wrap(<ConnectionsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete connection" }));
    expect(await screen.findByText(/Still used by Sales bot/)).toBeInTheDocument();
    expect(screen.getByText(/switch the tool to another connection/)).toBeInTheDocument();
  });
  it("lists auth type and masked secret state, never a secret", async () => {
    mockApi("admin", (p) => (p === "/tool-connections" ? json({ items: [conn(), conn({ id: "x2", name: "Public", authType: "none", hasSecret: false })] }) : undefined));
    wrap(<ConnectionsPage />);
    expect(await screen.findByText("Bearer token")).toBeInTheDocument();
    expect(screen.getByText("Secret saved")).toBeInTheDocument();
    expect(screen.getByText("No sign-in")).toBeInTheDocument();
  });
});

describe("tool builder", () => {
  const tree = { rootType: "object", fields: [
    { name: "status", path: "status", type: "string", sample: "shipped" },
    { name: "lines", path: "lines", type: "array", length: 2, itemType: "object", children: [{ name: "sku", path: "lines[].sku", type: "string", sample: "SKU-1" }] },
  ] };

  it("walks template -> connect -> ask -> send -> test (click-to-map) -> rules and saves a valid v2 manifest", async () => {
    const calls = mockApi("admin", (p, c) => {
      if (p === "/tool-connections") return json({ items: [conn()] });
      if (p === "/tools/test") return json({ ok: true, status: 200, latencyMs: 41, attempts: 1, request: { method: "GET", url: "https://shop.example/v1/orders/A-1001", headers: { authorization: "Bearer ***" } },
        response: { status: 200, contentType: "application/json", excerpt: '{"status":"shipped"}', truncated: false }, mapped: null, fieldTree: tree, error: null });
      void c; return undefined;
    });
    const onSave = vi.fn();
    wrap(<ToolBuilder mode="new" otherTools={[]} onClose={() => {}} onSave={onSave} />);
    await userEvent.click(await screen.findByRole("radio", { name: /Look up an order or customer/ }));
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await userEvent.click(await screen.findByRole("radio", { name: /Orders system/ }));
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByLabelText("Question 1")).toHaveValue("Order number");
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByTestId("preview-url")).toHaveTextContent("https://shop.example/v1/orders/A-1001");
    expect(document.body.textContent).not.toMatch(/tok_/);
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Run test" }));
    const sent = JSON.parse(calls.find((c) => c.url === "/tools/test")!.body!);
    expect(sent.sampleValues).toEqual({ order_number: "A-1001" });
    expect(toolManifestV2Schema.safeParse(sent.manifest).success).toBe(true);
    const statusNode = await screen.findByRole("button", { name: /status.*text/ });
    await userEvent.click(statusNode);
    expect(statusNode).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: /^sku/ }));
    const label = screen.getByLabelText("Label for status");
    await userEvent.clear(label);
    await userEvent.type(label, "Order status");
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await userEvent.click(await screen.findByLabelText("Hand over to a person", { exact: false }));
    await userEvent.click(screen.getByRole("button", { name: /Save tool/ }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const m = onSave.mock.calls[0]![0];
    expect(m).toMatchObject({ version: 2, name: "lookup_order", connectionId: CID, onFailure: "handoff", responseMapping: { order_status: "status", sku: "lines[].sku" }, allowedStages: expect.arrayContaining(["engaged"]) });
    expect(toolManifestV2Schema.safeParse(m).success).toBe(true);
  });

  it("offers inline connection creation when none exist", async () => {
    mockApi("admin", (p) => (p === "/tool-connections" ? json({ items: [] }) : undefined));
    wrap(<ToolBuilder mode="new" otherTools={[]} onClose={() => {}} onSave={() => {}} />);
    await userEvent.click(await screen.findByRole("radio", { name: /Start from scratch/ }));
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByRole("form", { name: "New connection" })).toBeInTheDocument();
    expect(within(screen.getByRole("form", { name: "New connection" })).getByRole("button", { name: "Save and test" })).toBeDisabled();
  });
});
