#!/usr/bin/env node
// Fail when a built bundle carries a tailnet hostname or 100.64/10 address (SC-9500: public fork; an
// .ehpk is uploaded to Even's portal). Usage: node scripts/check-no-tailnet.mjs <dir>
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TAILNET = /[a-z0-9-]+\.tail[0-9a-f]+\.ts\.net|\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+\b/;
const walk = (d) =>
  readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const dir = process.argv[2] ?? 'dist';
const hits = walk(dir).flatMap((f) => {
  const m = readFileSync(f, 'utf8').match(TAILNET);
  return m ? [`${f}: ${m[0]}`] : [];
});
if (hits.length) {
  console.error(`check-no-tailnet: ${hits.length} file(s) carry a tailnet address:\n  ${hits.join('\n  ')}`);
  process.exit(1);
}
console.log(`check-no-tailnet: clean (${dir})`);
