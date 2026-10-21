// Writes the OpenAPI 3.0 document to docs/openapi.json (Postman / Insomnia / codegen import).
// Usage: bun run openapi:export [outfile] [serverUrl]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildOpenApi } from "../src/openapi";

const out = resolve(process.argv[2] ?? resolve(import.meta.dir, "../../../docs/openapi.json"));
const server = process.argv[3] ?? process.env.PUBLIC_API_URL ?? "http://localhost:3000";
const doc = buildOpenApi();
(doc as { servers: unknown }).servers = [{ url: server }];
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
const ops = Object.values(doc.paths as Record<string, object>).reduce((n, p) => n + Object.keys(p).length, 0);
console.log(`wrote ${out} (${Object.keys(doc.paths).length} paths, ${ops} operations)`);
