# Tools: connections, manifest v2, tool test

Contract for the no-code tool builder. All routes are under `/api/v1`, JWT auth (`Authorization: Bearer ...`), **owner or admin** only (viewers and agents get 403). Errors use the standard envelope `{ error: { code, message, requestId, details? } }`.

How it fits together: a **connection** stores a customer backend (base URL + credential, encrypted). A **tool** is a manifest (v2) saved in the agent's `config.customTools` (bare manifest objects, via `PATCH /agents/:id`) and switched on by adding its `name` to `config.enabledTools`. When the model calls the tool, the server builds the HTTP request from the manifest, adds the connection's credential, calls the backend and hands the (mapped) response back to the model. The credential never reaches the model, prompts, `tool_executions` or any API response.

## 1. Connections

DTO (secrets are write-only; only `hasSecret` is returned):

```json
{ "id": "uuid", "name": "Orders API", "kind": "http", "baseUrl": "https://api.shop.example/v1",
  "authType": "bearer", "authHeaderName": null, "testPath": "/health", "hasSecret": true,
  "createdBy": "uuid", "createdAt": "ISO", "updatedAt": "ISO" }
```

| Method + path | Body | Result |
|---|---|---|
| `GET /tool-connections` | - | `{ items: DTO[] }` |
| `POST /tool-connections` | `{ name, baseUrl, authType?, authHeaderName?, secret?, testPath? }` | 201 DTO |
| `GET /tool-connections/:id` | - | DTO |
| `PATCH /tool-connections/:id` | any of the create fields; `secret: "new"` rotates, `secret: null` removes (only with `authType: "none"`), `testPath: null` clears | DTO |
| `DELETE /tool-connections/:id` | - | `{ ok: true }`; **409** `conflict` when an agent's tools still reference it (message lists agent names) |
| `POST /tool-connections/:id/test` | `{ path? }` (default: the connection's `testPath`, else `/`) | see below |

Fields:
- `name` 1-100 chars, unique per tenant (409 on duplicate).
- `baseUrl`: **https required in SaaS**, `http` also allowed when self-hosted. No credentials/query/fragment in the URL. Private, loopback and link-local hosts are always rejected (SSRF rules; also re-checked on every call and every redirect). On a redirect to another origin (scheme/host/port) `safeFetch` strips credential headers (authorization, proxy-authorization, x-api-key, x-yulona-signature/timestamp, cookie, plus the connection's custom auth header name via `sensitiveHeaders`); same-origin hops keep them. 301/302 POST and 303 become GET without body; 307/308 with a body to another origin is refused (`ssrf_blocked`).
- `authType`: `none | bearer | api_key | basic | hmac`.
  - `bearer`: `Authorization: Bearer <secret>`.
  - `api_key`: header `authHeaderName` (default `X-API-Key`) = secret.
  - `basic`: secret must be `"username:password"`; sent as `Authorization: Basic base64(secret)`.
  - `hmac`: secret is a signing secret. Each request carries `X-Yulona-Timestamp: <unix seconds>` and `X-Yulona-Signature: v1=<hex>` where the signature is `HMAC-SHA256(secret, "<timestamp>.<raw request body>")` (empty string body for GET/DELETE). Same scheme as outbound webhooks; receivers should reject timestamps older than 5 minutes.
  - `none` must not have a `secret`; every other type requires one on create.
- `secret` up to 2000 chars. Stored AES-256-GCM encrypted (AAD `toolconn:{tenant}:{id}`). **503 `service_unavailable`** when the server has no `ENCRYPTION_KEY`.

Connection test result (always 200 unless the connection is missing; rate limit 20/min per tenant, 429 `rate_limited` with `Retry-After`):

```json
{ "ok": true, "status": 200, "latencyMs": 84, "contentType": "application/json",
  "request": { "method": "GET", "url": "https://api.shop.example/v1/health", "headers": { "accept": "application/json", "authorization": "Bearer ***" } },
  "excerpt": "{\"status\":\"ok\"}", "error": null }
```
On failure `ok: false` and `error: { code, message, status? }` (codes below).

## 2. Manifest v2

Tools in `config.customTools` are bare manifest objects (the older `{ manifest, secret }` wrapper still works). **v1 manifests keep working unchanged** (`version: 1`, `endpointTemplate`, inline secret). v2:

```json
{
  "version": 2,
  "name": "lookup_order",
  "description": "Look up an order by its number and report the status.",
  "inputSchema": { "type": "object", "required": ["orderId"], "additionalProperties": false,
    "properties": { "orderId": { "type": "string", "maxLength": 40 }, "include": { "type": "string" } } },
  "outputSchema": { "type": "object" },
  "connectionId": "uuid",
  "request": {
    "method": "GET",
    "path": "/orders/{{orderId}}",
    "fields": [ { "name": "orderId", "in": "path" }, { "name": "include", "in": "query" } ],
    "headers": { "X-Source": "yulona" }
  },
  "timeoutMs": 10000,
  "retry": { "attempts": 3, "baseMs": 300 },
  "responseMapping": { "status": "status", "items": "lines[].sku", "firstTotal": "lines[0].total" },
  "onFailure": "tell_customer",
  "confirmBeforeRun": false,
  "allowedStages": ["engaged", "qualified"]
}
```

| Field | Rules |
|---|---|
| `version` | `2` |
| `name` | `^[a-z][a-z0-9_]{1,63}$`; must also be listed in `enabledTools`; cannot reuse a built-in name |
| `description` | 1-1000 chars; this is what the model reads, so say when to use it |
| `inputSchema` | JSON Schema subset (`object/string/number/integer/boolean/array`, `enum`, `required`, `min/maxLength`, `minimum/maximum`, `additionalProperties:false`). The model's arguments are validated against it before any call. `outputSchema` is informational |
| `connectionId` | uuid of a connection of the same tenant |
| `request.method` | `GET POST PUT PATCH DELETE` |
| `request.path` | starts with a single `/`, relative to the connection base URL, may contain `{{field}}` placeholders. Each placeholder needs a field with `in: "path"` (and vice versa). Values are URL-encoded; `.`/`..` rejected; the final URL must stay on the base URL's origin and prefix |
| `request.fields[]` | `{ name, in: "path" \| "query" \| "body" \| "header", as? }`. `name` is the key in the tool input; `as` renames the query/body key or header name. Array values for `query` repeat the key. Header names cannot be `authorization`, `cookie`, `host`, `content-length`, `x-yulona-*` etc. |
| `request.headers` | static extra headers (values may use `{{field}}`); same reserved names forbidden. Authentication is always taken from the connection and cannot be overridden |
| `request.bodyTemplate` | JSON string for POST/PUT/PATCH. Placeholders go **inside strings**: `"{{qty}}"` as a whole string keeps the value's type (number stays number); `"Order {{id}}"` interpolates. Without a template, `in: "body"` fields are sent as a JSON object |
| `timeoutMs` | 500-30000, default 10000 |
| `retry` | `{ attempts: 2-4, baseMs: 50-5000 }`, exponential backoff. **Only for GET/PUT/DELETE** (validation error otherwise). Retries on timeouts, network errors, HTTP 5xx and 429 |
| `responseMapping` | output key -> path in the JSON response. `a.b.c`, `a[0].b`, `items[].name` (array of every item's `name`), `[]` / `[].name` for a root array. Missing values become `null`. Without a mapping the whole JSON goes to the model (truncated at 8 KB). Non-JSON replies: `{ text }` |
| `onFailure` | `handoff` (default): a failed call raises a `system_failure` handoff. `tell_customer`: the model gets a failure message and tells the customer; no handoff |
| `confirmBeforeRun` | the first call returns `confirmation_required` and the model must ask the customer; a second call with `confirmed: true` runs it. The `confirmed` flag is added to the tool's parameters automatically (do not put it in `inputSchema`) |
| `allowedStages` | optional; default is the standard custom-tool stages |

Validation errors from `PATCH /agents/:id` point at `config.customTools.N....`.

## 3. Test a tool (the builder's "Test" button)

`POST /tools/test` (owner/admin, 20/min per tenant) performs the **real** request (the backend is called, with side effects for POST/PUT/DELETE). The manifest does not need to be saved.

Request:
```json
{ "manifest": { "...manifest v2...": true }, "sampleValues": { "orderId": "A-1001" } }
```

Response 200 (also when the backend fails; check `ok`):
```json
{
  "ok": true,
  "status": 200,
  "latencyMs": 112,
  "attempts": 1,
  "request": { "method": "GET", "url": "https://api.shop.example/v1/orders/A-1001?include=lines",
               "headers": { "accept": "application/json", "authorization": "Bearer ***" }, "body": "{\"qty\":2}" },
  "response": { "status": 200, "contentType": "application/json", "excerpt": "{\"status\":\"shipped\", ...first 4096 chars}", "truncated": false },
  "mapped": { "status": "shipped", "items": ["SKU-1", "SKU-2"] },
  "fieldTree": {
    "rootType": "object",
    "fields": [
      { "name": "status", "path": "status", "type": "string", "sample": "shipped" },
      { "name": "customer", "path": "customer", "type": "object", "children": [ { "name": "email", "path": "customer.email", "type": "string", "sample": "a@b.c" } ] },
      { "name": "lines", "path": "lines", "type": "array", "length": 2, "itemType": "object",
        "children": [ { "name": "sku", "path": "lines[].sku", "type": "string", "sample": "SKU-1" } ] }
    ]
  },
  "error": null
}
```

Click-to-map: the `path` of a clicked node is exactly the value to put in `responseMapping` (`lines[].sku` maps an array). Array nodes describe their first element; scalar arrays have `itemType` and no children (map them with the array node's own `path`). Root arrays use `rootType: "array"` and paths starting `[]`. The tree is capped (depth 6, 60 keys per object, 300 nodes) and samples are cut at 80 chars. `fieldTree` is `null` when the response was not JSON. `mapped` is `null` without a `responseMapping`. `request` is redacted: credential headers (`***`), signature headers, secret-looking query/body keys. The credential is also scrubbed from the response excerpt.

Failure shape: `ok: false`, `error: { code, message, status? }`, plus `request`/`response` when they exist.

| `error.code` | Meaning |
|---|---|
| `invalid_input` | `sampleValues` do not satisfy `inputSchema` (nothing was sent) |
| `bad_input` | request could not be built (missing path value, body template mismatch, URL leaves the base URL) |
| `connection_unavailable` | connection has no usable credential |
| `ssrf_blocked` | host is private/loopback/non-http(s) or redirects there |
| `timeout` | no response within `timeoutMs` (after retries) |
| `network_error` | DNS/connect/TLS failure (after retries) |
| `http_error` | backend returned status >= 400 (`error.status`; response excerpt included) |
| `response_too_large` | body over 256 KB |
| `not_json` | a `responseMapping` is set but the reply is not JSON |

HTTP-level errors of the endpoint itself: `400 validation_error` (bad body, manifest invalid or not v2; `details[].path` like `manifest.request.path`), `404 not_found` (connection of another tenant or missing), `429 rate_limited`, `503 service_unavailable` (no `ENCRYPTION_KEY`).

## 4. Runtime behaviour (what the builder should tell the user)

- Tool results and failures are logged in `tool_executions` with secret-looking input values and header fields masked; the credential is never stored.
- Failed call + `onFailure: "handoff"`: conversation goes to a human with a `system_failure` handoff. With `"tell_customer"` the AI keeps the conversation and tells the customer.
- A tool whose connection was deleted fails with `connection_not_found` (deleting a connection that tools still use is refused with 409).
- The sandbox (agent test console) never calls custom tools; it reports `wouldCall`. Use `POST /tools/test` to exercise the real backend.
- Audit log actions: `tool_connection.create|update|delete|test`, `tool.test`.
