import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fillDays, pctDelta, ago } from "@/lib/format";
import { can } from "@/auth/permissions";
import { json, mountApp } from "./helpers";

describe("palette", () => {
  it("opens with Ctrl+K, searches customers and users, and navigates", async () => {
    const u = userEvent.setup();
    const { calls } = mountApp("/attention", { "GET /search": { tenants: [{ id: "t9", name: "Zeta Ltd", status: "active", plan: "pro", matchedOn: "member_email" }], users: [{ id: "u9", tenantId: "t9", tenantName: "Zeta Ltd", email: "zed@zeta.test", name: "Zed", role: "owner", status: "active" }] }, "GET /tenants/t9": json({}, 500) });
    await screen.findByRole("heading", { name: "Needs attention" });
    await u.keyboard("{Control>}k{/Control}");
    const input = await screen.findByPlaceholderText(/Search customers, users, pages and actions/);
    expect(within(screen.getByRole("dialog")).getByText("Overview")).toBeInTheDocument();
    await u.type(input, "zeta");
    await screen.findByText("Zeta Ltd");
    expect(calls.some((c) => c.path === "/search" && c.url.includes("q=zeta"))).toBe(true);
    expect(screen.getByText("zed@zeta.test")).toBeInTheDocument();
    expect(screen.getByText("email match")).toBeInTheDocument();
    await u.click(screen.getByText("Zeta Ltd"));
    await waitFor(() => expect(calls.some((c) => c.path === "/tenants/t9")).toBe(true));
  });
});

describe("operations", () => {
  it("retries and discards dead jobs as support, with confirmation for discard", async () => {
    const u = userEvent.setup();
    const { calls } = mountApp("/operations", { "GET /ops/dead-jobs": { items: [{ id: "j1", tenantId: "t1", tenantName: "Acme Corp", name: "notify.email", attempts: 5, maxAttempts: 5, lastError: "SMTP 550", createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-31T00:00:00Z" }], total: 1 }, "POST /ops/dead-jobs/j1/retry": { ok: true }, "POST /ops/dead-jobs/j1/discard": { ok: true } }, { role: "support" });
    expect(await screen.findByText("notify.email")).toBeInTheDocument();
    expect(screen.getByText("SMTP 550")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/ops/dead-jobs/j1/retry")).toBe(true));
    await u.click(screen.getByRole("button", { name: /Discard/ }));
    await u.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/ops/dead-jobs/j1/discard")).toBe(true));
  });

  it("billing role sees dead jobs but the actions are disabled", async () => {
    mountApp("/operations", { "GET /ops/dead-jobs": { items: [{ id: "j1", tenantId: null, tenantName: null, name: "x", attempts: 1, maxAttempts: 5, lastError: null, createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-31T00:00:00Z" }], total: 1 } }, { role: "billing" });
    await screen.findByText("x");
    expect(screen.getByRole("button", { name: /Retry/ })).toBeDisabled();
  });
});

describe("admins", () => {
  it("is owner only and shows the temporary password once after inviting", async () => {
    const u = userEvent.setup();
    const { calls } = mountApp("/admins", { "GET /admins": { items: [{ id: "a1", email: "owner@lumi.test", name: "Owner Person", role: "owner", status: "active", twoFactorEnabled: true, lastLoginAt: null, createdAt: "2026-01-01T00:00:00Z" }] }, "POST /admins": json({ id: "a2", email: "new@lumi.test", role: "support", temporaryPassword: "Tmp-Pass-123456" }, 201) });
    await u.click(await screen.findByRole("button", { name: "Invite admin" }));
    const dlg = await screen.findByRole("dialog");
    await u.type(within(dlg).getByLabelText("Name"), "New Person");
    await u.type(within(dlg).getByLabelText("Email"), "new@lumi.test");
    await u.click(within(dlg).getByRole("button", { name: "Create admin" }));
    expect(await screen.findByTestId("temp-password")).toHaveTextContent("Tmp-Pass-123456");
    expect(calls.find((c) => c.method === "POST" && c.path === "/admins")?.body).toEqual({ email: "new@lumi.test", name: "New Person", role: "support" });
  });

  it("non-owners get a clear owners-only page and never call the admin list", async () => {
    const { calls } = mountApp("/admins", {}, { role: "support" });
    expect(await screen.findByText("Owners only")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/admins")).toBe(false);
  });
});

describe("two-factor enrolment", () => {
  it("walks password, QR and secret, code confirmation and recovery codes", async () => {
    const u = userEvent.setup();
    const { calls } = mountApp("/account", {
      "POST /auth/2fa/setup": { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/Lumi:o@lumi.test?secret=JBSWY3DPEHPK3PXP&issuer=Lumi" },
      "POST /auth/2fa/confirm": { recoveryCodes: Array.from({ length: 10 }, (_, i) => `aaaa${i}-bbbb${i}`) },
    });
    await u.click(await screen.findByRole("button", { name: "Set up two-factor" }));
    await u.type(within(await screen.findByRole("dialog")).getByLabelText("Password"), "my-password-1234");
    await u.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByTestId("totp-secret")).toHaveTextContent("JBSWY3DPEHPK3PXP");
    await u.type(screen.getByLabelText("6-digit code"), "123456");
    await u.click(screen.getByRole("button", { name: "Turn on" }));
    const codes = await screen.findByRole("list", { name: "Recovery codes" });
    expect(within(codes).getAllByRole("listitem")).toHaveLength(10);
    expect(calls.find((c) => c.path === "/auth/2fa/setup")?.body).toEqual({ password: "my-password-1234" });
    expect(calls.find((c) => c.path === "/auth/2fa/confirm")?.body).toEqual({ code: "123456" });
  });
});

describe("helpers", () => {
  it("fills missing days with zero and keeps order", () => {
    const out = fillDays([{ day: "2026-10-31T00:00:00.000Z", value: 4 }], 3, 1, new Date("2026-11-01T12:00:00Z"));
    expect(out).toEqual([{ x: "2026-10-30", y: 0 }, { x: "2026-10-31", y: 4 }, { x: "2026-11-01", y: 0 }]);
  });
  it("computes deltas and relative times", () => {
    expect(pctDelta(15, 10)).toBe(50); expect(pctDelta(5, 0)).toBeNull(); expect(pctDelta(0, 0)).toBe(0);
    expect(ago("2026-11-01T09:00:00Z", new Date("2026-11-01T12:00:00Z").getTime())).toBe("3h ago");
  });
  it("matches the role matrix of the contract", () => {
    expect(can("support", "impersonate")).toBe(true); expect(can("support", "impersonateWrite")).toBe(false); expect(can("billing", "impersonate")).toBe(false);
    expect(can("billing", "changePlan")).toBe(true); expect(can("support", "changePlan")).toBe(false); expect(can("owner", "manageAdmins")).toBe(true); expect(can("billing", "tenantLifecycle")).toBe(false);
  });
});
