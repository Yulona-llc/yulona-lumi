# Conversations API (contacts, conversations, messages, widgets, public widget API, realtime)

Owner: `conversations` agent. Zod schemas (source of truth for shapes): `packages/shared/src/conversations.ts`
(`@yulona/shared`). All bodies are `.strict()` (unknown fields => 400). Errors use the standard envelope
`{ error: { code, message, requestId, details? } }`. Timestamps are ISO-8601 strings. IDs are UUIDs.
`tenantId` is never accepted from clients.

Base paths: dashboard API `/api/v1/...` (Bearer access JWT). Public widget API `/api/v1/public/widget/...`
(also reachable at the alias `/public/widget/...` for deployments that route it directly). The prod Caddy only
proxies `/api/*`, so **widgets should use the `/api/v1/public/widget` form**.

## Data model (summary)
- `conversation.status`: `open` | `pending_human` (AI stopped, needs a person: "Needs Attention") | `resolved`.
- `conversation.handler`: `ai` (AI answers) | `human` (a person took over). `ai.respond` jobs are only enqueued
  when `status = open AND handler = ai`.
- `message.senderType`: `contact` | `ai` | `human` | `system` | `note`. `note` (internal) and `system` are
  **never** sent to visitors. A message may have `content` (plain-text fallback, always set) and `ui`
  (`WidgetUISchema`, see `@yulona/shared`).
- Contacts are contact-centric: one contact has many conversations/identities across channels.

## Dashboard endpoints (Bearer JWT, roles owner|admin|agent unless noted)

### Conversations
| Method | Path | Notes |
|---|---|---|
| GET | `/conversations` | Query: `status`, `handler`, `channel`, `assignee` (`me`\|`unassigned`\|uuid), `contactId`, `q` (matches contact name/email/phone, last preview and message text), `limit` (1-100, default 30), `cursor`. Returns `{ items: ConversationSummary[], nextCursor }` ordered by `lastMessageAt desc`. |
| GET | `/conversations/:id` | `ConversationSummary` + `contact` details. 404 across tenants. |
| GET | `/conversations/:id/messages` | Query `before` (message id), `limit` (default 50). Returns `{ items: MessageDto[] (oldest->newest within page), nextCursor }`; `nextCursor` = id to pass as `before` for older messages. Includes internal notes. |
| POST | `/conversations/:id/messages` | `{ text, kind?: "reply"\|"note" }`. `reply` is sent as `human` (implicitly takes over: `handler=human`, assigns the sender if unassigned, `pending_human` -> `open`). `note` is internal. Returns `MessageDto` (201). |
| POST | `/conversations/:id/takeover` | Sets `handler=human`, `assignedUserId=me`, status `open`. 409 if assigned to someone else (owner/admin may force). |
| POST | `/conversations/:id/return-to-ai` | `handler=ai`, unassigned, status `open`; writes a `system` message `metadata.event="returned_to_ai"`. |
| PATCH | `/conversations/:id` | `{ status?: "open"\|"resolved", assignedUserId?: uuid\|null }`. |

### Contacts
| Method | Path | Notes |
|---|---|---|
| GET | `/contacts` | `q`, `limit`, `cursor` -> `{ items: ContactDto[], nextCursor }`. Merged-away contacts are hidden. |
| POST | `/contacts` | `{ name?, email?, phone?, customAttributes? }` (201). |
| GET | `/contacts/:id` | `ContactDto` incl. channel identities. |
| PATCH | `/contacts/:id` | Any of `name,email,phone` (null clears), `customAttributes` (merged per key; `null` value deletes the key; keys `[a-zA-Z][a-zA-Z0-9_]{0,39}`, <=50 keys). |
| DELETE | `/contacts/:id` | Only if the contact has no conversations (else 409). |
| GET | `/contacts/:id/timeline` | Cross-channel, newest first: `{ items: TimelineItem[], nextCursor }`, `TimelineItem = { type: "message"\|"conversation_started", at, conversationId, channel, message? }`. Includes conversations of contacts merged into this one. |
| POST | `/contacts/:id/merge` | `{ sourceContactId }`: moves conversations + identities from source into `:id`, fills empty fields, merges attributes (primary wins), records `contact_merges`. Source is hidden afterwards. |

### Widgets (read: any role; write: owner/admin)
| Method | Path | Notes |
|---|---|---|
| GET | `/widgets`, `/widgets/:id` | `WidgetDto` (includes the public `widgetKey`). |
| POST | `/widgets` | `{ name, agentId?, enabled?, config?, prechat?, allowedDomains? }` (201). |
| PATCH | `/widgets/:id` | Partial of the above. |
| DELETE | `/widgets/:id` | Existing conversations keep history (widget link nulled). |
| POST | `/widgets/:id/rotate-key` | New `widgetKey`; the old one stops working immediately. |
| GET | `/widgets/:id/embed` | `{ snippet, widgetKey, apiUrl, scriptUrl }`. |

`config`: `title, subtitle, welcomeMessage, primaryColor (#rrggbb), theme (light|dark|auto), position (right|left), launcherLabel, avatarUrl (https), inputPlaceholder`.
`prechat`: `{ enabled, intro?, fields: [{ name: "name"|"email"|"phone", label, required }] (max 3) }`.
`allowedDomains`: `example.com`, `*.example.com` (subdomains only), optionally with scheme and/or port. **An empty list denies every origin** (outside production, `localhost`/`127.0.0.1` are always allowed for development).

