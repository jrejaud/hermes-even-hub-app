#!/usr/bin/env node
/**
 * claude-code-g2-bridge — the server half of the Even Hub app.
 *
 * Speaks the glasses WebSocket protocol (src/protocol.ts / bridge/protocol.mjs)
 * on one side and `even-terminal`'s HTTP API on the other, across as many hosts
 * as hosts.json lists. Replaces `hermes-evenhub-bridge`.
 *
 *   glasses app (WebView on the phone)
 *      ⇄ wss:// over Tailscale, shared token
 *      ⇄ THIS
 *      ⇄ http://<host>:3457/api/*   on Overlord, Chiba, …
 *
 * Binds to a single address (default loopback) and expects `tailscale serve` in
 * front for TLS. It is NOT safe to expose: one bearer token stands between the
 * open internet and an agent-spawner on every configured host.
 */

import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { WebSocketServer } from "ws";

import { loadHosts, readOp } from "./hosts.mjs";
import { Fleet, ActivityWatcher } from "./fleet.mjs";
import { TerminalRouter } from "./terminal.mjs";
import { SessionPump } from "./pump.mjs";
import { NotificationFeed } from "./notifications.mjs";
import { createTranscriber } from "./stt.mjs";
import { activity as activityFrame, error as errorFrame, helloOk, parseClient, sessions as sessionsFrame, transcript as transcriptFrame } from "./protocol.mjs";

const PORT = Number(process.env.BRIDGE_PORT ?? 8791);
const BIND = process.env.BRIDGE_BIND ?? "127.0.0.1";
// The token the wearer types into the phone setup form. `BRIDGE_TOKEN_OP` names
// a 1Password item instead, resolved in-process so it never hits a command line.
const TOKEN = process.env.BRIDGE_TOKEN ?? (process.env.BRIDGE_TOKEN_OP ? readOp(process.env.BRIDGE_TOKEN_OP) : undefined);
const HOSTS_FILE = process.env.HOSTS_FILE ?? new URL("./hosts.json", import.meta.url).pathname;
/** 60 s of 16 kHz mono PCM16. A longer press is a stuck mic, not a sentence. */
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES ?? 16_000 * 2 * 60);
const HELLO_TIMEOUT_MS = 5_000;

const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!TOKEN) {
  console.error("[fatal] BRIDGE_TOKEN is required (the token typed into the phone setup form)");
  process.exit(1);
}

const fleet = new Fleet(loadHosts(HOSTS_FILE), { log });
const watcher = new ActivityWatcher(fleet, {
  intervalMs: Number(process.env.ACTIVITY_INTERVAL_MS ?? 5_000),
  log,
});
const stt = createTranscriber(process.env, { log, hostNames: fleet.hostList().map((h) => h.name) });
// Flagged-session events for off-terminal clients (the Claude Glasses Android
// app). One feed, shared by every subscriber; a client opts in at hello.
const feed = new NotificationFeed(loadHosts(HOSTS_FILE), {
  intervalMs: Number(process.env.NOTIFY_INTERVAL_MS ?? 5_000),
  log,
});

/**
 * Where each host's TERMINALS are, so an utterance about a session you already
 * have open on screen goes into that tab rather than starting a second agent
 * against the same transcript. A host with no `terminalSsh` in hosts.json has no
 * terminals to route to (a Linux VPS has no iTerm) and always uses even-terminal.
 * `""` means "this machine".
 */
const hostCfg = loadHosts(HOSTS_FILE);
const terminal = new TerminalRouter({
  hosts: Object.fromEntries(hostCfg.flatMap((h) => (h.terminalSsh === undefined ? [] : [[h.key, h.terminalSsh]]))),
  // A tab-agent is the only thing that works on macOS: driving iTerm needs an
  // Apple event, and an ssh session is not authorized to send one. See
  // bridge/tab-agent.mjs.
  agents: Object.fromEntries(
    hostCfg.flatMap((h) =>
      h.tabAgentUrl ? [[h.key, { url: h.tabAgentUrl, token: resolveTabAgentToken(h) }]] : [],
    ),
  ),
  log,
});

function resolveTabAgentToken(h) {
  if (h.tabAgentTokenEnv && process.env[h.tabAgentTokenEnv]) return process.env[h.tabAgentTokenEnv];
  if (h.tabAgentTokenOp) return readOp(h.tabAgentTokenOp);
  return h.tabAgentToken ?? "";
}

/**
 * FCM device tokens, on disk next to the bridge (SC-5668).
 * A file rather than memory because the whole point of FCM is that delivery survives
 * things being restarted — including this process. Keyed by token, so a phone that
 * re-registers the same token does not accumulate duplicates, and a rotated token
 * simply adds a row (stale ones are dropped when FCM reports UNREGISTERED).
 */
