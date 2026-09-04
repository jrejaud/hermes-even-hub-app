#!/usr/bin/env node
/**
 * Fail the build if a dev credential got inlined into the production bundle.
 *
 * This is not hypothetical. `.env.local` is loaded by Vite in EVERY mode,
 * including `vite build`, and `import.meta.env.VITE_*` is statically replaced
 * with the literal value — so the bridge token was sitting in `dist/` and inside
 * the packed `.ehpk`, even though a runtime `import.meta.env.DEV` guard stopped
 * the app from USING it (found 2026-09-04, by checking a claim that it was
 * clean). Anyone with an `.ehpk` can extract what is inside it.
 *
 * The fix was to move dev defaults to `.env.development.local`, which Vite loads
 * only when mode=development. This check is what stops that regressing quietly:
 * it reads whatever dev env files exist and asserts none of their values appear
 * in the build output.
 *
 * Runs as part of `npm run pack`, so a package that would leak cannot be built.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const ENV_FILES = [".env.local", ".env.development.local", ".env.development", ".env"];

/** Values short enough to appear by coincidence are not evidence of a leak. */
const MIN_SECRET_LENGTH = 12;

function devValues() {
  const found = [];
  for (const name of ENV_FILES) {
    const path = join(ROOT, name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      const [, key, value] = m;
      if (value.length >= MIN_SECRET_LENGTH) found.push({ file: name, key, value });
    }
  }
  return found;
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

const values = devValues();
if (!values.length) {
  console.log("check-no-secrets: no dev env values to check for");
  process.exit(0);
}

const files = bundleFiles(DIST);
const leaks = [];
for (const file of files) {
  const content = readFileSync(file);
  for (const v of values) {
    // Keep BOTH names: which env file it came from, and which bundle file it
    // landed in. Collapsing them into one `file` made the message say the
    // secret came from the bundle it leaked into.
    if (content.includes(v.value)) leaks.push({ ...v, bundle: file.replace(ROOT, "") });
  }
}

if (leaks.length) {
  console.error("check-no-secrets: DEV CREDENTIALS ARE IN THE PRODUCTION BUNDLE\n");
  for (const l of leaks) {
    console.error(`  ${l.key} (from ${l.file}) is inlined in ${l.bundle}`);
  }
  console.error(
    "\nVite inlines import.meta.env.VITE_* as literals, and .env / .env.local are\n" +
      "loaded in EVERY mode. Move dev-only values to .env.development.local, which\n" +
      "is loaded only when mode=development. A runtime DEV guard is NOT enough —\n" +
      "it stops the value being used, not being shipped.",
  );
  process.exit(1);
}

console.log(`check-no-secrets: clean — ${values.length} dev value(s) absent from ${files.length} bundle file(s)`);
