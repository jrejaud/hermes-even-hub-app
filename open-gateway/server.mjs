#!/usr/bin/env node
// Open gateway for the Aristo Lens G2 app (SC-11683): run it next to Claude Code, point the lens at it.
//
//   GATEWAY_TOKEN=<secret> node open-gateway/server.mjs [--port 8787] [--cwd <dir>]
//
// Env:
//   GATEWAY_TOKEN       required; the lens sends it (?token=, Authorization: Bearer, or a first {t:"auth",token} frame)
//   PORT / --port       default 8787
//   HOST                default 127.0.0.1 (0.0.0.0 with TLS); expose it with `tailscale serve`, or give TLS_CERT + TLS_KEY
//   TLS_CERT, TLS_KEY   PEM files: serve wss:// directly
//   GATEWAY_CWD / --cwd the folder new sessions start in (default: where you run it)
//   CLAUDE_MODEL        optional model id for new sessions (default: Claude Code's default)
//   PERMISSION_MODE     default "default" (every tool asks on the lens); "acceptEdits" lets file edits through
//   STT_URL             OpenAI-compatible base URL for speech to text (default https://api.openai.com/v1)
//   STT_KEY             its API key (OPENAI_API_KEY is used when unset)
//   STT_MODEL           default "whisper-1"
//
// Claude Code auth is whatever the Agent SDK finds: your `claude` login or ANTHROPIC_API_KEY.
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { Gateway } from './core.mjs';
import { transcribe } from './stt.mjs';

const PATH = '/api/glasses';

export const CARD_SHAPE = {
  title: z.string().describe('Short title above the card'),
  kind: z.enum(['stat', 'list', 'table']),
  id: z.string().optional().describe('Reuse an id to update a card in place'),
  value: z.string().optional().describe('stat: the big value, e.g. "$4,210"'),
  delta: z.string().optional().describe('stat: one line under it, e.g. "+18% vs October"'),
  spark: z.array(z.number()).optional().describe('stat: trend values, oldest first'),
  spark_label: z.string().optional().describe('stat: what the trend covers, e.g. "last 30 days"'),
  rows: z.array(z.string()).optional().describe('list: one line per row'),
  head: z.array(z.string()).optional().describe('table: column names, at most 4'),
  table: z.array(z.array(z.string())).optional().describe('table: rows of cells'),
  align: z
    .array(z.enum(['l', 'r']))
    .optional()
    .describe('table: per column, "r" for numbers'),
  ttl_seconds: z.number().optional().describe('How long it stays (default 20; 0 = until dismissed)'),
};

// One process holds every session, so nothing a client sends may throw out of a request path (REVIEW.md). Every
// entry point below (HTTP request, upgrade, socket message) runs inside its own catch, and the helpers they use never
// throw on hostile input.

/** Constant-time compare of two strings; anything that is not a non-empty string is no match. */
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearer(req) {
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : null;
}

/** Declared capabilities: a comma-separated string (URL) or a string array (auth frame); anything else is none. */
function capsOf(v) {
  if (typeof v === 'string')
    return v
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

/** The request target as a URL, or null when it does not parse (`//[`, a bad port). */
function urlOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://x');
  } catch {
    return null; // error-ok: an unparsable target is answered 400 or dropped by the caller
  }
}

