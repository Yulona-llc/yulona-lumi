# Ops API (tickets, bookings, Needs Attention queue, availability, business hours, canned responses, tags, notifications)

Owner: `ops-backend` agent. Zod schemas (source of truth): `packages/shared/src/ops.ts` (`@yulona/shared`). Migration `0400_ops.sql`.
Conventions are the platform ones: base `/api/v1`, Bearer access JWT, strict bodies (unknown fields => 400), tenant from the token only,
errors `{ error: { code, message, requestId, details? } }`, ISO-8601 timestamps, UUID ids, 404 across tenants.
Roles: `viewer < agent < admin < owner`. "agent+" = agent, admin, owner. Lists use cursor pagination:
`?limit=` (1-100, default 30) `&cursor=` -> `{ items, nextCursor }` (`nextCursor` null on the last page).

## Tickets (read: any role; write: agent+)
`Ticket`: `{ id, number, title, description, status: open|in_progress|waiting|resolved|closed, priority: low|normal|high|urgent, assigneeUserId|null, assigneeName|null, contactId|null, contactName|null, conversationId|null, dueAt|null (SLA deadline), slaBreachedAt|null, resolvedAt|null, createdBy|null, tags: Tag[], createdAt, updatedAt }`. `number` is a per-tenant sequence (`#1042`).
| Method | Path | Notes |
|---|---|---|
| GET | `/tickets` | Query: `status` (csv ok), `priority` (csv), `assignee` (`me`\|`unassigned`\|uuid), `contactId`, `conversationId`, `tagId`, `q` (title/description/number), `slaBreached=true`, `limit`, `cursor`. Newest first. |
| GET | `/tickets/board` | Kanban data: `{ columns: { open: Ticket[], in_progress: [], waiting: [], resolved: [], closed: [] }, totals: { open: n, ... } }`; max 50 per column (newest updated first), same filters as the list (except status/cursor). |
| POST | `/tickets` | `{ title (1-200), description?, priority? (normal), assigneeUserId?, contactId?, conversationId?, dueAt? }` -> 201. `dueAt` defaults to `now + sla_minutes[priority]` (settings). Assignee/contact/conversation must belong to the tenant (else 400/404). Assigning notifies the assignee. |
| GET | `/tickets/:id` | `Ticket`. |
| PATCH | `/tickets/:id` | Any of `title, description, status, priority, assigneeUserId (null clears), dueAt (null clears), contactId, conversationId`. Changing `priority` without `dueAt` recomputes the SLA from `createdAt`. `resolved`/`closed` set `resolvedAt`; reopening clears it and the breach flag if still in time. Every change appends a `ticket_events` row. |
| POST | `/tickets/:id/comments` | `{ text (1-4000) }` -> 201 event (`type: "comment"`). |
| GET | `/tickets/:id/events` | `{ items: TicketEvent[], nextCursor }` oldest first (audit trail). `TicketEvent = { id, ticketId, actorUserId|null, actorName|null, type: created\|status_changed\|priority_changed\|assigned\|updated\|comment\|sla_breached\|bulk, data, createdAt }`. |
| POST | `/tickets/bulk` | `{ ids: uuid[] (1-100), action: "set_status"\|"set_priority"\|"assign"\|"delete", value?: string\|null }` -> `{ updated: n, skipped: n }`. `delete` needs admin+ (ticket + events removed). Each ticket gets an event with `data.bulk=true`. |
| DELETE | `/tickets/:id` | admin+. |
SLA: a worker scan (every 60 s) marks open (not resolved/closed) tickets with `dueAt < now` as breached (`slaBreachedAt`, event `sla_breached`, notification `ticket.sla_breached` to the assignee, or to all owner/admin when unassigned).

