#!/usr/bin/env node
/**
 * g2-bridge — drive the bridge over its real WebSocket protocol, from a terminal.
 *
 * The same frames the glasses send, without the glasses. This is how you prove
 * the backend half works before blaming the app, and how you reproduce a wearer's
 * report without wearing anything.
 *
 *   g2-bridge health                       bridge status + host reachability
 *   g2-bridge sessions                     the merged multi-host session list
 *   g2-bridge open <composite-id>          open a session, print its thread
 *   g2-bridge say <composite-id> <text>    open it and send an utterance
 *   g2-bridge new <hostKey> <text>         spawn a session on a host and prompt it
 *   g2-bridge watch                        idle, printing activity notifications
 *
 * Every verb streams server frames until the turn finishes or --seconds elapses.
 */

import { WebSocket } from "ws";
import { readOp } from "./hosts.mjs";

const argvRaw = process.argv.slice(2);
const urlFlag = argvRaw.indexOf("--url");
/** `--url` targets a deployed bridge; without it, the local one. */
const URL_ =
  (urlFlag >= 0 ? argvRaw[urlFlag + 1] : undefined) ??
  process.env.BRIDGE_URL ??
  `ws://127.0.0.1:${process.env.BRIDGE_PORT ?? 8791}`;
const HTTP = URL_.replace(/^ws/, "http");

/**
 * Resolved ONCE, before any socket is opened. `readOp` shells out to `op` and
 * blocks; doing that inside the `open` handler put a multi-second gap between
 * connect and `hello`, and the server closed the socket on its 5s hello deadline
 * — which reads as an auth failure and is nothing of the kind.
 */
const TOKEN = (() => {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  if (process.env.BRIDGE_TOKEN_OP) return readOp(process.env.BRIDGE_TOKEN_OP);
  throw new Error("set BRIDGE_TOKEN or BRIDGE_TOKEN_OP");
})();

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const SECONDS = Number(flag("seconds", 60));
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const [verb, ...rest] = positional;

/** Print one server frame the way it would read on the lens. */
function show(m) {
  switch (m.t) {
    case "sessions":
      console.log(`hosts: ${(m.hosts ?? []).map((h) => `${h.key}=${h.name}${h.online ? "" : " (OFFLINE)"}`).join("  ")}`);
      for (const s of m.items) {
        const when = s.updated ? new Date(s.updated * 1000).toISOString().slice(5, 16).replace("T", " ") : "--";
        console.log(`  ${s.busy ? "*" : " "} ${s.host ?? "?"}  ${when}  ${s.id}  ${s.title.slice(0, 60)}`);
      }
      break;
    case "history":
      console.log(`--- ${m.id} (${m.items.length} items${m.ok === false ? ", history unavailable" : ""}) ---`);
      for (const it of m.items) {
        console.log(it.kind === "user" ? `> ${it.text}` : `  ${String(it.text ?? "").slice(0, 300)}`);
      }
      break;
    case "assistant.delta": process.stdout.write(m.text); break;
    case "assistant": console.log(`\n= ${m.text}`); break;
    case "tool.start": console.log(`/ ${m.name}`); break;
    case "tool.end": console.log(`/ ${m.name} ${m.ok ? "ok" : "FAIL"}`); break;
    case "ask": console.log(`\n? [${m.ask}] ${m.text}${m.options?.length ? `   options=${m.options.join("|")}` : ""}`); break;
    case "ask.done": console.log(`? answered`); break;
    case "activity": console.log(`\n● ACTIVITY ${m.host}/${m.title} — ${m.preview}`); break;
    case "turn.done": console.log(`\n[turn done]`); break;
    case "active": console.log(`[active ${m.id}]`); break;
    case "transcript": console.log(`[transcript] ${m.text ? `"${m.text}"` : "(nothing heard)"}`); break;
    case "error": console.log(`[error] ${m.msg}`); break;
    default: break;
  }
}

async function health() {
  const res = await fetch(`${HTTP}/health`);
  console.log(JSON.stringify(await res.json(), null, 2));
}