/** Build the HTTP + WebSocket server around a Gateway. Returns the http.Server (not listening). */
export function serve({ gateway, token, stt, tls = null, log = (m) => console.error(m) }) {
  async function route(req, res) {
    const url = urlOf(req);
    if (!url) return void res.writeHead(400).end();
    if (req.method === 'GET' && url.pathname === '/health') return void res.end('ok');
    // Any agent, script or other Claude Code session can push a card: POST the show_card arguments as JSON.
    if (req.method === 'POST' && url.pathname === '/api/card') {
      if (!same(bearer(req) ?? url.searchParams.get('token'), token)) return void res.writeHead(401).end('bad token');
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 256 * 1024) return void res.writeHead(413).end();
      }
      let card;
      try {
        card = gateway.showCard(null, JSON.parse(body));
      } catch (e) {
        return void res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
      }
      return void res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, id: card.id }));
    }
    res.writeHead(404).end();
  }
  const handler = (req, res) =>
    route(req, res).catch((e) => {
      // A dropped connection mid-body, or anything else: answer if we still can, never take the process down.
      log(`open gateway: request failed: ${e?.message ?? e}`);
      if (!res.headersSent && !res.destroyed) res.writeHead(500).end();
      else res.destroy();
    });
  // TLS when given a cert and key; otherwise plain HTTP, which the CLI binds to 127.0.0.1 (see README: tailscale serve).
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  server.on('upgrade', (req, sock, head) => {
    try {
      sock.on('error', () => sock.destroy());
      const url = urlOf(req);
      if (!url || url.pathname !== PATH) return void sock.destroy();
      const given = url.searchParams.get('token') ?? bearer(req);
      // A wrong token in the URL or header is refused before the upgrade; none at all may come as the first frame.
      if (given !== null && !same(given, token)) {
        sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return void sock.destroy();
      }
      wss.handleUpgrade(req, sock, head, (ws) => accept(ws, given !== null, capsOf(url.searchParams.get('caps'))));
    } catch (e) {
      log(`open gateway: upgrade failed: ${e?.message ?? e}`);
      sock.destroy();
    }
  });

  function accept(ws, authed, caps) {
    const send = (f) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(f));
    let c = authed ? gateway.attach(send, caps) : null;
    const timer = authed ? null : setTimeout(() => ws.close(1008, 'auth timeout'), 5000);
    // An oversized or malformed frame makes `ws` emit 'error'; unhandled, it would crash every session.
    ws.on('error', () => ws.terminate());
    const onFrame = async (raw) => {
      let f;
      try {
        f = JSON.parse(String(raw));
      } catch {
        return send({ t: 'refused', reqId: '', reason: 'bad', message: 'Not JSON.' });
      }
      // JSON that is not an object (`null`, a number) is refused, never dereferenced.
      if (!f || typeof f !== 'object') return send({ t: 'refused', reqId: '', reason: 'bad', message: 'Not a frame.' });
      if (!c) {
        if (f.t !== 'auth' || !same(f.token, token)) return ws.close(1008, 'bad token');
        clearTimeout(timer);
        c = gateway.attach(send, caps.length ? caps : capsOf(f.caps));
        return;
      }
      try {
        await gateway.handle(c, f, send, stt);
      } catch (e) {
        send({
          t: 'refused',
          reqId: typeof f.reqId === 'string' ? f.reqId : '',
          reason: 'error',
          message: String(e?.message ?? e),
        });
      }
    };
    ws.on('message', (raw) =>
      onFrame(raw).catch((e) => {
        log(`open gateway: frame failed: ${e?.message ?? e}`);
        ws.terminate();
      }),
    );
    ws.on('close', () => {
      clearTimeout(timer);
      if (c) gateway.detach(c);
    });
  }

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { port: { type: 'string' }, cwd: { type: 'string' } } });
  const token = process.env.GATEWAY_TOKEN;
  if (!token) {
    console.error('Set GATEWAY_TOKEN (any long random string; the lens app needs the same one).');
    process.exit(2);
  }
  const { query, tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
  const gateway = new Gateway({
    query,
    tool,
    mcp: createSdkMcpServer,
    cardShape: CARD_SHAPE,
    cwd: values.cwd ?? process.env.GATEWAY_CWD ?? process.cwd(),
    model: process.env.CLAUDE_MODEL,
    permissionMode: process.env.PERMISSION_MODE ?? 'default',
  });
  const stt = (pcm) =>
    transcribe(pcm, {
      url: process.env.STT_URL ?? 'https://api.openai.com/v1',
      key: process.env.STT_KEY ?? process.env.OPENAI_API_KEY ?? '',
      model: process.env.STT_MODEL ?? 'whisper-1',
    });
  const port = Number(values.port ?? process.env.PORT ?? 8787);
  const tls =
    process.env.TLS_CERT && process.env.TLS_KEY
      ? { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) }
      : null;
  // Plain HTTP stays on this machine unless you say otherwise: the socket carries tool approvals and the token.
  const host = process.env.HOST ?? (tls ? '0.0.0.0' : '127.0.0.1');
  serve({ gateway, token, stt, tls }).listen(port, host, () =>
    console.log(`open gateway on ${tls ? 'wss' : 'ws'}://${host}:${port}${PATH} (sessions start in ${gateway.d.cwd})`),
  );
}
