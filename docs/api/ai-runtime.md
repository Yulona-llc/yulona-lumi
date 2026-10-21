# AI runtime and knowledge API

Owner: `airuntime`. Code: `packages/ai-runtime`, `apps/api/src/routes/knowledge.ts`. Migration: `packages/db/migrations/0200_ai_runtime.sql`.
All endpoints are under `/api/v1`, require `Authorization: Bearer <access JWT>`, tenant comes from the token only, bodies are strict (unknown fields => 400). Errors use the standard envelope. Write endpoints require role `owner` or `admin`; reads and the sandbox are open to any authenticated tenant user.

## 1. Knowledge sources

Source DTO: `{ id, agentId|null, type: "file"|"url"|"text", name, status: "pending"|"processing"|"ready"|"failed", error|null, sourceUrl|null, fileName|null, sizeBytes, chunkCount, attempts, maxPages?, lastIngestedAt|null, createdAt, updatedAt }`.
`agentId = null` means tenant-wide knowledge; otherwise only that agent retrieves it. Status flow: `pending -> processing -> ready | failed` (a failed source is retried by the queue up to 4 attempts for transient errors; permanent errors such as unsupported file or blocked URL stay `failed` immediately with a readable `error`).

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/knowledge/sources` | `?agentId&status&limit(1-100, 50)&offset` | `{ items, limit, offset }` |
| GET | `/knowledge/sources/:id` | | source DTO / 404 |
| GET | `/knowledge/sources/:id/chunks` | `?limit(1-100, 20)&offset` | `{ items: [{ id, chunkIndex, content, tokenCount }] }` |
| POST | `/knowledge/sources/text` | `{ name, text (<=900k chars), agentId? }` | 201 source (pending) |
| POST | `/knowledge/sources/url` | `{ url, name?, agentId?, maxPages? (1-25, default 1) }` | 201. Private/loopback/link-local/metadata hosts => 400 |
| POST | `/knowledge/sources/file` | `multipart/form-data`: `file` (required), `name?`, `description?`, `agentId?` | 201. Types: pdf, docx, txt, md, html; max 10 MB; magic bytes checked; optional ClamAV (`CLAMAV_URL`: `tcp://host:3310` clamd INSTREAM, or `http(s)://` benzino77 REST wrapper `POST /api/v1/scan`, field `FILES`; fails closed) |
| POST | `/knowledge/sources/:id/reingest` | | 202; 409 if already queued/processing |
| DELETE | `/knowledge/sources/:id` | | `{ ok: true }`; cascades chunks and stored file bytes |

