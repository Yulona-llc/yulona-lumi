import type {
  BillingEvent, BillingProvider, CalendarEventInput, CalendarProvider, EmailMessage, EmailProvider,
  LlmProvider, LlmRequest, LlmResponse, StorageProvider, StoredObject,
  TimeSlot, ToolCall, VirusScanner,
} from "./types";

const approxTokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));

/**
 * Deterministic mock LLM (no network). Behaviour, in order:
 *  1. `respond` override, if given.
 *  2. Last user message starting with `/tool <name> <json args>` => returns that tool call.
 *  3. Last user message starting with `/fail` => throws (simulates provider outage).
 *  4. Otherwise echoes: `[mock] <last user message>`.
 * All requests are recorded in `calls` for assertions.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = "mock";
  readonly calls: LlmRequest[] = [];
  constructor(private readonly respond?: (req: LlmRequest) => Partial<LlmResponse> | Promise<Partial<LlmResponse>>) {}

  async chat(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const inputTokens = approxTokens(req.messages.map((m) => m.content).join("\n"));
    const model = req.model ?? "mock-1";
    const override = await this.respond?.(req);
    let r: Partial<LlmResponse> = override ?? {};
    if (!override) {
      const last = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const tm = /^\/tool\s+([a-z][a-z0-9_]*)\s*(.*)$/s.exec(last);
      if (last.startsWith("/fail")) throw new Error("mock llm failure");
      if (tm) {
        let args: Record<string, unknown> = {};
        try { args = tm[2] ? JSON.parse(tm[2]) : {}; } catch { /* leave empty */ }
        const call: ToolCall = { id: `call_${this.calls.length}`, name: tm[1]!, arguments: args };
        r = { content: "", toolCalls: [call], finishReason: "tool_calls" };
      } else {
        r = { content: `[mock] ${last}` };
      }
    }
    const content = r.content ?? "";
    return {
      content,
      toolCalls: r.toolCalls ?? [],
      finishReason: r.finishReason ?? (r.toolCalls?.length ? "tool_calls" : "stop"),
      usage: r.usage ?? { inputTokens, outputTokens: approxTokens(content) },
      model: r.model ?? model,
    };
  }
}

/** Collects messages in memory (`sent`). */
export class MockEmailProvider implements EmailProvider {
  readonly name = "mock";
  readonly sent: EmailMessage[] = [];
  async send(msg: EmailMessage) {
    this.sent.push(msg);
    return { id: `mock-${this.sent.length}` };
  }
}

/** Dev provider: logs the message (never use for real delivery). */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";
  constructor(private readonly write: (line: string) => void = (l) => console.log(l)) {}
  async send(msg: EmailMessage) {
    this.write(`[email] to=${[msg.to].flat().join(",")} subject=${JSON.stringify(msg.subject)}\n${msg.text}`);
    return { id: `console-${Date.now()}` };
  }
}

export class MemoryStorageProvider implements StorageProvider {
  readonly name = "memory";
  private readonly objects = new Map<string, StoredObject>();
  async put(key: string, body: Uint8Array | string, opts?: { contentType?: string }) {
    this.objects.set(key, { body: typeof body === "string" ? new TextEncoder().encode(body) : body, contentType: opts?.contentType });
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  async signedUrl(key: string) {
    return this.objects.has(key) ? `memory://${key}` : null;
  }
  keys() {
    return [...this.objects.keys()];
  }
}

export class MockVirusScanner implements VirusScanner {
  async scan(body: Uint8Array) {
    const infected = new TextDecoder().decode(body.slice(0, 4096)).includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE");
    return infected ? { clean: false, signature: "Eicar-Test-Signature" } : { clean: true };
  }
}

/** Fixed availability: 09:00-17:00 UTC on weekdays, `durationMinutes` slots, minus booked events. */
export class MockCalendarProvider implements CalendarProvider {
  readonly name = "mock";
  readonly events = new Map<string, CalendarEventInput>();
  async availability(q: { from: string; to: string; durationMinutes: number }): Promise<TimeSlot[]> {
    const out: TimeSlot[] = [];
    const to = new Date(q.to).getTime();
    const step = q.durationMinutes * 60_000;
    const day = new Date(q.from);
    day.setUTCHours(0, 0, 0, 0);
    for (let d = day.getTime(); d <= to && out.length < 200; d += 86_400_000) {
      const dow = new Date(d).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      for (let t = d + 9 * 3_600_000; t + step <= d + 17 * 3_600_000; t += step) {
        if (t < new Date(q.from).getTime() || t + step > to) continue;
        const slot = { start: new Date(t).toISOString(), end: new Date(t + step).toISOString() };
        const busy = [...this.events.values()].some((e) => e.start < slot.end && e.end > slot.start);
        if (!busy) out.push(slot);
      }
    }
    return out;
  }
  async createEvent(e: CalendarEventInput) {
    const id = `evt_${this.events.size + 1}`;
    this.events.set(id, e);
    return { id, url: `https://calendar.mock/${id}` };
  }
  async cancelEvent(id: string) {
    this.events.delete(id);
  }
}

/** Used when STRIPE_SECRET_KEY is unset: all operations succeed locally and return fake URLs. */
export class StubBillingProvider implements BillingProvider {
  readonly name = "stub";
  async createCustomer(i: { tenantId: string }) {
    return { customerId: `cus_stub_${i.tenantId.slice(0, 8)}` };
  }
  async createCheckoutSession(i: { successUrl: string }) {
    return { url: i.successUrl };
  }
  async createPortalSession(i: { returnUrl: string }) {
    return { url: i.returnUrl };
  }
  async createCreditCheckout(i: { successUrl: string }) {
    return { url: i.successUrl };
  }
  async cancelSubscription() {}
  async parseWebhook(rawBody: string): Promise<BillingEvent> {
    // Dev/test only: unsigned JSON; extra fields (id, action, customerId, ...) are passed through.
    const j = JSON.parse(rawBody) as BillingEvent;
    return { ...j, type: j.type ?? "unknown", raw: j };
  }
}
