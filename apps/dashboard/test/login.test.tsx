import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider";
import { setFetchImpl } from "../src/api/client";
import Login from "../src/pages/Login";

describe("Login page", () => {
  it("shows validation and API errors accessibly", async () => {
    setFetchImpl((async (u: string) =>
      u.endsWith("/auth/login")
        ? new Response(JSON.stringify({ error: { code: "invalid_credentials", message: "Invalid email or password.", requestId: "r1" } }), { status: 401 })
        : new Response("{}", { status: 401 })) as unknown as typeof fetch);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter><AuthProvider><Login /></AuthProvider></MemoryRouter>
      </QueryClientProvider>,
    );
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByText(/valid email/i)).toBeInTheDocument();
    await u.type(screen.getByLabelText("Email"), "a@b.co");
    await u.type(screen.getByLabelText("Password"), "wrong");
    await u.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password.");
  });
});
