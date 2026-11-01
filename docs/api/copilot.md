# Onboarding, copilot and overview API (wave 7 / K)

Contract for the workspace profile, the onboarding wizard, the "Ask Lumi" copilot and the goal-based overview. All routes live under `/api/v1`, use the normal auth (bearer or cookie + CSRF) and the standard error envelope `{ error: { code, message, details?, requestId } }`. Migrations 1020-1049.

## Workspace profile

`tenants.goals text[]` (values `support`, `leads`, `bookings`, `other`, max 4, no duplicates) and `tenants.onboarding jsonb`.

| Route | Role | Body / response |
|---|---|---|
| `GET /workspace/profile` | viewer+ | `{ name, goals: Goal[], onboarding: { status: "not_started"\|"in_progress"\|"completed"\|"skipped", completedAt: iso\|null, skippedAt: iso\|null } }` |
| `PUT /workspace/profile` | admin+ | strict body `{ goals: Goal[] }`; returns the profile. Audit `workspace.profile.update` |

## Onboarding wizard

Admins only (owner/admin). Progress is stored server-side (`tenants.onboarding`), so it can be resumed from any device. The dashboard renders each step from a **typed step schema** with a whitelisted component map; the server never sends markup.

Step shape:

```
{ id, title, help?, component: "choice_cards"|"multi_chips"|"text"|"url"|"brand"|"hours"|"preview",
  required: boolean, skippable: boolean, multi?: boolean, maxSelect?: number, maxLength?: number,
  placeholder?: string, options?: { value, label, description?, suggested?: boolean }[] }
```

Step ids, in order: `businessType`, `businessName`, `goals`, `channels`, `tone`, `languages`, `hours`, `website`, `brand`, `handoff`, `preview`. Options of later steps depend on earlier answers (suggestions per business type, marked `suggested: true`). `preview` has no answer; it summarises what will be created.

Answer value by component: `choice_cards` string (an option value), `multi_chips` string[] (option values), `text` string, `url` string (https URL, may be empty when skippable), `brand` `{ color: "#RRGGBB", logoUrl?: https URL }`, `hours` `{ mode: "always" }` or `{ mode: "custom", timezone, days: { weekday 0-6, start "HH:MM", end "HH:MM" }[] }`.

| Route | Description |
|---|---|
| `GET /onboarding` | `{ status, currentStepId, steps: Step[], answers: Record<stepId, value>, progress: { done, total }, result: BundleResult \| null }` |
| `PUT /onboarding/answers` | body `{ stepId, value }`; value validated against that step (400 with `details` per field). Marks the status `in_progress`, moves `currentStepId` to the next unanswered step. Returns the same shape as `GET /onboarding` |
| `POST /onboarding/skip` | marks `skipped` (answers kept). Returns the state. Resumable: `PUT /onboarding/answers` flips back to `in_progress` |
| `POST /onboarding/finish` | builds the starter bundle (idempotent: a second call returns the stored `result` with 200, creates nothing). Requires answers for `businessType`, `businessName`, `goals`. 201 first time |

`BundleResult`: `{ agentId, widgetId, knowledgeSourceId: string\|null, usedModel: boolean, goals, nextStep: { label, path } }`.

Starter bundle (server templates per business type and tone): agent **draft** (system prompt, greeting, fallback, tools by goal), widget (name, `primaryColor`, `welcomeMessage`, `title`), knowledge URL source (`followLinks: true`, `maxDepth: 3`, `maxPages: 25`) when a website was given, ops settings (timezone, business hours, out-of-hours mode), `tenants.goals`. Never publishes. Plan limits apply: if the plan has no room for the agent or widget the call fails with 402 `plan_limit_exceeded` and nothing is created. A website that fails the SSRF check is skipped (no knowledge source) and the rest of the bundle is still built.

Model polish: after the template bundle is created, **one** call through the LlmResolver (`maxTokens` 700, prompt capped at about 1,300 tokens, total <= 2,000 tokens) rewrites `systemPrompt` and `greeting` only. The call is made at most once per workspace (guard stored in `tenants.onboarding.polishAttempted`, set atomically before the call), metered as `ai_usage_events.source = 'onboarding'` with `charge: false` (credits are recorded but never taken from the customer). On provider failure, missing platform provider, invalid output or timeout the template text stays and `usedModel` is `false`.

Errors: 403 `forbidden` for non-admins; 400 `validation_error` (with `details`) when finishing without the required answers; 409 `conflict` when answering after completion.

## Copilot ("Ask Lumi")

Drawer available app-wide to owners and admins. Reuses the agent-builder pattern (persisted sessions/messages, tool loop, metering) with a small whitelisted tool set.