function connect(onOpen, { until } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_);
    const send = (o) => ws.send(JSON.stringify(o));
    const timer = setTimeout(() => { ws.close(); resolve(); }, SECONDS * 1000);

    ws.on("open", () => send({ t: "hello", token: TOKEN, device: "cli" }));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "hello.ok") return void onOpen(send, ws);
      show(m);
      if (until?.(m)) { clearTimeout(timer); ws.close(); resolve(); }
    });
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      if (code === 1008) reject(new Error(`rejected: ${reason}`));
      else resolve();
    });
    ws.on("error", reject);
  });
}

switch (verb) {
  case "health":
    await health();
    break;

  case "sessions":
    await connect((send) => send({ t: "sessions.list" }), { until: (m) => m.t === "sessions" });
    break;

  case "open":
    await connect((send) => send({ t: "sessions.switch", id: rest[0] }), { until: (m) => m.t === "history" });
    break;

  case "say":
    await connect(
      (send) => {
        send({ t: "sessions.switch", id: rest[0] });
        // Give the attach a beat so history lands before the prompt's output.
        setTimeout(() => send({ t: "text", text: rest.slice(1).join(" ") }), 1_500);
      },
      { until: (m) => m.t === "turn.done" || m.t === "ask" },
    );
    break;

  case "answer":
    await connect(
      (send) => {
        send({ t: "sessions.switch", id: rest[0] });
        setTimeout(() => send({ t: "text", text: rest.slice(1).join(" ") }), 1_500);
      },
      { until: (m) => m.t === "turn.done" },
    );
    break;

  case "new": {
    // `--reply` answers an ask on the SAME connection. AskUserQuestion blocks
    // for only 60s before auto-answering "skip", so splitting ask and answer
    // across two CLI runs loses the race — and losing it looks exactly like the
    // answer path being broken.
    const reply = flag("reply");
    let sender;
    await connect(
      (send) => {
        sender = send;
        send({ t: "sessions.new", host: rest[0] });
        setTimeout(() => send({ t: "text", text: rest.slice(1).join(" ") }), 500);
      },
      {
        until: (m) => {
          if (m.t === "ask" && reply) {
            console.log(`\n[replying "${reply}"]`);
            sender({ t: "text", text: reply });
            return false;
          }
          return m.t === "turn.done" || (m.t === "ask" && !reply);
        },
      },
    );
    break;
  }

  case "speak": {
    // Push a WAV through the audio path exactly as the glasses would: binary
    // frames of 16 kHz mono PCM16 between audio.start and audio.stop. Proves the
    // transcriber without a microphone.
    const { readFileSync } = await import("node:fs");
    const wav = readFileSync(rest[0]);
    const pcm = wav.subarray(44); // strip the RIFF header; the SDK sends raw PCM
    await connect(
      (send, ws) => {
        send({ t: "audio.start" });
        for (let i = 0; i < pcm.length; i += 3200) ws.send(pcm.subarray(i, i + 3200));
        send({ t: "audio.stop" });
      },
      { until: (m) => m.t === "transcript" },
    );
    break;
  }

  case "app-env": {
    // Write the app's dev-only env so the simulator can auto-connect.
    //
    // The filename is load-bearing. Vite loads `.env.local` in EVERY mode,
    // including `vite build`, and statically inlines `import.meta.env.VITE_*`
    // into the bundle — so a token in `.env.local` ends up inside the packed
    // .ehpk even though a runtime `import.meta.env.DEV` guard stops it being
    // USED. Verified by grepping dist/ and finding it there (2026-09-04).
    // `.env.development.local` is loaded only when mode=development, so a
    // production build sees `undefined` and there is nothing to inline.
    // Anyone with an .ehpk can extract whatever is in it.
    const { writeFileSync } = await import("node:fs");
    const out = new globalThis.URL("../.env.development.local", import.meta.url).pathname;
    writeFileSync(out, `VITE_BRIDGE_URL=${URL_}\nVITE_BRIDGE_TOKEN=${TOKEN}\n`);
    console.log(`wrote ${out} (url=${URL_}, token=${TOKEN.length} chars)`);
    break;
  }

  case "watch":
    console.log(`watching for activity for ${SECONDS}s…`);
    await connect((send) => send({ t: "sessions.list" }));
    break;

  default:
    console.log(`usage: g2-bridge {health|sessions|open <id>|say <id> <text>|new <host> <text>|watch} [--seconds N]`);
    process.exit(verb ? 1 : 0);
}
