import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { readdirSync } from "node:fs";
import { websocket } from "hono/bun";
import { PASSWORD, boot, hasDb, jsonOf, type Booted } from "../support";

/**
 * Playwright smoke: login through the real dashboard bundle (apps/dashboard/dist) against the real API + DB,
 * then the inbox renders a seeded conversation. Skipped (with a note) when Chromium or the built dashboard is missing.
 */
const DIST = resolve(import.meta.dir, "../../apps/dashboard/dist");
function findChrome(): string | null {
  const base = join(homedir(), "Library/Caches/ms-playwright");
  const linux = join(homedir(), ".cache/ms-playwright");
  for (const root of [base, linux]) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      for (const rel of ["chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-linux/chrome", "chrome-linux64/chrome"]) {
        const p = join(root, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}
const chrome = findChrome();
const ready = hasDb && !!chrome && existsSync(join(DIST, "index.html"));
if (!ready) console.warn(`dashboard smoke skipped: chrome=${chrome ?? "missing"} dist=${existsSync(join(DIST, "index.html"))}`);

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2" };

describe.skipIf(!ready)("playwright smoke: login + inbox", () => {
  let b: Booted, api: ReturnType<typeof Bun.serve>, web: ReturnType<typeof Bun.serve>;
  beforeAll(async () => {
    web = Bun.serve({
      port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/config.js") return new Response(`window.__YULONA_CONFIG__ = { apiUrl: "http://localhost:${api.port}" };`, { headers: { "content-type": "text/javascript" } });
        const f = join(DIST, p === "/" ? "index.html" : p);
        if (f.startsWith(DIST) && existsSync(f) && !f.endsWith("/")) { try { return new Response(readFileSync(f), { headers: { "content-type": MIME[extname(f)] ?? "application/octet-stream" } }); } catch { /* dir */ } }
        return new Response(readFileSync(join(DIST, "index.html")), { headers: { "content-type": "text/html" } }); // SPA fallback
      },
    });
    b = await boot({ env: { CORS_ORIGINS: `http://localhost:${web.port}` } }); // allowlist is fixed at app creation
    api = Bun.serve({ port: 0, fetch: b.app.fetch, websocket: websocket as never });
  });
  afterAll(async () => { api?.stop(true); web?.stop(true); await b?.close(); });

  test("register via API, sign in through the UI, inbox lists a seeded conversation; wrong password is rejected", async () => {
    const email = `pw-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const reg = await fetch(`http://localhost:${api.port}/api/v1/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD, name: "Pat", workspaceName: "Smoke Co" }) });
    expect(reg.status).toBe(201);
    const { tenant } = await jsonOf<{ tenant: { id: string } }>(reg);
    const [c] = await b.owner<{ id: string }[]>`INSERT INTO contacts (tenant_id, name) VALUES (${tenant.id}, 'Smoke Visitor') RETURNING id`;
    const [cv] = await b.owner<{ id: string }[]>`INSERT INTO conversations (tenant_id, contact_id, last_message_preview, last_message_at) VALUES (${tenant.id}, ${c!.id}, 'Hello from the smoke test', now()) RETURNING id`;
    // the Inbox lists website chats the visitor actually wrote in
    await b.owner`INSERT INTO messages (tenant_id, conversation_id, sender_type, content) VALUES (${tenant.id}, ${cv!.id}, 'contact', 'Hello from the smoke test')`;

    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath: chrome!, headless: true });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`http://localhost:${web.port}/login`);
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill("not-the-password-123");
      await page.getByRole("button", { name: /sign in/i }).click();
      const alert = page.getByRole("alert").first();
      await alert.waitFor({ timeout: 8000 });
      expect(await alert.innerText()).toMatch(/invalid|incorrect|wrong/i);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: /sign in/i }).click();
      await page.waitForURL(/\/overview/, { timeout: 10_000 }); // landing page after sign-in
      await page.getByRole("link", { name: "Inbox", exact: true }).first().click();
      await page.waitForURL(/\/inbox/, { timeout: 10_000 });
      await page.getByRole("heading", { name: "Inbox" }).waitFor({ timeout: 10_000 });
      await page.getByText("Smoke Visitor").first().waitFor({ timeout: 10_000 });
      // access token lives in memory only
      const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
      expect(stored).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
      expect(errors).toEqual([]);
      // reload keeps the session through the httpOnly refresh cookie
      await page.reload();
      await page.getByRole("heading", { name: "Inbox" }).waitFor({ timeout: 10_000 });
    } finally { await browser.close(); }
  }, 60_000);
});
