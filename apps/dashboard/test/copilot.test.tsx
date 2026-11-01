import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import type { CopilotStatus } from "@yulona/shared";
import { AuthProvider } from "../src/auth/AuthProvider";
import { setFetchImpl } from "../src/api/client";
import { createQueryClient } from "../src/api/queryClient";
import { AskLumi } from "../src/features/copilot/CopilotDrawer";
import { remainingText, type CopilotMessage } from "../src/features/copilot/api";

const SID = "44444444-4444-4444-8444-444444444444";
const session = (role: string) => ({ accessToken: "t", expiresIn: 900, user: { id: "11111111-1111-4111-8111-111111111111", email: "a@b.co", name: "A", role }, tenant: { id: "22222222-2222-4222-8222-222222222222", name: "T" } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const err = (status: number, code: string, message: string) => json({ error: { code, message, requestId: "r" } }, status);
const m = (id: string, role: "user" | "assistant", content: string, payload: CopilotMessage["payload"] = null): CopilotMessage => ({ id, role, content, payload, createdAt: "2026-01-01T00:00:00Z" });
const allowed = (over: Partial<CopilotStatus> = {}): CopilotStatus => ({ access: "allowed", reason: null, selfHosted: false, allowance: { limitCredits: 150, usedMicro: 2_000_000, remainingMicro: 148_000_000, resetsAt: "2026-12-01T00:00:00Z" }, session: null, ...over });
const locked = (): CopilotStatus => ({ access: "locked", reason: "requires_plan", selfHosted: false, allowance: { limitCredits: 0, usedMicro: 0, remainingMicro: 0, resetsAt: "2026-12-01T00:00:00Z" }, session: null });

function mount(role: string, status: CopilotStatus, onSend?: (b: any) => Response) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const calls: Array<{ url: string; method: string; body?: any }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const msgs = [m("w", "assistant", "Hi, I'm Lumi.", { blocks: [{ type: "chips", options: ["What should I do next?"] }] })];
  setFetchImpl((async (u: string, init?: RequestInit) => {
    const p = u.replace(/^.*\/api\/v1/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? "GET";
    calls.push({ url: p, method, body });
    if (p === "/auth/refresh") return json(session(role));
    if (p === "/copilot/status") return json(status);
    if (p === "/copilot/sessions" && method === "POST") return json({ id: SID, status: "open", messages: msgs, limits: { maxUserMessages: 40, userMessages: 0 } }, 201);
    if (p === `/copilot/sessions/${SID}`) return json({ id: SID, status: "open", messages: msgs, limits: { maxUserMessages: 40, userMessages: 0 } });
    if (p === `/copilot/sessions/${SID}/messages`) return onSend ? onSend(body) : json({ messages: [m("u1", "user", body.text ?? body.choice), m("a1", "assistant", "Done.")], assistant: m("a1", "assistant", "Done."), allowance: { ...status.allowance, usedMicro: 3_000_000 } });
    if (p === `/copilot/sessions/${SID}/confirm`) return json({ ok: true, message: m("a9", "assistant", "Published Helper (version 1).", { blocks: [{ type: "link", label: "Open the agent", path: "/agents/x" }] }) });
    if (p === `/copilot/sessions/${SID}/cancel`) return json({ ok: true, message: m("a8", "assistant", "Okay, I did not publish anything.") });
    return err(404, "not_found", "nope");
  }) as unknown as typeof fetch);
  render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><AuthProvider><AskLumi /></AuthProvider></MemoryRouter></QueryClientProvider>);
  return calls;
}
beforeEach(() => { document.cookie = "yl_csrf=c; path=/"; try { sessionStorage.clear(); } catch { /* */ } });

describe("Ask Lumi drawer", () => {
  it("is available to admins only", async () => {
    mount("agent", allowed());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("button", { name: /ask lumi/i })).toBeNull();
  });

  it("locked workspaces see an upgrade card and no chat, and no session is created", async () => {
    const calls = mount("owner", locked());
    await userEvent.click(await screen.findByRole("button", { name: /ask lumi/i }));
    const card = await screen.findByTestId("copilot-locked");
    expect(card).toHaveTextContent(/included in paid plans/i);
    expect(within(card).getByRole("link", { name: /see plans/i })).toHaveAttribute("href", "/settings/billing");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(calls.some((c) => c.url === "/copilot/sessions")).toBe(false);
  });

  it("unlocked: opens a session, shows the remaining allowance, sends text and chips, shows the updated remaining", async () => {
    const calls = mount("owner", allowed());
    await userEvent.click(await screen.findByRole("button", { name: /ask lumi/i }));
    expect(await screen.findByText("Hi, I'm Lumi.")).toBeInTheDocument();
    expect(screen.getByTestId("copilot-remaining")).toHaveTextContent("148 of 150 credits left this month");
    await userEvent.type(screen.getByRole("textbox", { name: /message to lumi/i }), "make my greeting friendlier");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Done.")).toBeInTheDocument();
    expect(calls.find((c) => c.url.endsWith("/messages"))?.body).toEqual({ text: "make my greeting friendlier" });
    await waitFor(() => expect(screen.getByTestId("copilot-remaining")).toHaveTextContent("147 of 150"));
    await userEvent.click(screen.getByRole("button", { name: "What should I do next?" }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/messages")).at(-1)?.body).toEqual({ choice: "What should I do next?" }));
  });

  it("renders only whitelisted blocks from text, never markup, and a confirm card the user must press", async () => {
    const calls = mount("owner", allowed(), (b) => json({
      messages: [m("u1", "user", b.text), m("a1", "assistant", "Press Confirm. <img src=x onerror=alert(1)>", { blocks: [
        { type: "confirm", token: "tok-aaaaaaaaaaaaaaaaaaaaaaaa", title: "Publish Helper?", summary: "Customers will get answers.", expiresAt: new Date(Date.now() + 600000).toISOString() },
        { type: "diff", title: "Updated Helper (draft)", changes: [{ field: "greeting", before: "Hi", after: "<b>Hello</b>" }] },
        { type: "link", label: "Evil", path: "//evil.example" },
        { type: "weird" } as never,
      ] })],
      assistant: m("a1", "assistant", "x"), allowance: allowed().allowance,
    }));
    await userEvent.click(await screen.findByRole("button", { name: /ask lumi/i }));
    await userEvent.type(await screen.findByRole("textbox"), "publish my agent");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    const card = await screen.findByTestId("confirm-card");
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeInTheDocument();
    expect(screen.getByText("<b>Hello</b>")).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByRole("link", { name: /evil/i })).toHaveAttribute("href", "/overview"); // unsafe path replaced
    expect(calls.some((c) => c.url.endsWith("/confirm"))).toBe(false); // nothing confirmed until pressed
    await userEvent.click(within(card).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(/Published Helper \(version 1\)/)).toBeInTheDocument();
    expect(calls.find((c) => c.url.endsWith("/confirm"))?.body).toEqual({ token: "tok-aaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(within(card).queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  it("not now cancels the proposal", async () => {
    const calls = mount("owner", allowed(), (b) => json({ messages: [m("u1", "user", b.text), m("a1", "assistant", "Confirm?", { blocks: [{ type: "confirm", token: "tok-bbbbbbbbbbbbbbbbbbbbbbbb", title: "Publish?", summary: "s", expiresAt: new Date(Date.now() + 600000).toISOString() }] })], assistant: m("a1", "assistant", "x"), allowance: allowed().allowance }));
    await userEvent.click(await screen.findByRole("button", { name: /ask lumi/i }));
    await userEvent.type(await screen.findByRole("textbox"), "publish");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(await screen.findByText(/did not publish anything/i)).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/cancel"))).toBe(true);
  });

  it("shows the limit message when the monthly allowance is used up", async () => {
    mount("owner", allowed(), () => err(402, "copilot_limit_reached", "You have used this month's Ask Lumi allowance."));
    await userEvent.click(await screen.findByRole("button", { name: /ask lumi/i }));
    await userEvent.type(await screen.findByRole("textbox"), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/allowance/i);
  });

  it("self-hosted shows no allowance line; remaining text covers unlimited", async () => {
    mount("owner", allowed({ selfHosted: true, allowance: { limitCredits: null, usedMicro: 0, remainingMicro: null, resetsAt: "2026-12-01T00:00:00Z" } }));
    await userEvent.click(await screen.findByRole("button", { name: /ask lumi/i }));
    await screen.findByText("Hi, I'm Lumi.");
    expect(screen.queryByTestId("copilot-remaining")).toBeNull();
    expect(remainingText({ limitCredits: null, usedMicro: 0, remainingMicro: null, resetsAt: "" })).toBe("No monthly limit");
    expect(remainingText({ limitCredits: 150, usedMicro: 150_000_001, remainingMicro: 0, resetsAt: "" })).toBe("0 of 150 credits left this month");
  });
});