## Bookings (read: any role; write: agent+)
`Booking`: `{ id, status: booked|cancelled|failed, title, startAt, endAt, timezone|null, contactId|null, contactName|null, conversationId|null, attendeeEmail|null, notes|null, provider: "google"|null, externalEventId|null, eventUrl|null, failureReason|null, cancelledAt|null, createdAt }`.
| Method | Path | Notes |
|---|---|---|
| GET | `/bookings` | Query: `status`, `contactId`, `conversationId`, `from`, `to` (on `startAt`), `limit`, `cursor`. Upcoming-first when `from` given, else newest first. |
| GET | `/bookings/availability` | Query `from`, `to` (ISO, <= 14 days apart), `durationMinutes` (5-480, default 30), `timezone?`, `provider?` (`google` or `calendly`; default: the workspace default calendar) -> `{ slots: [{ start, end }], source: "google" \| "calendly" }`. 409 (`code: conflict`, `details.reason = "calendar_not_connected"`) when no calendar; 503 `service_unavailable` when Google keeps failing. Slots respect the tenant business hours when any are configured. |
| POST | `/bookings` | `{ startAt, endAt? \| durationMinutes? (30), title?, contactId?, conversationId?, attendeeEmail?, timezone?, notes?, provider? }` -> 201. `provider` forces one connected calendar (409 `calendar_not_connected` when it is not connected). Creates the event on the default (or forced) calendar when one is connected (provider `google`, or `calendly` via the invitee API; on the Calendly Free plan or without `attendeeEmail` the booking is stored as `offered`, `eventUrl` = single-use link, no event), otherwise a manual booking (provider null). Overlapping a `booked` booking of the same tenant => 409. Provider timeout/failure: 3 attempts with exponential backoff (0.5 s, 1 s); then the booking is stored as `failed` (it does not block the slot), admins are notified (`booking.failed`, emailed) and HTTP 503 `service_unavailable` (`details.bookingId`) is returned. A `system_failure` handoff is raised only for **AI-initiated** bookings (calendar tools) on an open, AI-handled conversation; a human clicking "book" just sees the error. With a `conversationId` the conversation stage advances to `booked` (`markBooked`). Notification `booking.created`. |
| GET | `/bookings/:id` | |
| POST | `/bookings/:id/cancel` | `{ reason? }`. Cancels the external event too. 409 if already cancelled. |

### Calendar (Google) connection (admin+)
| Method | Path | Notes |
|---|---|---|
| GET | `/calendar/connection` | `{ connected: boolean, provider?: "google", accountEmail?, calendarId?, status?: active\|error, connectedAt? }`. Tokens are never returned (stored as an AES-256-GCM envelope bound to the tenant). |
| POST | `/calendar/google/connect` | -> `{ url }`: Google consent URL (scopes `calendar.events`, `calendar.freebusy`, offline). Open it in the browser. 503 if `GOOGLE_CLIENT_ID/SECRET` or `ENCRYPTION_KEY` are not configured. The `state` is an HMAC-signed, 10-minute token bound to tenant+user. |
| GET | `/calendar/google/callback` | Public (Google redirects the browser). Validates `state`, exchanges the code, stores access/refresh tokens **encrypted**, then 302s to `${APP_URL}/settings/integrations?calendar=connected` (or `?calendar=error&reason=...`). |
| PATCH | `/calendar/connection` | `{ calendarId }` (default `primary`). |
| DELETE | `/calendar/connection` | Disconnects (stored tokens are deleted; existing bookings are kept). |
Env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (default `${PUBLIC_API_URL}/api/v1/calendar/google/callback`; register it in the Google console), `ENCRYPTION_KEY`, `PUBLIC_API_URL`, `APP_URL`. Booking cancellation stores the reason in `notes`.

### Calendly (Wave 4 B4; migration 0940)

