#!/usr/bin/env node
/**
 * tab-agent — the piece that must run ON the machine with the terminals.
 *
 * Why this exists rather than the bridge just SSHing in: macOS blocks it.
 * Driving iTerm needs its Python API, which needs an auth cookie obtained via an
 * Apple event, and an ssh session is not authorized to send Apple events —
 * `-1743 Not authorized`, and `launchctl asuser` from ssh fails earlier still
 * with "Could not switch to audit session". That is TCC, not a missing config:
 * a remote shell is structurally outside the GUI session that owns the app.
 *
 * So a small agent lives inside that GUI session, and the bridge asks IT.
 *
 *   GET  /health                    is it up
 *   GET  /tab?session=<id>          {uuid} of the live tab, or {uuid:null}
 *   POST /send {session, text}      type an utterance into that tab
 *
 * Token-gated and bound to loopback plus one explicit address. It can type
 * arbitrary text into any terminal on this machine, which is as dangerous as it
 * sounds — never expose it beyond the tailnet.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const PORT = Number(process.env.TAB_AGENT_PORT ?? 8792);
const BINDS = (process.env.TAB_AGENT_BIND ?? "127.0.0.1").split(",").map((s) => s.trim()).filter(Boolean);
// `_OP` names a 1Password item, resolved in-process so the token never reaches
// a command line, a shell history, or a launchd plist.
const TOKEN =
  process.env.TAB_AGENT_TOKEN ??
  (process.env.TAB_AGENT_TOKEN_OP ? (await import("./hosts.mjs")).readOp(process.env.TAB_AGENT_TOKEN_OP) : undefined);
const REGISTRY = join(homedir(), ".local/state/claude-sessions");
const SEND = join(homedir(), ".claude/skills/create-tab/scripts/send-to-session.sh");

const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!TOKEN) {
  console.error("[fatal] TAB_AGENT_TOKEN is required");
  process.exit(1);
}

/** The live tab for a session, or null. Liveness is the recorded pid. */
function resolveTab(sessionId) {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
  const file = join(REGISTRY, `${sessionId}.json`);
  if (!existsSync(file)) return null;
  let entry;
  try {
    entry = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!entry.open || !entry.iterm_uuid || !entry.pid) return null;
  try {
    process.kill(entry.pid, 0); // existence check, no signal delivered
  } catch {
    return null; // a SIGKILLed session never fires SessionEnd
  }
  return entry.iterm_uuid;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ code: -1, out, err: e.message }));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

/**
 * The utterance goes via a FILE, never an argument: it is dictated speech and
 * will eventually contain a quote, a backtick or a newline, and a transcription
 * is not something to hand to a shell as a literal.
 */
async function sendToTab(uuid, text) {
  const dir = await mkdtemp(join(tmpdir(), "g2-tab-"));
  const file = join(dir, "utterance.txt");
  try {
    await writeFile(file, text);
    const r = await run(SEND, ["--uuid", uuid, "--text-file", file]);
    if (r.code !== 0) return { ok: false, error: (r.err || r.out).trim().slice(0, 400) };
    return { ok: true };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/health" && req.method === "GET") {
    return send(res, 200, { ok: true, registry: REGISTRY, send: existsSync(SEND) });
  }

  const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (bearer !== TOKEN) return send(res, 401, { error: "unauthorized" });

  if (url.pathname === "/tab" && req.method === "GET") {
    return send(res, 200, { uuid: resolveTab(url.searchParams.get("session") ?? "") });
  }

  if (url.pathname === "/send" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 200_000) req.destroy();
    });
    req.on("end", async () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "body was not JSON" });
      }
      const uuid = resolveTab(String(body.session ?? ""));
      if (!uuid) return send(res, 404, { error: "no live tab for that session" });
      const text = String(body.text ?? "");
      if (!text.trim()) return send(res, 400, { error: "empty text" });

      const r = await sendToTab(uuid, text);
      log(`[send] ${body.session} -> ${uuid} ${r.ok ? "ok" : `FAILED: ${r.error}`}`);
      return send(res, r.ok ? 200 : 500, r.ok ? { ok: true, uuid } : { error: r.error });
    });
    return;
  }

  return send(res, 404, { error: `no route for ${url.pathname}` });
});

let listening = 0;
for (const bind of BINDS) {
  const s = bind === BINDS[0] ? server : http.createServer(server.listeners("request")[0]);
  s.listen(PORT, bind, () => log(`tab-agent listening on http://${bind}:${PORT}`));
  s.on("error", (e) => log(`[warn] could not bind ${bind}: ${e.message}`));
  listening++;
}
if (!listening) process.exit(1);