Notes for the UI: poll `GET /knowledge/sources` (or `:id`) while any source is `pending|processing`. Uploaded file size is also bounded by the global `BODY_LIMIT_BYTES` (default 1 MB); raise it (and the reverse proxy limit) to allow the full 10 MB. Every create/reingest/delete writes an audit log (`knowledge.source.create|reingest|delete`). Ingestion: extract text -> split into titled sections (the skill's sections, stored as chunks rows) -> keyword-searchable; no embeddings. URL sources crawl same-origin links up to `maxPages`; every hop (including redirects) is re-checked against private IP ranges, responses are capped (2 MB/page, 15 s).

## 2. Sandbox test console

`POST /knowledge/sandbox` (20 requests/min per user)
Request: `{ agentId, message (<=2000), stage?: ConversionStage (default "visitor"), history?: [{role:"user"|"assistant", content}] (<=10), lead?: {name,email,phone,need,budget,timeline} }`
Response:
```json
{
  "answer": "plain text",
  "ui": { "version": 1, "components": [ ... WidgetUISchema ... ] },
  "stageBefore": "visitor", "stageAfter": "engaged",
  "guardTriggered": false,
  "handoff": null | { "type": "uncertainty|stage|system_failure", "reason", "summary", "leadCard?", "customerMessage" },
  "toolRuns": [{ "name", "input", "output?", "success", "error?", "latencyMs" }],
  "lead": {},
  "usage": { "promptTokens", "completionTokens" },
  "retrieved": [{ "id", "sourceId", "sourceName", "score", "content", "usedForAnswer" }]
}
```
`retrieved` lists the skill sections the agent had in front of it: sections pre-loaded by keyword search (or all of them when the knowledge base is small) plus any it opened with the `search_skills` / `read_skill` tools. `score` is the 0..1 keyword rank (1 = loaded wholesale) and `usedForAnswer` is always true. There is no similarity threshold, top-K or embedding step; see "Knowledge as skills". It runs the production turn logic in dry-run mode: nothing is persisted (only token usage counters), custom tools are not called (reported as `dryRun`). Unknown agent (or another tenant's) => 404. The sandbox always tests the saved draft (`agents.config`) via `loadAgent(tx, tenantId, agentId, { draft: true })`, even when a version is published; live traffic uses the published version.

## 3. Agent config consumed by the runtime

Loaded from `agents` (`published_version` set => `agent_versions.config` for that version; otherwise `agents.config`). Keys: `systemPrompt`, `greeting?` (widget opening message fallback), `fallbackMessage`, `handoffMessage`, `model?`, `enabledTools` (default all built-ins), `customTools: [{ manifest: ToolManifest, secret? }]`, `handoffAtQualified` (bool). Custom tools run server-side only over HTTP: `endpointTemplate` is `"[METHOD ]https://host/path/{{param}}"` (default POST; GET puts leftover params in the query string), `authType` api_key => `X-API-Key`, bearer/oauth2 => `Authorization: Bearer <secret>`, `responseMapping` maps output keys to dot paths of the JSON response.

## 4. Worker job contract (for `conversations` and `platform`)

Handlers: `createJobHandlers({ db, ports, onEvent? })` from `@yulona/ai-runtime`, returns `Record<jobName, (payload) => Promise<void>>`. Register in `apps/worker/src/jobs/index.ts`. `ports` = `portsFromProviders(createProvidersFromEnv())`. Runtime needs the app-role `db` (never the owner).

| Job | Payload (strict) | Producer |
|---|---|---|
| `ai.respond` | `{ tenantId, conversationId, messageId }` (uuids) | conversations: enqueue in the SAME transaction that inserts the customer message, only when `conversations.handler = 'ai'` |
| `knowledge.ingest` / `knowledge.crawl` | `{ tenantId, sourceId }` | knowledge routes |

`ai.respond` behaviour (`handleInboundMessage`):
1. Skips (returns normally, no reply) when: conversation/message not found, message is not `sender_type='contact'`, `conversations.status` is `pending_human` or `resolved`, `handler='human'`, AI is paused/stage is `handoff_requested`, an AI reply to this `messageId` already exists (idempotent; retries are safe, a per-conversation advisory lock prevents double replies), or no agent resolves (`conversations.agent_id`, else the tenant's oldest agent).
2. Loads the agent's skills (see "Knowledge as skills"); the model answers from them or declines with `[[NO_ANSWER]]`, which clarifies first and hands off (`uncertainty`) at the agent's limit.
3. Builds the system prompt with ONLY the actions legal for the current stage; customer and KB text are wrapped in `<user_message>` / `<knowledge>` blocks (delimiter-escaped) and declared untrusted. Tool calls are validated and gated by stage again server-side.
4. Inserts one row into `messages`: `sender_type='ai'`, `content` = plain-text rendition, `ui` = `WidgetUISchema` formatted for the channel capability (forms/buttons degrade to numbered text on poor channels), `metadata = { inReplyTo, agentId, stage, guardTriggered, sources:[{sourceId,name,score}], handoff?:{type,reason}, windowExpired? }`. It also updates `conversations.last_message_at/last_message_preview`. If `metadata.windowExpired` is true the channel's reply window has passed and the adapter must send a template instead of this text.
5. Form submissions: if the customer message has `metadata.uiEvent = { type: "form", values: {...} }` the runtime handles it deterministically (collect_contact / qualify_lead, no LLM).
6. Retryable failures (DB) throw so the queue retries; LLM or tool failures become a `system_failure` handoff instead.

Realtime: the job does not publish. Pass `onEvent` to `createJobHandlers`; it is called after commit with `{ type: "message.created" | "conversation.stage_changed" | "conversation.handoff", tenantId, conversationId, messageId?, data? }`. Wire it to the realtime publisher.

Handoff (any of three types) in one transaction: row in `handoffs` (`type`, `reason`, `summary` = last turns, `lead_card` for `stage` type or whenever lead data exists, `context`), `conversation_ai_state.stage = handoff_requested` and `ai_paused = true`, `conversations.status = 'pending_human'`, and a customer-facing message. AI stays silent until a human returns the conversation: call `returnConversationToAi(tx, tenantId, conversationId)` (exported) inside the same transaction that sets `status='open'`/`handler='ai'`; it resumes at `engaged`. Lead card: `{ name?, email?, phone?, need?, budget?, timeline?, score?, stage, summary }`.

## 5. Stage machine and funnel data

Table `conversation_ai_state(tenant_id, conversation_id, stage, lead jsonb, ai_paused, last_handoff_type)` is created lazily on first AI turn (default `visitor`; no stage column on `conversations`). Every change appends `stage_transitions(from_stage, to_stage, reason, created_at)` (append-only, validated against `STAGE_TRANSITIONS` in `@yulona/shared`). Automatic rules: first AI reply `visitor -> engaged`; `qualify_lead` with need plus (budget or timeline) => `qualified`; escalation or `handoffAtQualified` => `handoff_requested`. Wave 2 booking uses exported `markBookingOffered` / `markBooked`. Funnel queries: `SELECT to_stage, count(DISTINCT conversation_id) FROM stage_transitions WHERE tenant_id = $1 AND created_at >= $2 GROUP BY 1`.

Stage-allowed actions: visitor `collect_contact, escalate_to_human`; engaged and qualified add `qualify_lead`; booking_offered `collect_contact, escalate_to_human`; booked `escalate_to_human`; handoff_requested none. Custom tools default to engaged/qualified/booking_offered unless `manifest.allowedStages` says otherwise.

## 6. Other tables written by the runtime

`tool_executions` (tool_name, input, output, success, error, latency_ms, conversation_id), `handoffs`, `stage_transitions`, `ai_usage(tenant_id, day, kind, amount)` with kinds `llm_prompt_tokens, llm_completion_tokens, embedding_tokens, llm_requests` (feeds the `llm_tokens_monthly` plan limit). All have RLS ENABLE + FORCE with `tenant_id` policies.

## 7. Security notes

- SSRF: http(s) only, no credentials, DNS answers must all be public; redirects are re-validated per hop; size and time caps. DNS is resolved by the validator and again by `fetch`, so also run the worker behind an egress policy that blocks private ranges (residual DNS-rebinding window).
- Prompt injection: data delimiters + tag stripping, rules restated as highest priority, stage-gated tool list enforced both in prompt and executor; the model can never call a tool that is not legal in the current stage.
- Provider keys never reach the browser; custom tool secrets are never put in prompts.

## 8. In-process (external) tools, e.g. calendar

`createJobHandlers({ db, ports, externalTools })` accepts `externalTools: ExternalToolProvider = { manifests: ToolManifest[], execute({tenantId, conversationId}, name, input) => { kind: "ok"|"rejected"|"failed", output?, error? } }`. ai-runtime does not import `@yulona/ops` (it depends on ai-runtime); the worker wires it, adapting `CALENDAR_TOOL_MANIFESTS` and `executeCalendarTool`. A tool is offered only if the agent lists its name in `enabledTools` and the stage is in the manifest's `allowedStages`; input is validated against `inputSchema`. `rejected` is fed back to the model; `failed` is treated as "handoff already raised by the provider": the runtime records the tool run, sends the customer handoff message and raises no second handoff. Stage changes made by the tool are respected (the runtime only applies legal hops from the current DB stage). The sandbox never executes external tools.

## Handoff flow (clarify first, never leave the customer waiting)

Agent config (`escalationRules`, plus `clarifyMessage`):

| Field | Default | Behaviour |
|---|---|---|
| `escalationRules.maxUnansweredTurns` | 3 | Consecutive customer questions with no grounded answer before the AI hands off. Below the limit the AI replies with a clarifying message (LLM-written in the customer's language, `clarifyMessage` as fallback) and keeps the conversation. A grounded answer or a return to AI resets the counter (`conversation_ai_state.unanswered_turns`). `1` = hand off on the first miss. |
| `escalationRules.keywords` | `[]` | Customer message containing one hands off immediately. |
| `escalationRules.resumeKeyword` | `"AI"` | While the conversation waits for a person, replying with exactly this word (case/punctuation-insensitive) returns it to the AI. Empty disables it. |
| `clarifyMessage` | built-in | Static fallback for the clarifying reply. |

- Explicit requests for a person ("talk to a human", "real person please", ...) hand off immediately (reason `customer asked for a person`) without retrieval or an LLM call. Greetings/thanks/goodbyes are answered conversationally and never count as misses.
- Every handoff message gets a notice appended: how to carry on with the AI (`reply "AI"`), and, when `ops_in_business_hours` is false, that the team is offline (omitted when `outOfHours.mode = message`, whose own notice is posted by the DB trigger).
- `ai.respond` is now enqueued for every customer message that is not on a resolved conversation. While paused the runtime skips it (`skipped: ai_paused`) unless it is the resume keyword **and** an unresolved handoff exists **and** no person has replied since it was raised. Then: conversation -> `open`/`ai`, handoffs resolved (`resolution_note = "customer resumed the AI"`), system message `customer_resumed_ai`, AI welcome message, result `{ status: "resumed" }`.
- Migration `0900_ai_unanswered_turns.sql` adds `conversation_ai_state.unanswered_turns` (run `bun run migrate` before starting the new worker).

## Knowledge as skills (no embeddings)

Every knowledge source is a **skill**: `{ skill: "<slug>", name, description, sections }`. Ingestion (`knowledge.ingest`, no AI calls) extracts text, splits it into titled sections (markdown/HTML headings; otherwise paragraphs grouped to ~2000 chars) and stores them in `knowledge_chunks` (`title`, `content`, full-text index over title + content). The description defaults to the first sentence plus section titles and can be set at creation (`description`) or via `PATCH /knowledge/sources/:id` `{ name?, description? }` (owner/admin; `null` description restores the automatic one).

Per customer message the runtime:
1. Answers small talk and explicit "talk to a person" requests without touching knowledge.
2. Loads the agent's skill index. If all knowledge is <= 9000 characters it is placed in the prompt whole (one LLM call, no tools).
3. Otherwise the prompt carries the skill list plus the best keyword matches (stemmed prefix terms, ranked by Postgres `ts_rank_cd` and term coverage), and the model may call `search_skills {query, skill?}` and `read_skill {skill, section?}` (up to 4 rounds). Results come back inside `<knowledge_result>` data blocks.
4. The model answers from that knowledge, or replies `[[NO_ANSWER]] <clarifying question>`: the runtime counts an unanswered turn (clarify first, hand off after `escalationRules.maxUnansweredTurns`, see "Handoff flow"). An agent with no ready skills takes the same path.

`similarityThreshold` / `topK` in agent config are deprecated and ignored (kept so stored configs validate). Sandbox `retrieved[]` lists the skill sections the agent had (`score` 1 = loaded wholesale, otherwise keyword match 0..1); `threshold` is gone and `usage` has no `embeddingTokens`. Source DTOs gain `skill` and `description`; `GET /knowledge/sources/:id/chunks` items gain `title` (they are the skill's sections).