## Public widget API (no JWT)
Every request needs `X-Widget-Key: <widgetKey>` (or `?key=` for the WebSocket) **and an `Origin` header
matching the widget's allowed domains**, else `403 forbidden`. A disabled widget / suspended tenant => 403.
CORS: preflight (`OPTIONS`) is answered for any origin; `Access-Control-Allow-Origin` is only set on responses
that passed the allowlist. Session-scoped calls also need `Authorization: Bearer <sessionToken>`.
Bodies are capped at 16 KB. Rate limits (per widget + IP / session) return 429 with `Retry-After`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/config` | key | `{ widgetId, name, config, prechat, schemaVersion, features: { sse: true, ws: true } }`. Safe for caching (short). Fetch at runtime for branding. |
| POST | `/conversations` | key | Body `{ visitorId?, visitor?: {name,email,phone}, context?: {pageUrl,referrer,locale,timezone} }`. If `prechat.enabled` and a required field is missing => 400. Returns 201 `{ sessionToken, expiresIn, visitorId, conversation: { id, status, handler }, messages: PublicMessage[] }` (messages contain the welcome message when configured, else the agent's `greeting` from the published version or draft when it has one). Store `visitorId` + token in localStorage; reusing `visitorId` links new conversations to the same contact. |
| POST | `/session/refresh` | key + session | New `sessionToken` (extends expiry; old stays valid until it expires). |
| GET | `/messages` | key + session | Query `after` / `before` (message ids), `limit`. -> `{ items: PublicMessage[] (chronological), hasMore: boolean, conversation: { id, status, handler } }`. Use `after=<last id>` to catch up after reconnect. |
| POST | `/messages` | key + session | `{ text, clientMessageId }`. Idempotent per `clientMessageId` (retry-safe for the offline queue). Returns 201 `PublicMessage` (200 with the original on replay). Enqueues the AI reply (`ai.respond`) when the conversation is AI-handled. |
| POST | `/ui-events` | key + session | Form / button / calendar submissions (see `uiEventSchema`): `{ type: "form_submit"\|"button_click"\|"calendar_select", messageId, clientMessageId, ... }`. `messageId` must be a message of this conversation. Stored as a `contact` message (`content` = readable summary, `metadata.uiEvent`) and routed to the AI like a normal message. Form values for `name/email/phone` also update the contact. Returns 201 `PublicMessage`. Booking itself is Wave 2. |
| POST | `/typing` | key + session | `{ typing: boolean }` -> `{ ok: true }` (relayed to agents). |
| GET | `/stream` | key + session (headers) | **SSE** fallback (use `fetch` streaming, since `EventSource` cannot set headers). Events: `ready`, `message.created`, `conversation.updated`, `typing`; `: ping` comment every 20 s. |
| GET (upgrade) | `/ws?key=<widgetKey>` | first frame | **WebSocket**; see below. |

`PublicMessage`: `{ id, senderType: "contact"|"ai"|"human", senderName?, content, ui?, createdAt }`. `ui` is a
`WidgetUISchema` object; clients must ignore unknown component types.

Session token: HS256 JWT, `aud=yulona:widget`, claims `sub` (session id), `tid`, `wid`, `cid`, `ctid`,
`exp` (default 24 h). Server-side revocable. It is **not** accepted by dashboard endpoints and dashboard access
tokens are not accepted by public endpoints. Expired/invalid => 401 `unauthorized`: start a new conversation.

## Realtime (WebSocket + SSE)
- Dashboard: `GET /api/v1/realtime/ws` (WebSocket upgrade). Visitor: `GET /api/v1/public/widget/ws?key=...`.
- The token is **never** in the URL. First client frame must be `{ "type": "auth", "token": "<access JWT | sessionToken>" }`
  within 5 s, else the socket closes (code 4408; a bad token closes with 4401). The server answers `{ "type": "ready", "kind": "agent"|"visitor" }`.
- Client -> server frames (`wsClientFrameSchema`): `auth`, `typing` (`{ type:"typing", conversationId?, typing }`; agents must pass `conversationId`), `ping` (server replies `{"type":"pong"}`).
  Frames > 4 KB close the socket (1009). Max 5 sockets per visitor session, 5 per user, 1000 per tenant per instance.
- Server -> client events (`RealtimeEvent` in shared):
  - `message.created { conversationId, message }`: agents receive every tenant message (incl. notes) as `MessageDto`; visitors receive only their conversation's `PublicMessage` (no notes/system).
  - `conversation.updated { conversation }`: agents get a full `ConversationSummary`; visitors `{ id, status, handler }`.
  - `typing { conversationId, from: "contact"|"ai"|"human", userId?, typing }`.
  - `presence { subject: "contact"|"agent", conversationId?, userId?, online }`.
  - `error { code, message }`.
- Agents automatically receive events for their whole tenant (the "inbox" feed); there is no subscribe step.
- Fan-out across processes/instances uses Postgres `LISTEN/NOTIFY` (DB triggers fire on every message insert, so
  AI replies written by the worker reach sockets without extra wiring). Typing/presence frames use Redis pub/sub when
  `REDIS_URL` is set, otherwise Postgres NOTIFY. Presence is per-instance accurate (best effort across instances).
- Transport heartbeat: server pings every ~30 s; idle sockets are closed.

## Config (env)
`ENCRYPTION_KEY` (base64, 32 bytes; required to store channel credentials), `PUBLIC_API_URL` (used in the embed
snippet), `WIDGET_SCRIPT_URL` (default `/widget.js`), `WIDGET_SESSION_TTL_HOURS` (default 24).

## Contract with ai-runtime
Job `ai.respond` payload `{ tenantId, conversationId, messageId }` is enqueued (same transaction as the contact
message insert) for contact messages in AI-handled, `open` conversations. The runtime inserts `messages` rows
(`sender_type='ai'`, `content`, `ui`) and may set `conversations.status='pending_human'`; DB triggers publish the
realtime events and maintain `last_message_*`. Returning a conversation to the AI is signalled by the `system`
message `metadata.event="returned_to_ai"` plus `status=open, handler=ai`.
