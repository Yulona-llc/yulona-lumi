import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider";
import { setFetchImpl } from "../src/api/client";
import BookingsPage from "../src/features/bookings/BookingsPage";

const uid = "11111111-1111-4111-8111-111111111111";
const session = (role: string) => ({ accessToken: "t", expiresIn: 900, user: { id: uid, email: "a@b.co", name: "A", role }, tenant: { id: "22222222-2222-4222-8222-222222222222", name: "T" } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const booking = (o = {}) => ({ id: "b1", status: "booked", title: "Demo call", startAt: "2030-03-01T10:00:00Z", endAt: "2030-03-01T10:30:00Z", timezone: null, contactId: null, contactName: "Lee", conversationId: null, attendeeEmail: null, notes: null, provider: "google", externalEventId: null, eventUrl: null, failureReason: null, cancelledAt: null, createdAt: "x", ...o });
const google = (o = {}) => ({ provider: "google", configured: true, connected: true, accountEmail: "g@x.test", calendarId: "primary", status: "active", isDefault: true, ...o });
const calendly = (o = {}) => ({ provider: "calendly", configured: true, connected: true, accountEmail: "c@x.test", calendarId: "https://api.calendly.com/event_types/E", eventTypeSelected: true, status: "active", isDefault: false, ...o });
const off = (p: string) => ({ provider: p, configured: true, connected: false });
const slot = (iso: string, mins = 30) => ({ start: iso, end: new Date(Date.parse(iso) + mins * 60000).toISOString() });
const soon = (h: number) => new Date(Date.now() + h * 3600_000 + 86_400_000).toISOString();

function mount(role: string, routes: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  setFetchImpl((async (u: string, init?: RequestInit) => {
    const p = u.replace(/^.*\/api\/v1/, "");
    calls.push({ url: p, method: init?.method ?? "GET", body: init?.body as string | undefined });
    if (p === "/auth/refresh") return json(session(role));
    const hit = Object.entries({ "/bookings": { items: [booking()], nextCursor: null }, ...routes }).sort((a, b) => b[0].length - a[0].length).find(([k]) => p.startsWith(k));
    if (hit) return typeof hit[1] === "function" ? (hit[1] as (u: string, i?: RequestInit) => Response)(p, init) : json(hit[1]);
    return json({ error: { code: "not_found", message: "nope" } }, 404);
  }) as unknown as typeof fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><AuthProvider><Routes><Route path="/" element={<BookingsPage />} /><Route path="/settings/integrations" element={<p>connectors page</p>} /></Routes></AuthProvider></MemoryRouter>
    </QueryClientProvider>);
  return calls;
}
beforeEach(() => { document.cookie = "yl_csrf=c; path=/"; try { localStorage.clear(); } catch { /* */ } });
const newBtn = async () => (await screen.findAllByRole("button", { name: /new booking/i }))[0]!;

describe("bookings: calendar status strip and New booking", () => {
  it("no calendar connected: New booking disabled with a hint, inline Connect Google and Connect Calendly", async () => {
    const calls = mount("admin", { "/calendar/connections": { items: [off("google"), off("calendly")], default: null }, "/calendar/google/connect": { url: "about:blank#g" } });
    expect(await newBtn()).toBeDisabled();
    expect(await screen.findByText(/connect a calendar to create bookings/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Calendly" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /manage in connectors/i })).toHaveAttribute("href", "/settings/integrations");
    await userEvent.click(screen.getByRole("button", { name: "Connect Google" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/calendar/google/connect" && c.method === "POST")).toBe(true));
  });

  it("only Calendly connected: New booking is enabled and the modal is the Calendly slot picker (no picker, no free-time fields)", async () => {
    mount("admin", { "/calendar/connections": { items: [off("google"), calendly({ isDefault: true })], default: "calendly" }, "/bookings/availability": { slots: [slot(soon(1)), slot(soon(2))], source: "calendly" } });
    const btn = await newBtn();
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).queryByRole("group", { name: "Calendar" })).toBeNull();
    expect(within(dlg).queryByLabelText("Duration")).toBeNull();
    expect((await within(dlg).findAllByRole("radio")).length).toBe(2);
    expect(within(dlg).getByRole("button", { name: "Create booking" })).toBeDisabled();
  });

  it("Calendly: slot + attendee email required, request carries provider and the chosen slot", async () => {
    const s1 = soon(1);
    const calls = mount("admin", {
      "/calendar/connections": { items: [off("google"), calendly()], default: "calendly" },
      "/bookings/availability": { slots: [slot(s1)], source: "calendly" },
      "/bookings": (p: string, i?: RequestInit) => (i?.method === "POST" ? json(booking({ status: "booked", provider: "calendly" }), 201) : json({ items: [booking()], nextCursor: null })),
    });
    await waitFor(async () => expect(await newBtn()).toBeEnabled());
    await userEvent.click(await newBtn());
    const dlg = await screen.findByRole("dialog");
    await userEvent.click((await within(dlg).findAllByRole("radio"))[0]!);
    const create = within(dlg).getByRole("button", { name: "Create booking" });
    expect(create).toBeDisabled();
    await userEvent.type(within(dlg).getByLabelText("Attendee email"), "cust@example.test");
    expect(create).toBeEnabled();
    await userEvent.click(create);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/bookings")).toBe(true));
    const body = JSON.parse(calls.find((c) => c.method === "POST" && c.url === "/bookings")!.body!);
    expect(body).toMatchObject({ provider: "calendly", attendeeEmail: "cust@example.test", startAt: new Date(s1).toISOString() });
    expect(calls.find((c) => c.url.startsWith("/bookings/availability"))!.url).toContain("provider=calendly");
  });

  it("Calendly offered: shows the single-use link with Copy instead of closing", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mount("admin", {
      "/calendar/connections": { items: [off("google"), calendly()], default: "calendly" },
      "/bookings/availability": { slots: [slot(soon(1))], source: "calendly" },
      "/bookings": (_p: string, i?: RequestInit) => (i?.method === "POST" ? json(booking({ status: "offered", provider: "calendly", attendeeEmail: "cust@example.test", eventUrl: "https://calendly.com/d/single-1" }), 201) : json({ items: [], nextCursor: null })),
    });
    await waitFor(async () => expect(await newBtn()).toBeEnabled());
    await userEvent.click(await newBtn());
    const dlg = await screen.findByRole("dialog");
    await userEvent.click((await within(dlg).findAllByRole("radio"))[0]!);
    await userEvent.type(within(dlg).getByLabelText("Attendee email"), "cust@example.test");
    await userEvent.click(within(dlg).getByRole("button", { name: "Create booking" }));
    expect(await screen.findByLabelText("Scheduling link")).toHaveValue("https://calendly.com/d/single-1");
    expect(screen.getByText(/no booking exists yet/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy scheduling link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://calendly.com/d/single-1"));
  });

  it("only Google connected: free-time form with duration; provider is sent", async () => {
    const calls = mount("admin", { "/calendar/connections": { items: [google(), off("calendly")], default: "google" }, "/bookings": (_p: string, i?: RequestInit) => (i?.method === "POST" ? json(booking(), 201) : json({ items: [], nextCursor: null })) });
    await waitFor(async () => expect(await newBtn()).toBeEnabled());
    await userEvent.click(await newBtn());
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByLabelText("Duration")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "Start date" }));
    await userEvent.click(await screen.findByRole("button", { name: "Today" })); // the platform picker, not the native one; the time defaults to 09:00
    expect(within(dlg).getByRole("button", { name: "Start time" })).toHaveTextContent(/9:00/);
    await userEvent.click(within(dlg).getByRole("button", { name: "Create booking" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/bookings")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === "POST" && c.url === "/bookings")!.body!)).toMatchObject({ provider: "google", durationMinutes: 30 });
  });

  it("both connected: provider picker switches between the Google form and the Calendly slots", async () => {
    mount("admin", { "/calendar/connections": { items: [google({ isDefault: false }), calendly({ isDefault: true })], default: "calendly" }, "/bookings/availability": { slots: [slot(soon(1))], source: "calendly" } });
    await waitFor(async () => expect(await newBtn()).toBeEnabled());
    await userEvent.click(await newBtn());
    const dlg = await screen.findByRole("dialog");
    const picker = within(dlg).getByRole("group", { name: "Calendar" });
    expect(within(picker).getByRole("button", { name: "Calendly", pressed: true })).toBeInTheDocument();
    await userEvent.click(within(picker).getByRole("button", { name: "Google Calendar" }));
    expect(await within(dlg).findByLabelText("Duration")).toBeInTheDocument();
    await userEvent.click(within(picker).getByRole("button", { name: "Calendly" }));
    expect((await within(dlg).findAllByRole("radio")).length).toBe(1);
  });

  it("Calendly with no open times says so; an errored connection still shows Needs attention", async () => {
    mount("admin", { "/calendar/connections": { items: [off("google"), calendly({ status: "error" })], default: "calendly" }, "/bookings/availability": { slots: [], source: "calendly" } });
    expect(await screen.findByText("Needs attention")).toBeInTheDocument();
    await waitFor(async () => expect(await newBtn()).toBeEnabled());
    await userEvent.click(await newBtn());
    expect(await screen.findByText(/no open times/i)).toBeInTheDocument();
  });

  it("agents cannot read connections: strip hidden, New booking stays available (server decides)", async () => {
    mount("agent", {});
    expect(await newBtn()).toBeEnabled();
    expect(screen.queryByRole("heading", { name: "Calendars" })).toBeNull();
  });

  it("viewers get no New booking", async () => {
    mount("viewer", {});
    await screen.findByText("Demo call");
    expect(screen.queryByRole("button", { name: /new booking/i })).toBeNull();
  });
});
