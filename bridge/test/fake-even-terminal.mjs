/**
 * A stand-in for `even-terminal`, faithful to the routes and payload shapes read
 * out of the real package's dist/. Lets the whole bridge be driven end to end —
 * including a permission prompt answered by voice — without a live agent, an API
 * bill, or a pair of glasses.
 *
 * Scripted, not simulated: a test pushes the exact message sequence a turn
 * should produce, then asserts what came out the other side.
 */

import http from "node:http";

export async function startFakeEvenTerminal({ token = "t0k", name = "fake" } = {}) {
  /** @type {Map<string, {messages:object[], nextId:number, state:string, history:object[], title:string, timestamp:string}>} */
  const sessions = new Map();
  const calls = [];
  let counter = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${token}` && url.searchParams.get("token") !== token) {
      return json(res, 401, { error: "unauthorized" });
    }

    const body = req.method === "POST" ? await readJson(req) : null;
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });

    if (url.pathname === "/api/info") {
      return json(res, 200, { account: { email: "test@example.com" }, model: "Test", provider: "claude" });
    }

    if (url.pathname === "/api/sessions") {
      return json(res, 200, {
        sessions: [...sessions.entries()].map(([id, s]) => ({
          id,
          title: s.title,
          timestamp: s.timestamp,
          cwd: "/tmp",
          provider: "claude",
          status: s.state,
        })),
      });
    }

    const hist = url.pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
    if (hist) {
      const s = sessions.get(decodeURIComponent(hist[1]));
      if (!s) return json(res, 404, { error: "Session not found" });
      return json(res, 200, { history: s.history });
    }

    if (url.pathname === "/api/messages") {
      const s = sessions.get(url.searchParams.get("sessionId"));
      if (!s) return json(res, 200, { messages: [], state: "idle" });
      const after = Number(url.searchParams.get("after") ?? 0);
      return json(res, 200, {
        messages: s.messages.filter((m) => m.id > after),
        state: s.state,
        sessionId: url.searchParams.get("sessionId"),
        provider: "claude",
      });
    }

    if (url.pathname === "/api/prompt") {
      let id = body?.sessionId;
      if (id && !sessions.has(id)) {
        // even-terminal's exact wording for a session that no longer exists.
        return json(res, 400, { error: `No conversation found with session ID: ${id}` });
      }
      if (!id) {
        id = `sess-${++counter}`;
        sessions.set(id, {
          messages: [], nextId: 0, state: "idle", history: [],
          title: String(body?.text ?? "").slice(-60), timestamp: new Date().toISOString(),
        });
      }
      const s = sessions.get(id);
      s.state = "busy";
      s.history.push({ role: "user", text: body?.text ?? "" });
      return json(res, 202, { ok: true, sessionId: id, provider: "claude" });
    }

    if (url.pathname === "/api/permission-response" || url.pathname === "/api/question-response") {
      const s = sessions.get(body?.sessionId);
      if (!s) return json(res, 404, { error: "Session not found" });
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/interrupt") return json(res, 200, { ok: true });
    return json(res, 404, { error: "not found" });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    name,
    calls,
    sessions,
    /** Create a session as if it already existed on disk. */
    seed(id, { title = "seeded", history = [], state = "idle", timestamp = new Date().toISOString() } = {}) {
      sessions.set(id, { messages: [], nextId: 0, state, history, title, timestamp });
      return id;
    },
    /** Push messages onto a session's ring, as the real agent would mid-turn. */
    push(id, ...messages) {
      const s = sessions.get(id);
      if (!s) throw new Error(`no such fake session ${id}`);
      for (const m of messages) s.messages.push({ id: ++s.nextId, ...m });
      s.timestamp = new Date().toISOString();
      if (messages.some((m) => m.type === "result")) {
        s.state = "idle";
        const last = [...messages].reverse().find((m) => m.type === "result");
        s.history.push({ role: "assistant", text: last.text ?? "" });
      }
      return s;
    },
    setState(id, state) {
      sessions.get(id).state = state;
    },
    async close() {
      await new Promise((r) => server.close(r));
    },
  };
}

function json(res, code, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : null);
      } catch {
        resolve(null);
      }
    });
  });
}
