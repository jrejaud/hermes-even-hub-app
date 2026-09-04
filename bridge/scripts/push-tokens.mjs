#!/usr/bin/env node
/**
 * Resolve the bridge's tokens HERE and write them to a remote host's env file.
 *
 * Why this exists: the bridge normally resolves `tokenOp` references through
 * the 1Password CLI in its own process, so no secret ever lands on disk. That
 * needs a working `op` on the host running the bridge. When it does not have one
 * — Chiba's service-account token is currently dead — the tokens have to be
 * materialised, and this is the safe way to do it:
 *
 *   - values are resolved on THIS machine, where `op` works
 *   - they travel over ssh STDIN, never on a command line, so they cannot land
 *     in shell history, a permission prompt, or a transcript
 *   - the remote file is written 0600
 *
 * Usage:
 *   node scripts/push-tokens.mjs <ssh-host> [remote-path]
 *
 * Reads the same `hosts.json` and `.env` the bridge does, so the set of tokens
 * it pushes cannot drift from the set the bridge needs.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readOp } from "../hosts.mjs";

const HOST = process.argv[2];
const REMOTE = process.argv[3] ?? "~/Development/claude-code-g2-hub/bridge/.env.tokens";
if (!HOST) {
  console.error("usage: push-tokens.mjs <ssh-host> [remote-path]");
  process.exit(1);
}

const ROOT = new URL("..", import.meta.url).pathname;

function envValue(key) {
  const path = join(ROOT, ".env");
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`));
    if (m) return m[1];
  }
  return undefined;
}

const lines = [];

// The bridge's own token, which the phone types in.
const bridgeRef = envValue("BRIDGE_TOKEN_OP");
if (bridgeRef) lines.push(`BRIDGE_TOKEN=${readOp(bridgeRef)}`);

// One per host, named the way hosts.mjs looks them up.
const hosts = JSON.parse(readFileSync(join(ROOT, "hosts.json"), "utf8")).hosts ?? [];
for (const h of hosts) {
  if (!h.tokenOp) continue;
  lines.push(`EVEN_TERMINAL_TOKEN_${h.key.toUpperCase()}=${readOp(h.tokenOp)}`);
}

if (!lines.length) {
  console.error("push-tokens: nothing to push — no tokenOp refs found");
  process.exit(1);
}

// `cat > file` reading STDIN: the values never appear as arguments anywhere.
const r = spawnSync(
  "ssh",
  [HOST, `umask 077 && mkdir -p "$(dirname ${REMOTE})" && cat > ${REMOTE} && chmod 600 ${REMOTE} && wc -l < ${REMOTE}`],
  { input: lines.join("\n") + "\n", encoding: "utf8" },
);

if (r.status !== 0) {
  console.error(`push-tokens: ssh failed: ${(r.stderr || "").trim()}`);
  process.exit(1);
}
console.log(`push-tokens: wrote ${lines.length} token(s) to ${HOST}:${REMOTE} (${r.stdout.trim()} lines, mode 600)`);
console.log(`  keys: ${lines.map((l) => l.split("=")[0]).join(", ")}`);
