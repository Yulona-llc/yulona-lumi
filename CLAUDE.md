# Yulona monorepo

Bun workspaces: `apps/{api,worker,dashboard,widget,docs}`, `packages/*`, `tests/`, `deploy/`, `docs/` (internal design notes and API contracts), `apps/docs/` (the public product documentation, Mintlify).

Commands: `bun run typecheck`, `bun test` per package (needs `TEST_DATABASE_URL`, one database per agent/session, never the dev DB `yulona`), `bun run migrate` (reads `.env`: check `APP_DB_PASSWORD` first), dashboard `cd apps/dashboard && bun run test && bun run build`.

## Documentation is part of the change
Product documentation lives in `apps/docs` and must stay current. See `.claude/rules/documentation.md` (loaded automatically) and `apps/docs/DOCS_MAP.md` (which code change needs which page). A change is not done until its docs are updated and `bun test tests/docs` passes.
