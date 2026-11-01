import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import type { OnboardingState, OnboardingStep } from "@yulona/shared";
import { AuthProvider } from "../src/auth/AuthProvider";
import { setFetchImpl } from "../src/api/client";
import { createQueryClient } from "../src/api/queryClient";
import OnboardingPage from "../src/features/onboarding/OnboardingPage";
import { STEP_COMPONENTS, answerReady } from "../src/features/onboarding/steps";

const session = (role: string) => ({ accessToken: "t", expiresIn: 900, user: { id: "11111111-1111-4111-8111-111111111111", email: "a@b.co", name: "A", role }, tenant: { id: "22222222-2222-4222-8222-222222222222", name: "T" } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const STEPS: OnboardingStep[] = [
  { id: "businessType", title: "What kind of business is it?", component: "choice_cards", required: true, skippable: false, options: [{ value: "clinic", label: "Clinic", description: "Appointments" }, { value: "retail", label: "Shop" }] },
  { id: "businessName", title: "What is your business called?", component: "text", required: true, skippable: false, maxLength: 100 },
  { id: "goals", title: "What do you want Lumi to help with?", component: "multi_chips", required: true, skippable: false, multi: true, maxSelect: 4, options: [{ value: "support", label: "Answer customer questions", suggested: true }, { value: "leads", label: "Capture leads" }] },
  { id: "website", title: "Do you have a website?", component: "url", required: false, skippable: true },
  { id: "brand", title: "Pick your brand colour", component: "brand", required: false, skippable: true },
  { id: "hours", title: "When is your team available?", component: "hours", required: false, skippable: true },
  { id: "preview", title: "Here is what Lumi will set up", help: "Nothing goes live.\nA draft assistant.\nA website chat window.", component: "preview", required: false, skippable: false },
];
const stateOf = (answers: Record<string, unknown>, status: OnboardingState["status"] = "in_progress"): OnboardingState => {
  const real = STEPS.filter((s) => s.component !== "preview");
  return { status, currentStepId: real.find((s) => !(s.id in answers))?.id ?? "preview", steps: STEPS, answers, progress: { done: Object.keys(answers).length, total: real.length }, result: null };
};
function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname}</p>; }

function mount(role: string, answers: Record<string, unknown> = {}, over: { finish?: () => Response } = {}) {
  const calls: Array<{ url: string; method: string; body?: any }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let cur = stateOf(answers);
  setFetchImpl((async (u: string, init?: RequestInit) => {
    const p = u.replace(/^.*\/api\/v1/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: p, method: init?.method ?? "GET", body });
    if (p === "/auth/refresh") return json(session(role));
    if (p === "/onboarding" && (init?.method ?? "GET") === "GET") return json(cur);
    if (p === "/onboarding/answers") { cur = stateOf({ ...cur.answers, [body.stepId]: body.value }); return json(cur); }
    if (p === "/onboarding/skip") return json({ ...cur, status: "skipped" });
    if (p === "/onboarding/finish") return over.finish?.() ?? json({ agentId: "a1", widgetId: "w1", knowledgeSourceId: null, usedModel: false, goals: ["support"], nextStep: { label: "x", path: "/agents/a1" } }, 201);
    return json({ error: { code: "not_found", message: "nope" } }, 404);
  }) as unknown as typeof fetch);
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/onboarding"]}><AuthProvider>
        <Routes><Route path="/onboarding" element={<OnboardingPage />} /><Route path="*" element={<Where />} /></Routes>
      </AuthProvider></MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}
beforeEach(() => { document.cookie = "yl_csrf=c; path=/"; });

