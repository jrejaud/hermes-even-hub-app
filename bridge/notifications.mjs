/**
 * The `notifications` stream (SC-5538 phase 4): events from FLAGGED sessions only,
 * across every host, pushed to any client that said `hello` with
 * `stream: "notifications"` — today the "Claude Glasses" Android app, whose only
 * job is to post one Android notification per event so the Even app mirrors it
 * onto the HUD while the terminal app is closed.
 *
 * Source of truth for "flagged" is each host's FLAGGED even-terminal instance
 * (`flaggedUrl` in hosts.json — Chiba :3459, Overlord :3457), whose
 * `/api/sessions` is already filtered by the registry (`glasses_visible=true`).
 * So the feed never reads registry files itself and cannot disagree with what
 * terminal mode lists.
 *
 * Per flagged session it holds one SSE subscription (`GET /api/events?sessionId=`)
 * and forwards `user_question`, `permission_request` and `notification`; a tab's
 * events arrive on the same stream via `POST /api/notify`. "finished" comes from a
 * busy→idle transition on the flagged list (one poll per host, same rule as
 * ActivityWatcher: a session coming to REST, never each tick of a long turn).
 *
 * Dedup: SSE frames carry even-terminal's per-session message id; a frame whose id
 * is ≤ the last one seen for that session is dropped, so a reconnect with replay
 * cannot double-post. Even's own double-fire (utterances arrive twice) never
 * reaches here — it is upstream of the session.
 */

import { EvenTerminal, HostOffline } from "./even-terminal.mjs";
import { compositeId } from "./protocol.mjs";

const FORWARD = new Set(["user_question", "permission_request", "notification"]);

export class NotificationFeed {
  /**
   * @param {Array<{key,name,flaggedUrl,flaggedToken,provider?}>} hostConfigs
   */
  constructor(hostConfigs, { intervalMs = 5_000, log = () => {}, now = () => Date.now() } = {}) {
    this.hosts = new Map(
      hostConfigs
        .filter((c) => c.flaggedUrl && c.flaggedToken)
        .map((c) => [c.key, new EvenTerminal({ key: c.key, name: c.name, url: c.flaggedUrl, token: c.flaggedToken, provider: c.provider })]),
    );
    this.intervalMs = intervalMs;
    this.log = log;
    this.now = now;
    this.listeners = new Set();
    /** @type {Map<string,{abort:AbortController,lastId:number,title:string,busy:boolean,updated:number}>} composite id → state */
    this.subs = new Map();
    this.timer = undefined;
    this.seq = 0;
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  hostList() {
    return [...this.hosts.values()].map((h) => ({ key: h.key, name: h.name, online: h.online }));
  }

  start() {
    if (this.timer || !this.hosts.size) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.log(`[notif] ${e.message}`)), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    void this.tick().catch(() => {});
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const s of this.subs.values()) s.abort.abort();
    this.subs.clear();
  }

  emit(ev) {
    const frame = { t: "notification", id: `n${++this.seq}`, ts: this.now(), ...ev };
    this.log(`[notif] ${frame.kind} ${frame.host}/${frame.sessionId.slice(0, 8)} ${String(frame.text ?? "").slice(0, 80)}`);
    for (const fn of this.listeners) fn(frame);
  }

  /** One `/api/sessions` per host: reconcile subscriptions + detect finished turns. */
  async tick() {
    const live = new Set();
    for (const h of this.hosts.values()) {
      let list;
      try {
        list = await h.sessions(40);
      } catch (err) {
        if (!(err instanceof HostOffline)) this.log(`[notif] ${h.key} sessions failed: ${err.message}`);
        continue;
      }
      for (const s of list) {
        const id = compositeId(h.key, s.id);
        live.add(id);
        const updated = Math.floor(new Date(s.timestamp ?? 0).getTime() / 1000) || 0;
        const busy = s.status === "busy";
        let st = this.subs.get(id);
        if (!st) {
          st = { abort: new AbortController(), lastId: 0, title: (s.title ?? "").trim(), busy, updated, primed: false };
          this.subs.set(id, st);
          void this.subscribe(h, s.id, st);
        } else {
          st.title = (s.title ?? "").trim() || st.title;
          // Came to rest after working: "finished". First sight never counts.
          if (st.primed && st.busy && !busy) {
            this.emit({ kind: "finished", host: h.key, hostName: h.name, sessionId: s.id, title: st.title, text: `${st.title || "session"} finished` });
          }
          st.busy = busy;
          st.updated = updated;
        }
        st.primed = true;
      }
    }
    // A session that dropped off every flagged list (unflagged, pruned, archived) — stop listening.
    for (const [id, st] of this.subs) {
      if (!live.has(id)) {
        st.abort.abort();
        this.subs.delete(id);
      }
    }
  }

  /** Long-lived SSE reader for one session; reconnects with backoff until unsubscribed. */
  async subscribe(host, sessionId, st) {
    let backoff = 2_000;
    while (!st.abort.signal.aborted) {
      try {
        const url = new URL(`${host.url}/api/events`);
        url.searchParams.set("sessionId", sessionId);
        const res = await fetch(url, { headers: { Authorization: `Bearer ${host.token}` }, signal: st.abort.signal });
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        backoff = 2_000;
        await this.readSse(res.body, (id, data) => this.onFrame(host, sessionId, st, id, data));
      } catch (err) {
        if (st.abort.signal.aborted) return;
        this.log(`[notif] ${host.key}/${sessionId.slice(0, 8)} sse dropped: ${err.message}; retry in ${backoff}ms`);
      }
      if (st.abort.signal.aborted) return;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }

  async readSse(body, onEvent) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let id = 0;
        let data = "";
        for (const line of chunk.split("\n")) {
          if (line.startsWith("id: ")) id = Number(line.slice(4)) || 0;
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (data) onEvent(id, data);
      }
    }
  }

  onFrame(host, sessionId, st, id, data) {
    if (id && id <= st.lastId) return; // replay / duplicate
    if (id) st.lastId = id;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!FORWARD.has(msg.type)) return;
    const base = { host: host.key, hostName: host.name, sessionId, title: st.title };
    if (msg.type === "user_question") {
      const q = msg.questions?.[0] ?? {};
      const options = (q.options ?? []).map((o) => o.label).filter(Boolean);
      this.emit({ ...base, kind: "question", text: q.question || "Claude is asking a question", options, toolUseId: msg.toolUseId ?? null });
    } else if (msg.type === "permission_request") {
      const detail = msg.detail ? ` — ${msg.detail}` : "";
      this.emit({ ...base, kind: "permission", text: `${msg.toolName ?? "tool"}: ${msg.description ?? ""}${detail}`.trim(), options: (msg.options ?? []).map((o) => o.text), toolUseId: msg.toolUseId ?? null });
    } else {
      // even-terminal also emits "notification" for API retries — those are noise on a HUD.
      if (/^API Retry$/i.test(msg.title ?? "")) return;
      this.emit({ ...base, kind: "notification", text: [msg.title, msg.message].filter(Boolean).join(": ") });
    }
  }
}
