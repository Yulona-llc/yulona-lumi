import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider";
import { setFetchImpl } from "../src/api/client";
import CalendarSettings from "../src/features/bookings/CalendarSettings";

const uid = "11111111-1111-4111-8111-111111111111";
const session = (role: string) => ({ accessToken: "t", expiresIn: 900, user: { id: uid, email: "a@b.co", name: "A", role }, tenant: { id: "22222222-2222-4222-8222-222222222222", name: "T" } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

const hubspotOff = { configured: true, connected: false, status: null, lastError: null, lastSyncAt: null, connectedAt: null, mapping: { properties: {}, sourceValue: "Lumi chat", syncOnBooked: true }, recent: [] };
function mount(role: string, routes0: Record<string, unknown>, at = "/") {
  const routes = { "/crm/hubspot": hubspotOff, ...routes0 };
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  setFetchImpl((async (u: string, init?: RequestInit) => {
    const p = u.replace(/^.*\/api\/v1/, "");
    calls.push({ url: p, method: init?.method ?? "GET", body: init?.body as string | undefined });
    if (p === "/auth/refresh") return json(session(role));
    const hit = Object.entries(routes).sort((a, b) => b[0].length - a[0].length).find(([k]) => p.startsWith(k));
    if (hit) return json(hit[1]);
    return json({ error: { code: "not_found", message: "nope" } }, 404);
  }) as unknown as typeof fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[at]}><AuthProvider><Routes><Route path="/" element={<CalendarSettings />} /></Routes></AuthProvider></MemoryRouter>
    </QueryClientProvider>);
  return calls;
}
beforeEach(() => { document.cookie = "yl_csrf=c; path=/"; try { localStorage.clear(); } catch { /* */ } });

const google = { provider: "google", configured: true, connected: false };
const calendly = (o = {}) => ({ provider: "calendly", configured: true, connected: true, accountEmail: "o@cal.test", calendarId: "https://api.calendly.com/event_types/ET1", eventTypeSelected: true, status: "active", lastError: null, isDefault: true, connectedAt: "2026-01-01T00:00:00Z", ...o });
const types = { items: [{ uri: "https://api.calendly.com/event_types/ET1", name: "Intro", durationMinutes: 30, schedulingUrl: null, selected: true }, { uri: "https://api.calendly.com/event_types/ET2", name: "Deep dive", durationMinutes: 60, schedulingUrl: null, selected: false }] };

describe("calendar settings", () => {
  it("shows Google and Calendly cards; connects Calendly via its own endpoint", async () => {
    const calls = mount("admin", { "/calendar/connections": { items: [google, { provider: "calendly", configured: true, connected: false }], default: null } });
    expect(await screen.findByRole("button", { name: "Connect Calendly" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Google Calendar" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect Calendly" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/calendar/calendly/connect" && c.method === "POST")).toBe(true));
  });

  it("connected Calendly: status, event type picker, change type, error state shows reconnect + last error", async () => {
    const calls = mount("admin", { "/calendar/connections": { items: [google, calendly({ status: "error", lastError: "token refresh failed (reconnect Calendly)" })], default: "calendly" }, "/calendar/calendly/event-types": types, "/calendar/calendly/event-type": { eventTypeUri: "x", name: "Deep dive", durationMinutes: 60 } });
    expect(await screen.findByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/token refresh failed/);
    expect(screen.getByRole("button", { name: /reconnect/i })).toBeInTheDocument();
    const sel = await screen.findByLabelText("Event type the AI books");
    await userEvent.selectOptions(sel, "https://api.calendly.com/event_types/ET2");
    await waitFor(() => expect(calls.find((c) => c.url === "/calendar/calendly/event-type")?.body).toBe(JSON.stringify({ eventTypeUri: "https://api.calendly.com/event_types/ET2" })));
  });

  it("disconnect needs confirmation; both connected => choose the calendar the AI uses; unconfigured server is explained", async () => {
    const calls = mount("admin", { "/calendar/connections": { items: [{ provider: "google", configured: true, connected: true, accountEmail: "g@x.test", calendarId: "primary", status: "active", isDefault: false }, calendly()], default: "calendly" }, "/calendar/calendly/event-types": types, "/calendar/default": { default: "google" }, "/calendar/calendly/connection": {} });
    await userEvent.click(await screen.findByRole("radio", { name: "Google Calendar" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/calendar/default")?.body).toBe(JSON.stringify({ provider: "google" })));
    await userEvent.click(screen.getByRole("button", { name: /disconnect calendly/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/calendar/calendly/connection" && c.method === "DELETE")).toBe(true));
  });

  it("unconfigured provider disables connect with an explanation; OAuth redirect banners; non-admin sees a notice", async () => {
    mount("admin", { "/calendar/connections": { items: [google, { provider: "calendly", configured: false, connected: false }], default: null } }, "/?calendar=connected&provider=calendly");
    expect(await screen.findByText(/CALENDLY_CLIENT_ID/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Calendly" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Calendly connected.");
  });
  it("Connectors page: header, Calendar and CRM sections", async () => {
    mount("admin", { "/calendar/connections": { items: [google, { provider: "calendly", configured: true, connected: false }], default: null } });
    expect(await screen.findByRole("heading", { level: 1, name: "Connectors" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Calendar" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "CRM" })).toBeInTheDocument();
  });

  it("Calendly card shows the exact redirect URL with Copy and registration steps", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const uri = "https://api.example.test/api/v1/calendar/calendly/callback";
    mount("admin", { "/calendar/connections": { items: [google, { provider: "calendly", configured: true, connected: false, redirectUri: uri, redirectSource: "PUBLIC_API_URL", redirectWarning: null, redirectError: null }], default: null } });
    expect(await screen.findByTestId("calendly-redirect-url")).toHaveTextContent(uri);
    expect(screen.getByText(/Register this exact URL as its Redirect URI/)).toBeInTheDocument();
    expect(screen.getByText(/built from PUBLIC_API_URL/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy redirect URL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(uri));
    expect(screen.getByRole("button", { name: "Connect Calendly" })).toBeEnabled();
  });

  it("redirect warning is shown; a pre-flight error disables Connect", async () => {
    mount("admin", { "/calendar/connections": { items: [google, { provider: "calendly", configured: true, connected: false, redirectUri: "http://localhost:4000/cb", redirectSource: "localhost_fallback", redirectWarning: null, redirectError: "PUBLIC_API_URL is not set, so the Calendly redirect URL fell back to localhost." }], default: null } });
    expect((await screen.findAllByRole("alert")).some((a) => /fell back to localhost/.test(a.textContent ?? ""))).toBe(true);
    expect(screen.getByRole("button", { name: "Connect Calendly" })).toBeDisabled();
  });
  it("redirect warning (not an error) keeps Connect enabled", async () => {
    mount("admin", { "/calendar/connections": { items: [google, { provider: "calendly", configured: true, connected: false, redirectUri: "http://localhost:4000/cb", redirectSource: "localhost_fallback", redirectWarning: "PUBLIC_API_URL is not set, so the redirect URL uses localhost.", redirectError: null }], default: null } });
    expect(await screen.findByRole("status")).toHaveTextContent(/PUBLIC_API_URL is not set/);
    expect(screen.getByRole("button", { name: "Connect Calendly" })).toBeEnabled();
  });

  it("OAuth error flash uses plain language and Calendly's own description", async () => {
    mount("admin", { "/calendar/connections": { items: [google, { provider: "calendly", configured: true, connected: false }], default: null } }, "/?calendar=error&provider=calendly&reason=invalid_grant&detail=redirect%20uri%20mismatch");
    const alert = await screen.findByText(/Could not connect Calendly\./);
    expect(alert).toHaveTextContent(/not exactly the one shown below/);
    expect(screen.getByText(/Calendly said: redirect uri mismatch/)).toBeInTheDocument();
    expect(screen.queryByText(/invalid_grant/)).toBeNull();
  });

  it("agents cannot manage calendars", async () => {
    mount("agent", {});
    expect(await screen.findByText(/Only admins/)).toBeInTheDocument();
  });
});