**What was verified** (against developer.calendly.com on 2026-10-19, via the published `.md` pages and `llms.txt`; the HTML pages do not render for scrapers):
- OAuth: authorize `GET https://auth.calendly.com/oauth/authorize` (`client_id`, `response_type=code`, `redirect_uri`, PKCE `code_challenge_method=S256` + `code_challenge`; PKCE is recommended for web apps, not enforced). Token `POST https://auth.calendly.com/oauth/token` (form body, **HTTP Basic** `client_id:client_secret`; `authorization_code` with `code`, `redirect_uri`, `code_verifier`, or `refresh_token`). Access tokens live **2 h**; refresh tokens do not expire **until used (they rotate)**; limit 8 token requests per user per minute. Revoke `POST https://auth.calendly.com/oauth/revoke` (`client_id`, `client_secret`, `token`). Production redirect URIs must be HTTPS. **Scopes are chosen when the OAuth app is registered, not sent in the authorize URL.** Needed: `users:read`, `event_types:read` (includes `event_type_available_times`), `availability:read`, `scheduled_events:write` (invitee creation + cancellation), `scheduling_links:write`.
- `GET /users/me`; `GET /event_types?user=<uri>&active=true` (`duration`, `scheduling_url`, `pooling_type`); `GET /event_types/{uuid}`.
- `GET /event_type_available_times?event_type&start_time&end_time`: `start_time` must be in the future, range **at most 31 days**; response `collection[] { status: "available", start_time, invitees_remaining, scheduling_url }` (no end time: the length is the event type's `duration`).
- Scheduling API `POST /invitees` (`event_type`, `start_time`, `invitee { name|first_name, email, timezone }`, optional `location`, `questions_and_answers`, ...) -> 201 `resource { event, cancel_url, reschedule_url, ... }`. **Only on paid Calendly plans (Standard and above); Free plan => 403.**
- `POST /scheduling_links` `{ max_event_count: 1, owner: <event type uri>, owner_type: "EventType" }` -> `resource.booking_url` (single use).
- `POST /scheduled_events/{uuid}/cancellation` `{ reason? }` -> 201.

**Not verified / not possible here**: no real Calendly credentials or sandbox app were available, so nothing has run against real Calendly (all tests use a local mock that mirrors the documented shapes). Unverified details: exact error bodies (the docs show a generic shape), whether a `location` is required for event types with a location kind (we send none; Calendly may answer 400 for such event types), the Scheduling API behaviour for round-robin / collective event types, and the exact set of statuses Calendly returns for revoked refresh tokens (we treat any 4xx from the token endpoint as "reconnect required").

**Design.** `CalendlyClient` + `TenantCalendlyCalendar` in `@yulona/ops` (`calendly.ts`, `calendar.ts`). A connection stores the chosen event type URI in `calendar_connections.calendar_id` (auto-selected at connect, changeable). Availability: Calendly's own availability (the tenant business hours are not re-applied; Calendly is authoritative); the event type's `duration` overrides the model's `duration_minutes`. Booking: `POST /invitees` (invitee name from the contact, e-mail from the contact or `attendee_email`, timezone from the booking or UTC). If Calendly answers 403 (Free plan) or no invitee e-mail is known, a **single-use scheduling link** is created instead: the booking is stored with `status = "offered"` (`eventUrl` = link, no external event, does not block the slot, conversation stage NOT advanced to `booked`) and `book_appointment` returns `{ booked: false, schedulingLink }` for the model to send to the customer. Nothing marks it booked afterwards (no Calendly webhook yet). Cancelling a `booked` Calendly booking calls the cancellation endpoint with the reason; cancelling an `offered` one is local only.
OAuth state is the same HMAC-signed 10-minute tenant+user token as Google; the PKCE verifier is derived as `HMAC(JWT_SECRET, "pkce:"+state)`, so nothing is stored server-side and the verifier never appears in a URL. Tokens are AES-256-GCM sealed with AAD `calendar:{tenant}:calendly`. Refresh tokens rotate, so refreshes run under a `SELECT ... FOR UPDATE` on the connection row and re-read before spending the token (concurrent workers refresh once). A permanent refresh failure sets `status = error` with `last_error = "token refresh failed (reconnect Calendly)"`.

**Per-tenant provider.** A tenant may connect both providers; `calendar_connections.is_default` (unique per tenant) marks the one the AI and the bookings API use (the last one connected becomes default; change with `POST /calendar/default`). Healthy connections win over errored ones. Bookings remember their provider, so cancelling uses the booking's own provider. The worker (`apps/worker/src/jobs/ops-tools.ts`) now resolves the calendar per tenant on every tool call (`loadTenantCalendarAny`); a provider whose server credentials are not set is skipped. The `/bookings/availability` response `source` is `google` or `calendly`.

| Method | Path | Notes |
|---|---|---|
| GET | `/calendar/connections` | admin+. `{ items: [{ provider: google\|calendly, configured, connected, accountEmail?, calendarId?, eventTypeSelected?, status?, lastError?, isDefault?, connectedAt? }], default: provider\|null }`. `configured` = server env present. The **calendly** item also carries `redirectUri` (exactly what is sent to Calendly in both the authorize and token requests), `redirectSource` (`CALENDLY_REDIRECT_URI` \| `PUBLIC_API_URL` \| `localhost_fallback`), `redirectWarning` and `redirectError` (pre-flight verdict, below). |
| POST | `/calendar/default` | admin+. `{ provider }` -> `{ default }`. 404 if that provider is not connected. |
| POST | `/calendar/calendly/connect` | admin+. -> `{ url, redirectUri, warning }` (consent URL with PKCE). 503 if `CALENDLY_CLIENT_ID/SECRET` or `ENCRYPTION_KEY` unset. **Pre-flight:** 400 `validation_error` (`details.reason = "invalid_redirect_uri"`, `details.redirectUri`, `details.redirectSource`) when the redirect URI is not a URL, is not https (http is allowed on localhost outside `NODE_ENV=production` only), or fell back to localhost in production; `warning` is set (and logged) when `PUBLIC_API_URL` is unset or the URI is http on localhost. |
| GET | `/calendar/calendly/callback` | Public (browser redirect). Signed-state checked, code exchanged with the PKCE verifier, `/users/me` + event types read, tokens stored encrypted, becomes default, 302 to `${APP_URL}/settings/integrations?calendar=connected&provider=calendly` (or `calendar=error&provider=calendly&reason=<code>[&detail=<text>]`). `reason` is `invalid_state`, `denied` (also `error=access_denied`), `exchange_failed`, or Calendly's own OAuth `error` code (`[a-z_]` only, for example `invalid_grant`, `invalid_scope`; anything else becomes `provider_error`). `detail` is Calendly's `error_description` (token endpoint body or callback query), whitespace-collapsed and clipped to 200 characters; never a token or secret. |
| GET | `/calendar/calendly/event-types` | admin+. `{ items: [{ uri, name, durationMinutes, schedulingUrl, selected }] }`. 404 not connected, 503 Calendly down. |
| PATCH | `/calendar/calendly/event-type` | admin+. `{ eventTypeUri }`; verified against Calendly with the tenant's own token (400 when unknown/inactive/foreign host). |
| DELETE | `/calendar/calendly/connection` | admin+. Deletes the row (tokens) and revokes the refresh token at Calendly (best effort). Audit `calendar.disconnect`. |

**Redirect URI (Calendly developer docs, "Creating an OAuth app", read 2026-11-01):** an app has exactly one redirect URI; a Sandbox app accepts https and http on localhost, a Production app accepts https only; the token request must send the same `redirect_uri` as the authorize request (the client uses one value for both). Not documented by Calendly, so not verified: exact-match rules (trailing slash, case, query), whether error codes are returned on the redirect, and the body shape of token errors. The pre-flight cannot tell a Sandbox app from a Production one, so it treats `NODE_ENV=production` as Production.

Env: `CALENDLY_CLIENT_ID`, `CALENDLY_CLIENT_SECRET`, `CALENDLY_REDIRECT_URI` (default `${PUBLIC_API_URL}/api/v1/calendar/calendly/callback`; register it, over HTTPS, in the Calendly developer console), `ENCRYPTION_KEY`; set them for the API **and** the worker (`deploy/docker-compose.yml` shared env, `deploy/.env.example`). Migration 0940 also widens `bookings.provider` and adds booking status `offered`.

### AI calendar tools
`@yulona/ops` exports `CALENDAR_TOOL_MANIFESTS` (`check_availability` allowed in engaged/qualified/booking_offered, `book_appointment` in qualified/booking_offered) and `executeCalendarTool({ db, tenantId, conversationId, calendar, retry? }, name, input) -> { kind: ok|rejected|failed, output?, error? }`, with `loadTenantCalendar(...)` to build the tenant's Google provider. The AI runtime must call them server-side (they need DB + tenant credentials, so they are not HTTP custom tools): `rejected` is fed back to the model, `failed` means a `system_failure` handoff was already raised. `check_availability` advances to `booking_offered` (`markBookingOffered`); `book_appointment` creates the booking and advances to `booked`. Any calendar timeout after retries => `system_failure` handoff.

## Needs Attention queue (handoffs) (agent+)
`HandoffItem`: `{ id, type: uncertainty|stage|system_failure, reason, summary|null, leadCard|null, context, outOfHours: boolean, state: open|claimed|resolved, assignedUserId|null, assignedUserName|null, claimedAt|null, resolvedAt|null, resolvedBy|null, resolutionNote|null, createdAt, conversation: { id, status, handler, channel, assignedUserId, lastMessagePreview|null, lastMessageAt }, contact: { id, name|null, email|null, phone|null } }`.
`state`: `resolved` if `resolvedAt`; `claimed` if `claimedAt`; else `open` (waiting; may carry a suggested `assignedUserId` from auto-routing).
| Method | Path | Notes |
|---|---|---|
| GET | `/needs-attention` | Query: `state` (`open`\|`claimed`\|`resolved`\|`active` = open+claimed; default `active`), `type` (csv), `assignee` (`me`\|`unassigned`\|uuid), `limit`, `cursor`. Oldest first (longest waiting at the top). |
| GET | `/needs-attention/counts` | `{ uncertainty, stage, system_failure, total, mine }` for unresolved items. |
| GET | `/needs-attention/:id` | |
| POST | `/needs-attention/:id/claim` | Takeover: `claimedAt`, assignee = me, conversation `handler=human`, `assignedUserId=me`, `status=open`. 409 if claimed by someone else (admin+ may pass `{ "force": true }`). |
| POST | `/needs-attention/:id/assign` | admin+. `{ userId }` assigns (and claims on their behalf = conversation assigned to that user, status `open`, `handler=human`). Notifies the assignee. |
| POST | `/needs-attention/:id/release` | Un-claims (assignee only or admin+): back to `open`, conversation `status=pending_human`. |
| POST | `/needs-attention/:id/resolve` | `{ note?, returnToAi?: boolean (false) }`. Sets `resolvedAt/By`. With `returnToAi`: conversation `handler=ai`, `status=open`, unassigned, AI resumed (`returnConversationToAi`) and the `returned_to_ai` system message is written. Without it a `pending_human` conversation becomes `open` handled by a human. |
Realtime: handoff creation emits `conversation.updated` (status `pending_human`). New handoffs also create `handoff.requested` notifications (below), so the UI can badge via `/notifications` polling or the existing WS feed.

## Agent availability + business hours + routing
| Method | Path | Notes |
|---|---|---|
| GET | `/availability` | Team: `{ items: [{ userId, name, role, status: online\|away\|offline, updatedAt\|null, openConversations }] }` (active owner/admin/agent users; no row => `offline`). |
| PUT | `/availability/me` | `{ status }` -> same item. Agents set themselves online/away/offline (not for others). |
| GET | `/ops/settings` | `{ timezone (IANA), slaMinutes: { urgent, high, normal, low }, outOfHours: { mode: "ai_only"\|"message"\|"queue", message|null }, assignment: { mode: "manual"\|"least_busy" }, holidays: ["YYYY-MM-DD"], businessHours: [{ weekday: 0-6 (0 = Sunday), start: "HH:MM", end: "HH:MM" }] }` (defaults when never saved: UTC, always open). Any role. |
| PUT | `/ops/settings` | admin+. Partial; `businessHours` (<= 28 windows, `start < end`, "24:00" allowed as end) is replaced as a whole. Audit-logged. |
| GET | `/business-hours/status` | `{ open: boolean, timezone, now }`. No configured windows => always open. |
Routing at handoff time (DB trigger, so it works for AI worker handoffs, tool failures and booking failures alike):
- `assignment.mode = least_busy`: the **online** active owner/admin/agent with the fewest unresolved assigned conversations gets the handoff `assignedUserId` (and `conversations.assigned_user_id`); the conversation stays `pending_human` until they claim it. Nobody online => unassigned, broadcast notification.
- Out of business hours (`outOfHours: true` on the handoff): `mode=message` also posts an `ai` message (`metadata.event="out_of_hours"`, text from `outOfHours.message` or a default) so the visitor knows when to expect a reply; `queue` only flags the item; `ai_only` does nothing special.

## Canned responses (read: any role; write: agent+ create, owner of the row or admin+ edit/delete)
`CannedResponse = { id, shortcut, title, content, createdBy|null, createdAt, updatedAt }`, shortcut `^[a-z0-9][a-z0-9_-]{0,31}$` (typed as `/shortcut` in the composer), unique per tenant (409).
`GET /canned-responses?q=&limit=&cursor=` (matches shortcut/title/content; ordered by shortcut), `POST /canned-responses` `{ shortcut, title, content (<= 4000) }`, `PATCH /canned-responses/:id`, `DELETE /canned-responses/:id`.

## Tags (read: any role; create/attach: agent+; rename/delete: admin+)
`Tag = { id, name (1-40, unique case-insensitively), color (#rrggbb), count }`.
`GET /tags` (`count` = number of tagged resources), `POST /tags` `{ name, color? }` (409 duplicate), `PATCH /tags/:id`, `DELETE /tags/:id` (detaches everywhere).
Tagging `conversations`, `contacts`, `tickets`: `GET /{conversations|contacts|tickets}/:id/tags` -> `{ items: Tag[] }`, `PUT /{conversations|contacts|tickets}/:id/tags` `{ tagIds: uuid[] (<= 20) }` replaces the set -> `{ items: Tag[] }`. Unknown/foreign tag ids => 400, missing resource => 404. Tickets also return `tags` (`[{id,name,color}]`) inline and filter by `tagId`. (The conversations/contacts list endpoints owned by `conversations` do not filter by tag yet; use `GET /tags/:id/resources?type=conversation&limit=&cursor=` -> `{ items: [{ resourceId, createdAt }], nextCursor }`.)

## Notifications (own notifications only; any role)
`Notification = { id, type: handoff.requested|handoff.assigned|ticket.assigned|ticket.sla_breached|booking.created|booking.failed, title, body|null, data (ids for deep links: conversationId, handoffId, ticketId, bookingId), readAt|null, createdAt }`.
`GET /notifications?unread=true&limit&cursor` -> `{ items, nextCursor, unreadCount }`, `POST /notifications/:id/read`, `POST /notifications/read-all` -> `{ updated }`.
`GET /notifications/preferences` -> `{ email: boolean }` (default true), `PUT /notifications/preferences` `{ email }`. Email is sent by the worker through the `EmailProvider` (SMTP/console) shortly after the notification is created; `handoff.requested`, `handoff.assigned`, `ticket.assigned`, `ticket.sla_breached` and `booking.failed` are emailed, `booking.created` is in-app only.

## Audit log actions
`ticket.create|update|delete|bulk`, `ticket.comment`, `booking.create|cancel`, `calendar.default|calendar.connect|disconnect|update`, `handoff.claim|assign|release|resolve`, `ops_settings.update`, `canned_response.create|update|delete`, `tag.create|update|delete`, `tags.assign`.

## Worker
Interval tasks (started by `apps/worker`): `ops_sla_scan()` every 60 s, notification email dispatch every 15 s (claims pending rows with a `FOR UPDATE SKIP LOCKED` SECURITY DEFINER function; retries up to 5 times, then marks `failed`).

## Tables (migration 0400)
`ops_settings`, `business_hours`, `agent_availability`, `ticket_counters`, `tickets`, `ticket_events`, `calendar_connections`, `bookings`, `canned_responses`, `tags`, `taggables`, `notifications`, `notification_prefs`; `handoffs` gains `assigned_user_id, claimed_at, resolved_by, resolution_note, out_of_hours`. Migration `1000_drop_transactions.sql` removed the former `transactions` and `transaction_webhook_endpoints` tables (the transactions feature no longer exists). Migration `0401_ops_handoff_routing_fix.sql` replaces the handoff trigger function (variable shadowing bug in 0400's least_busy branch). All have RLS ENABLE+FORCE, a tenant policy and an `owner_all` policy. SQL functions: `ops_in_business_hours(tenant, at)`, `ops_sla_scan()`, `ops_txn_endpoint_resolve(id)` (the only cross-tenant read, for the public webhook), `ops_notifications_claim_email(n)`, `ops_notification_email_done(id, ok, err)`.

## HubSpot CRM (Wave 5 D; migration 0970)
Zod: `packages/shared/src/hubspot.ts`. Client `packages/ops/src/hubspot.ts`, sync job `packages/ops/src/hubspot-sync.ts`, routes `apps/api/src/ops/hubspot.ts`. All routes admin+ (owner/admin), tenant from the token, 404 when not connected.
Verified against developers.hubspot.com (CRM v3): `POST /crm/v3/objects/contacts/search` (`filterGroups[].filters[] {propertyName, operator: EQ, value}`, `limit`), `POST /crm/v3/objects/contacts` (`properties`), `PATCH /crm/v3/objects/contacts/{id}`; private-app token as Bearer; scopes `crm.objects.contacts.read` + `crm.objects.contacts.write` (the HubSpot docs pages fetched did not list the scope names, so these come from the private-app scope names and are unconfirmed against a real account); search is limited to 5 requests/second/account; 429 on overload; errors `{status, message, category, correlationId}`. Only `https://api.hubapi.com` is contacted, redirects are never followed.

| Method | Path | Notes |
|---|---|---|
| GET | `/crm/hubspot` | `{ configured (ENCRYPTION_KEY set), connected, status: active\|error\|null, lastError, lastSyncAt, connectedAt, mapping, recent[10] { id, trigger: qualified\|booked\|test, status: pending\|ok\|failed\|skipped, action: created\|updated\|null, hubspotId, error, conversationId, createdAt, syncedAt } }`. The token is never returned. |
| PUT | `/crm/hubspot/connection` | `{ token (10-500 chars), mapping? }`. Makes a live `GET /crm/v3/objects/contacts?limit=1`; 401/403/400 from HubSpot => 400 `validation_error` (`details[0].path = "token"`), HubSpot down => 503. Token sealed with `ENCRYPTION_KEY` (AAD `crm:{tenant}:hubspot`); 503 when the key is unset. Audit `crm.connect`. |
| PATCH | `/crm/hubspot/mapping` | `{ mapping: { properties { need, budget, timeline, score, conversationLink, source: HubSpot internal property names }, sourceValue (default "Lumi chat"), lifecycleStage? (create only), syncOnBooked (default true) } }`. Audit `crm.update`. |
| DELETE | `/crm/hubspot/connection` | Deletes the token. Audit `crm.disconnect`. |
| POST | `/crm/hubspot/test-contact` | `{ email, name? }` => `{ id, action }`; 10/min per tenant; HubSpot failure => 502 `service_unavailable` with a token-free message. Audit `crm.test_contact`. |

Sync: `transitionStage` (`packages/ai-runtime/src/stage.ts`) calls `onLeadStage` (`crm-hook.ts`) in the same transaction when a conversation reaches `qualified` or `booked`: on `qualified` it emits the `lead.qualified` webhook event; if the tenant has a `crm_connections` row it inserts the unique `crm_sync_log (tenant, provider, conversation, trigger)` row and queues `crm.hubspot.sync` (6 attempts). The job upserts by lower-cased email (search, then PATCH or POST; a 409 "Existing ID" race falls back to PATCH), writes `contacts.hubspot_id`, and records the result. Transient errors (429/5xx/timeouts, after 3 in-process attempts) set `last_error` and re-throw so the queue retries; 401/403 set the connection `status = error`, 400s are recorded, and neither is retried. No email => `skipped`. Only mapped custom properties are sent.
Not built: notes and deals (the plan listed them as optional), HubSpot OAuth.
**Not verified**: nothing ran against real HubSpot (no credentials available); tests use a local fake server mirroring the documented shapes.
