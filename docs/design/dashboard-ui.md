# Dashboard UI system (read before touching `apps/dashboard`)

Brand source: yulona.co. **Ember** `#f97316` (action, active, focus), **Midnight** `#0f1a2f` (sidebar, ink), **Mist** `#aebcd0` (quiet text on navy), WhatsApp green `#25d366` only for "live/online/delivered". Logo = the Lumi drop + thin wordmark (`src/components/Logo.tsx`, assets in `public/brand/`).

## Stack
React 19, Tailwind v4 (`src/styles.css` holds every token), shadcn/ui components in `src/components/ui/*` (Radix + cva + `cn()` from `@/lib/utils`), `lucide-react` icons, `motion` (`motion/react`) for animation, `sonner` toasts, `cmdk`. Path alias `@/` = `src/`.

## Tokens (use these, never raw hex)
`bg-background` page, `bg-card` surfaces, `bg-muted` quiet fills, `text-foreground`, `text-muted-foreground`, `border` / `border-border`, `bg-primary text-primary-foreground` (ember, navy text: AA), `bg-accent text-accent-foreground` (ember tint), `text-destructive`, `text-success`, `text-warning`, `text-info`, `bg-sidebar*` (navy surfaces). Legacy names (`ink`, `ink-2`, `paper`, `line`, `brand`, `signal`, `danger`) still resolve but are **deprecated: replace them** in the files you own. Light and dark are both required (`.dark` class); because tokens are CSS variables, semantic classes work in both. Charts: `--chart-1..5` (`var(--chart-1)`), ember first.

## Type
`font-display` (Space Grotesk) for page titles, card titles, big numbers; Inter for UI/body; `font-mono` (JetBrains Mono) for ids, keys, URLs, code. Sentence case everywhere. Numbers: `tabular-nums`.

## Components
- `@/components/ui/*`: button (variants default/secondary/outline/ghost/destructive/link/dark; sizes default/sm/lg/icon/icon-sm), input, textarea, label, select (Radix), checkbox, switch, tabs, dialog, sheet, dropdown-menu, popover, tooltip, command, table, badge (default/secondary/outline/success/warning/destructive/info), card, alert, progress, skeleton, avatar, separator, scroll-area, sonner (`toast`).
- `features/common/ui.tsx` keeps the old API on top of them: `PageHeader`, `Card`, `Badge` (color prop), `TextField`/`TextArea`/`Select` (native select, best on phones)/`Check`, `Modal`/`ConfirmModal` (dialog on desktop, bottom sheet on phones), `Empty`, `ErrorState`, `Loading` (skeletons), `RoleNotice`, `Stat` (count-up number tile), `useRole`. Prefer the shadcn primitives directly for new UI; keep these wrappers where pages already use them.
- `components/motion.tsx`: `PageTransition` (already applied by the Shell), `Stagger`/`StaggerItem`, `AnimatedNumber`, re-exported `motion`. `MotionConfig reducedMotion="user"` is global.
- Legacy CSS classes `.btn`, `.btn-ghost`, `.field` still work but replace them with `<Button>` / `<Input>` in the files you own.

## Rules
1. **Mobile first.** Design at 390px, then enhance at `sm`/`md`/`lg`. 44px touch targets on phones (components already do this), no horizontal page scroll, tables become stacked cards or scroll inside their own container with a sticky first column, filters collapse into a Sheet/Popover, primary action reachable by thumb. The Shell already adds the bottom tab bar (`pb-24`) and safe-area padding.
2. **Motion answers actions.** Skeletons while loading (never a lone spinner for lists), `AnimatePresence` for items added/removed, `layout` for reordering (kanban, lists), one staggered entrance per page at most, toasts for results (`toast.success("Published")`, `toast.error(...)`: use the same verb as the button). No decorative loops. Everything must be fine with `prefers-reduced-motion`.
3. **Spend boldness once per area.** Each area has one memorable element; everything around it stays calm and consistent. Avoid the tells: identical rounded cards everywhere, ALL-CAPS eyebrows, "01/02/03" numbering on non-sequences, gradient washes as decoration, `→` on every link.
4. **Words are design.** Sentence case, active verbs ("Save changes", "Invite member"), errors say what happened and how to fix it, empty states invite an action. Keep an action's name identical across button, dialog and toast.
5. **Accessibility floor.** Visible focus (provided), labels on every control, `aria-live` for async results, contrast AA in light and dark, keyboard operable (drag and drop needs a keyboard alternative).
6. **Do not change behaviour.** Keep API calls, query keys, route paths and role gating. Update unit tests only when visible text/roles you changed are asserted; keep them green.

## QA harness
- Dashboard dev server: `http://localhost:5199` (already running; if it is not: `cd apps/dashboard && bunx vite --port 5199`). Do not touch the user's servers on 5176 / 3000.
- QA API on `http://localhost:3099` against database `yulona_qa` (a copy of the dev DB: **safe to mutate/seed**; never touch database `yulona`). Login: `kaleab@yulona.co` / `qa-password-123`. If the API is down: `cd apps/api && QA_URL=$(grep -E "^DATABASE_URL=" ../../.env | cut -d= -f2- | sed 's#/yulona$#/yulona_qa#') && DATABASE_URL="$QA_URL" PORT=3099 CORS_ORIGINS=http://localhost:5199 AI_PROVIDER=mock AI_API_KEY= nohup bun --env-file=../../.env src/index.ts &`.
- Screenshots: `OUT=<dir> JOBS='[{"name":"x","path":"/knowledge","w":390,"h":844,"auth":true,"dark":false,"wait":1500,"full":false,"actions":[{"click":"button:has-text(\"Add URL\")","wait":600}]}]' node <scratchpad>/shot.mjs` (script path is in your brief), then open the PNG with the Read tool. Check 390x844, 768x1024 and 1280x800, light and dark. Seed realistic rows into `yulona_qa` with SQL (owner `postgres://yulona_owner:yulona_owner@localhost:5433/yulona_qa`) when your pages are empty.
- Checks before you finish: `cd apps/dashboard && bun run typecheck && bunx vitest run <your test files>`; `bun run build` must pass.
