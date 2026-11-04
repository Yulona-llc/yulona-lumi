import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

vi.mock("../src/auth/AuthProvider", () => ({ useAuth: () => ({ status: "authenticated" }) }));
import { PublicOnly } from "../src/App";
import { reasonLabel } from "../src/features/attention/AttentionPage";

function at(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<PublicOnly />}><Route path="/login" element={<p>login</p>} /><Route path="/register" element={<p>register</p>} /></Route>
        <Route path="/onboarding" element={<p>wizard</p>} />
        <Route path="/overview" element={<p>overview</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("signed-in visitors on public pages", () => {
  it("a new workspace goes from /register to the setup wizard", () => {
    at("/register");
    expect(screen.getByText("wizard")).toBeTruthy();
  });
  it("/login still goes to Overview", () => {
    at("/login");
    expect(screen.getByText("overview")).toBeTruthy();
  });
});

describe("needs attention reasons", () => {
  it("shows system reason codes as sentences and leaves free text alone", () => {
    expect(reasonLabel("agent_unavailable")).toMatch(/not live/);
    expect(reasonLabel("customer asked for a person")).toBe("customer asked for a person");
  });
});
