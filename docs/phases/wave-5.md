# Wave 5 brief: agent gating, turn cost, widget protection + abuse, $49 plan + Stripe sandbox, HubSpot, Lumi rename

Source of truth: the approved plan `/Users/ethio1/.claude/plans/moonlit-chasing-hippo.md` (read it first, your section only). Inherits `PLAN.md`, `docs/phases/wave-4.md` ("Shared rules" apply verbatim: append-only migrations in your range, RLS ENABLE+FORCE, own test database per agent, minimal atomic edits to shared files, security floor, honest <400-word report).

## Ranges and ownership
- **A** (agent gating + turn cost): no migration unless needed (0980-0989). Owns `packages/ai-runtime/src/{agent-loader,runtime,turn,knowledge,conversation-store,prompt}.ts` for the token and gating changes, `apps/api/src/routes/agents.ts` archive warning, widget `unavailable` flag in `apps/api/src/routes/public-widget.ts` (small, additive).
- **B** (widget protection + abuse): migrations 0950-0959. Owns widget config/protection, honeypot/Turnstile, abuse config + flow, contact block routes, inbox/contact UI, agent editor Safety card.
- **C** (plan + Stripe + credit estimates): migrations 0960-0969. Owns `packages/providers/src/stripe.ts`, `apps/api/src/billing/*`, `apps/api/src/usage/*`, plan seeding, usage/billing/admin credits UI, Stripe sandbox setup.
- **D** (HubSpot): migrations 0970-0979. Owns `packages/ops/src/hubspot.ts`, `apps/api/src/ops/hubspot.ts`, worker sync job, Integrations UI.
- **E** (rename + docs, runs last, after A-D finish).

Files several agents touch (`turn.ts`, `agent-loader.ts`, `packages/shared/src/{agent,conversations}.ts`, `public-widget.ts`, `apps/api/src/app.ts`, `apps/worker/src/jobs/index.ts`, `packages/integrations/src/events.ts`, `openapi-extra.ts`, `docs/openapi.json`): re-read right before each edit, make small additive edits, never reformat or revert another agent's change. Run only your own package tests during work; regenerate OpenAPI only once at the end of your work (`cd apps/api && bun scripts/export-openapi.ts`, then `bun run docs:sync`).

## Rules for everyone
- Never touch databases `yulona`, `yulona_platform`, `yulona_airuntime`; never run migrate/tests against the root `.env` DB; never run the db CLI from the repo root (it would reset the `yulona_app` role password). Create `yulona_<agent>` with `docker exec yulona-dev-postgres-1 psql -U yulona_owner -d postgres -c "CREATE DATABASE yulona_<agent>"` + `CREATE EXTENSION vector`, use `TEST_DATABASE_URL=postgres://yulona_owner:yulona_owner@localhost:5433/yulona_<agent>`, and drop it (and `<db>_qasuite`) at the end.
- Do not start servers on 5176 or 3000. Do not commit. Never print secrets from `.env`.
- Docs are part of the change (`.claude/rules/documentation.md`, `apps/docs/DOCS_MAP.md`): update the matching `apps/docs` pages and `apps/docs/changelog.mdx` for what you build, `docs/api/*.md` for contracts, `deploy/.env.example` + `apps/docs/self-hosting/configuration.mdx` for env vars; `bun test tests/docs` must pass. Keep the product name in new text as "Lumi" (the rename agent handles old text).
- Final report: files, commands with real results, shared files touched, gaps. Say what you could not verify.