const FCM_STORE = new URL("./fcm-tokens.json", import.meta.url).pathname;
function fcmTokens() {
  try {
    return JSON.parse(readFileSync(FCM_STORE, "utf8"));
  } catch {
    return [];
  }
}
function saveFcmToken(token, pkg) {
  const rows = fcmTokens().filter((r) => r.token !== token);
  rows.push({ token, package: pkg, seen: new Date().toISOString() });
  writeFileSync(FCM_STORE, JSON.stringify(rows, null, 2));
  log(`[fcm] token registered for ${pkg} (${rows.length} total)`);
}

const httpServer = http.createServer((req, res) => {
  // POST /push — put an arbitrary line on the glasses (SC-5669). Same bearer token
  // as the WebSocket; the frame fans out to every notifications subscriber, i.e. the
  // "Glasses Notifications" Android app, which the Even app mirrors onto the HUD.
  // POST /fcm-token — the Glasses Notifications app registers its FCM device token
  // here (SC-5668). The token identifies one install, rotates on reinstall/data-clear,
  // and is useless to the sender until it is stored; the app re-posts it on every
  // start and on every rotation, so this is idempotent by design.
  if (req.url?.startsWith("/fcm-token") && req.method === "POST") {
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (bearer !== TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 20_000) req.destroy();
    });
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "body was not JSON" }));
        return;
      }
      const t = String(body.token ?? "").trim();
      if (t.length < 60) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "that does not look like an FCM token" }));
        return;
      }
      saveFcmToken(t, String(body.package ?? "unknown"));
      const out = JSON.stringify({ ok: true, tokens: fcmTokens().length });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(out) });
      res.end(out);
    });
    return;
  }

  if (req.url?.startsWith("/push") && req.method === "POST") {
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (bearer !== TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 100_000) req.destroy();
    });
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "body was not JSON" }));
        return;
      }
      if (!String(body.text ?? "").trim() && !String(body.title ?? "").trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "need a title or text" }));
        return;
      }
      feed.publish(body);
      const out = JSON.stringify({ ok: true, delivered_to: notifClients.size });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(out) });
      res.end(out);
    });
    return;
  }

  if (req.url?.startsWith("/health")) {
    const body = JSON.stringify({
      ok: true,
      hosts: fleet.hostList(),
      stt: stt.engine,
      clients: wss.clients.size,
      notifications: { hosts: feed.hostList(), subscribed: feed.subs.size, clients: notifClients.size },
    });
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: httpServer });
/** Connections that said hello with stream:"notifications" — they get feed frames and nothing else. */
const notifClients = new Set();
/**
 * FCM delivery (SC-5668). Every frame goes out BOTH ways for now:
 *   - down the WebSocket, to whatever is currently connected (instant, and the
 *     only path that works on a device with no Play Services);
 *   - through FCM, which reaches the phone when its process is dead or dozing —
 *     the case the socket structurally cannot cover.
 * The app de-duplicates on its own log; dropping the socket is a later step, once
 * FCM has been trusted for a while. Sending is best-effort: a push failure must
 * never break the socket fan-out, so every error is swallowed after one log line.
 */
const FCM_KEY = process.env.FCM_KEY_FILE ?? new URL("./fcm-sender-key.json", import.meta.url).pathname;
const FCM_PROJECT = process.env.FCM_PROJECT ?? "glasses-notify-260923";
let fcmToken = { value: null, exp: 0 };

async function fcmAccessToken() {
  if (fcmToken.value && Date.now() < fcmToken.exp - 60_000) return fcmToken.value;
  const key = JSON.parse(readFileSync(FCM_KEY, "utf8"));
  const { createSign } = await import("node:crypto");
  const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`token exchange ${r.status}`);
  fcmToken = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return fcmToken.value;
}

