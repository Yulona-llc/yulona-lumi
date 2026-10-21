#!/usr/bin/env bun
/**
 * yulona-license verify <token|file> --pub <public.pem>      verify a license JWT offline
 * yulona-license manifest <manifest.json> --pub <public.pem> verify a signed update manifest
 * Exit code 0 = valid, 1 = invalid. The public key may also come from LICENSE_PUBLIC_KEY(_FILE).
 */
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { publicKeyFromEnv, verifyLicense, verifyManifest } from "./index";

const { positionals, values } = parseArgs({ allowPositionals: true, options: { pub: { type: "string" } } });
const [cmd, input] = positionals;
const pub = values.pub ? readFileSync(values.pub, "utf8") : publicKeyFromEnv();
if (!cmd || !input || !pub) {
  console.error("usage: yulona-license <verify|manifest> <token|file> --pub public.pem");
  process.exit(2);
}
const raw = existsSync(input) ? readFileSync(input, "utf8") : input;
if (cmd === "verify") {
  const r = verifyLicense(raw, pub);
  if (!r.ok) { console.error(`INVALID: ${r.reason}`); process.exit(1); }
  const { customer, seats, features, exp } = r.claims;
  console.log(`VALID  customer=${customer} seats=${seats} features=${features.join(",") || "-"} expires=${new Date(exp * 1000).toISOString()}`);
} else if (cmd === "manifest") {
  const r = verifyManifest(JSON.parse(raw), pub);
  if (!r.ok) { console.error(`INVALID: ${r.reason}`); process.exit(1); }
  console.log(`VALID  version=${r.payload.version} released=${r.payload.releasedAt}`);
} else { console.error(`unknown command ${cmd}`); process.exit(2); }
