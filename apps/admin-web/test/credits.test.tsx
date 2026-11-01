import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, mountApp } from "./helpers";

const profile = { id: "pr1", name: "OpenAI prod", baseUrl: "https://api.openai.com/v1", authHeader: "Authorization", authScheme: "bearer", extraHeaders: { "x-org": "abc" }, queryParams: {}, chatPath: "/chat/completions", defaultModel: "gpt-4o-mini", enabledModels: ["gpt-4o-mini", "gpt-4o"], isDefault: true, enabled: true, hasCredentials: true, createdAt: "x", updatedAt: "x" };
const rate = (model: string, i: number, o: number) => ({ model, inputMicroPer1k: i, outputMicroPer1k: o, enabled: true, updatedAt: "x" });
const writes = (calls: Array<{ method: string; path: string; body: unknown }>) => calls.filter((c) => c.method !== "GET" && !c.path.startsWith("/auth/"));

describe("billing and credits (ported from the old dashboard admin)", () => {
  it("lists providers, never shows the key, and reports a failing connection test", async () => {
    const { calls } = mountApp("/billing/providers", { "GET /llm-profiles": { items: [profile] }, "POST /llm-profiles/pr1/test": { ok: false, latencyMs: 0, model: null, error: "401 invalid key" } });
    expect((await screen.findAllByText("OpenAI prod")).length).toBeGreaterThan(0);
    expect(screen.getByText("Key saved")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /test connection for OpenAI prod/i }));
    expect(await screen.findByText("401 invalid key")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/llm-profiles/pr1/test" && c.method === "POST")).toBe(true);
    expect(document.body.textContent).not.toMatch(/sk-/);
  });

  it("switches between tabs without looping", async () => {
    mountApp("/billing/providers", { "GET /llm-profiles": { items: [] }, "GET /model-rates": { items: [rate("*", 250000, 1000000)] } });
    await userEvent.click(await screen.findByRole("link", { name: "Model rates" }));
    expect(await screen.findByText("Default (*)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Providers" }));
    expect(await screen.findByText("No providers yet")).toBeInTheDocument();
  });

  it("creates a provider with a write-only key and header rows", async () => {
    const { calls } = mountApp("/billing/providers", { "GET /llm-profiles": { items: [] }, "POST /llm-profiles": json(profile, 201) });
    await userEvent.click((await screen.findAllByRole("button", { name: /add provider/i }))[0]!);
    const dlg = await screen.findByRole("dialog");
    await userEvent.type(within(dlg).getByLabelText("Name"), "Azure");
    await userEvent.type(within(dlg).getByLabelText("Default model"), "gpt-4o");
    await userEvent.type(within(dlg).getByLabelText("API key"), "secret-key");
    await userEvent.click(within(dlg).getByRole("button", { name: /add header/i }));
    await userEvent.type(within(dlg).getByLabelText(/extra headers header 1/i), "x-org");
    await userEvent.type(within(dlg).getByLabelText(/extra headers value 1/i), "abc");
    await userEvent.click(within(dlg).getByRole("button", { name: "Create provider" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body).toMatchObject({ name: "Azure", defaultModel: "gpt-4o", apiKey: "secret-key", authScheme: "bearer", extraHeaders: { "x-org": "abc" }, enabledModels: [] });
  });

  it("edits a model rate in credits and sends micro-credits", async () => {
    const { calls } = mountApp("/billing/rates", { "GET /model-rates": { items: [rate("*", 250000, 1000000), rate("gpt-4o", 2500000, 10000000)] }, "PUT /model-rates": {} });
    expect(await screen.findByText("Default (*)")).toBeInTheDocument();
    expect(screen.getByText("0.25")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /edit rate for gpt-4o/i }));
    const input = screen.getByLabelText("Input credits per 1k for gpt-4o");
    await userEvent.clear(input); await userEvent.type(input, "1.5");
    await userEvent.click(screen.getByRole("button", { name: /save rate for gpt-4o/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ model: "gpt-4o", inputMicroPer1k: 1_500_000, outputMicroPer1k: 10_000_000, enabled: true });
    expect(screen.queryByRole("button", { name: /delete rate for \*/i })).toBeNull();
  });

  it("saves a plan allowance as whole credits, and unlimited as null", async () => {
    const { calls } = mountApp("/billing/plans", { "GET /plans": { items: [{ key: "free", name: "Free", limits: { llm_credits_monthly: 50 } }, { key: "enterprise", name: "Enterprise", limits: { llm_credits_monthly: null } }] }, "GET /model-rates": { items: [] }, "PUT /plans/free/limits/llm_credits_monthly": {} });
    const free = await screen.findByLabelText("Monthly credits for Free");
    expect(free).toHaveValue("50");
    await userEvent.clear(free); await userEvent.type(free, "75");
    await userEvent.click(screen.getByRole("button", { name: /save allowance for free/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({ path: "/plans/free/limits/llm_credits_monthly", body: { limit: 75 } });
    expect(screen.getByLabelText("Monthly credits for Enterprise")).toBeDisabled();
  });

  it("edits the Ask Lumi allowance of a plan separately from chat credits", async () => {
    const { calls } = mountApp("/billing/plans", { "GET /plans": { items: [{ key: "pro", name: "Pro", limits: { llm_credits_monthly: 4980, copilot_credits_monthly: 150 } }, { key: "free", name: "Free", limits: { llm_credits_monthly: 50, copilot_credits_monthly: 0 } }] }, "GET /model-rates": { items: [] }, "PUT /plans/pro/limits/copilot_credits_monthly": json({}) });
    const pro = await screen.findByLabelText("Ask Lumi credits for Pro");
    expect(pro).toHaveValue("150");
    expect(screen.getByLabelText("Ask Lumi credits for Free")).toHaveValue("0");
    await userEvent.clear(pro); await userEvent.type(pro, "300");
    await userEvent.click(screen.getByRole("button", { name: /save ask lumi allowance for pro/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({ path: "/plans/pro/limits/copilot_credits_monthly", body: { limit: 300 } });
  });

  it("creates a credit pack with the price in cents", async () => {
    const { calls } = mountApp("/billing/packs", { "GET /credit-packs": { items: [{ id: "k1", name: "Starter", credits: 500, priceCents: 900, currency: "usd", active: true, sortOrder: 0, createdAt: "x" }] }, "POST /credit-packs": json({}, 201) });
    expect(await screen.findByText(/500 credits for \$9/)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: /add pack/i })[0]!);
    const dlg = await screen.findByRole("dialog");
    await userEvent.type(within(dlg).getByLabelText("Name"), "Big");
    await userEvent.type(within(dlg).getByLabelText("Credits"), "10000");
    await userEvent.type(within(dlg).getByLabelText("Price (USD)"), "129.5");
    await userEvent.click(within(dlg).getByRole("button", { name: "Create pack" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body).toEqual({ name: "Big", credits: 10000, priceCents: 12950, active: true, sortOrder: 0 });
  });

  it("shows the message estimate per plan", async () => {
    mountApp("/billing/plans", { "GET /plans": { items: [{ key: "pro", name: "Pro", limits: { llm_credits_monthly: 4980, llm_tokens_monthly: 15_480_000 } }, { key: "free", name: "Free", limits: { llm_credits_monthly: 50, llm_tokens_monthly: 200_000 } }] }, "GET /model-rates": { items: [rate("*", 250_000, 1_000_000)] } });
    await waitFor(() => expect(screen.getByTestId("plan-estimate-pro")).toHaveTextContent("4,980 credits, 15,480,000 tokens, about 2,371 messages"));
    expect(screen.getByTestId("plan-estimate-free")).toHaveTextContent("about 23 messages");
  });

  it("is read only for support: fields and buttons are disabled with a note", async () => {
    mountApp("/billing/packs", { "GET /credit-packs": { items: [] } }, { role: "support" });
    expect(await screen.findByText(/Read only\. Requires the owner or billing role/)).toBeInTheDocument();
    for (const b of screen.getAllByRole("button", { name: /add pack/i })) expect(b).toBeDisabled();
  });

  it("only owners edit providers and flags; billing sees them read only", async () => {
    mountApp("/billing/providers", { "GET /llm-profiles": { items: [profile] } }, { role: "billing" });
    expect(await screen.findByText(/Read only\. Requires the owner role/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /^edit /i })).toBeDisabled();
  });
});

describe("feature flags", () => {
  it("creates a flag as owner and is read only for others", async () => {
    const { calls, unmount } = mountApp("/flags", { "GET /feature-flags": { items: [{ key: "beta.voice", description: "Voice", defaultEnabled: false }] }, "PUT /feature-flags/new.flag": {} });
    await userEvent.type(await screen.findByLabelText("Flag key"), "new.flag");
    await userEvent.click(screen.getByRole("button", { name: "Save flag" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toMatchObject({ path: "/feature-flags/new.flag", body: { defaultEnabled: false } }));
    unmount();
    mountApp("/flags", { "GET /feature-flags": { items: [] } }, { role: "support" });
    expect(await screen.findByText(/Read only\. Requires the owner role/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save flag" })).toBeDisabled();
  });
});
