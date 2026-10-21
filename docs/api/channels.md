# Channels API (WhatsApp, Messenger, Instagram, Telegram, Slack)

Owner: `channels` agent. Code: `packages/channels` (adapters, `channel.send` job), `apps/api/src/channels/*`
(routes, webhook receivers, ingestion), migration `packages/db/migrations/0600_channels.sql`.
Errors use the standard envelope. Dashboard endpoints need a Bearer JWT; **read: any role, write: owner/admin**
(`merge-suggestions/:id/dismiss`: owner/admin/agent). Requires `ENCRYPTION_KEY` (else create/update => 503).

## Dashboard endpoints (`/api/v1`)
| Method | Path | Notes |
|---|---|---|
| GET | `/channels/available` | `{ items: [{ channel, capabilities, credentialFields: [{name,label,secret,required}] }] }`: drives the connect form. |
| GET | `/channels/connections` | `{ items: Connection[] }` |
| POST | `/channels/connections` | `{ channel, name, agentId?, credentials }` (strict). Unknown credential keys => 400. `verifyToken` / `webhookSecret` are generated when omitted and returned **once** in `generatedSecrets`. 201 returns `Connection & { generatedSecrets }`. |
| GET | `/channels/connections/:id` | `Connection` |
| PATCH | `/channels/connections/:id` | `{ name?, agentId?, status?: "active"\|"disabled", credentials? }`. `credentials` is partial: provided fields replace stored ones, the rest are kept (rotate one secret). |
| DELETE | `/channels/connections/:id` | Conversations keep their history (link nulled) but can no longer send. |
| POST | `/channels/connections/:id/test` | Live health check with stored credentials (20/min/tenant). `{ ok, detail, checkedAt }`; updates `status` (`active`/`error`) and `health`. |
| GET | `/channels/merge-suggestions` | Pending cross-channel duplicate contacts: `{ items: [{ id, reason: same_email\|same_phone\|same_name, primary, other, createdAt }] }`. Confirm by calling `POST /contacts/:primary/merge { sourceContactId: other.id }` (suggestion then disappears); `POST /channels/merge-suggestions/:id/dismiss` hides it. |

`Connection`: `{ id, channel, name, externalId, agentId, status: active|disabled|error, credentialsMasked, webhookUrl, health: { checkedAt, ok, error }, createdAt, updatedAt }`.
Secrets are never returned: `credentialsMasked` shows `••••1234` for secret fields and the raw value for identifiers (phone number id, page id).
`webhookUrl` is what to paste into the provider console: `{PUBLIC_API_URL}/api/v1/webhooks/channels/{channel}/{connectionId}`.

### Credentials per channel
| Channel | Fields (required unless noted) | Webhook auth |
|---|---|---|
| `whatsapp` | `accessToken`, `phoneNumberId`, `appSecret`, `verifyToken`(generated), `templateName`?, `templateLanguage`? | `X-Hub-Signature-256` HMAC + GET `hub.challenge` |
| `facebook` | `pageAccessToken`, `pageId`, `appSecret`, `verifyToken`(generated) | same |
| `instagram` | `accessToken`, `igUserId`, `appSecret`, `verifyToken`(generated) | same |
| `telegram` | `botToken`, `webhookSecret`(generated) | `X-Telegram-Bot-Api-Secret-Token`. Register with `setWebhook?url=<webhookUrl>&secret_token=<webhookSecret>` |
| `slack` | `botToken`, `signingSecret` | `X-Slack-Signature` + timestamp (5 min window); `url_verification` answered |

Capabilities: all five are text-only (`richCards/forms/interactiveButtons=false`); the AI output formatter degrades calendars/buttons to numbered text.
`messageWindow`: 24 h for WhatsApp/Messenger/Instagram, none for Telegram/Slack.

## Public webhook receivers (no JWT)
`GET|POST /api/v1/webhooks/channels/:channel/:connectionId`
- Signature/secret is verified in constant time over the **raw body** before any parsing. Failure => 401 (and a per-connection failure rate limit, 20/min). Unknown id, wrong channel in the path, disabled connection or suspended tenant => 404 (no probing).
- Replay protection: every provider event id is recorded in `channel_webhook_events` (unique per connection, pruned after 7 days); duplicates answer 200 and are skipped. Slack additionally rejects timestamps older/newer than 5 min.
- Rate limits: 1200/min per IP, 600/min per connection (on top of the global limiter).
- Pipeline: identity (`contact_identities`, WhatsApp also matches an existing contact by phone digits) -> open conversation for (contact, channel, connection) or a new one (`conversations.metadata.externalContactId`) -> `contact` message -> `ai.respond` job when `status=open AND handler=ai`. Realtime events come from the existing DB triggers. New contacts with the same email/phone/name as an existing one create merge suggestions.
- Attachments arrive as text placeholders (`[image]`); files are not stored yet.

## Outbound: job `channel.send`
A DB trigger (`messages_enqueue_channel_send`) enqueues `channel.send { tenantId, messageId }` for every `ai`/`human` message in a non-widget conversation, whoever inserted it (API reply, AI worker). Notes/system messages are never sent. The worker handler (`apps/worker/src/jobs/channels.ts`, needs `ENCRYPTION_KEY`) sends through the adapter and records the result in `channel_deliveries` (unique per message => idempotent).
- Transient errors (network, 429, 5xx) retry with the queue's exponential backoff (6 attempts); on the last attempt they are recorded as failed.
- Permanent errors (window closed, rejected, bad credentials, missing connection) are recorded as `failed` and a `system` message `metadata.event="delivery_failed"` (`{messageId, code}`) is added to the conversation so agents see it. Bad credentials also flip the connection to `status=error`.
- WhatsApp outside the 24 h window sends `templateName` (one body variable = the text) if configured, else fails with `window_closed`. Messenger/Instagram outside 24 h fail with `window_closed`.

## Data (migration 0600)
`channel_connections` (+ `last_health_*`), `channel_webhook_events`, `channel_deliveries`, `contact_merge_suggestions`, SECURITY DEFINER `channel_connection_resolve(uuid)` (the only cross-tenant read; returns ciphertext). All tenant tables: RLS ENABLE+FORCE, tenant + `owner_all` policies, grants to `yulona_app`. Credentials: AES-256-GCM envelope (`apps/api/src/conversations/crypto.ts`), AAD = `{tenantId}:{connectionId}`.
