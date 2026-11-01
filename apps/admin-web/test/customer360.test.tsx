import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, mountApp, tenantDetail } from "./helpers";

const base = (extra: Record<string, unknown> = {}) => ({
  "GET /tenants/t1": tenantDetail(), "GET /tenants/t1/notes": { items: [{ id: "n1", body: "Called them", adminId: "a1", adminEmail: "owner@lumi.test", createdAt: "2026-10-01T00:00:00Z" }] },
  "GET /plans": { items: [{ key: "free", name: "Free", limits: {} }, { key: "pro", name: "Pro", limits: {} }] },
  "GET /tenants/t1/users": { items: [{ id: "u1", email: "boss@acme.test", name: "Bo Boss", role: "owner", status: "active", lastLoginAt: null, createdAt: "2026-01-02T00:00:00Z", locked: false }], invitations: [{ id: "i1", email: "new@acme.test", role: "agent", createdAt: "2026-10-01T00:00:00Z", expiresAt: "2026-10-08T00:00:00Z", status: "pending" }] },
  ...extra,
});

describe("customer 360", () => {
  it("shows health reasons, key facts, notes and tags on the overview", async () => {
    mountApp("/customers/t1", base());
    expect(await screen.findByRole("heading", { name: "Acme Corp" })).toBeInTheDocument();
    expect(await screen.findByText("4 failed webhook deliveries in 7 days")).toBeInTheDocument();
    expect(screen.getByText("No customer messages for 14+ days")).toBeInTheDocument();
    expect(await screen.findByText("Called them")).toBeInTheDocument();
    expect(screen.getByText("vip")).toBeInTheDocument();
    expect(screen.getAllByText(/boss@acme.test/).length).toBeGreaterThan(0);
  });

  it("opens a tab from the URL and lists issues with the hint, filtering by kind", async () => {
    const u = userEvent.setup();
    const { calls } = mountApp("/customers/t1?tab=issues", base({ "GET /tenants/t1/errors": () => json({ items: [{ kind: "webhook_delivery_failed", at: "2026-10-31T00:00:00Z", refId: "d1", title: "Order hook returned 500", detail: "HTTP 500 from https://x.test", hint: "Check the endpoint is up." }], total: 1, counts: { webhook_delivery_failed: 1, job_failed: 0 } }) }));
    expect(await screen.findByText("Order hook returned 500")).toBeInTheDocument();
    expect(screen.getByText(/Check the endpoint is up/)).toBeInTheDocument();
    expect(screen.getByText("HTTP 500 from https://x.test")).toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText("Kind"), "job_failed");
    await waitFor(() => expect(calls.filter((c) => c.path === "/tenants/t1/errors").at(-1)!.url).toContain("kind=job_failed"));
  });

  it("adds a note as support and hides note controls from billing", async () => {
    const u = userEvent.setup();
    const { calls, unmount } = mountApp("/customers/t1", base({ "POST /tenants/t1/notes": json({ id: "n2", body: "x", adminId: "a1", adminEmail: "s", createdAt: "2026-10-02T00:00:00Z" }, 201) }), { role: "support" });
    await u.type(await screen.findByLabelText("Add a note"), "Second note");
    await u.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === "/tenants/t1/notes")?.body).toEqual({ body: "Second note" }));
    unmount();
    mountApp("/customers/t1", base(), { role: "billing" });
    await screen.findByRole("heading", { name: "Acme Corp" });
    expect(screen.queryByLabelText("Add a note")).not.toBeInTheDocument();
    expect(screen.getByText(/Requires the owner or support role to add notes/)).toBeInTheDocument();
  });

  it("role-gates header actions: billing cannot impersonate or suspend, support cannot change plan, owner can do all", async () => {
    mountApp("/customers/t1", base(), { role: "billing" });
    await screen.findByRole("heading", { name: "Acme Corp" });
    expect(screen.getByRole("button", { name: "Impersonate" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Suspend" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change plan" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Grant credits/ })).toBeEnabled();
  });

  it("support: plan change disabled, impersonation enabled", async () => {
    mountApp("/customers/t1", base(), { role: "support" });
    await screen.findByRole("heading", { name: "Acme Corp" });
    expect(screen.getByRole("button", { name: "Change plan" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Impersonate" })).toBeEnabled();
  });

  it("starts a read-only impersonation by default and opens the exchange link", async () => {
    const u = userEvent.setup();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { calls } = mountApp("/customers/t1", base({ "POST /tenants/t1/impersonate": json({ sessionId: "s1", code: "c0de", codeExpiresIn: 60, customerUrl: "https://app.test/impersonate#code=c0de", readOnly: true, user: { id: "u1", email: "boss@acme.test", name: "Bo", role: "owner" }, tenant: { id: "t1", name: "Acme Corp" } }, 201) }), { role: "support" });
    await u.click(await screen.findByRole("button", { name: "Impersonate" }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByLabelText(/Read-only/)).toBeChecked();
    expect(within(dlg).getByLabelText(/Write mode/)).toBeDisabled();
    await u.type(within(dlg).getByLabelText("Reason"), "Ticket 4411 broken widget");
    await u.click(within(dlg).getByRole("button", { name: /Start read-only session/ }));
    await waitFor(() => expect(calls.find((c) => c.path === "/tenants/t1/impersonate")?.body).toEqual({ reason: "Ticket 4411 broken widget", readOnly: true }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("https://app.test/impersonate#code=c0de", "_blank", "noopener"));
    expect(await screen.findByText(/Read-only session as boss@acme.test/)).toBeInTheDocument();
    open.mockRestore();
  });

  it("owner can choose write mode and sends readOnly false", async () => {
    const u = userEvent.setup();
    vi.spyOn(window, "open").mockReturnValue(null);
    const { calls } = mountApp("/customers/t1", base({ "POST /tenants/t1/impersonate": json({ sessionId: "s1", code: "c", codeExpiresIn: 60, customerUrl: "https://app.test/impersonate#code=c", readOnly: false, user: { id: "u1", email: "b@a.test", name: "B", role: "owner" }, tenant: { id: "t1", name: "Acme Corp" } }, 201) }));
    await u.click(await screen.findByRole("button", { name: "Impersonate" }));
    const dlg = await screen.findByRole("dialog");
    await u.type(within(dlg).getByLabelText("Reason"), "Customer asked us to fix it");
    await u.click(within(dlg).getByLabelText(/Write mode/));
    await u.click(within(dlg).getByRole("button", { name: /Start write session/ }));
    await waitFor(() => expect(calls.find((c) => c.path === "/tenants/t1/impersonate")?.body).toMatchObject({ readOnly: false }));
  });

  it("grants credits with a reason", async () => {
    const u = userEvent.setup();
    const { calls } = mountApp("/customers/t1", base({ "POST /tenants/t1/credits": tenantDetail().credits }), { role: "billing" });
    await u.click(await screen.findByRole("button", { name: /Grant credits/ }));
    const dlg = await screen.findByRole("dialog");
    await u.type(within(dlg).getByLabelText("Credits"), "-25");
    await u.type(within(dlg).getByLabelText("Reason"), "Refund for outage");
    await u.click(within(dlg).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/tenants/t1/credits" && c.method === "POST")?.body).toEqual({ credits: -25, reason: "Refund for outage" }));
  });

  it("resends a pending invitation from the team tab", async () => {
    const u = userEvent.setup();
    const { calls } = mountApp("/customers/t1?tab=team", base({ "POST /tenants/t1/invitations/i1/resend": { ok: true, emailSent: true } }), { role: "support" });
    await u.click(await screen.findByRole("button", { name: "Resend" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/tenants/t1/invitations/i1/resend")).toBe(true));
  });
});
