// Writes the platform-admin OpenAPI document to docs/admin-openapi.json (separate from the customer spec).
// Usage: bun scripts/export-openapi.ts [outfile] [serverUrl]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildAdminOpenApi } from "../src/openapi";

const out = resolve(process.argv[2] ?? resolve(import.meta.dir, "../../../docs/admin-openapi.json"));
const doc = buildAdminOpenApi();
if (process.argv[3]) doc.servers = [{ url: process.argv[3] }];
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
const ops = Object.values(doc.paths).reduce((n, p) => n + Object.keys(p).length, 0);
console.log(`wrote ${out} (${Object.keys(doc.paths).length} paths, ${ops} operations)`);
