# Docs map: which code change needs which page

Every row says: if you change the thing on the left, update the pages on the right in the same change. Page paths are relative to `apps/docs/`. If you add a feature that fits no row, add a row.

| You changed | Update |
|---|---|
| Dashboard navigation, a page's layout, labels or flows (`apps/dashboard/src/features/*`, `pages/Shell.tsx`) | the matching guide under `guides/` (see the feature rows below); `quickstart.mdx` if the first-run path changed |
| Agent config fields (`packages/shared/src/agent.ts`), agent editor | `guides/agents/configure-your-agent.mdx`, `developers/ai-runtime.mdx`, `developers/agent-builder-api.mdx` |
| Agent builder chat (`apps/api/src/agent-builder/*`, `dashboard/src/features/agent-builder/*`) | `guides/agents/create-with-ai.mdx`, `developers/agent-builder-api.mdx` |
| Knowledge/skills (`packages/ai-runtime/src/{knowledge,sections,ingest}.ts`, `apps/api/src/routes/knowledge.ts`) | `guides/agents/knowledge-skills.mdx`, `developers/ai-runtime.mdx`, `concepts.mdx` |
| Sandbox, versions, publish | `guides/agents/test-in-sandbox.mdx`, `guides/agents/publish-and-versions.mdx` |
| Handoff, resume keyword, unanswered turns, business hours routing | `guides/agents/handoffs-and-human-takeover.mdx`, `guides/workspace/needs-attention.mdx`, `guides/workspace/business-hours.mdx`, `developers/ai-runtime.mdx` |
| Tools, manifest, connections, tool test (`packages/ai-runtime/src/{tools,http-tool}.ts`, `packages/shared/src/tool-manifest.ts`, `apps/api/src/tools/*`) | `guides/tools/*`, `developers/custom-tools-backend.mdx`, `developers/tool-manifest.mdx` |
| Calendar / Calendly / Google (`packages/ops`, `apps/api/src/ops/*`) | `guides/tools/calendar-booking.mdx`, `guides/workspace/bookings.mdx`, `self-hosting/channels-and-integrations-setup.mdx` |
| Channel adapters (`packages/channels`, `apps/api/src/channels`) | `guides/channels/*`, `self-hosting/channels-and-integrations-setup.mdx` |
| Widget (`apps/widget`, `apps/api/src/routes/public-widget.ts`, widget settings) | `guides/channels/website-widget.mdx`, `developers/widget-embed.mdx` |
| Inbox, contacts, tickets, transactions, bookings, canned/tags, notifications UI or API | the same-named page in `guides/workspace/`, and `developers/public-api.mdx` if the public API changed |
| Roles, invitations (incl. the emailed `/accept-invite` page), API keys, audit log | `guides/workspace/team-and-roles.mdx`, `developers/authentication.mdx`, `developers/public-api.mdx` |
| Credits, usage, plans, billing (`apps/api/src/usage/*`, `billing/*`, migrations 09xx) | `guides/account/usage-and-credits.mdx`, `guides/account/billing-and-plans.mdx`, `developers/credits-api.mdx`, `platform-admin/plans-credits-and-rates.mdx` |
| LLM provider config (`packages/providers`, `AI_*` env, provider profiles) | `self-hosting/ai-providers.mdx`, `platform-admin/providers.mdx` |
| Platform admin console, impersonation, feature flags | `platform-admin/*` |
| Auth, sessions, CSRF, RLS, rate limits, error codes (`apps/api/src/{middleware,errors}.ts`, `packages/db`) | `developers/authentication.mdx`, `developers/multi-tenancy-and-security.mdx`, `developers/api-conventions.mdx`, `developers/errors.mdx` |
| Webhooks, public API, realtime | `developers/webhooks.mdx`, `developers/public-api.mdx`, `developers/realtime.mdx` |
| Any API route, request/response shape | regenerate the OpenAPI spec (`cd apps/api && bun scripts/export-openapi.ts`) then `bun run docs:sync`; update the relevant developer page |
| Env vars, compose, Dockerfiles, `deploy/*`, `scripts/*` | `self-hosting/configuration.mdx` (every variable in `deploy/.env.example` must appear), `self-hosting/requirements-and-install.mdx`, `self-hosting/upgrade-backup-restore.mdx` |
| Deployment mode, license (`packages/license`) | `self-hosting/overview.mdx`, `self-hosting/licensing.mdx` |
| Security headers, hardening, rate limits | `self-hosting/security-hardening.mdx` |
| Health endpoints, logging, worker jobs | `self-hosting/operations-and-monitoring.mdx` |
| Any user-visible change worth announcing | `changelog.mdx` (newest first) |
| A new concept or term users will meet | `concepts.mdx` |
