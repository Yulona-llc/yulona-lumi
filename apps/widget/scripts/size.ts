import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

const buf = readFileSync(new URL("../dist/widget.js", import.meta.url));
const gz = gzipSync(buf, { level: 9 }).length;
const LIMIT = 40 * 1024;
console.log(`widget.js: ${(buf.length / 1024).toFixed(1)} kB raw, ${(gz / 1024).toFixed(1)} kB gzip (budget 40 kB)`);
if (gz > LIMIT) {
  console.error("Bundle exceeds 40 kB gzip budget");
  process.exit(1);
}
