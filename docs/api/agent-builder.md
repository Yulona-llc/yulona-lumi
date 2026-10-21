# Agent builder chat (Wave 4 / B3)

Migration `0930`: `builder_sessions` (tenant, user, status `open|created|abandoned`, `draft` jsonb, `agent_id`, `tokens_used`), `builder_messages` (role `user|assistant|tool`, `content`, `payload` jsonb), `agents.created_via` (`null|'builder'`). RLS ENABLE+FORCE. All routes: JWT, owner/admin only, strict bodies; a session is visible only to the user who started it (other users and tenants get `404`).

## Endpoints (`/api/v1`)
- `POST /agent-builder/sessions` (body `{}`; 10/min) -> `201` session: `{ id, status, agentId, draft, limits, messages[], createdAt, updatedAt }`. `messages[0]` is the assistant's opening question.
- `GET /agent-builder/sessions/:id` -> same session (reload/audit). `messages[].payload`: assistant `{ ask: { question, options[] } }` (render `options` as quick-reply chips), `{ ready: true }` (the model called finish); user `{ choice: true }`; tool messages `{ name, ok, reply }` (hide them in the UI).
- `POST /agent-builder/sessions/:id/messages` (20/min) body `{ text }` or `{ choice }` (exactly one) -> `{ messages[] (new, incl. tool), assistant, draft, ready }`. Errors: `402 credits_exhausted` (SaaS, nothing persisted), `409` (session closed, or previous message still being answered), `429` (rate limit, 60 user messages or 150k tokens per session), `503` (AI provider down).
- `POST /agent-builder/sessions/:id/create` (body `{}`) -> `201 { agentId, name, status: "draft", sandboxHint: { path: "/agents/<id>", tab: "sandbox", message } }`. Creates a DRAFT through the same repository, plan limit (`402 plan_limit_exceeded`) and audit path as `POST /agents`; sets `created_via='builder'`; never publishes. `400` when name/system prompt/greeting are still missing; `409` when the session already created an agent.

## Draft
`draft = { name?, description?, config: <partial agentConfig>, knowledge: [{ id, name, type }], ready }`. The model changes it with `update_draft(patch)`; every patch is merged and the whole config validated with `agentConfigSchema.safeParse` (errors go back to the model to repair). It cannot set `model`, `customTools`, `similarityThreshold`, `topK`; `enabledTools` is limited to `qualify_lead, collect_contact, escalate_to_human, check_availability, book_appointment`.

## Model tools
`update_draft`, `ask(question, options?)` (ends the turn), `create_knowledge_source(type url|text, name, url|content)` (same repository, `storage_mb` limit, SSRF check, ingest job and audit as `/knowledge/sources/*`; tenant-wide source; max 3 per session), `finish(summary?)` (needs name, systemPrompt, greeting).

## Metering and credits
Every LLM call is recorded in `ai_usage_events` with `source='builder'` (no agent) through `addUsage`. SaaS gates before the call (`creditsRemaining <= 0` -> `402 credits_exhausted`); self-hosted records only. Prompts contain only the static rules and the draft; the model is told never to accept secrets.
