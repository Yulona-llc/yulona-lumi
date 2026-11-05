/**
 * In-browser fake backend for the demo page / tests. NOT imported by the production entry.
 * Implements the same public contract as src/api.ts.
 */
interface PubMsg {
  id: string;
  senderType: "contact" | "ai" | "human";
  content: string;
  ui?: unknown;
  createdAt: string;
}

export interface MockOptions {
  latency?: number;
  preChat?: boolean;
  /** Toggle to simulate going offline (fetch rejects). */
  offline?: { value: boolean };
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

export function createMockFetch(opts: MockOptions = {}): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const latency = opts.latency ?? 400;
  const store: { id?: string; token?: string; msgs: PubMsg[] } = { msgs: [] };
  let n = 0;
  const mk = (senderType: PubMsg["senderType"], content: string | undefined, ui?: unknown): PubMsg => ({
    id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    senderType,
    content: content ?? "",
    ui,
    createdAt: new Date(Date.now() + n).toISOString(),
  });
  const msg = (text: string) => ({ type: "message", text });

  function reply(text: string): PubMsg {
    const t = text.toLowerCase();
    if (/book|demo|meeting|schedule/.test(t)) {
      const slots = [0, 1, 2].flatMap((d) =>
        [9, 11, 14, 16].map((h) => {
          const s = new Date();
          s.setUTCDate(s.getUTCDate() + d + 1);
          s.setUTCHours(h, 0, 0, 0);
          return { start: s.toISOString(), end: new Date(s.getTime() + 1800_000).toISOString() };
        }),
      );
      return mk("ai", undefined, { version: 1, components: [msg("Great, pick a time that works for you:"), { type: "calendar", id: "cal", timezone: "Africa/Addis_Ababa", slots }] });
    }
    if (/form|contact|email/.test(t))
      return mk("ai", undefined, {
        version: 1,
        components: [
          msg("Happy to follow up. Where should we reach you?"),
          { type: "form", id: "lead", submitLabel: "Send details", fields: [
            { name: "name", label: "Name", kind: "text", required: true },
            { name: "email", label: "Work email", kind: "email", required: true },
            { name: "size", label: "Team size", kind: "select", options: ["1-10", "11-50", "51+"] },
            { name: "notes", label: "Anything else?", kind: "textarea" },
          ] },
        ],
      });
    if (/card|pricing|plan/.test(t))
      return mk("ai", undefined, { version: 1, components: [
        msg("Here's our most popular plan. More at https://example.com/pricing."),
        { type: "card", id: "plan", title: "Growth plan", body: "Unlimited conversations, AI qualification and calendar booking.", actions: [{ label: "Talk to sales", value: "sales" }, { label: "See features", value: "features" }] },
      ] });
    if (/future|unknown/.test(t))
      return mk("ai", "Fallback text for a newer UI.", { version: 2, components: [{ type: "carousel", items: [] }, { type: "rating", title: "How did we do?" }] });
    return mk("ai", undefined, { version: 1, components: [
      msg("Hi! I'm the Lumi assistant. Try one of these (or type: book a demo, contact form, pricing card):"),
      { type: "buttons", id: "menu", buttons: [{ label: "Book a demo", value: "book" }, { label: "Pricing", value: "pricing" }, { label: "Contact me", value: "contact" }] },
    ] });
  }

  const wait = () => new Promise((r) => setTimeout(r, latency));

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    await wait();
    if (opts.offline?.value) throw new TypeError("offline");
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace(/^.*\/public\/widget/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    const authed = () => !!store.token && auth === `Bearer ${store.token}`;

    if (path === "/config")
      return json({
        name: "Lumi Support",
        schemaVersion: 1,
        welcome: "Hello! Ask me anything.",
        config: { title: "Lumi Support", subtitle: "We reply in seconds", welcomeMessage: "Hello! Ask me anything.", primaryColor: "#4f46e5", position: "right", theme: "auto" },
        prechat: opts.preChat
          ? { enabled: true, intro: "Before we start, who are we talking to?", fields: [
              { name: "name", label: "Your name", required: true },
              { name: "email", label: "Email", required: true },
            ] }
          : { enabled: false, fields: [] },
      });
    if (path === "/conversations" && method === "POST") {
      store.id = "c_" + Math.random().toString(36).slice(2, 8);
      store.token = "tok_" + Math.random().toString(36).slice(2);
      store.msgs = [mk("ai", "Hello! Ask me anything.")];
      return json({ sessionToken: store.token, expiresIn: 86400, visitorId: "11111111-1111-4111-8111-111111111111", conversation: { id: store.id, status: "open", handler: "ai" }, messages: store.msgs }, 201);
    }
    if (!["/messages", "/ui-events", "/stream", "/typing", "/session/refresh"].includes(path)) return json({ error: "not_found" }, 404);
    if (!authed()) return json({ error: { code: "unauthorized" } }, 401);
    if (path === "/stream") return json({ error: "no_sse_in_mock" }, 404); // exercises poll fallback
    if (path === "/typing") return json({ ok: true });
    if (path === "/session/refresh") return json({ sessionToken: store.token, expiresIn: 86400 });
    if (path === "/messages" && method === "GET") {
      const after = url.searchParams.get("after");
      return json({ items: store.msgs.filter((x) => !after || x.id > after), conversation: { id: store.id, status: "open", handler: "ai" } });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (path === "/messages") {
      const um = mk("contact", String(body.text ?? "").slice(0, 4000));
      store.msgs.push(um);
      setTimeout(() => store.msgs.push(reply(um.content)), latency ? 900 : 5);
      return json(um, 201);
    }
    // ui-events
    const label = body.type === "calendar_select" ? `Booked ${body.start}` : body.type === "form_submit" ? "Thanks, details received." : String(body.label ?? "");
    const um = mk("contact", label);
    store.msgs.push(um);
    setTimeout(() => store.msgs.push(reply(body.type === "button_click" ? String(body.value ?? "") : "Thanks! A teammate will confirm shortly.")), latency ? 900 : 5);
    return json(um, 201);
  }) as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}
