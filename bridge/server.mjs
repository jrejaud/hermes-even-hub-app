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
import { WebSocketServer } from "ws";

import { loadHosts, readOp } from "./hosts.mjs";
import { Fleet, ActivityWatcher } from "./fleet.mjs";
import { SessionPump } from "./pump.mjs";
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

const httpServer = http.createServer((req, res) => {
  if (req.url?.startsWith("/health")) {
    const body = JSON.stringify({
      ok: true,
      hosts: fleet.hostList(),
      stt: stt.engine,
      clients: wss.clients.size,
    });
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  const peer = req.socket.remoteAddress;
  let authed = false;
  let audio = null;
  const emit = (frame) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  };
  const pump = new SessionPump(fleet, emit, { log });

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
    unsubscribe();
    pump.detach();
    log(`[ws] ${peer} disconnected`);
  });
  ws.on("error", (err) => log(`[ws] ${peer} error: ${err.message}`));
});

watcher.start();

httpServer.listen(PORT, BIND, () => {
  log(`claude-code-g2-bridge on ws://${BIND}:${PORT}`);
  log(`  hosts: ${fleet.hostList().map((h) => `${h.key}=${h.name}`).join(", ")}`);
  log(`  stt:   ${stt.engine}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`shutting down on ${sig}`);
    watcher.stop();
    wss.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