async function fcmSend(frame) {
  const rows = fcmTokens();
  if (!rows.length) return;
  let at;
  try {
    at = await fcmAccessToken();
  } catch (err) {
    log(`[fcm] no access token: ${err.message}`);
    return;
  }
  for (const row of rows) {
    try {
      const body = {
        message: {
          token: row.token,
          android: { priority: "HIGH", notification: { channel_id: frame.kind ?? "notification" } },
          notification: {
            title: `${frame.hostName ?? frame.host ?? "?"}${frame.title ? " · " + frame.title : ""}`,
            body: String(frame.text ?? "").slice(0, 400),
          },
          // The same fields the WebSocket frame carries, so the app's two paths
          // post identical notifications.
          data: Object.fromEntries(
            Object.entries({
              kind: frame.kind, host: frame.host, hostName: frame.hostName,
              sessionId: frame.sessionId, title: frame.title, text: frame.text,
              options: Array.isArray(frame.options) ? frame.options.join("|") : "",
            }).map(([k, v]) => [k, String(v ?? "")]),
          ),
        },
      };
      const r = await fetch(`https://fcm.googleapis.com/v1/projects/${FCM_PROJECT}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${at}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (r.status === 404 || r.status === 400) {
        // UNREGISTERED / invalid: the install is gone or the token rotated. Drop it
        // rather than retrying forever on a dead phone.
        const remaining = fcmTokens().filter((x) => x.token !== row.token);
        writeFileSync(FCM_STORE, JSON.stringify(remaining, null, 2));
        log(`[fcm] dropped a stale token (HTTP ${r.status}); ${remaining.length} left`);
      } else if (!r.ok) {
        log(`[fcm] send failed HTTP ${r.status}`);
      }
    } catch (err) {
      log(`[fcm] send error: ${err.message}`);
    }
  }
}

feed.onEvent((frame) => {
  void fcmSend(frame);
  const data = JSON.stringify(frame);
  for (const ws of notifClients) if (ws.readyState === ws.OPEN) ws.send(data);
});

wss.on("connection", (ws, req) => {
  const peer = req.socket.remoteAddress;
  let authed = false;
  let audio = null;
  const emit = (frame) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  };
  const pump = new SessionPump(fleet, emit, { log, terminal });

  const helloTimer = setTimeout(() => {
    if (!authed) ws.close(1008, "unauthorized: no hello");
  }, HELLO_TIMEOUT_MS);

  // Activity from a session the wearer is NOT currently looking at. Filtering
  // here rather than in the watcher keeps one poll loop serving every client.
  const unsubscribe = watcher.onActivity((e) => {
    if (!authed) return;
    if (e.id === pump.compositeId) return;
    emit(activityFrame(e.id, e.host, e.title || "session", e.preview || ""));
  });

  ws.on("message", async (data, isBinary) => {
    if (isBinary) {
      if (!authed || !audio) return;
      if (audio.bytes + data.length > MAX_AUDIO_BYTES) return;
      audio.chunks.push(Buffer.from(data));
      audio.bytes += data.length;
      return;
    }

    let m;
    try {
      m = parseClient(data.toString());
    } catch (err) {
      log(`[ws] ${peer} sent a bad frame: ${err.message}`);
      return;
    }

    if (m.t === "hello") {
      if (m.token !== TOKEN) {
        log(`[ws] ${peer} rejected — bad token`);
        ws.close(1008, "unauthorized: token");
        return;
      }
      authed = true;
      clearTimeout(helloTimer);
      if (m.stream === "notifications") {
        // A notification-only client: no session pump, no activity frames — just
        // the flagged-session feed, until it disconnects.
        notifClients.add(ws);
        unsubscribe();
        log(`[ws] ${peer} connected to the notifications stream (device=${m.device ?? "?"})`);
        emit(helloOk({ hosts: feed.hostList(), stream: "notifications", kinds: ["question", "permission", "notification", "finished"] }, null));
        return;
      }
      log(`[ws] ${peer} connected (device=${m.device ?? "?"})`);
      emit(helloOk({ hosts: fleet.hostList(), stt: stt.engine, multiHost: true, ask: true, activity: true }, null));
      return;
    }
    if (!authed) {
      ws.close(1008, "unauthorized");
      return;
    }

    try {
      await handle(m);
    } catch (err) {
      log(`[ws] ${m.t} failed: ${err.stack ?? err.message}`);
      emit(errorFrame(String(err.message ?? err).slice(0, 200)));
    }
  });

  async function handle(m) {
    switch (m.t) {
      case "fcm.token": {
        // Idempotent: the app re-sends on every start and on rotation.
        const t = String(m.token ?? "").trim();
        if (t.length >= 60) saveFcmToken(t, String(m.package ?? "unknown"));
        return;
      }
      case "sessions.list": {
        const items = await fleet.sessions({ force: true });
        emit(sessionsFrame(items, pump.compositeId, fleet.hostList()));
        return;
      }
      case "sessions.switch":
        await pump.attach(m.id);
        return;
      case "sessions.new":
        pump.armNew(m.host);
        return;
      case "text":
        await pump.handleText(m.text);
        return;
      case "stop":
        await pump.interrupt();
        return;
      case "audio.start":
        audio = { chunks: [], bytes: 0 };
        return;
      case "audio.stop": {
        const buf = audio ? Buffer.concat(audio.chunks, audio.bytes) : Buffer.alloc(0);
        audio = null;
        if (!buf.length) {
          emit(transcriptFrame(""));
          return;
        }
        const text = await stt.transcribe(buf);
        if (!text && stt.unavailableReason) {
          emit(errorFrame(stt.unavailableReason));
        }
        log(`[stt] ${(buf.length / 32_000).toFixed(1)}s -> ${text ? `"${text.slice(0, 80)}"` : "(nothing)"}`);
        emit(transcriptFrame(text));
        return;
      }
      default:
        return;
    }
  }

  ws.on("close", () => {
    clearTimeout(helloTimer);
    notifClients.delete(ws);
    unsubscribe();
    pump.detach();
    log(`[ws] ${peer} disconnected`);
  });
  ws.on("error", (err) => log(`[ws] ${peer} error: ${err.message}`));
});

watcher.start();
feed.start();

httpServer.listen(PORT, BIND, () => {
  log(`claude-code-g2-bridge on ws://${BIND}:${PORT}`);
  log(`  hosts: ${fleet.hostList().map((h) => `${h.key}=${h.name}`).join(", ")}`);
  log(`  stt:   ${stt.engine}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`shutting down on ${sig}`);
    watcher.stop();
    feed.stop();
    wss.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
