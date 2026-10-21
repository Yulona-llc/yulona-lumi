# Credits, AI usage metering and LLM provider config (Wave 4 / B1)

Contract for the dashboard Usage page and the platform-admin Credits UI. Migration `0910`. Errors use the standard envelope `{ error: { code, message, requestId, details? } }`.

## Concepts

- **Micro-credits.** All credit amounts on the wire are integers in micro-credits (`1 credit = 1_000_000 micro`). Divide by `1e6` for display. Fields end in `Micro`. Plan limits (`plan_limits.llm_credits_monthly`) and admin grants/pack sizes are in whole credits (admin grant accepts decimals).
- **Cost of a call** = `ceil((promptTokens * inputMicroPer1k + completionTokens * outputMicroPer1k) / 1000)` micro, using the rate row for the model, else the `*` default row.
- **Deployment mode.** `saas`: platform-managed LLM, credits are charged, gated, top-ups sold. `selfhosted`: usage is still recorded (events carry the computed cost for information) but credits are never charged, never gated, no billing. `GET /usage/credits` returns `enabled: false` there; the UI should hide credit meters and show tokens only.
- **Monthly period** (UTC calendar month, `period` = first day, `YYYY-MM-01`). Monthly allowance = `plan_limits.llm_credits_monthly` (credits; `null` = unlimited) of the tenant's current plan (re-read on every call, so an upgrade takes effect immediately). Placeholder values: free 50, pro 1500, enterprise/self_hosted unlimited. Consumption draws the **monthly allowance first, then the top-up balance**. The top-up balance carries over to the next month; the allowance resets. An in-flight call can overshoot, so `topupMicro` may be slightly negative (a later top-up pays that off).
- **Warnings** (once per period each, admin/owner notifications of type `credits.warning_80` and `credits.exhausted` through the existing notifications API): `warning_80` at >= 80% of the available pool, `exhausted` when `remaining <= 0`.
- **Gate (SaaS only).** When `remaining <= 0` the AI does not call the model: the inbound message raises a `system_failure` handoff with reason `ai_credits_exhausted` (appears in Needs Attention), the customer gets a safe notice (text from env `CREDITS_EXHAUSTED_MESSAGE`, default "Our assistant is temporarily unavailable. A member of our team will get back to you shortly."), and the sandbox returns `402 credits_exhausted`. Buying a credit pack lifts the gate immediately.

## Tenant endpoints (always mounted, JWT, any deployment mode)

### `GET /api/v1/usage/credits` (any role)
```json
{
  "mode": "saas",              // "saas" | "selfhosted"
  "enabled": true,             // false in selfhosted: hide the credit UI
  "unlimited": false,          // plan has no credit limit
  "period": "2026-10-01",
  "allowanceMicro": 50000000,  // monthly allowance, null when unlimited / selfhosted
  "usedMicro": 12000000,       // consumed from the allowance this period
  "topupMicro": 0,             // remaining top-up balance (carries over)
  "topupUsedMicro": 0,         // consumed from top-ups this period
  "remainingMicro": 38000000,  // allowance left + topup balance; null when unlimited / selfhosted
  "percentUsed": 24,           // 0-100 (can exceed 100 on overshoot), null when unlimited / selfhosted
  "status": "ok",              // "ok" | "warning" (>=80%) | "exhausted" (remaining <= 0)
  "warnings": []               // subset of ["warning_80", "exhausted"]
}
```