describe("onboarding wizard", () => {
  it("renders steps from the server schema, validates before continuing and saves each answer", async () => {
    const calls = mount("owner");
    expect(await screen.findByRole("heading", { name: /what kind of business/i })).toBeInTheDocument();
    const next = screen.getByRole("button", { name: /continue/i });
    expect(next).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: /clinic/i }));
    expect(next).toBeEnabled();
    await userEvent.click(next);
    expect(await screen.findByRole("heading", { name: /called/i })).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/onboarding/answers")?.body).toEqual({ stepId: "businessType", value: "clinic" });
    await userEvent.type(screen.getByRole("textbox"), "Sunrise Dental");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    // multi-select chips keep click order and suggest options
    expect(await screen.findByRole("heading", { name: /help with/i })).toBeInTheDocument();
    expect(screen.getByText("suggested")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /capture leads/i }));
    await userEvent.click(screen.getByRole("checkbox", { name: /answer customer questions/i }));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByRole("heading", { name: /website/i });
    expect(calls.filter((c) => c.url === "/onboarding/answers").at(-1)?.body).toEqual({ stepId: "goals", value: ["leads", "support"] });
  });

  it("resumes at the first unanswered step and can go back", async () => {
    mount("owner", { businessType: "clinic", businessName: "Sunrise Dental", goals: ["support"] });
    expect(await screen.findByRole("heading", { name: /website/i })).toBeInTheDocument();
    expect(screen.getByText(/step 4 of 7/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(await screen.findByRole("heading", { name: /help with/i })).toBeInTheDocument();
  });

  it("optional steps can be skipped (null answer) and the website needs a real link", async () => {
    const calls = mount("owner", { businessType: "clinic", businessName: "S", goals: ["support"] });
    await screen.findByRole("heading", { name: /website/i });
    await userEvent.type(screen.getByRole("textbox"), "not a url");
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /skip this step/i }));
    await screen.findByRole("heading", { name: /brand colour/i });
    expect(calls.find((c) => c.body?.stepId === "website")?.body.value).toBeNull();
  });

  it("brand step uses swatches and shows a preview", async () => {
    const calls = mount("owner", { businessType: "clinic", businessName: "S", goals: ["support"], website: null });
    await screen.findByRole("heading", { name: /brand colour/i });
    await userEvent.click(screen.getByRole("radio", { name: /blue/i }));
    expect(screen.getByLabelText("Preview")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByRole("heading", { name: /team available/i });
    expect(calls.find((c) => c.body?.stepId === "brand")?.body.value).toEqual({ color: "#2563eb" });
  });

  it("hours step renders as a component (hooks stay stable across steps) and sends custom hours", async () => {
    const calls = mount("owner", { businessType: "clinic", businessName: "S", goals: ["support"], website: null, brand: null });
    await screen.findByRole("heading", { name: /team available/i });
    await userEvent.click(screen.getByRole("radio", { name: /set opening hours/i }));
    expect(screen.getByRole("list", { name: /opening hours/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /saturday/i }));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByRole("heading", { name: /what lumi will set up/i });
    const sent = calls.find((c) => c.body?.stepId === "hours")?.body.value;
    expect(sent.mode).toBe("custom");
    expect(sent.days.map((d: { weekday: number }) => d.weekday)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("the last step lists what will be created and finishes into the overview", async () => {
    const calls = mount("owner", { businessType: "clinic", businessName: "S", goals: ["support"], website: null, brand: null, hours: null });
    expect(await screen.findByText("A draft assistant.")).toBeInTheDocument();
    expect(screen.getByText(/one short ai call/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /create my setup/i }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/overview"));
    expect(calls.some((c) => c.url === "/onboarding/finish" && c.method === "POST")).toBe(true);
  });

  it("shows the server error when finishing fails and stays on the step", async () => {
    mount("owner", { businessType: "clinic", businessName: "S", goals: ["support"], website: null, brand: null, hours: null }, { finish: () => json({ error: { code: "plan_limit_exceeded", message: "Plan limit reached for agents", requestId: "r1" } }, 402) });
    await userEvent.click(await screen.findByRole("button", { name: /create my setup/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/plan limit/i);
  });

  it("skip setup leaves for the overview; non-admins are sent away", async () => {
    const calls = mount("owner");
    await userEvent.click(await screen.findByRole("button", { name: /skip setup for now/i }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/overview"));
    expect(calls.some((c) => c.url === "/onboarding/skip")).toBe(true);
  });
  it("viewers and agents are redirected to the overview without calling the API", async () => {
    const calls = mount("agent");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/overview"));
    expect(calls.some((c) => c.url === "/onboarding")).toBe(false);
  });
});

describe("step components", () => {
  it("only the whitelisted components exist and answers are validated per component", () => {
    expect(Object.keys(STEP_COMPONENTS).sort()).toEqual(["brand", "choice_cards", "hours", "multi_chips", "preview", "text", "url"]);
    const step = (component: OnboardingStep["component"], required = true): OnboardingStep => ({ id: "goals", title: "t", component, required, skippable: false });
    expect(answerReady(step("multi_chips"), [])).toBe(false);
    expect(answerReady(step("multi_chips", false), [])).toBe(true);
    expect(answerReady(step("brand"), { color: "red" })).toBe(false);
    expect(answerReady(step("brand"), { color: "#112233" })).toBe(true);
    expect(answerReady(step("hours"), { mode: "always" })).toBe(true);
    expect(answerReady(step("url"), "javascript:alert(1)")).toBe(false);
    expect(within(document.body).queryByText("x")).toBeNull();
  });
});
