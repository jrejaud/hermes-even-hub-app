#!/usr/bin/env node
/**
 * Keep the vendored gateway contract identical to Aristo's (SC-9500).
 *
 *   node scripts/contract.mjs check   exit 1 when src/gateway/glasses.ts drifted from aristo-v2
 *   node scripts/contract.mjs sync    re-copy it
 *
 * Source: $ARISTO_GLASSES_TS, else ~/Development/aristo-v2/packages/shared/glasses.ts.
 * The source repo is private and absent on CI, so a missing source is a skip (exit 0), never a pass claim.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const here = join(import.meta.dirname, '..', 'src', 'gateway', 'glasses.ts');
const src = process.env.ARISTO_GLASSES_TS ?? join(homedir(), 'Development/aristo-v2/packages/shared/glasses.ts');
const IMPORT_FROM = 'import type { AnswerArgs, Priority, SessionStatus } from "./protocol.js";';
const IMPORT_TO = 'import type { AnswerArgs, Priority, SessionStatus } from "./aristo-types";';
const BEGIN = '// ---- BEGIN VENDORED ----\n';
const END = '// ---- END VENDORED ----';

const mode = process.argv[2];
if (mode !== 'check' && mode !== 'sync') {
  console.error('usage: contract.mjs check|sync');
  process.exit(2);
}
if (!existsSync(src)) {
  console.log(`contract: SKIP — no source at ${src}`);
  process.exit(0);
}
const upstream = readFileSync(src, 'utf8').replace(IMPORT_FROM, IMPORT_TO);
const local = readFileSync(here, 'utf8');
const head = local.slice(0, local.indexOf(BEGIN) + BEGIN.length);
const body = local.slice(head.length, local.indexOf(END));
if (mode === 'sync') {
  writeFileSync(here, head + upstream + END + '\n');
  console.log(`contract: synced from ${src}`);
} else if (body === upstream) {
  console.log(`contract: OK (identical to ${src})`);
} else {
  console.error(`contract: DRIFT — src/gateway/glasses.ts differs from ${src}; run npm run contract:sync`);
  process.exit(1);
}
