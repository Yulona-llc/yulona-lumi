import { describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import AcceptInvite from "@/pages/AcceptInvite";
import { setFetchImpl } from "@/api/client";

const mount = (url: string) => render(<MemoryRouter initialEntries={[url]}><Routes><Route path="/accept-invite" element={<AcceptInvite />} /><Route path="/login" element={<p>login page</p>} /></Routes></MemoryRouter>);
const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("accept invitation page (the emailed link must work)", () => {
  test("a link without a token explains what to do", () => {
    mount("/accept-invite");
    expect(screen.getByText("Invitation link incomplete")).toBeInTheDocument();
  });
  test("validates, posts the token, name and password, then moves to sign in", async () => {
    const f = vi.fn(reply(201, { ok: true, role: "agent" }));
    setFetchImpl(f as never);
    mount("/accept-invite?token=abc123");
    await userEvent.type(screen.getByLabelText("Your name"), "Ana");
    await userEvent.type(screen.getByLabelText("Password"), "short");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Use at least 12 characters.")).toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText("Password"));
    await userEvent.type(screen.getByLabelText("Password"), "a-long-enough-passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("/invitations/accept");
    expect(JSON.parse(String(init.body))).toEqual({ token: "abc123", name: "Ana", password: "a-long-enough-passphrase" });
    expect(await screen.findByText("You're in")).toBeInTheDocument();
  });
  test("an expired or used invitation says so", async () => {
    setFetchImpl(reply(400, { error: { code: "validation_error", message: "Invitation is invalid or expired", requestId: "r" } }) as never);
    mount("/accept-invite?token=old");
    await userEvent.type(screen.getByLabelText("Your name"), "Ana");
    await userEvent.type(screen.getByLabelText("Password"), "a-long-enough-passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid, already used or has expired");
  });
});