### `GET /api/v1/usage/ai?from=&to=&groupBy=day|agent|model|conversation` (min role admin)
`from`/`to`: ISO dates `YYYY-MM-DD` (UTC, inclusive), default last 30 days, max span 366 days. `groupBy` default `day`.
```json
{
  "from": "2026-09-20", "to": "2026-10-19", "groupBy": "agent",
  "items": [
    { "key": "<agent uuid>", "label": "Support bot", "promptTokens": 1200, "completionTokens": 300,
      "totalTokens": 1500, "requests": 9, "creditsMicro": 450000 }
  ],
  "totals": { "promptTokens": 1200, "completionTokens": 300, "totalTokens": 1500, "requests": 9, "creditsMicro": 450000 }
}
```
`key`/`label`: day -> `YYYY-MM-DD`; agent -> agent id + name (`"(unattributed)"` when no agent, `"(deleted agent)"`); model -> model name (label same; `"(unknown)"`); conversation -> conversation id (top 200 by credits). `day` is ascending, the others sort by `creditsMicro` descending. Events also carry `source` (`turn|sandbox|builder|tool_test`), included only in the CSV export.

### `GET /api/v1/usage/ai/export` (min role admin)
Same query as above, plus nothing else; returns `text/csv` (`Content-Disposition: attachment`) with columns `key,label,promptTokens,completionTokens,totalTokens,requests,creditsMicro`.

## Billing router (SaaS only; mounted with the other billing routes, so absent in selfhosted)

### `GET /api/v1/billing/credit-packs` (min role admin)
`{ "items": [ { "id": "<uuid>", "name": "Starter", "credits": 500, "priceCents": 900, "currency": "usd" } ] }` (active packs only, cheapest first).

### `POST /api/v1/billing/credits/checkout` (min role admin)
Body `{ "packId": "<uuid>" }` (strict). Returns `{ "url": "<provider checkout url>" }`; redirect the browser. Errors: `404 not_found` (unknown/inactive pack), `503 service_unavailable` (provider down or provider has no one-time payments, e.g. none configured). On success the provider webhook (`POST /api/v1/webhooks/billing`) adds the pack's credits to `topupMicro`, idempotently (a re-delivered event or the second event for the same checkout session is ignored). Success/cancel redirect back to `{APP_URL}/settings/billing?credits=success|cancelled`.

The existing `GET /billing` response also lists `llm_credits_monthly` among `limits` (values in credits, `used` rounded up).

## Platform-admin endpoints (`/api/v1/admin/...`, platform-admin bearer token, SaaS or when `SUPER_ADMIN_ENABLED`)
All writes go through `sa_*` SECURITY DEFINER functions and are recorded in `platform_audit_logs` (`llm_profile.create|update|delete`, `model_rate.set|delete`, `credit_pack.upsert|delete`, `credits.grant`, `plan.limit`).

### LLM provider profiles (any OpenAI-compatible service)
Profile object (the API key is **never** returned):
```json
{ "id": "uuid", "name": "OpenAI prod", "baseUrl": "https://api.openai.com/v1",
  "authHeader": "Authorization",        // header name used for the key
  "authScheme": "bearer",               // "bearer" -> "<authHeader>: Bearer <key>", "raw" -> "<authHeader>: <key>" (e.g. api-key), "none"
  "extraHeaders": { "x-org": "abc" },   // NOT secret: stored and returned in the clear
  "queryParams": { "api-version": "2024-06-01" },  // appended to every request (Azure)
  "chatPath": "/chat/completions",
  "defaultModel": "gpt-4o-mini",
  "enabledModels": ["gpt-4o-mini", "gpt-4o"],   // models agents may choose; anything else falls back to defaultModel
  "isDefault": true, "enabled": true, "hasCredentials": true,
  "createdAt": "...", "updatedAt": "..." }
```
- `GET /admin/llm-profiles` -> `{ items: Profile[] }`; `GET /admin/llm-profiles/:id`.
- `POST /admin/llm-profiles` (201). Body (strict): `name` (1-80), `baseUrl` (https in SaaS; SSRF-checked: private/loopback hosts rejected unless deployment is selfhosted), `defaultModel` (required), `apiKey?` (write-only, <= 4096; needs `ENCRYPTION_KEY`, else `503`), `authHeader?` (header token, default `Authorization`), `authScheme?` (default `bearer`), `extraHeaders?`, `queryParams?` (<= 20 string entries each; headers `host`, `content-length`, `connection`, `transfer-encoding`, `cookie` are refused), `chatPath?` (starts with `/`), `enabledModels?` (<= 100), `isDefault?`, `enabled?`. Errors: `400` (validation, SSRF/URL), `409` (duplicate name), `503` (no `ENCRYPTION_KEY`).
- `PATCH /admin/llm-profiles/:id` same fields, all optional; `apiKey: null` clears the key. Setting `isDefault: true` unsets the previous default (atomic). A disabled profile is never the default.
- `DELETE /admin/llm-profiles/:id` -> `{ ok: true }`.
- `POST /admin/llm-profiles/:id/test` body `{ model? }` -> `{ ok: boolean, latencyMs: number, model: string|null, error: string|null }` (always 200; calls the provider with a tiny prompt; the key is scrubbed from `error`).
- Runtime: SaaS resolves the default enabled profile per call (30 s cache) and falls back to env (`AI_*`) when none exists; selfhosted uses env only. Env also supports `AI_AUTH_HEADER`, `AI_AUTH_SCHEME`, `AI_EXTRA_HEADERS` (JSON), `AI_QUERY` (JSON), `AI_CHAT_PATH`.

