# Dashboard needs (from `dash-inbox`)

Things the inbox/contacts UI uses or wants from the backend. The UI degrades gracefully where marked.

## Used today (exists)
- `docs/api/conversations.md` conversations, messages, takeover, return-to-ai, contacts, timeline, merge; `GET /users` (platform) for the assignee picker; `/realtime/ws`.
- `GET /canned-responses?limit=100` (`docs/api/ops.md`; field `content` is mapped to the composer body). On 404/405/501 the composer uses 3 built-in generic responses.

## Missing (UI falls back)
1. **(DONE by dash-ops: `apps/api/src/conversations/ai-state.ts`, used by the inbox contact panel)** **Conversation AI state** - `GET /conversations/:id/ai-state` -> `{ stage: ConversionStage|null, lead: {name?,email?,phone?,need?,budget?,timeline?,score?,summary?}, handoff?: { type, reason? } | null }`
   from `conversation_ai_state` + latest `handoffs` row. Fallback: stage/handoff derived from the newest AI message `metadata`; lead card hidden.
2. **Read state** - the UI tracks unread in `localStorage` (per browser). A server `last_read_at` per (user, conversation) plus `POST /conversations/:id/read` and an `unreadCount` on the summary would make it consistent across devices.
3. **Conversation tags** - `GET/PUT /conversations/:id/tags` exist in ops.md; the inbox does not show or filter by tag yet (list filter `tagId` on `GET /conversations` would be needed).
4. **Contact tags / merge suggestions** - same as above; merge is manual search only (no duplicate suggestions endpoint).
5. `GET /conversations/:id` returns the compact contact ref; the side panel fetches `GET /contacts/:id` separately (one extra request).
6. Realtime `typing` for agents->visitor is sent on the first keystroke then every 3 s; no explicit `typing:false` frame is sent.