Tables: `copilot_sessions` (`busy_until` is the DB-backed in-flight guard), `copilot_messages`, `copilot_pending_actions` (`token_hash` = sha256 of the token, `expires_at` 15 minutes, `status`).

### Access (gating)

`copilotAccess`: self-hosted: allowed, never charged. SaaS: allowed only when `billing_customers.status` in (`active`,`trialing`) AND `billing_customers.plan_key` is set and not `free`. Otherwise locked. Allowed accounts also have a separate monthly allowance, plan limit metric `copilot_credits_monthly` (placeholders: free 0, pro 150, enterprise 600, self_hosted unlimited; `null` = unlimited). Usage = sum of `ai_usage_events.credits_micro` with `source = 'copilot'` this UTC month, `charge: false` (never drawn from chat credits).

| Status | `code` | When |
|---|---|---|
| 402 | `copilot_requires_plan` | free/unpaid/canceled/past due workspace. `details: { upgradePath: "/settings/billing" }` |
| 402 | `copilot_limit_reached` | allowance used up. `details: { limitCredits, usedMicro, resetsAt }` |
| 429 | `rate_limited` | per-user rate (20 messages/min, 10 new sessions/min), per-session cap (40 user messages or 60,000 tokens), per-workspace cap (500 user messages per UTC month) |
| 409 | `conflict` | previous message still being answered (DB guard), session closed, pending action already used/expired |
| 503 | `service_unavailable` | AI provider unavailable |

### Routes (all admin+)

| Route | Description |
|---|---|
| `GET /copilot/status` | `{ access: "allowed"\|"locked", reason: "requires_plan"\|null, selfHosted, allowance: { limitCredits: number\|null, usedMicro, remainingMicro: number\|null, resetsAt }, session: { id, userMessages, maxUserMessages } \| null }` (always 200, also when locked) |
| `POST /copilot/sessions` | 201 `{ id, status, messages, limits }`; 402 when locked or over limit |
| `GET /copilot/sessions/:id` | own session with messages (tool messages hidden) |
| `POST /copilot/sessions/:id/messages` | body `{ text }` or `{ choice }` (exactly one). Returns `{ messages, assistant, allowance }`. Max 3 tool rounds per message; `maxTokens` 600 per call; model from `COPILOT_MODEL` when set |
| `POST /copilot/sessions/:id/confirm` | body `{ token }`: executes the pending high-impact action as the calling user and returns `{ ok, message }` (the new assistant message). Token is single use, bound to session+user+tenant, expires after 15 minutes |
| `POST /copilot/sessions/:id/cancel` | body `{ token }`: cancels the pending action |

### Tools (model side, whitelist)

`get_workspace_summary`, `update_agent_draft` (same `agentConfigSchema` validation and forbidden keys as the builder; edits the draft only), `publish_agent` (proposes only; returns a confirm block, never publishes), `update_widget_appearance`, `add_knowledge_url`, `set_business_hours`, `set_goals`, `list_channel_status`, `suggest_next_steps`. Each tool declares a minimum role and runs under that check as the calling user. There is no tool that confirms, deletes, disconnects, reads secrets or reads knowledge/customer text. The workspace summary contains counts, names, ids, statuses and booleans only. Audit rows use the same action names as the REST routes with `metadata.via = "copilot"` and `metadata.sessionId`.

### Message payload (assistant messages)

`payload.blocks` is an array from this whitelist (rendered by dashboard components; never HTML):

- `chips` `{ options: string[] }` (clicking sends the text as a `choice`)
- `checklist` `{ items: { label, done, path? }[] }`
- `diff` `{ title, changes: { field, before, after }[] }`
- `preview` `{ title, lines: string[] }`
- `confirm` `{ token, title, summary, expiresAt }`
- `link` `{ label, path }` (internal paths only)

## Overview

`GET /overview` (viewer+, one call). `{ goals, common, support?, leads?, bookings?, order: Goal[] }` with the blocks of the workspace goals only (`other` has no block). Window: last 30 days, UTC.

- `common`: `{ conversations: { last30d, open, today }, credits: { remainingMicro\|null, allowanceMicro\|null }, channels: { total, connected, unhealthy }, setup: { items: { key, label, done, path }[], doneCount, total } }`
- `support`: `{ aiResolvedPct\|null, handoffs, medianFirstResponseSeconds\|null, unanswered: { count, items: { id, conversationId, createdAt }[] } }` (unanswered = `handoffs.type = 'uncertainty'`; no customer text)
- `leads`: `{ funnel: { stage, count }[], qualified, hubspot: { connected, lastSyncAt\|null, failed } }`
- `bookings`: `{ upcoming, booked30d, cancelled30d, calendar: { connected, provider\|null } }`

Empty state: when `goals` is empty the dashboard shows a "tell Lumi your goal" prompt.
