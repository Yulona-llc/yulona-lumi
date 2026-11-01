# Writing and maintaining the Lumi docs

Site: Mintlify (`docs.json` + MDX). Preview: `bun run docs:dev` (needs Node for the `mint` CLI). Check before committing: `bun run docs:check` (validates config and OpenAPI, finds broken links) and `bun test tests/docs`.

## Audiences (every page names its reader in the first paragraph)
- **Guides**: business owners, support leads and agents who use the dashboard. No code, no jargon; say what to click and what happens. Screens and labels must match the dashboard exactly.
- **Developers**: engineers integrating or extending: API, webhooks, tools, widget, runtime. Precise, with requests, responses, error codes, limits.
- **Self-hosting**: operators. Commands, env vars, failure modes, backups.
- **Platform admin**: the people running the SaaS: plans, credits, providers, tenants.

## Rules
1. **Only document what exists.** Verify against the code, `docs/api/*.md` or by running it. Never invent flags, screens, limits or defaults. If unsure, read the source, then cite it in a comment at the end of the page (`{/* source: packages/ai-runtime/src/turn.ts */}`).
2. **Frontmatter on every page**: `title` (sentence case, 2-6 words) and `description` (one sentence, what the reader will be able to do). Optional `icon`.
3. **Sentence case** headings and UI labels as they appear on screen. Active voice, plain verbs ("Click Save draft"). One idea per paragraph. Lead with what the reader wants to do.
4. **Structure of a guide page**: what this is and who needs it (2 sentences) -> before you start (prerequisites, role needed) -> steps (`<Steps>`) -> what you should see -> common problems -> next steps (`<Card>` links). Roles: say which role is required (viewer / agent / admin / owner).
5. **Components**: `<Steps>`, `<Tabs>`, `<CodeGroup>`, `<Note>`, `<Warning>`, `<Tip>`, `<Card>`/`<CardGroup>`, `<Accordion>`, `<ParamField>`/`<ResponseField>` for API details. Do not nest more than two levels. Do not use emoji.
6. **Code samples** must run: real routes (`/api/v1/...`), real field names, `curl` first, then JavaScript. Use placeholders like `YOUR_API_KEY`; never real secrets. Show the success response and the common error.
7. **Links**: relative paths without extension (`/guides/agents/knowledge-skills`). No dead links (`bun run docs:check`).
8. **Images**: store under `images/<area>/`, descriptive alt text, no secrets or real customer data. Prefer text and tables when a screenshot would go stale.
9. **Terminology** (use consistently): workspace, agent, skill (a knowledge source), section, conversation, handoff, needs attention, resume keyword, credits, connection, tool, channel, widget, sandbox, draft / published.
10. **Self-hosted differences** and **plan differences** go in a `<Note>` where they apply, not a separate page.
11. Keep `docs.json` navigation in sync: a page that exists but is not in navigation fails `bun test tests/docs`.

## Page checklist
Title/description set - reader named - steps verified against the product - roles stated - errors and limits listed - links work - added to navigation - `DOCS_MAP.md` row exists for its source code - changelog entry if user-visible.
