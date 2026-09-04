/**
 * HTTP client for one `even-terminal` instance.
 *
 * Route list and auth are from `even-terminal-service.md` and the package's own
 * dist/, not guessed. Every route is under `/api` and 401s without the bearer.
 *
 *   GET  /api/info
 *   GET  /api/sessions                       -> {sessions:[{id,title,timestamp,cwd,provider,status}]}
 *   GET  /api/sessions/:id/history           -> {history:[{role,text}]}
 *   GET  /api/messages?sessionId=&after=     -> {messages,state,sessionId,provider}
 *   GET  /api/status?sessionId=              -> 404 unless the session is live in memory
 *   POST /api/prompt                         -> 202 {ok,sessionId,provider}   (ASYNC)
 *   POST /api/interrupt
 *   POST /api/permission-response            {sessionId, decision, provider}
 *   POST /api/question-response              {sessionId, answer, provider}
 */

export class HostOffline extends Error {
  constructor(key, cause) {
    super(`host ${key} unreachable: ${cause}`);
    this.name = "HostOffline";
    this.key = key;
  }
}

export class EvenTerminal {
  /**
   * @param {{key:string,name:string,url:string,token:string,provider?:string,timeoutMs?:number}} cfg
   */
  constructor(cfg) {
    this.key = cfg.key;
    this.name = cfg.name ?? cfg.key;
    this.url = cfg.url.replace(/\/$/, "");
    this.token = cfg.token;
    this.provider = cfg.provider ?? "claude";
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
    /** Set false by any transport failure, true by any success — drives the host row on the lens. */
    this.online = true;
    this.lastError = null;
  }

  async req(method, path, { query, body } = {}) {
    const url = new URL(this.url + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // A transport failure is the host being down, not a bad request. Ad-hoc
      // even-terminal on a laptop is offline most of the time by design, so this
      // path is normal operation and must never take the whole bridge with it.
      this.online = false;
      this.lastError = err.message;
      throw new HostOffline(this.key, err.message);
    }

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      this.online = false;
      this.lastError = `non-JSON ${res.status}`;
      throw new Error(`${this.key} ${method} ${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      // A 4xx means the host is up and talking — it is the request that is wrong.
      this.online = true;
      const detail = json.error ?? json.message ?? text.slice(0, 200);
      const err = new Error(`${this.key} ${method} ${path} -> ${res.status}: ${detail}`);
      err.status = res.status;
      throw err;
    }
    this.online = true;
    this.lastError = null;
    return json;
  }

  info() {
    return this.req("GET", "/api/info");
  }

  async sessions(limit = 40) {
    const r = await this.req("GET", "/api/sessions", { query: { limit } });
    return r.sessions ?? [];
  }

  async history(sessionId) {
    const r = await this.req("GET", `/api/sessions/${encodeURIComponent(sessionId)}/history`);
    return r.history ?? [];
  }

  messages(sessionId, after = 0) {
    return this.req("GET", "/api/messages", {
      query: { sessionId, after, provider: this.provider },
    });
  }

  prompt(text, sessionId) {
    const body = { text, provider: this.provider };
    if (sessionId) body.sessionId = sessionId;
    return this.req("POST", "/api/prompt", { body });
  }

  interrupt(sessionId) {
    return this.req("POST", "/api/interrupt", { body: { sessionId, provider: this.provider } });
  }

  permissionResponse(sessionId, decision) {
    return this.req("POST", "/api/permission-response", {
      body: { sessionId, decision, provider: this.provider },
    });
  }

  questionResponse(sessionId, answer) {
    return this.req("POST", "/api/question-response", {
      body: { sessionId, answer, provider: this.provider },
    });
  }
}

/**
 * even-terminal's own wording when a remembered session no longer exists —
 * archived, deleted, or the service restarted under us. Recoverable: drop the
 * id and respawn, never surface it to the wearer.
 * (Ported from even-agent-webhook.mjs, where it was learned live.)
 */
export function isDeadSession(err) {
  return /no conversation found|session not found/i.test(err?.message ?? "");
}
