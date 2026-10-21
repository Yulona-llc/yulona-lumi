# Keep the product documentation current

The public docs (Mintlify, `apps/docs`) are the source of truth for end users, developers, self-hosters and platform admins. Any session that changes behaviour, UI, API, configuration or deployment must update them in the same change.

## When you must update the docs
- You add, remove or change a user-visible feature, screen, label, flow, role permission, limit, default, error message or plan/credit rule.
- You add or change an API route, request/response shape, error code, webhook event, scope, or the tool manifest.
- You add, rename or remove an environment variable, compose service, script, migration step or deployment mode behaviour.
- You change security behaviour (auth, CSRF, rate limits, encryption, SSRF rules).

## How
1. Open `apps/docs/DOCS_MAP.md`, find the rows for the code you touched, and update every listed page. If no row fits, add one.
2. Follow `apps/docs/CONTRIBUTING.md` (audiences, structure, terminology, code-sample rules). Only document what exists: verify against the code or by running it. Never invent flags, screens or defaults.
3. API changes: regenerate the spec (`cd apps/api && bun scripts/export-openapi.ts`), run `bun run docs:sync`, then update the matching `developers/*` page.
4. New env var: add it to `deploy/.env.example` AND `apps/docs/self-hosting/configuration.mdx` (a test enforces this).
5. New page: add it to `apps/docs/docs.json` navigation (a test enforces this), with `title` and `description` frontmatter.
6. User-visible change: add an entry to `apps/docs/changelog.mdx` (newest first, date, one line per change, link to the page).
7. Verify: `bun test tests/docs` (always) and `bun run docs:check` when the Mintlify CLI is available.

## Style essentials
Name the reader in the first paragraph; sentence case; UI labels exactly as on screen; active voice; steps in `<Steps>`; runnable `curl` first; no emoji; no real secrets; relative links without extension. Terminology: workspace, agent, skill, section, conversation, handoff, needs attention, resume keyword, credits, connection, tool, channel, widget, sandbox, draft/published.

## Do not
- Leave docs "for later" or open a follow-up instead of updating them.
- Copy internal design notes (`docs/phases`, `docs/adr`) into public pages; link concepts, not internal plans.
- Document features that are behind unfinished work as if they shipped.
