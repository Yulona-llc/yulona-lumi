import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, mountApp, tenantItem } from "./helpers";

const list = (items = [tenantItem()], total = items.length) => ({ items, total, limit: 25, offset: 0 });
const plans = { items: [{ key: "free", name: "Free", limits: {} }, { key: "pro", name: "Pro", limits: {} }] };

describe("customers list", () => {
  it("reads filters, sort and page from the URL and sends them to the server", async () => {
    const { calls } = mountApp("/customers?status=suspended&health=at_risk&sort=health&order=asc&page=2&q=acme", { "GET /tenants": list(), "GET /plans": plans, "GET /tags": { items: [] } });
    await screen.findByText("Acme Corp");
    const url = new URL(calls.filter((c) => c.path === "/tenants").at(-1)!.url, "http://x");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ status: "suspended", health: "at_risk", sort: "health", order: "asc", q: "acme", offset: "25", limit: "25" });
  });

  it("updates the URL-driven query when a filter or sort changes", async () => {
    const u = userEvent.setup();
    const { calls } = mountApp("/customers", { "GET /tenants": list(), "GET /plans": plans, "GET /tags": { items: [] } });
    await screen.findByText("Acme Corp");
    await u.click(screen.getByRole("button", { name: /filters/i }));
    await u.selectOptions(screen.getByLabelText("Health"), "at_risk");
    await waitFor(() => expect(calls.filter((c) => c.path === "/tenants").at(-1)!.url).toContain("health=at_risk"));
    await u.click(screen.getByRole("button", { name: "Credits" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/tenants").at(-1)!.url).toContain("sort=credits"));
  });

  it("shows owner email, health with a word, credits and the tag", async () => {
    mountApp("/customers", { "GET /tenants": list(), "GET /plans": plans, "GET /tags": { items: [] } });
    const row = (await screen.findByText("Acme Corp")).closest("tr")!;
    expect(within(row).getByText(/boss@acme.test/)).toBeInTheDocument();
    expect(within(row).getByText("62 Watch")).toBeInTheDocument();
    expect(within(row).getByText("vip")).toBeInTheDocument();
    expect(within(row).getByText("Low")).toBeInTheDocument();
  });

  it("bulk tags selected customers per the contract", async () => {
    const u = userEvent.setup();
    const { calls } = mountApp("/customers", { "GET /tenants": list([tenantItem(), tenantItem({ id: "t2", name: "Beta" })]), "GET /plans": plans, "GET /tags": { items: [{ tag: "vip", count: 1 }] }, "POST /tenants/tags/bulk": { updated: 2 } });
    await screen.findByText("Acme Corp");
    await u.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
    await u.click(screen.getByRole("button", { name: "Tag" }));
    await u.type(screen.getByLabelText("Add tags"), "Onboarding, review");
    await u.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/tenants/tags/bulk")?.body).toEqual({ tenantIds: ["t1", "t2"], add: ["onboarding", "review"] }));
  });

  it("billing role cannot bulk tag (disabled with the reason)", async () => {
    const u = userEvent.setup();
    mountApp("/customers", { "GET /tenants": list(), "GET /plans": plans, "GET /tags": { items: [] } }, { role: "billing" });
    await screen.findByText("Acme Corp");
    await u.click(screen.getByRole("checkbox", { name: "Select Acme Corp" }));
    const btn = screen.getByRole("button", { name: "Tag" });
    expect(btn).toBeDisabled();
    expect(btn.closest("span")).toHaveAttribute("aria-label", "Requires the owner or support role");
  });

  it("exports with the current filters through the authenticated client", async () => {
    const u = userEvent.setup();
    URL.createObjectURL = () => "blob:x"; URL.revokeObjectURL = () => undefined; HTMLAnchorElement.prototype.click = () => undefined;
    const { calls } = mountApp("/customers?status=active", { "GET /tenants": list(), "GET /plans": plans, "GET /tags": { items: [] }, "GET /tenants/export": () => new Response("id\n", { headers: { "Content-Disposition": 'attachment; filename="customers-2026-11-01.csv"' } }) });
    await screen.findByText("Acme Corp");
    await u.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/tenants/export" && c.url.includes("status=active"))).toBe(true));
    void json;
  });
});
