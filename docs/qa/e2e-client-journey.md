# Lumi: end-to-end test guide for the client journey

Audience: an autonomous QA agent that drives a real browser. Scope: everything a new customer does on the tenant side, in order: **sign up, onboarding, setting up the workspace, then using the chat modules** (the visitor widget and the team's inbox). The platform admin console and the backend deploy are out of scope.

How to read this file: sections 1 to 4 are rules and context, read them first. Section 5 is the **smoke path** (run it first, it gates everything else). Sections 6 to 13 are the journey test suites, section 14 the cross-cutting checks and section 15 the isolation and security checks. Section 16 lists behaviour that looks odd but is expected, so you do not report it. Section 17 is the reporting format you must follow. Section 18 is the UI reference (exact labels).

| Suite (section) | Test id prefixes |
|---|---|
| A access and registration (6) | A |
| B onboarding wizard (7) | B |
| C Overview and first-run state (8) | C |
| D agents, sandbox, knowledge (9) | D (agents and sandbox), K (knowledge) |
| E workspace settings (10) | W (widget settings), H (business hours), T (team), U (usage, billing, account) |
| F visitor widget (11) | F |
| G team inbox (12) | I |
| H Ask Lumi and plan gating (13) | L |
| Cross-cutting (14), isolation (15) | X, Z |

---

## 1. What the product is

Lumi lets a business put an AI assistant in front of its customers. The assistant answers from the business's own knowledge and hands the conversation to a person when it is unsure.

| Term | Meaning |
|---|---|
| Workspace | One customer account (a tenant). Everything below belongs to a workspace. |
| Agent | The AI persona: instructions, greeting, tools, escalation rules. It is a **draft** until published. Only a **published, non-archived** agent answers customers. |
| Knowledge / skill / section | What the agent reads. A source (URL, file, text) becomes a skill made of titled sections. |
| Widget | The chat window embedded on the customer's website. Setup lives under Settings > Website widget. |
| Channel | Other messaging apps (WhatsApp, Messenger, Instagram, Telegram, Slack). Cannot be fully tested without real accounts. |
| Inbox | Where the team sees and answers conversations. |
| Handoff / Needs attention | When the AI stops and a person should step in. Listed under "Needs attention". |
| Credits | The AI usage meter. Free plan has a small allowance. |
| Ask Lumi | Paid-only assistant drawer that changes workspace settings for the user. |

Roles: owner, admin, agent, viewer. Navigation and actions depend on role (section 18.11).

Actors in the tests:
- **Owner**: the person who registers. Does onboarding and setup.
- **Visitor**: an anonymous customer using the website widget. Use a **separate browser context** (no shared cookies) for the visitor.
- **Team member**: a second user invited into the workspace (agent or viewer role).

Real-time: the visitor widget and the Inbox update live. Run the owner dashboard and the visitor widget **at the same time in two contexts** for the chat suites.

---

## 2. Environment and access

Fill these in before starting. If a value is missing, stop and ask the operator; do not guess or use production.

| Variable | Meaning | Example |
|---|---|---|
| `DASHBOARD_URL` | Tenant dashboard origin | `https://app.example.com` |
| `API_URL` | API origin (no `/api/v1`) | `https://api.example.com` |
| `RUN_ID` | Unique id for this run, e.g. `qa-20261103-1` | |
| `TEST_EMAIL_DOMAIN` | Domain you may use for addresses, e.g. `example.test` | |
| `TEST_SITE_URL` | A website the operator controls with at least 3 levels of linked pages (for the crawl test). Optional | |
| `PAID_WORKSPACE` | Credentials of a workspace on a paid plan (for Ask Lumi). Optional | |
| `AI_MODE` | `mock` or `real` (ask the operator, see below) | |

Prerequisites the operator must confirm:
1. **Public sign-up is open** (`ALLOW_PUBLIC_SIGNUP=true`). If Register shows "Sign-up is closed", the environment is not ready; report it as BLOCKED, not as a bug.
2. **Which AI is behind the agent.**
   - `real`: a real model. Knowledge questions get real answers. Needed for the answer-quality tests (D14, F3, F13, I11).
   - `mock`: a deterministic fake. It replies `[mock] <your last message>`; a message starting with `/fail` simulates a provider outage; `/tool <name> <json>` forces a tool call. It does **not** read knowledge. With `mock`, skip tests marked `[real-AI]` and use the keyword-based handoff triggers, which do not need a model.
3. The dashboard origin is listed in the widget's **Allowed domains**, or the environment is local development (localhost is always allowed). Needed for the "Live widget" preview and `/widget-preview.html`.

Rate limits you must respect (hitting them is your fault, not a product bug):
- **Registration**: 10 per hour per IP.
- **Login**: 8 attempts per 15 minutes per IP+email, 40 per IP. **Log in once per workspace and reuse the session.** Do not log in repeatedly. Never store a session cookie file across runs: refresh tokens rotate and the second use of an old token logs you out.
- All API calls: 300 per minute per IP.

What you **cannot** test (mark BLOCKED, do not fail): real WhatsApp/Messenger/Instagram/Telegram/Slack traffic, Google or Calendly sign-in (needs OAuth accounts), HubSpot, a real payment, real Cloudflare Turnstile, email delivery unless the operator gives you a mailbox.

---

## 3. Ground rules for the agent

1. **Use only fake data.** Emails `qa+<RUN_ID>-<n>@<TEST_EMAIL_DOMAIN>`, names like "QA Owner 1". Never use real people's data. Never type real card numbers; if a payment form appears use Stripe's test card `4242 4242 4242 4242`, any future date, any CVC, only in a test-mode environment.
2. **Name everything with the run id** (workspace "QA <RUN_ID> Dental", agent "QA Agent") so the operator can find and delete it. There is no "delete workspace" button; leave the data.
3. **Do not break other tenants.** Never use ids or URLs from outside your own workspaces except in the explicit isolation tests (section 15).
4. **Passwords**: at least 12 characters, e.g. `QaRun-<RUN_ID>-Pw1!`. Do not write passwords, tokens, cookies or API keys in the report. Mask them.
5. **One workspace per full run**, kept for the whole run (the journey is stateful: onboarding creates the agent and widget that later suites use). Start a second workspace only where a suite says so.
6. **Observe on every step**, not just the asserted outcome. Record: browser console errors and warnings, failed network requests (URL path and status only), layout breakage, text overflow, wrong or placeholder copy, spelling, the old brand name "Yulona" visible to a user (the product is called **Lumi**; report any visible "Yulona" as S4), missing loading/empty/error states, keyboard and focus problems.
7. **Wait properly.** Knowledge reading, crawls and AI replies are asynchronous. Poll for up to 90 seconds before calling something stuck. Knowledge status refreshes every 3 seconds.
8. **Selectors**: use roles and accessible names (section 18). The app has very few `data-testid`s (listed in 18.12). Match button names with a case-insensitive regex; many buttons add hidden text.
9. **Evidence**: take a screenshot after every test case (pass or fail) and a full-page screenshot on failure. Save the browser console log and failing requests for each failure.
10. **Do not fix, retry endlessly or work around.** If something fails, record it, note whether it blocks later tests, then continue with the next independent test. Retry a failing step at most once to check it is reproducible.
11. **Stop immediately and report** if you see another customer's data, a stack trace or secret on screen, or a payment of real money about to happen.

---

## 4. Test data to reuse

Business profile (use in onboarding): type "Clinic or health service", name `QA <RUN_ID> Dental`, goals "Answer customer questions" + "Capture leads" + "Take bookings", channels Website chat, tone "Friendly", language English, hours "Set opening hours" Monday to Friday 09:00 to 17:00 (Saturday and Sunday closed), website `TEST_SITE_URL` (or leave it empty), brand colour any swatch, handoff "When the AI is not sure".

Knowledge text to add (paste into "Add text", name `QA Clinic Facts`). Note the deliberate irregular spacing in the first line:

```
Opening   hours:  Monday to Friday 9:00 to 17:00.     Saturday closed.
Address: 12 Example Street, Testville.
A check-up costs 40 euros. A cleaning costs 65 euros.
To book, call 555-0100 or ask here. Cancellations need 24 hours notice.
We do not give medical advice over chat. In an emergency call your local emergency number.
```

Visitor questions with expected answers (`[real-AI]`):
- "What are your opening hours?" -> Monday to Friday 9 to 17, Saturday closed.
- "How much is a cleaning?" -> 65 euros.
- "Do you accept walk-ins on Sunday?" -> not in the knowledge; expect the clarifying reply or a handoff, never an invented answer.
- "Hello" / "thanks" -> a short natural reply, no handoff.

Handoff triggers that work **without a real model**: set "Words that call a person" to `refund` on the agent, then a visitor message containing the word "refund".

Abuse test phrase: set Blocked phrases to `zzbadword` on the agent.

Hostile inputs (must render as plain text everywhere): `<img src=x onerror=alert(1)>`, `<script>alert(1)</script>`, `"'; DROP TABLE contacts;--`, a 3000-character string without spaces, right-to-left text (Arabic: `مرحبا كيف حالك`), Amharic `ሰላም`, emoji `😀🙏`.

---

## 5. Smoke path (run first; about 25 steps)

If any step marked **GATE** fails, stop the rest of the run, report it as S1 and write the report. Everything else depends on it.

| # | Step | Expected |
|---|---|---|
| S1 | Open `DASHBOARD_URL/register`. Register the owner (name, workspace, email, password). | Lands on `/onboarding`. **GATE** |
| S2 | Complete all 11 onboarding steps with the profile in section 4, press "Create my setup". | Toast "Your starter setup is ready. Try it, then publish."; lands on `/overview`. **GATE** |
| S3 | On Overview, find the "Try it now" card (or open Agents). | A draft agent exists. |
| S4 | Open the agent > Sandbox tab, send "Hello". | A reply appears (mock: `[mock] Hello`). |
| S5 | Persona tab: add a greeting if empty; Escalation tab: add "Words that call a person" = `refund`. "Save draft", then "Publish" and confirm. | Toasts "Draft saved", "Published". Header shows "Live". **GATE** |
| S6 | Knowledge > Add text (section 4 facts). Wait for status "ready". | Status badge "ready", sections > 0. |
| S7 | Settings > Website widget. Check "Answering agent" is the published agent (select it and "Save changes" if not). Add the dashboard origin to Allowed domains if needed. | Toast "Widget saved". **GATE** |
| S8 | Copy `widgetKey` from "Embed code". Open the visitor page in a second context (section 11.1). | Chat launcher appears; opening it shows the welcome message. **GATE** |
| S9 | Visitor sends "Hello". | A reply arrives. |
| S10 | Owner opens Inbox. | The conversation is listed (live) with the visitor's message. |
| S11 | Visitor sends "I want a refund". | Conversation moves to "Waiting for a person"; it appears under Needs attention; the visitor sees the handoff message. |
| S12 | Owner: Inbox > "Take over", send a reply. | Visitor sees the reply tagged "Team member". |
| S13 | Owner: "Return to AI" then "Resolve". | Toasts "Returned to the AI", "Resolved". |
| S14 | Reload the dashboard. Navigate Inbox > Team > Tickets > Contacts > Agents twice. | No blank page, no error screen, content loads every time. |

---

## 6. Suite A: access and registration

**A1 (P0) Register a workspace.** Steps: open `/register`; fields are "Your name", "Workspace name", "Work email", "Password" (hint "At least 12 characters."); submit with valid data. Expect: button shows "Creating" while busy, then navigates to `/onboarding`. The workspace name appears later in the sidebar.

**A2 (P1) Validation.** Submit empty, then each invalid field: bad email "Enter a valid email address.", password of 11 characters "Use at least 12 characters.", empty name "Enter your name.", empty workspace "Name your workspace." Expect: messages exactly as quoted, shown next to the field, no network call for client-side failures, focus moves sensibly, nothing is created.

**A3 (P1) Duplicate email.** Register again with the same email. Expect: a generic failure message (the product must not reveal whether the email exists beyond the API message), no second workspace, no crash.

**A4 (P1) Login and logout.** Sign out (user menu), then "Sign in" at `/login` with the owner. Expect: lands on `/overview` (or the page you came from). Wrong password: an error message, no lockout wording needed. Do not exceed 3 login attempts here.

**A5 (P1) Route protection.** Signed out, open `/overview`, `/inbox`, `/settings/team`. Expect: redirect to `/login`. Signed in, open `/login` and `/register`. Expect: redirect to the app, not a flash of the form.

**A6 (P2) Sign-up closed.** If the environment has sign-up closed, expect the "Sign-up is closed" view with "Ask your workspace administrator for an invitation, or sign in." Report as environment note, not a bug.

**A7 (P2) Unknown URL.** Open `/nope`. Expect: a not-found page with a way back, not a blank screen.

**A8 (P2) Session survives reload.** Reload on `/inbox` and `/settings/billing`. Expect: still signed in, same page, no redirect loop.

---

## 7. Suite B: onboarding wizard

The wizard is at `/onboarding`, opens right after registration, is for admins and owners only, saves progress on the server, and ends with "Create my setup". Full step list in 15.2.

**B1 (P0) Happy path.** Complete all 11 steps (section 4 profile). Expect at each step: heading "Step N of 11" with a progress bar (aria-label "Setup progress"); "Continue" disabled until the step has a valid answer; "Back" disabled on step 1; suggested options are tagged "suggested"/"Suggested" and depend on the business type chosen in step 1. At the preview step the list "What will be created" matches your answers. Press "Create my setup". Expect: button label "Setting up", toast "Your starter setup is ready. Try it, then publish.", redirect to `/overview`.

**B2 (P0) What was created.** After B1: Agents has one agent in **Draft** ("Never published"), Settings > Website widget has a widget, Knowledge has a URL source if you gave a website (else none), Settings > Business hours reflects the hours you set (09:00 to 17:00 weekdays), and the Overview shows blocks for your three goals. The greeting mentions the business name. **Nothing is published.** Record anything that is missing or different.

**B3 (P1) Resume.** Start a **second workspace** (new registration). Answer steps 1 to 3, close the tab, sign in again and open `/overview`. Expect: an Overview card "Finish your setup with Lumi." with button "Continue setup"; clicking it resumes at the step after your last answer with earlier answers still selected.

**B4 (P1) Skip setup.** In a third workspace press "Skip setup for now" on step 1. Expect: goes to `/overview` with no toast; the card "Finish your setup with Lumi." (button "Start setup") remains; the Overview also shows "Tell Lumi your goal" with buttons "Answer questions", "Capture leads", "Take bookings".

**B5 (P1) Step validation.** Business name empty -> Continue disabled. Website step: type `not a url` -> Continue disabled; `https://example.com` -> enabled; clear it and use "Skip this step". Brand step: type `#2563EB` in "Or type a colour"; type `blue` -> must not be accepted silently (record behaviour). Hours step "Set opening hours": toggling a day closed shows "Closed"; set an end time earlier than the start -> record what happens (should not allow or should explain).

**B6 (P1) Back and change.** Go back from step 6 to step 1, change business type, continue. Expect: suggested tags update; previously chosen answers for later steps are kept or sensibly reset (record which); no stale suggestions.

**B7 (P2) Skippable steps.** Steps 4 to 10 are skippable, steps 1 to 3 and 11 are not. Skip everything skippable and finish. Expect: a valid starter setup using defaults.

**B8 (P2) Plan limit at the end.** In a workspace that already has an agent and a widget (the Free plan allows 1 agent and 1 widget), open `/onboarding` again if it is reachable and finish. Expect: an inline error such as "Plan limit reached for agents" in an alert box, not a crash and no half-created data. (A completed wizard redirects to `/overview`; if it is not reachable, mark BLOCKED.)

**B9 (P2) Non-admin access.** Sign in as an `agent` or `viewer` member (suite 13) and open `/onboarding`. Expect: redirect to `/overview`.

**B10 (P2) Browser back/forward and reload mid-wizard.** Use the browser back button and reload on step 5. Expect: stays in the wizard on the saved step, no duplicate creation.

**B11 (P2) Small screens.** Run steps 1, 3, 7, 9 at 390x844. Expect: no horizontal scroll, buttons reachable, chips wrap.

---

## 8. Suite C: Overview and first-run state

**C1 (P0) Checklist.** Right after onboarding (before publish): "Set up your workspace" shows "N of 4 done" with items "Create your agent", "Add knowledge", "Add the chat to your website or connect a channel", "Try it, then publish your agent"; done items are marked done, undone items have an "Open" button that navigates to the right page. Expect the count to rise as you complete S5 to S7; after all four it should read 4 of 4. The checklist leads the page while there are no conversations in the last 30 days.

**C2 (P1) "Try it now".** A card shows after onboarding and before publishing; its button opens `/agents/<id>?tab=sandbox`.

**C3 (P1) Goal blocks.** With goals support+leads+bookings, blocks "Customer questions", "Leads", "Bookings" show. Support: KPIs "Answered by Lumi", "Handed to your team", "First reply" show "No data yet" with no conversations; "Questions Lumi could not answer" empty text reads "Nothing yet. When Lumi cannot find an answer, those chats show here so you can add the missing information." Leads: funnel Started/Engaged/Qualified/Offered/Booked and "Qualified leads"; HubSpot tile "Not connected." Bookings: Upcoming/Booked/Cancelled and a calendar status "No calendar connected yet". After the chat suites (11, 12) re-open Overview: numbers must reflect the conversations you created (Started >= conversations, "Handed to your team" >= handoffs). Record mismatches.

**C4 (P1) Credits card.** "AI credits" with a bar and "N% used this month" (hidden on unlimited self-hosted installs). After AI replies, the percentage may rise (real model). If it does not change after 5 AI replies, record it.

**C5 (P2) "Right now" and "Needs you".** With a conversation waiting for a person, "Waiting for a person" shows 1 and "Needs you" lists it, linking to the conversation. When nothing waits: "No one is waiting." and "Nothing needs a person. The AI has it covered."

**C6 (P2) Activity chart.** Switch "7 days" / "30 days". Expect the chart redraws, a single day of data is not stretched into one huge bar, and "Show as table" works.

**C7 (P2) Goal change.** From "Tell Lumi your goal" choose "Capture leads" (in the skipped-setup workspace). Expect the Leads block appears without a reload.

---

## 9. Suite D: agents, knowledge and the sandbox

### 9.1 Agents

**D1 (P0) List and create.** Agents shows the onboarding agent ("Never published", badge draft). "New agent": fields "Name" and "Description"; Create -> toast "Created <name>". On the Free plan expect a **second** agent to be refused with a toast "Plan limit reached for agents" (the plan allows 1). Expect no half-created agent. Report if the upgrade path is not offered anywhere near that error (S3).

**D2 (P0) Edit, save, publish.** Open the agent. Tabs: Persona, Knowledge, Escalation, Tools, Versions, Sandbox. Change the Greeting. The bar shows an unsaved-changes marker; "Save draft" becomes enabled; "Publish" is disabled with the title "Save your draft before publishing". Save -> "Draft saved", marker gone. "Publish" -> modal "Publish this draft?" with optional "Note" -> toast "Published". Header badge reads "Live · v1" and the subline "Live on version 1. Edits below are a draft until you publish."

**D3 (P1) Versions.** Edit the greeting again, save, publish with note "second". Versions tab: two versions, newest marked "live", notes shown. "Roll back" version 1 -> modal "Roll back to version 1?" -> toast "Rolled back to version 1"; the greeting in the editor and in the live widget (after the 60 second config cache) returns to the old value.

**D4 (P1) Unsaved changes.** Edit a field and navigate to another page. Record whether the user is warned (no requirement, report as observation). "Discard changes" (icon button) restores saved values.

**D5 (P1) Archive and unarchive.** "Archive agent" -> modal "Archive this agent?" -> toast "Archived". Because the widget uses this agent, a warning toast about it still being attached appears. Visitor behaviour: see F11. "Unarchive agent" -> toast "Unarchived"; the agent returns as published if it had a version.

**D6 (P1) Create with AI.** Agents > "Create with AI" (`/agents/new-ai`): answer the assistant's questions using quick-reply chips and typed answers. Expect: each answer is acknowledged, the live "agent sheet" fills in, "Create draft" -> toast "Draft created: <name>" and a draft agent exists, **not published**. On the Free plan expect "Plan limit reached for agents" if an agent already exists. `[real-AI]` for meaningful conversation; with mock the replies echo, so only test navigation and the empty/error states.

**D7 (P1) Role gate.** As an `agent` or `viewer` member, Agents is not in the navigation and `/agents` shows a role notice or redirects (record which); the editor save/publish controls are absent.

**D8 (P2) Field limits.** "Persona and instructions" shows a counter n/8000; paste 8001 characters. Expect it is blocked or flagged, not silently truncated. Empty name on a new agent is refused.

**D9 (P2) Escalation tab.** "Words that call a person" chips (add `refund`, remove, add a duplicate), "Hand off after unanswered questions" (1 to 20; try 0 and 21), "Resume keyword", switch "Hand off qualified leads". Safety section: "Block abusive visitors" switch (default on), "Strikes before blocking", "Messages per minute", "Blocked phrases", "Farewell message". Expect sensible validation and that saved values persist after reload.

**D10 (P2) Tools tab.** Switches "Qualify lead", "Collect contact", "Escalate to human", "Check calendar availability", "Book appointments", and the custom tools panel. Toggle, save, reload: values persist. Without a connected calendar, record what the booking switches say.

**D11 (P2) Model and Reply style.** Knowledge tab: Model select ("Workspace default" first) and the "Reply style" slider labelled Precise / Balanced / Creative / Very creative. Expect plain-language labels, no raw numbers required.

### 9.2 Sandbox (test conversation)

**D12 (P0) Run a test.** Sandbox tab (save any pending edits first; a dirty draft shows "Save your draft first. The sandbox runs the last saved draft."). Type in "Message" ("Type a customer message") and press "Send". Expect: "Thinking…" then a reply; nothing appears in the Inbox ("Nothing is saved or sent to customers."); the right panel "What the agent read" fills in: stage change, "Grounded" or "Not found in knowledge", skill sections read, tokens. "Reset conversation" clears it.

**D13 (P1) Sandbox sees the draft, not the live version.** Change the greeting/prompt, save the draft (do not publish), test in the sandbox: it uses the new draft. Visitors in the widget still see the published version.

**D14 (P1) `[real-AI]` Grounding.** After the knowledge in 9.3 is ready ask the section 4 questions in the sandbox. Expect correct answers marked "Grounded" with 1 or more "section(s) read"; the Sunday walk-in question must **not** be invented ("Not found in knowledge" or a clarifying question).

**D15 (P2) Greetings.** "Hello", "hi", "thanks". Expect a short natural reply and no handoff (this was a past bug: greetings used to trigger "I'm not sure about that").

### 9.3 Knowledge

**K1 (P0) Add text.** Knowledge > "Add text": "Text" and "Name" (required). Paste the section 4 facts. Expect: a row appears; status goes "pending" ("Queued. Reading starts shortly.") -> "processing…" ("Reading and splitting into sections…") -> "ready" within about a minute. Sections count > 0; "Sections" opens a sheet. **Whitespace**: titles and the displayed text must not contain runs of extra spaces (the first line was deliberately messy: "Opening   hours:  Monday...").

**K2 (P1) Upload a file.** "Upload file": accepts .pdf .docx .txt .md .html .htm, max 10 MB. Upload a small .txt: progress "N% uploaded", toast "Uploaded. Reading it now.", status becomes ready. Try an unsupported file (.exe or .png): error "Unsupported type. Use PDF, DOCX, TXT, MD or HTML." Try a file over 10 MB: "File is larger than 10 MB." Drag and drop onto the strip also opens the dialog.

**K3 (P1) Add a web page.** "Add URL": field "URL" (placeholder https://example.com/help). Defaults: switch "Follow links on this site" **on**, "How deep" **3** (stepper "Go less deep" / "Go deeper", range 1 to 5), "Max pages" 25 (max 50), switch "Include subdomains" **off**. With `TEST_SITE_URL`: add it with the defaults. Expect progress text "Reading pages: X read, Y found so far (up to Z)." and at the end "Read N pages, skipped M ...". "Pages read (N)" in the Sections sheet lists page URLs. Pages deeper than the chosen depth are not read; pages are not duplicated; the number read never exceeds Max pages. Then re-add with "Follow links" off: exactly 1 page.

**K4 (P1) Crawl safety.** Add `http://localhost:3000`, `http://127.0.0.1`, `http://169.254.169.254/` and `ftp://example.com`. Expect each to be refused or end "failed" with a safe, non-technical error and no crash or internal detail. Report any case that succeeds (S1).

**K5 (P2) Depth and limits UI.** Stepper cannot go below 1 or above 5; Max pages rejects 0, 51 and negative numbers.

**K6 (P1) Edit, reingest, delete.** Pencil "Edit <name>": change the name/description, "Save skill" -> toast "Skill saved"; "Use automatic description" restores it. Menu "Reingest" -> toast "Reingesting <name>"; menu "Delete" -> confirm "Delete this skill?" -> toast "Deleted <name>"; the row disappears.

**K7 (P2) Empty and failed states.** Empty list: "No knowledge yet" with the explanation. A failing source shows its error in red and can be reingested or deleted.

**K8 (P2) Storage limit.** Informational only: on the Free plan a source can hit "Plan limit reached for storage_mb". Do not attempt to fill storage.

---

## 10. Suite E: workspace settings that affect chat

### 10.1 Website widget settings

**W1 (P0) Create or open the widget.** `/settings/widget` shows the widget made by onboarding (or "No widget yet" + "Create widget" -> toast "Widget created", name "Website chat"). Sections: Branding, Appearance, Behaviour, Allowed domains, Protection, Pre-chat form; right rail: Draft preview, Embed code, Live widget.

**W2 (P0) Answering agent.** Select "Answering agent": it lists **published agents only** plus "No agent (offline)". Record whether the starter agent is preselected after you publish it. If you had to select it manually for the widget to work, report it as a usability finding (S3): the owner may not know.

**W3 (P0) Save and reflect.** Change "Title", "Subtitle" and "Welcome message", then "Save changes" -> toast "Widget saved". The save bar only appears when something changed; "Discard" reverts. Reload the page: values persist. Visitor widget shows the new values within 60 seconds (config is cached for 60 s, expected).

**W4 (P1) Colours without codes.** Appearance > "Colour style" "One colour": click swatches (each has an accessible colour name) and the "Brand colour" picker. Switch to "Two colours": "Start colour", "End colour", "Ready-made blends", "Direction". The preview (image "Preview of your colours") updates immediately. Save. Visitor widget header, launcher and visitor bubbles use the colour/gradient and the text stays readable on light and dark colours (test white, yellow, black). No hex typing is required anywhere.

**W5 (P1) Avatar upload.** "Upload a picture" opens a crop dialog; "Use this picture" -> toast "Picture saved"; header shows it in the live widget. Try an SVG and a PDF -> "Use a PNG, JPEG or WebP picture". Try an image over 12 MB -> "That picture is too large. Choose one under 12 MB." "Remove" -> toast "Picture removed". Unsaved edits in other fields must **not** be lost by uploading a picture (past bug). The advanced "Picture web address" accepts https only.

**W6 (P1) Allowed domains.** "Add your website": enter `example.com` (chip appears), `*.example.com`, and invalid values (`http://`, `not a domain`, spaces). Expect `"x" does not look like a website address. Try example.com` for bad input; Enter and the "Add" button both work; removing a chip works. A visitor page on a domain not in the list must not be able to chat (browser console shows the widget refused; record the user-visible behaviour).

**W7 (P1) Pre-chat form.** Switch on "Ask visitors for details before chatting", set "Intro text", tick Name, Email (required). Save. Visitor sees the form before chatting (F2).

**W8 (P1) Embed code.** "Embed snippet" shows a script with `widgetKey` and `apiUrl`. "Copy snippet" -> toast "Snippet copied". The snippet works when pasted into a page served from an allowed domain (11.1). The API URL in the snippet is your `API_URL`, not localhost (report if it points to localhost on a hosted environment, S2).

**W9 (P1) "Live widget".** The right rail runs the real widget in an iframe with the saved config. If the dashboard origin is not an allowed domain it shows a notice or error (expected, section 16); add the origin and reload.

**W10 (P2) Advanced protection.** Collapsed by default ("Honeypot on by default"). Turn on "Cloudflare Turnstile": fields "Site key", "Secret key", Theme/Size/Appearance, "Action (optional)". Save with an empty key -> the save must be disabled or refused with a clear message. Dummy Cloudflare keys (always pass): site key `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`. With these, a visitor should see the check pass automatically (BLOCKED if the environment cannot reach Cloudflare). The secret is write-only: after saving, it must never be shown again.

**W11 (P2) Rotate key.** Do this **last**: "Rotate key" -> confirm "Rotate the widget key?" -> toast "Key rotated. Update the snippet on your site." The old key must stop working for visitors; the new snippet works.

**W12 (P2) Disable widget.** Switch "Widget enabled" off and save: visitors see no chat (or a clear refusal). Re-enable.

### 10.2 Business hours

**H1 (P1) Weekly windows.** `/settings/operations` (Settings > "Business hours"): "Team availability" status (My status radios, toast "You are <status>"), "Time zone", "Weekly windows" with "Weekdays 9 to 5", per-day "<Day> open" switches, "Add window", "Copy". Make changes -> save bar -> "Save settings" -> toast "Settings saved". Reload to confirm persistence. With no windows the text says the workspace is treated as always open.

**H2 (P1) Outside business hours.** Cards "AI only", "AI sends a message" (field "Out-of-hours message"), "Flag in the queue". Choose "AI sends a message", set the message, set hours so that "now" is closed, trigger a handoff (F12). Expect the visitor sees your out-of-hours message and the item is flagged "Out of hours" in Needs attention. Restore hours afterwards.

**H3 (P2) Validation.** Overlapping windows, a window ending before it starts, an invalid time zone. Expect clear errors, no saved nonsense.

### 10.3 Team and roles

**T1 (P1) Invite.** Settings > Team > "Invite member": Email and Role (owner/admin/agent/viewer with role hints). "Send invite". The dialog says the link is valid for 7 days. In development mode a "Development link:" with "Copy link" is shown; otherwise the email must be delivered to a mailbox the operator controls (else BLOCKED for the accept step).

**T2 (P1) Accept the invite.** In a fresh context open the link (`/accept-invite?token=...`): "Join your team", fields "Your name", "Password" (12+ characters), button "Create account". Expect "You're in", then redirect to `/login` (no auto-login). Sign in as the new member. Errors: an already used or expired link says "This invitation is invalid, already used or has expired. Ask your administrator to send a new one." A link without a token shows "Invitation link incomplete".

**T3 (P1) Role gating.** Invite one `agent` and one `viewer`. Expect: **viewer** sees Overview, Inbox, Contacts, Tickets, Bookings and the read-only settings but not Agents, Knowledge, Needs attention or Channels, and cannot save settings; **agent** additionally sees Needs attention and Knowledge but not Agents or Channels; **admin/owner** see everything. Type the restricted URLs directly (`/agents`, `/channels`, `/settings/billing`): expect a role notice or redirect, never working controls. Hidden buttons must also be refused if reached (try "Take over" as a viewer).

**T4 (P2) Invitations list.** Pending invites list with "Revoke" (confirm "Revoke invitation?", toast "Invitation revoked"); a revoked link fails with the invalid message. Change a member's role via the row select; remove a member. The last owner must not be removable or demotable.

**T5 (P2) Free plan seats.** The Free plan allows 2 seats. Inviting a third member should be refused with a plan-limit message, not a crash.

### 10.4 Account, usage, billing

**U1 (P1) Rename the workspace.** Settings > Account > "Workspace name" -> "Save changes" -> toast "Workspace renamed". The **sidebar workspace name updates immediately without a reload** (past bug).

**U2 (P1) Usage page.** `/settings/usage`: "This month", allowance reset date, "Monthly allowance", "Used this month", "Top-up balance", and "about N messages left". "Export CSV" -> toast "CSV exported" and a file downloads. "Breakdown" tabs By agent / By model / Top conversations. After real AI chats, usage increases and the breakdown lists your agent.

**U3 (P2) Billing page.** `/settings/billing` (admin): shows the current plan (Free), usage vs limits with "Near limit"/"At limit", an upgrade button "Upgrade to Pro". Without Stripe it should say "Payments are not configured on this installation." Do not complete a real payment. Non-owners see "Only owners can change the plan."

**U4 (P2) Credits exhausted states.** Only if the operator provides a workspace at 0 credits: banner "AI replies are paused until you add credits", dialog buttons "Buy credits"/"Open needs attention"/"View usage", and visitors get a polite message and a handoff, never an error text from a provider.

**U5 (P2) Account basics.** Password change if offered; profile page at `/profile`.

---

## 11. Suite F: the visitor widget (chat module, customer side)

### 11.1 Loading the widget on a test page

Get `widgetKey` from the "Embed snippet" (format `wk_...`). Two ways to load it, use both:

1. **Preview page**: open `DASHBOARD_URL/widget-preview.html#` followed by this JSON URI-encoded:
   `{"widgetKey":"wk_...","apiBase":"API_URL/api/v1","scriptUrl":"/widget.js"}`
   It forces the chat open. The page origin (the dashboard) must be in the widget's Allowed domains.
2. **Your own page**: any HTML file served over http(s) from an allowed domain, with the snippet pasted in. For a local file use a tiny static server on `localhost` (always allowed in development).

Use a **fresh browser context per visitor** (new cookies and storage = new visitor). Reuse the same context to test "returning visitor".

**F1 (P0) Launcher and welcome.** Launcher button (accessible name = launcher label, or "Open chat") appears bottom right (or left per setting). Open: a dialog titled with the widget title, the welcome message (from "Welcome message", or the agent's Greeting if that is empty), input "Type a message…" (or your placeholder), send button "Send message" disabled when empty. "Close chat" and Esc close it; the launcher returns.

**F2 (P1) Pre-chat form.** With W7 on: fields per setting (labels Name/Email/Phone). Empty required fields -> "This field is required"; bad email -> "Enter a valid email address". "Start chat" starts the conversation. Expect the contact appears under Contacts with the entered details (I12).

**F3 (P0) Ordinary conversation.** Send "Hello", then a question from section 4. Expect: typing indicator ("Assistant is typing"), reply appears, messages in order, own message right-aligned; no duplicate messages; no reply is cut off. With `real` AI check the answer quality (D14). With `mock`, expect `[mock] <text>`.

**F4 (P1) Hostile and unusual input.** Send each hostile input from section 4. Expect it is shown as plain text in the widget **and** later in the Inbox, with no script execution and no layout break (long strings wrap or scroll inside the bubble). Arabic/Amharic/emoji render correctly (right-to-left text aligns sensibly). A 5000-character message: record the limit behaviour (accepted, trimmed or refused with a message). An empty or whitespace-only message cannot be sent.

**F5 (P1) Persistence.** Reload the visitor page. Expect the same conversation continues (history visible) in the same browser context, and a new context starts a fresh conversation.

**F6 (P1) Connectivity.** Go offline (browser offline mode) while the chat is open: banner "You're offline. Messages will send when you reconnect." Send a message offline: it shows "Sending…", then "Not delivered. Retry" or delivers on reconnect. Restore the network: no duplicated message. Header status shows "Offline"/"Reconnecting…" meaningfully.

**F7 (P1) Mobile.** At 390x844 the widget uses the screen sensibly, the keyboard does not hide the input (record), close is reachable, no horizontal page scroll introduced on the host page.

**F8 (P2) Accessibility.** Keyboard only: Tab reaches launcher, input and send; Enter sends; focus is trapped in the open dialog and returns to the launcher on close; screen-reader names exist as listed.

**F9 (P2) Honeypot and automation.** The widget has a hidden field named `website`. A normal visitor must never see it. (You are not expected to attack it; just confirm it is invisible and not focusable.)

### 11.2 Agent availability

**F10 (P0) Unpublished or unassigned agent.** Set "Answering agent" to "No agent (offline)" (or point it at a draft-only agent) and save; wait 60 s. A new visitor sees the banner "This assistant is offline right now. Leave a message and a team member will reply." If the visitor sends a message, the reply is a polite unavailable message ("This assistant is not available right now. A team member will reply.") and the conversation appears in Needs attention for the team. **No AI answer must ever be produced from a draft.** Report any AI reply here as S1.

**F11 (P1) Archived agent.** Archive the live agent (D5) with the widget still attached. New and existing visitors must not get AI answers; they see the unavailable behaviour as in F10. Unarchive and confirm answers resume.

### 11.3 Handoff and human takeover (visitor view)

**F12 (P0) Keyword handoff (no model needed).** With "Words that call a person" = `refund`, visitor sends "I want a refund". Expect the handoff message ("Thanks! I'm handing you over to a teammate who will be with you shortly." unless customised) and the AI stops replying afterwards (send "hello": no AI answer while waiting for a person, or only the resume behaviour below).

**F13 (P1) `[real-AI]` Unknown question path.** Ask three questions the knowledge cannot answer ("Do you accept walk-ins on Sunday?", "Do you sell pizza?", "What is your CEO's shoe size?"). Expect first the clarifying reply ("I couldn't find that in the information I have. Could you rephrase it or share a bit more detail? If you'd rather talk to a person, just say so."), and after the configured number of unanswered questions the fallback ("I'm not sure about that. Let me connect you with a teammate who can help.") plus a handoff. The assistant must not invent facts.

**F14 (P1) Human reply.** After a handoff the owner takes over (I3) and replies. The visitor sees the reply live, tagged "Team member", without refreshing.

**F15 (P1) Resume keyword.** Read the agent's "Resume keyword" value (Escalation tab). In a fresh handoff **before any human has replied**, the visitor sends exactly that keyword. Expect the AI picks the conversation back up and the handoff clears. After a human replied, the keyword must not resume the AI by itself.

### 11.4 Abuse protection

**F16 (P1) Strike flow.** On the agent set Blocked phrases to `zzbadword`, leave "Block abusive visitors" on and "Strikes before blocking" at its default; save and publish. In a fresh visitor context send `zzbadword` repeatedly (up to the strike count). Expect the assistant sends its short farewell message first, then the conversation closes, the visitor sees "This conversation has ended." when trying again, and starting a **new** chat from the same browser is also refused. In the dashboard the conversation shows "Conversation closed and visitor blocked for abuse", the contact has a red "Blocked" badge, and Needs attention shows an item typed "Blocked for abuse".

**F17 (P1) Unblock is human-only.** In the Inbox contact panel the block reason is visible. As an **owner/admin**, "Unblock" -> toast "Contact unblocked"; as an **agent** the text "Only an owner or admin can unblock." shows instead. After unblocking, the visitor can chat again. The resume keyword must never un-block a visitor.

**F18 (P2) Normal behaviour is not punished.** Send 5 normal messages quickly and a message with a swear word that is not in your blocked list: no block. (Flooding limits exist; record at what rate a harmless burst gets blocked, if any.)

---

## 12. Suite G: team inbox (chat module, owner side)

Use the owner context while a visitor chats in the other.

**I1 (P0) Live conversation list.** Inbox shows "Live" status. A new visitor chat appears in the list without reloading, with a name or "Visitor", an AI/Human badge, an unread dot (aria "Unread") and the last message preview. Opening it clears the unread dot.

**I2 (P0) Conversation view.** Header status text matches state: "The AI is answering", "Waiting for a person", "<name> is handling this", "Resolved". Messages: visitor, AI, human (labelled with the sender name), notes ("Internal note"), system events ("Conversation returned to the AI", "<name> took over", "Handoff requested: the AI was not confident in an answer"). "Load earlier messages" works on long threads.

**I3 (P0) Take over and reply.** "Take over" -> toast "You took over". The composer has "Send as": "Reply to customer" / "Internal note". Send a reply (Ctrl+Enter also sends): it appears for the visitor **live**. Sending a reply also takes over from the AI (hint text). Send an **Internal note**: the visitor must **never** see it. The AI does not answer while a human owns the conversation.

**I4 (P1) Canned responses.** Type `/` in the composer: a list "Canned responses" appears; also the "Canned responses" menu "Insert a saved reply". Create canned replies first under Settings > "Canned responses" (or "Hours and routing" group) and test insertion by keyboard and mouse.

**I5 (P0) Return to AI and resolve.** "Return to AI" (or "Hand back to AI" when not yours) -> toast "Returned to the AI"; the AI answers the next visitor message. "Resolve" -> toast "Resolved"; the composer shows "This conversation is resolved. Reopen it to reply."; "Reopen" -> toast "Reopened". A visitor message on a resolved conversation reopens it (record behaviour).

**I6 (P1) Assign.** "Assignee" select: assign to yourself and to the invited member (T2). The member sees it under "Assigned to me" in Filters.

**I7 (P1) Search and filters.** Search ("Search name, email or message", shortcut `/`) finds by name, email and message text. "Filters" sheet: Status (Open / Needs attention / Resolved), "Handled by" (AI / Human), Channel, Assignee. Chips appear, "Remove filter: X" removes one, "Reset"/"Clear all" clears. Empty results show "No matches" with "Clear filters". An empty workspace shows "No conversations yet" with "Connect a channel".

**I8 (P1) Realtime resilience.** Disconnect the owner's network for 20 seconds while the visitor sends 2 messages; reconnect. Expect the status shows "Offline"/"Reconnecting", then "Live", and the missed messages appear without a reload and without duplicates.

**I9 (P1) Contact panel.** Right panel "Contact details": "Open full profile", "Conversion stage", "Lead card" (name, email, phone captured by the AI if the visitor shared them), "Custom attributes", "Earlier conversations". Block flow from F16/F17 (modal "Block this contact?" with "Reason (optional)", toasts "Contact blocked"/"Contact unblocked").

**I10 (P1) Needs attention.** `/attention` (agent and above): filter chips "Uncertain", "Lead ready", "System failure", "Blocked for abuse"; tabs Active / Waiting / Claimed / Resolved; items show wait time. "Claim" -> toast "Claimed"; a second user trying to claim gets "Someone else claimed this first."; "Resolve" modal ("Resolution note (optional)", switch "Hand the conversation back to the AI"); "Release"; "Assign" menu; "Open conversation". Empty queue: "Queue is clear". Counts in the nav/badges update live.

**I11 (P1) Lead capture.** As the visitor say "I'd like to book a check-up, my name is QA Visitor and my email is qa+visitor@<TEST_EMAIL_DOMAIN>". `[real-AI]`: expect the AI asks for missing details, the Lead card fills in, the stage moves (visible in the contact panel), and the contact appears under Contacts. With mock, use the pre-chat form instead.

**I12 (P2) Contacts.** `/contacts`: table (Name, Email, Phone, Channels, Last seen), search ("Search name, email or phone"), "New contact" (needs at least one field; toast "Contact created"), open a profile, edit and "Save changes" (toast "Contact saved"), custom attributes ("Add attribute"), timeline with conversations. Duplicate handling: create two contacts with the same email -> "Merge duplicate" flow ("Find the duplicate", "Confirm merge"). Blocked contacts show their badge here too.

**I13 (P2) Tickets.** `/tickets`: Board/List/Table views, "New ticket" (Title required, Priority, Assignee, toast "Ticket created"), drawer to change Status (Open, In progress, Waiting, Resolved, Closed), Priority and Assignee, "Add a comment" -> "Comment", bulk actions bar, delete (admin) with confirmation, search ("Search title, description or #number"). Assigning a ticket notifies the assignee (bell icon).

**I14 (P2) Notifications bell.** Bell in the header shows unread items for handoffs/tickets assigned to the user; opening marks them read; counts are correct after reload.

**I15 (P2) Bookings (limited).** `/bookings`: "Calendars" strip says no calendar connected with "Manage in Connectors"; the **"New booking" button is disabled** with the hint "Connect a calendar above to create bookings." for admins when nothing is connected. Settings > Connectors (`/settings/integrations`) shows sections Calendar (Google Calendar, Calendly) and CRM (HubSpot) with plain-language status. Clicking "Connect Calendly" without server credentials should show a clear, non-technical message (record text). The Calendly card shows the exact redirect address with a Copy button when the server is configured. Real connection: BLOCKED.

**I16 (P2) Channels (limited).** `/channels` (admin): tiles WhatsApp, Messenger, Instagram, Telegram, Slack, "Add a channel" sheet with "Connection name", "Answering agent", credential fields; leave required fields empty -> "Connect" disabled. Creating a connection with dummy credentials and pressing "Test connection" should fail gracefully ("Test failed" with a readable reason); then Disable/Enable and Delete (confirm "Delete connection?"). Report credentials echoed back in clear text after saving (secrets must be masked).

---

## 13. Suite H: Ask Lumi (copilot) and plan gating

**L1 (P1) Locked on the Free plan.** Header button "Ask Lumi" is visible to owners/admins only. Opening it shows "Ask Lumi is included in paid plans" with "See plans" (-> Billing). It never calls an AI model; typing is not possible.

**L2 (P1) Unlocked (needs `PAID_WORKSPACE`, otherwise BLOCKED).** Welcome message "Hi, I'm Lumi. I can update your agent, ...". Send "make my greeting friendlier": Lumi answers and applies a **draft** change (verify in the agent editor, not published). Send "publish my agent": a confirmation card appears (buttons "Confirm" / "Not now"); the agent is **not** published until "Confirm". "Not now" leaves it unpublished. Expiry: the same card later says "This confirmation expired. Ask again." The line "N of M credits left this month" decreases. Lumi must refuse requests outside configuration (e.g. "show me all customers' emails") and must never reveal secrets or read customer conversations.

**L3 (P2) Role gate.** Agents/viewers do not see the Ask Lumi button.

**L4 (P2) Plan limit messages.** On Free: second agent (D1), third seat (T5), second widget (try "Create widget" if reachable) all show readable "Plan limit reached for ..." messages and never white-screen.

---

## 14. Cross-cutting checks (run during every suite, plus these explicit cases)

**X1 (P0) The blank-page regression.** Navigate the sidebar in this order three times, with a reload between rounds: Inbox, Settings > Team, Tickets, Contacts, Agents, Knowledge, Settings > Website widget, Overview. Expect every page renders its content each time (no blank area, no "Something went wrong", no endless skeleton). Report any occurrence with the sequence.

**X2 (P0) Saves show immediately.** After each save, the UI reflects the change **without a manual reload**: agent publish (list shows "Live on version N"), widget save, rename workspace (sidebar), business hours, canned reply, tag, knowledge rename, member role change, contact edit, block/unblock (badge in the Inbox list). Report any that need a reload.

**X3 (P1) Reload persistence.** Reload every settings page after saving; values persist.

**X4 (P1) Mobile layout (390x844).** Bottom navigation shows the primary items (Overview, Inbox, Needs attention, Contacts, Tickets, Bookings) with a "More" menu for the rest; every page is usable: no horizontal scroll, tap targets at least 40px, modals and sheets scroll, the composer stays reachable above the keyboard. Test onboarding, Inbox conversation view, Agent editor, Widget settings, Knowledge.

**X5 (P1) Dark mode and theme.** Switch theme (the theme toggle in the header). Check text contrast, icons, charts, the widget preview, modals. Reload keeps the choice.

**X6 (P1) Keyboard and focus.** Tab through the sign-in form, a modal and the sidebar; focus is visible; Esc closes modals and sheets; the command palette (`Ctrl/Cmd+K` "Search or jump to…") opens, searches pages and jumps.

**X7 (P1) Empty, loading and error states.** For each page visit with no data: a helpful empty state with a next action. Block the API in dev tools (offline) and navigate: a readable error with retry, never a blank page.

**X8 (P1) Console and network hygiene.** Over the full run list every console error and every unexpected 4xx/5xx (ignore the expected 402 plan-limit and 401 before login, and refresh-token calls). Group duplicates.

**X9 (P1) Copy and brand.** Any visible "Yulona" is a finding (S4). Typos, mixed tone, raw error codes or raw JSON in the UI, English text where the user chose another language for the widget welcome (the UI itself is English only).

**X10 (P1) Time and numbers.** Dates and times in the user's local format, relative times ("5 min") correct, counts match across pages (Overview vs Inbox vs Needs attention).

**X11 (P2) Performance.** Note pages that take more than 3 seconds to become usable on a normal connection, the largest layout shifts, and an Inbox with 50 conversations (create them via the visitor widget in a loop if you can) scrolling smoothly.

---

## 15. Isolation and security-minded checks (client side)

**Z1 (P0) Workspace isolation.** Create workspace B (second registration, second context). From B open URLs containing A's ids (`/agents/<A agent id>`, `/inbox/<A conversation id>`, `/contacts/<A contact id>`). Expect "not found"/an error with no data from A. Never use B to modify A.

**Z2 (P1) Widget key isolation.** A visitor page using A's widget key shows A's branding only; B's dashboard never lists A's conversations.

**Z3 (P1) Secrets never shown.** After saving, secrets (Turnstile secret, channel credentials, API keys after creation) are masked or shown once. API keys: Settings > API keys shows the key once ("new-key") and never again.

**Z4 (P1) Stored XSS.** Contact name, ticket title, canned reply, agent name, workspace name and knowledge name containing `<img src=x onerror=alert(1)>` render as text everywhere (lists, drawers, toasts, the command palette).

**Z5 (P1) Session handling.** Sign out in one tab; the other tab's next action redirects to login without exposing data. Back button after logout does not show private pages.

**Z6 (P2) Privilege escalation.** As viewer/agent, try role-restricted routes directly; try the same action via buttons that should be hidden; expect refusal messages, not silent success.

---

## 16. Expected behaviour that looks odd (do not report as bugs)

- Nothing goes live until the agent is **published**. After onboarding the agent is a draft, and a visitor then sees the offline notice.
- The widget configuration is cached for up to **60 seconds**; visitor changes can lag after saving.
- The widget's "Answering agent" lists **published agents only**.
- "Skip setup for now" shows no toast; the Overview keeps offering to finish setup.
- Publish is disabled while the draft has unsaved changes; the Sandbox tests the **last saved draft**.
- The Free plan allows 1 agent, 1 widget, 2 team seats and 2 API keys; hitting them gives "Plan limit reached for ...".
- The final onboarding step shows plan-limit errors as an inline alert, not a dialog.
- The "New booking" button is disabled until a calendar is connected.
- Ask Lumi is locked on free and trial workspaces by design.
- A blocked visitor only sees "This conversation has ended." (no separate "you are blocked" text).
- With the mock AI the replies are echoes and knowledge is not used.
- Accepting an invitation does not sign you in automatically.
- The knowledge crawl is polite and slow: about half a second between pages, and it stops after about 4 minutes keeping what it read.
- The "Live widget" preview needs the dashboard origin in Allowed domains (localhost is allowed in development).
- Transactions, embeddings and a "Calendar" settings page no longer exist (replaced by Connectors; knowledge is skills, not embeddings).
- "Pages read" shows only the first 100 pages.

---

## 17. Reporting

Deliver two artifacts: a human-readable **report** and a machine-readable **findings.json**. Never include passwords, tokens or cookies.

### 17.1 Severity

| Level | Meaning | Examples |
|---|---|---|
| S1 Critical | Data exposure, security flaw, journey blocked for everyone, AI answers from a draft | Cross-workspace data visible; XSS executes; cannot register or publish |
| S2 Major | Core feature broken or wrong with no workaround | Visitor messages never reach the Inbox; publish fails; handoff never happens |
| S3 Moderate | Feature works with a workaround or is confusing | Widget needs a manual agent selection; unclear error; save needs a reload |
| S4 Minor | Cosmetic, copy, small inconsistency | Visible "Yulona"; typo; misaligned icon |

### 17.2 Report layout (Markdown)

1. **Run summary**: date, `RUN_ID`, environment URLs, AI mode, browser and viewport(s), build/version if visible, duration, tester.
2. **Verdict** in three lines: can a new customer get from sign-up to a working chat? what is the worst problem? what should be fixed first?
3. **Results table**: one row per test case: ID, title, result (PASS / FAIL / BLOCKED / SKIPPED), severity if failed, finding id, screenshot file.
4. **Findings** (most severe first), each using the template below.
5. **Coverage**: suites run, cases skipped and why, what was BLOCKED (with the missing prerequisite).
6. **Observations** that are not defects (usability friction, ideas), kept separate.
7. **Console and network log summary** (grouped).
8. **Environment notes**: rate limits hit, flaky behaviour, anything the operator should fix before the next run.

### 17.3 Finding template

```
ID: F-001
Title: <one line, what is wrong>
Severity: S2
Area: onboarding | agents | knowledge | widget settings | widget (visitor) | inbox | needs attention | contacts | billing | settings | cross-cutting
Test case: B2
Environment: <URL>, AI mode, browser, viewport, logged-in role
Steps to reproduce:
 1. ...
 2. ...
Expected: <quote the expected text from this guide where possible>
Actual: <what happened, exact message>
Reproducibility: always | 2 of 3 | once
Evidence: <screenshot file names>, console: <errors>, network: <METHOD /path -> status>
Impact: <who is affected and how>
Workaround: <if any>
Suspected cause (optional, clearly marked as a guess):
```

### 17.4 findings.json

```json
{
  "runId": "qa-20261103-1",
  "environment": { "dashboard": "", "api": "", "aiMode": "mock|real", "browser": "", "viewports": ["1280x800", "390x844"] },
  "summary": { "pass": 0, "fail": 0, "blocked": 0, "skipped": 0 },
  "results": [ { "id": "B1", "title": "", "result": "PASS|FAIL|BLOCKED|SKIPPED", "severity": null, "findingId": null, "evidence": [] } ],
  "findings": [ { "id": "F-001", "title": "", "severity": "S1|S2|S3|S4", "area": "", "testCase": "", "steps": [], "expected": "", "actual": "", "reproducibility": "", "evidence": [], "consoleErrors": [], "failedRequests": [], "impact": "", "workaround": "" } ],
  "blocked": [ { "id": "", "reason": "" } ]
}
```

### 17.5 Order of work

1. Read sections 1 to 4, confirm the prerequisites (section 2) with the operator.
2. Run the smoke path (section 5). If a GATE fails, report and stop.
3. Run suites in this order, keeping the same workspace: B (onboarding, using workspaces 2 and 3 for the resume/skip cases) -> C -> D (agents, knowledge) -> E (settings) -> F (visitor widget) -> G (inbox) -> H (copilot) -> X (cross-cutting, throughout) -> Z (isolation, last, with a second workspace). Do rotate-key (W11) and anything destructive last.
4. Write the report and `findings.json`. Include BLOCKED items so the operator knows what a human must still verify (real WhatsApp, Calendly/Google, payments).

---

## 18. UI reference (exact labels)

Strings are quoted from the code. Punctuation such as "…" is real. If the screen differs from this list, that is a finding (copy drift) unless the guide is obviously outdated: say which.

### 18.1 Auth
- **Register** `/register`: title "Create your workspace"; subtitle "Start answering customers with AI in minutes."; fields "Your name", "Workspace name", "Work email", "Password" (hint "At least 12 characters."); button "Create workspace" (busy "Creating"); link "Already have an account? Sign in". Errors: "Enter a valid email address.", "Use at least 12 characters.", "Enter your name.", "Name your workspace.", closed: "Sign-up is closed" / "This installation does not allow public registration." / "Ask your workspace administrator for an invitation, or sign in."; fallback "Something went wrong. Try again."
- **Login** `/login`: "Sign in" / "Welcome back to your workspace."; fields "Email", "Password"; button "Sign in" (busy "Signing in"); link "New here? Create a workspace"; errors "Enter a valid email address.", "Enter your password."
- **Accept invite** `/accept-invite?token=`: "Join your team", "Choose your name and a password to finish setting up your account."; "Create account"; success "You're in" / "Your account is ready." / "Taking you to sign in…"; errors in T2.

### 18.2 Onboarding `/onboarding`
Header "Set up Lumi" + "Skip setup for now". Progress "Step N of 11". Buttons "Back", "Continue", "Skip this step", last "Create my setup" (busy "Setting up"), note "Lumi may use one short AI call to polish the wording. It never publishes anything and costs you no credits."
1. "What kind of business is it?" cards: Restaurant or cafe, Clinic or health service, Shop or online store, Real estate, School or training, Hotel or travel, Professional services, Something else.
2. "What is your business called?" (placeholder "Sunrise Dental").
3. "What do you want Lumi to help with?" chips: "Answer customer questions", "Capture leads", "Take bookings", "Something else" (choose up to 4).
4. "Where do your customers talk to you?" chips: Website chat, WhatsApp, Messenger, Instagram, Telegram, Slack.
5. "How should Lumi sound?" cards: Friendly, Professional, "Short and direct".
6. "Which languages do your customers write in?" chips: English, Amharic, Arabic, French, Spanish, Portuguese, Swahili.
7. "When is your team available?" cards "No fixed hours" / "Set opening hours" (per-day "<Day> opens", "<Day> closes", "Closed").
8. "Do you have a website Lumi can learn from?" (placeholder https://example.com).
9. "Pick your brand colour": swatches, "Or type a colour" (placeholder #2563EB), "Logo link (optional)", preview bubble "Hi! How can I help?".
10. "When should customers reach a person?" cards: "When the AI is not sure", "Always offer a person", "Only in business hours".
11. "Here is what Lumi will set up" ("Nothing goes live until you publish. You can change everything afterwards."), list "What will be created".
Success toast: "Your starter setup is ready. Try it, then publish."

### 18.3 Overview `/overview`
"Hello, <first name>"; setup card "Set up your workspace" with "N of 4 done"; items listed in C1; "Try it now"; "Tell Lumi your goal" with "Answer questions" / "Capture leads" / "Take bookings" / "Set up with Lumi"; blocks "Customer questions", "Leads", "Bookings"; right column "AI credits" (link "View usage"), "Right now" ("AI is handling", "Waiting for a person", "No one is waiting."), "Needs you", "Activity" ("7 days"/"30 days"). Alerts: "You have used N% of your AI credits", "AI replies are paused", banner "AI replies are paused until you add credits".

### 18.4 Agents
List: "Agents"; buttons "Create with AI", "New agent"; empty "No agents yet" / "Create your first agent, add knowledge, then test it in the sandbox before publishing."; card text "Live on version N" or "Never published". New agent modal "New agent": "Name", "Description", "Cancel", "Create"; toast "Created <name>".
Editor tabs (list aria-label "Agent sections"): Persona, Knowledge, Escalation, Tools, Versions, Sandbox.
Persona: Name, Description, "Persona and instructions (system prompt)" (n/8000), Greeting, "Clarifying reply", "Handoff message", "Fallback message"; side panel "Prompt helper" (Tone, Languages, Goals, "Append to prompt", toast "Added to the prompt").
Escalation: "Words that call a person", "Hand off after unanswered questions", "Resume keyword", switch "Hand off qualified leads"; Safety: "Block abusive visitors", "Strikes before blocking", "Messages per minute", "Blocked phrases", "Farewell message".
Bar: "All changes saved" (or with "Live: vN"), "Save draft", "Publish", "Discard changes". Toasts "Draft saved", "Published", "Rolled back to version N", "Archived", "Unarchived". Archive: "Archive agent" / "Archive this agent?", "Unarchive agent".
Sandbox: "Test conversation", "Nothing is saved or sent to customers.", select "Stage", input "Message" ("Type a customer message"), "Send", "Reset conversation", "Thinking…", panel "What the agent read" with "Grounded" / "Not found in knowledge", "Skill sections (N)", "Tools runs", "Tokens".
Create with AI `/agents/new-ai`: "Create with AI", input "Your answer" ("Type your answer"), "Send", "Quick replies", "Create draft", toast "Draft created: <name>".

### 18.5 Knowledge `/knowledge`
Buttons "Upload file", "Add URL", "Add text"; empty "No knowledge yet". Dialogs "Upload a file", "Add a web page", "Add text". URL dialog: "URL", "Follow links on this site", "How deep" ("Go less deep"/"Go deeper"), "Max pages", "Include subdomains", submit "Add", toast "Added. Reading it now."; file toast "Uploaded. Reading it now."; select "Available to" ("All agents"). Status: pending, processing…, ready, failed; texts in K1/K3. Row: "Sections", menu "Actions for <name>" (Sections / Reingest / Delete), "Edit <name>", "Save skill", "Use automatic description". Toasts "Reingesting <name>", "Deleted <name>", "Skill saved".

### 18.6 Website widget `/settings/widget`
Page "Website widget"; "Create widget"; sections Branding ("Widget name (internal)", Title, Subtitle, "Launcher label", Theme "Match visitor"/Light/Dark, Position "Bottom right"/"Bottom left", "Input placeholder", "Welcome message"); Appearance ("Colour style" "One colour"/"Two colours", "Brand colour", "Start colour", "End colour", "Ready-made blends", "Direction", "Upload a picture"/"Change picture", "Remove", crop "Use this picture"/"Cancel", Advanced "Picture web address"); Behaviour ("Answering agent", "Widget enabled"); "Allowed domains" ("Add your website", "Add"); "Advanced protection" ("Honeypot field", "Cloudflare Turnstile", "Site key", "Secret key", "Remove stored secret"); "Ask visitors for details before chatting" + "Intro text" + Name/Email/Phone with "required"; right rail "Draft preview", "Embed code" ("Copy snippet", "Rotate key"), "Live widget". Bar "Discard"/"Save changes"; toasts "Widget saved", "Snippet copied", "Picture saved", "Picture removed", "Key rotated. Update the snippet on your site."

### 18.7 Visitor widget
Launcher "Open chat"/"Close chat" (or the launcher label); dialog (name = widget title, default "Chat"); input "Message" (placeholder "Type a message…"); "Send message"; typing "Assistant is typing"; "Team member" tag; statuses "Offline", "Reconnecting…", "Loading…", "We couldn't load the chat." + "Try again", "This conversation has ended.", "Please confirm you are human to start the chat.", "The check could not load.", pre-chat default intro "Tell us a little about you so we can help." with "Start chat", errors "This field is required" and "Enter a valid email address"; offline banner "This assistant is offline right now. Leave a message and a team member will reply."; connectivity "You're offline. Messages will send when you reconnect.", "Sending…", "Not delivered. Retry".
Default AI texts: fallback "I'm not sure about that. Let me connect you with a teammate who can help."; clarify "I couldn't find that in the information I have. Could you rephrase it or share a bit more detail? If you'd rather talk to a person, just say so."; handoff "Thanks! I'm handing you over to a teammate who will be with you shortly."

### 18.8 Inbox, Needs attention, Contacts, Tickets, Bookings
- **Inbox**: "Inbox", "Live"/"Offline"/"Reconnecting"; search "Search name, email or message"; "Filters" sheet "Filter conversations" (Status: Open/Needs attention/Resolved; "Handled by": AI/Human; Channel; Assignee: Anyone/Assigned to me/Unassigned); "Reset", "Clear all"; empty "No matches", "No conversations yet", "Load more". Conversation: "Take over", "Return to AI"/"Hand back to AI", "Resolve"/"Reopen"; "Assignee"; "Send as" ("Reply to customer"/"Internal note"); "Canned responses"; "Send"/"Add note"; banner "The AI has stopped and needs a person. Reply or take over to continue." Contact panel "Contact details": "Block contact", "Unblock", "Blocked for abuse". Toasts: "You took over", "Returned to the AI", "Resolved", "Reopened", "Contact blocked", "Contact unblocked".
- **Needs attention** `/attention`: type chips "Uncertain", "Lead ready", "System failure", "Blocked for abuse"; tabs Active, Waiting, Claimed, Resolved; "Claim", "Resolve", "Release", "Assign", "Open conversation", "Out of hours"; empty "Queue is clear".
- **Contacts** `/contacts`: "New contact", search "Search name, email or phone"; empty "No contacts yet"; "Merge duplicate"; toasts "Contact created", "Contact saved".
- **Tickets** `/tickets`: views Board/List/Table; "New ticket"; statuses Open, In progress, Waiting, Resolved, Closed; toasts "Ticket created", "Comment added".
- **Bookings** `/bookings`: "New booking", "Calendars", "Manage in Connectors"; empty "No bookings yet"; toasts "Booking created", "Booking cancelled".

### 18.9 Ask Lumi
Button "Ask Lumi"; title "Ask Lumi"; description "Tell Lumi what to change in your workspace. Lumi never publishes without your confirmation."; locked "Ask Lumi is included in paid plans" + "See plans"; welcome "Hi, I'm Lumi. I can update your agent, the look of your chat window, your business hours, goals and the website I learn from. What would you like to do?"; input "Message to Lumi" ("For example: make my greeting friendlier"); "Lumi is working"; confirm group "Confirmation needed" with "Confirm"/"Not now"; limit message "You have used this month's Ask Lumi allowance. It resets next month; chat with your customers is not affected."

### 18.10 Settings
Navigation group "Settings": Website widget, Team, API keys, Webhooks, Billing, Usage, Connectors, Connections, "Business hours", Account, plus "Canned responses", Tags, "Audit log", "Data and privacy" inside Settings. Business hours page: sections "Team availability", "Business hours and routing", "Time zone", "Weekly windows" ("Weekdays 9 to 5", "<Day> open", "Add window", "Copy"), cards "AI only"/"AI sends a message"/"Flag in the queue", "Out-of-hours message", "Handoff assignment" ("Manual claim"/"Least busy online agent"), "Holidays"; bar "Discard"/"Save settings", toast "Settings saved". Team: "Invite member", "Send invite", "Invitations" ("Revoke"), role hints "Everything, including billing" / "Manages settings and agents" / "Works the inbox" / "Read only". Usage: "This month", "Monthly allowance", "Used this month", "Top-up balance", "Buy credits", "Export CSV". Billing: "Current plan", "Upgrade to <Plan>", "Manage payment", "Cancel plan", "Payments are not configured on this installation." Account: "Workspace name", "Save changes", toast "Workspace renamed". Connectors: "Calendar" (Google Calendar, Calendly) and "CRM" (HubSpot).

### 18.11 Roles
| Item | viewer | agent | admin | owner |
|---|---|---|---|---|
| Overview, Inbox, Contacts, Tickets, Bookings, Settings pages (read) | yes | yes | yes | yes |
| Needs attention, Knowledge | no | yes | yes | yes |
| Agents, Channels, Billing, publish, widget save | no | no | yes | yes |
| Block contact | no | yes | yes | yes |
| Unblock contact | no | no | yes | yes |
| Change the plan | no | no | no | yes |
| Ask Lumi | no | no | yes | yes |

(If the product differs from this table, report it with the role and the page.)

### 18.12 Automation hooks
`data-testid` values that exist: `setup-prompt`, `setup-checklist`, `try-then-publish`, `no-goal`, `right-now`, `credits-card`, `credits-hero`, `kpi-resolved`, `kpi-handoffs`, `kpi-response`, `kpi-qualified`, `kpi-upcoming`, `kpi-booked`, `kpi-cancelled`, `block-support`, `block-leads`, `block-bookings`, `hubspot-status`, `calendar-status`, `copilot-locked`, `copilot-remaining`, `copilot-allowance`, `confirm-card`, `messages-left`, `plan-allowance`, `new-key`, `typing`, `preview-body`, `preview-url`, `calendly-redirect-url`. Everything else: find by role + accessible name (for example the radiogroup "Send as", tablist "Agent sections", log "Conversation", buttons "Send", "Send message", "Close chat", "Filters", "Reset conversation").