### Model rates
- `GET /admin/model-rates` -> `{ items: [ { model, inputMicroPer1k, outputMicroPer1k, enabled, updatedAt } ] }` (the `*` default row is always present).
- `PUT /admin/model-rates` body `{ model, inputMicroPer1k, outputMicroPer1k, enabled? }` (non-negative integers; `model` 1-120 chars or `*`) -> the row. Upsert.
- `DELETE /admin/model-rates?model=<name>` -> `{ ok: true }`; the `*` row cannot be deleted (`400`).
- Defaults: `*` = 250_000 in / 1_000_000 out micro-credits per 1k tokens (0.25 / 1 credit).

### Plan credit limits
`PUT /admin/plans/:key/limits/llm_credits_monthly` body `{ "limit": 1500 }` (credits; `null` = unlimited): the existing plans endpoint (`GET /admin/plans` lists it with the other limits).

### Credit packs
- `GET /admin/credit-packs` -> `{ items: [ { id, name, credits, priceCents, active, sortOrder, createdAt } ] }` (includes inactive).
- `POST /admin/credit-packs` (201) body `{ name, credits (int 1..10_000_000), priceCents (int >= 0), active?, sortOrder? }`; `PATCH /admin/credit-packs/:id` (same, optional); `DELETE /admin/credit-packs/:id` (hard-deletes a never-purchased pack, otherwise deactivates it so purchase history stays) -> `{ ok: true, result: "deleted"|"deactivated" }`. Seed: Starter 500 credits / 9.00 USD, Growth 2500 / 39.00, Scale 10000 / 129.00 (placeholders).

### Tenant credits
- `GET /admin/tenants/:id/credits` -> same shape as `GET /usage/credits` for that tenant (plus `"planKey"`).
- `POST /admin/tenants/:id/credits` body `{ "credits": 100, "reason": "Goodwill after outage" }` (`credits` non-zero number, may be negative to deduct, up to 6 decimals; `reason` 3-300 chars) -> updated credits object. Adds to the top-up balance, audit-logged with the reason, and also creates a `credits.granted` tenant notification for owners/admins when positive. `404` for unknown tenant.

## Notes for the frontend
- Show the Usage page meter from `GET /usage/credits`; when `status` is `warning`/`exhausted` show the banner and a "Buy credits" button (`/billing/credit-packs` + checkout) in SaaS only (`mode === "saas"`).
- `status: "exhausted"` also means customers are being handed off: link to Needs Attention.
- Inside the sandbox, `402 credits_exhausted` has `details: { remainingMicro }`. The sandbox response also carries `usage` (tokens) and, when the agent's model was not allowed, `modelNote`.
