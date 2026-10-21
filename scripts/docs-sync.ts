// Copies the generated OpenAPI spec into the Mintlify folder so the API reference never drifts.
//   bun run docs:sync   (also runs before `mint dev` / `mint validate`)
// Regenerate the spec first when routes change: `cd apps/api && bun scripts/export-openapi.ts`.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const from = resolve(root, "docs/openapi.json");
const to = resolve(root, "apps/docs/api-reference/openapi.json");
if (!existsSync(from)) {
  console.error("docs/openapi.json is missing. Run: cd apps/api && bun scripts/export-openapi.ts");
  process.exit(1);
}
mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`synced ${from} -> ${to}`);
