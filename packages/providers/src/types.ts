// Provider interfaces. Everything external (LLM, email, storage, calendar, billing)
// sits behind one of these so tests/dev run with the deterministic mocks and no keys.

// ---------------------------------------------------------------- LLM
export type ChatRole = "system" | "user" | "assistant" | "tool";
export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** assistant messages that requested tools */
  toolCalls?: ToolCall[];
  /** tool-role messages: which call this answers */
  toolCallId?: string;
  name?: string;
}
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments */
  parameters: Record<string, unknown>;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface LlmRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** sent as `reasoning_effort` (none|minimal|low|medium|high) by OpenAI-compatible providers that support it; omit otherwise */
  reasoningEffort?: string;
  /** Ask for a JSON object response */
  json?: boolean;
  signal?: AbortSignal;
}
export interface LlmResponse {
  content: string;
  toolCalls: ToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "other";
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}
export interface LlmProvider {
  readonly name: string;
  chat(req: LlmRequest): Promise<LlmResponse>;
}

// ---------------------------------------------------------------- Email
export interface EmailMessage {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  from?: string;
  replyTo?: string;
}
export interface EmailProvider {
  readonly name: string;
  send(msg: EmailMessage): Promise<{ id: string }>;
}

// ---------------------------------------------------------------- Storage (S3-compatible)
export interface StoredObject {
  body: Uint8Array;
  contentType?: string;
}
export interface StorageProvider {
  readonly name: string;
  put(key: string, body: Uint8Array | string, opts?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Time-limited GET URL (null if the backend cannot presign). */
  signedUrl(key: string, opts?: { expiresInSec?: number }): Promise<string | null>;
}
/** Optional virus scan hook (CLAMAV_URL). Resolves `clean:false` to reject the upload. */
export interface VirusScanner {
  scan(body: Uint8Array): Promise<{ clean: boolean; signature?: string }>;
}

// ---------------------------------------------------------------- Calendar
export interface TimeSlot {
  start: string; // ISO 8601
  end: string;
}
export interface CalendarEventInput {
  title: string;
  start: string;
  end: string;
  attendeeEmail?: string;
  description?: string;
  timezone?: string;
}
export interface CalendarProvider {
  readonly name: string;
  availability(q: { from: string; to: string; durationMinutes: number; timezone?: string }): Promise<TimeSlot[]>;
  createEvent(e: CalendarEventInput): Promise<{ id: string; url?: string }>;
  cancelEvent(id: string): Promise<void>;
}

// ---------------------------------------------------------------- Billing
export interface BillingEvent {
  type: string;
  customerId?: string;
  subscriptionId?: string;
  planKey?: string;
  raw?: unknown;
  /** Provider event id (idempotency key). */
  id?: string;
  /** Provider-neutral effect; events with no action are acknowledged and ignored. */
  action?: "subscription_set" | "subscription_deleted" | "payment_failed" | "payment_succeeded" | "credit_topup";
  /** credit_topup: `ref` is the idempotency key (checkout session id), `credits` whole credits purchased. */
  topup?: { ref: string; packId?: string; credits: number; amountCents?: number };
  /** Provider subscription status (active|trialing|past_due|unpaid|canceled|...). */
  status?: string;
  /** Tenant id when the provider carries it (checkout metadata / client_reference_id). */
  tenantId?: string;
  periodEnd?: Date;
  cancelAtPeriodEnd?: boolean;
}
export interface BillingProvider {
  readonly name: string;
  /** Plan keys purchasable via checkout (undefined = any paid plan; stub). */
  checkoutPlans?(): string[];
  createCustomer(i: { tenantId: string; email: string; name: string }): Promise<{ customerId: string }>;
  createCheckoutSession(i: { customerId: string; planKey: string; successUrl: string; cancelUrl: string; tenantId?: string }): Promise<{ url: string }>;
  createPortalSession(i: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** One-time payment for a credit pack; absent => credit purchases unavailable. */
  createCreditCheckout?(i: {
    customerId: string; tenantId: string; pack: { id: string; name: string; credits: number; priceCents: number; currency: string };
    successUrl: string; cancelUrl: string;
  }): Promise<{ url: string }>;
  cancelSubscription(subscriptionId: string): Promise<void>;
  /** Verify the signature and parse a webhook; throws on invalid signature. */
  parseWebhook(rawBody: string, signature: string | null): Promise<BillingEvent>;
}

export interface Providers {
  llm: LlmProvider;
  email: EmailProvider;
  storage: StorageProvider;
  calendar: CalendarProvider;
  billing: BillingProvider;
  virusScanner?: VirusScanner;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
  }
}
