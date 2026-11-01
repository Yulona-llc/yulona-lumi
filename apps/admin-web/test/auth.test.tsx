import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, json, me, mountApp } from "./helpers";

describe("session", () => {
  it("restores the session on load from the refresh cookie (no stored token)", async () => {
    const { calls } = mountApp("/", { "GET /overview": apiError(500, "internal_error") });
    expect(await screen.findByRole("button", { name: "Account menu" })).toBeInTheDocument();
    const refresh = calls.find((c) => c.path === "/auth/refresh")!;
    expect(refresh.method).toBe("POST");
    expect(refresh.headers["X-Admin-Request"]).toBe("1");
    expect(JSON.stringify({ ...localStorage })).not.toMatch(/tok/);
  });

  it("shows the sign-in form when there is no session, and signs in", async () => {
    const u = userEvent.setup();
    const { calls } = mountApp("/", { "POST /auth/login": json({ accessToken: "t", expiresIn: 900, admin: me("support") }), "GET /overview": apiError(500, "internal_error") }, { role: null });
    await u.type(await screen.findByLabelText("Email"), "support@lumi.test");
    await u.type(screen.getByLabelText("Password"), "correct horse battery");
    await u.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("button", { name: "Account menu" })).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/auth/login")!.body).toEqual({ email: "support@lumi.test", password: "correct horse battery" });
  });

  it("asks for the TOTP code after the password and supports recovery codes", async () => {
    const u = userEvent.setup();
    const { calls } = mountApp("/", {
      "POST /auth/login": { twoFactorRequired: true, challengeToken: "chal-token-123", expiresIn: 300 },
      "POST /auth/login/2fa": json({ accessToken: "t", expiresIn: 900, admin: me("owner", { twoFactorEnabled: true }) }),
      "GET /overview": apiError(500, "internal_error"),
    }, { role: null });
    await u.type(await screen.findByLabelText("Email"), "o@lumi.test");
    await u.type(screen.getByLabelText("Password"), "correct horse battery");
    await u.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Two-factor code" })).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Use a recovery code" }));
    await u.type(screen.getByLabelText("Recovery code"), "abcde-fghij");
    await u.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("button", { name: "Account menu" })).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/auth/login/2fa")!.body).toEqual({ challengeToken: "chal-token-123", recoveryCode: "abcde-fghij" });
  });

  it("shows invalid credentials without detail and a rate-limit message", async () => {
    const u = userEvent.setup();
    mountApp("/", { "POST /auth/login": apiError(429, "rate_limited") }, { role: null });
    await u.type(await screen.findByLabelText("Email"), "o@lumi.test");
    await u.type(screen.getByLabelText("Password"), "x");
    await u.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/Too many attempts/)).toBeInTheDocument();
  });

  it("locks a restricted session to the forced password change", async () => {
    const u = userEvent.setup();
    const { calls } = mountApp("/customers", { "POST /auth/password": { ok: true } }, { adminOver: { restricted: "password_change" } });
    expect(await screen.findByRole("heading", { name: "Choose a new password" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
    await u.type(screen.getByLabelText("Temporary password"), "temp-password-123");
    await u.type(screen.getByLabelText("New password"), "a-much-better-password");
    await u.type(screen.getByLabelText("Repeat the new password"), "a-much-better-password");
    await u.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/auth/password")).toBe(true));
  });

  it("returns to sign-in when the session is rejected and cannot be refreshed", async () => {
    let n = 0;
    mountApp("/customers", { "GET /tenants": apiError(401, "unauthorized"), "POST /auth/refresh": () => (n++ === 0 ? json({ accessToken: "t", expiresIn: 900, admin: me("owner") }) : apiError(401, "invalid_refresh_token")) });
    expect(await screen.findByRole("heading", { name: "Platform admin" })).toBeInTheDocument();
    expect(within(document.body).queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
  });
});
