#!/usr/bin/env node
/**
 * Capture every screen the app can show, one PNG per state, into `docs/ui/`.
 *
 * A glasses UI is only checkable by LOOKING at it, and most states are awkward
 * to reach against a live backend — recording needs a mic, an unanswered
 * permission needs a blocked agent. So the app renders a fixed gallery
 * (`src/dev/gallery.ts`, gated on `VITE_UI_GALLERY=1`) and this walks it.
 *
 *   VITE_UI_GALLERY=1 npm run dev          # in one terminal
 *   npm run sim                            # in another
 *   node scripts/ui-gallery.mjs            # then this
 *
 * Every capture is followed by a real look at the PNG. This script only makes
 * that cheap; it does not replace it — it cannot tell you a header is sitting on
 * top of the connection dot, which is exactly the bug that motivated it.
 */

import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.EVEN_SIM_BASE ?? "http://127.0.0.1:9898";
const OUT = join(import.meta.dirname, "..", "docs", "ui");
const READY = "[glasses] ready";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  const text = await res.text();
  return text === "pong" ? "pong" : JSON.parse(text);
}

async function bytes(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function click() {
  // The Content-Type header is REQUIRED — without it /api/input 415s, and with
  // output discarded that looks exactly like a gesture that was delivered.
  const res = await fetch(`${BASE}/api/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "click" }),
  });
  if (!res.ok) throw new Error(`/api/input -> ${res.status}`);
}

/** Read the app's own console for the gallery's frame lines. */
async function frameLines(sinceId = 0) {
  const data = await json(`/api/console?since_id=${sinceId}`);
  const out = [];
  let last = sinceId;
  for (const e of data.entries ?? []) {
    last = Math.max(last, e.id);
    const m = /\[gallery\] (\d+)\/(\d+) (\S+) — (.*)$/.exec(e.message ?? "");
    if (m) out.push({ index: Number(m[1]), total: Number(m[2]), name: m[3], looking_for: m[4] });
  }
  return { frames: out, last };
}

async function waitForReady(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let since = 0;
  while (Date.now() < deadline) {
    const data = await json(`/api/console?since_id=${since}`);
    for (const e of data.entries ?? []) {
      since = Math.max(since, e.id);
      if ((e.message ?? "").includes(READY)) return;
    }
    await sleep(250);
  }
  throw new Error(`app never logged "${READY}" — is the dev server running with VITE_UI_GALLERY=1?`);
}

await json("/api/ping");
await waitForReady();

const first = await frameLines();
if (!first.frames.length) {
  console.error(
    "No [gallery] lines in the app console — the app is running WITHOUT the gallery.\n" +
      "Start the dev server as: VITE_UI_GALLERY=1 npm run dev",
  );
  process.exit(1);
}

const total = first.frames[0].total;
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (f.endsWith(".png")) unlinkSync(join(OUT, f));

let seen = first.frames[first.frames.length - 1];
let cursor = first.last;
const captured = [];

for (let n = 0; n < total; n++) {
  // Let the render settle: a rebuild plus four textContainerUpgrade calls are
  // several async round-trips, and screenshotting early captures the PREVIOUS
  // frame — indistinguishable from a state that renders identically.
  await sleep(900);
  const png = await bytes("/api/screenshot/glasses");
  const path = join(OUT, `${seen.name}.png`);
  writeFileSync(path, png);
  captured.push({ ...seen, path, size: png.byteLength });
  console.log(`${String(n + 1).padStart(2)}/${total}  ${seen.name.padEnd(28)} ${String(png.byteLength).padStart(6)}B  ${seen.looking_for}`);

  if (n === total - 1) break;
  await click();
  await sleep(400);
  const next = await frameLines(cursor);
  cursor = next.last;
  if (next.frames.length) seen = next.frames[next.frames.length - 1];
}

// Two identical PNGs mean a frame did not actually change — a render that
// silently failed looks exactly like a state that renders the same.
const bySize = new Map();
for (const c of captured) {
  const k = String(c.size);
  bySize.set(k, [...(bySize.get(k) ?? []), c.name]);
}
const suspicious = [...bySize.values()].filter((names) => names.length > 1);
if (suspicious.length) {
  console.log(`\n⚠ identical byte-size groups — check these actually differ:`);
  for (const names of suspicious) console.log(`   ${names.join("  ==  ")}`);
}

console.log(`\n${captured.length} frame(s) → ${OUT}`);
console.log("Now LOOK at every one of them. This script cannot see a header sitting on the dot.");
