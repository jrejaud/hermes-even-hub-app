#!/usr/bin/env node
/**
 * Assert that the built bundle carries exactly the credentials it is supposed to
 * — no more, no fewer.
 *
 * Usage: check-no-secrets.mjs [beta|release]
 *
 *   release  (default)  NOTHING from any env file may appear in dist/.
 *   beta                the pair from `.env.beta.local` is EXPECTED (a
 *                       testing-group build the wearer installs and just runs);
 *                       anything else from any other env file is still a leak.
 *
 * Why this is not paranoia: `.env.local` is loaded by Vite in EVERY mode,
 * including `vite build`, and `import.meta.env.VITE_*` is statically replaced
 * with the literal value — so the bridge token was sitting in `dist/` and inside
 * the packed `.ehpk` even though a runtime `import.meta.env.DEV` guard stopped
 * the app from USING it (found 2026-09-04, by checking a claim that it was
 * clean). Anyone with an `.ehpk` can extract what is inside it.
 *
 * Baking a token into a beta build is acceptable ONLY while the bridge is behind
 * `tailscale serve` with no funnel — unreachable from the public internet, so
 * the token is useless to anyone not already on the tailnet. Expose the bridge
 * publicly and this whole mode should go away.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MODE = (process.argv[2] ?? "release").toLowerCase();
if (!["beta", "release"].includes(MODE)) {
  console.error(`check-no-secrets: unknown mode "${MODE}" — want beta or release`);
  process.exit(1);
}

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
/** Files whose values must NEVER appear in a build, in any mode. */
const FORBIDDEN_FILES = [".env", ".env.local", ".env.development", ".env.development.local"];
/** Baked deliberately, and only in beta. */
const BETA_FILE = ".env.beta.local";

/** Values short enough to appear by coincidence are not evidence of a leak. */
const MIN_SECRET_LENGTH = 12;

function valuesIn(name) {
  const path = join(ROOT, name);
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    const [, key, value] = m;
    if (value.length >= MIN_SECRET_LENGTH) out.push({ file: name, key, value });
  }
  return out;
}

function bundleFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...bundleFiles(path));
    else out.push(path);
  }
  return out;
}

if (!existsSync(DIST)) {
  console.error("check-no-secrets: no dist/ — run the build first");
  process.exit(1);
}

const expected = MODE === "beta" ? valuesIn(BETA_FILE) : [];
const forbidden = FORBIDDEN_FILES.flatMap(valuesIn)
  // A value that is ALSO the intended beta value is not a leak — the same URL
  // legitimately appears in both files.
  .filter((f) => !expected.some((e) => e.value === f.value));

const files = bundleFiles(DIST);
const contents = files.map((f) => ({ file: f.replace(ROOT, ""), text: readFileSync(f) }));

const leaks = [];
for (const c of contents) {
  for (const v of forbidden) {
    if (c.text.includes(v.value)) leaks.push({ ...v, bundle: c.file });
  }
}

if (leaks.length) {
  console.error(`check-no-secrets (${MODE}): CREDENTIALS ARE IN THE BUNDLE THAT SHOULD NOT BE\n`);
  for (const l of leaks) console.error(`  ${l.key} (from ${l.file}) is inlined in ${l.bundle}`);
  console.error(
    "\nVite inlines import.meta.env.VITE_* as literals, and .env / .env.local are\n" +
      "loaded in EVERY mode. Dev-only values belong in .env.development.local and\n" +
      "beta values in .env.beta.local, so a production build never sees either.\n" +
      "A runtime DEV guard is NOT enough — it stops the value being used, not shipped.",
  );
  process.exit(1);
}

// In beta, the point is that the credentials ARE there. Silence would mean the
// wearer installs a build that boots straight to the setup screen.
if (MODE === "beta") {
  if (!expected.length) {
    console.error(`check-no-secrets (beta): ${BETA_FILE} has no values — a beta build must carry the bridge profile`);
    process.exit(1);
  }
  const missing = expected.filter((e) => !contents.some((c) => c.text.includes(e.value)));
  if (missing.length) {
    console.error(`check-no-secrets (beta): expected value(s) NOT baked into the build: ${missing.map((m) => m.key).join(", ")}`);
    console.error(`  Build with \`vite build --mode beta\` or ${BETA_FILE} is not loaded.`);
    process.exit(1);
  }
  console.log(`check-no-secrets (beta): baked in ${expected.map((e) => e.key).join(", ")} — intended, tailnet-only bridge`);
  console.log(`  no other env value leaked (${forbidden.length} checked across ${files.length} bundle file(s))`);
} else {
  console.log(`check-no-secrets (release): clean — ${forbidden.length} value(s) absent from ${files.length} bundle file(s)`);
}
