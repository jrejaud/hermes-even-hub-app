/**
 * The multi-host half: one merged session list across every configured machine,
 * plus the activity watcher that notices a session moving while the wearer is
 * looking at something else.
 *
 * "Host" is config, never a constant — adding a third machine is a line in
 * hosts.json, not a code change.
 */

import { EvenTerminal, HostOffline } from "./even-terminal.mjs";
import { compositeId, splitId } from "./protocol.mjs";

/** How stale a merged session list may be before a `sessions.list` refetches. */
const LIST_TTL_MS = 3_000;

export class Fleet {
  /** @param {Array<{key,name,url,token,provider?}>} hostConfigs */
  constructor(hostConfigs, { log = () => {} } = {}) {
    if (!hostConfigs?.length) throw new Error("at least one host must be configured");
    /** @type {Map<string, EvenTerminal>} */
    this.hosts = new Map(hostConfigs.map((c) => [c.key, new EvenTerminal(c)]));
    this.log = log;
    this.defaultHost = hostConfigs[0].key;
    this._cache = { at: 0, items: [] };
  }

  host(key) {
    return this.hosts.get(key);
  }

  /** Resolve a composite id to `{host, sessionId}` with the EvenTerminal attached. */
  resolve(composite) {
    const parts = splitId(composite);
    if (!parts) return null;
    const host = this.hosts.get(parts.host);
    if (!host) return null;
    return { host, sessionId: parts.sessionId };
  }

  hostList() {
    return [...this.hosts.values()].map((h) => ({ key: h.key, name: h.name, online: h.online }));
  }

  /**
   * Every host's sessions, merged and newest-first.
   *
   * A host that is down contributes nothing and does NOT fail the call — an
   * ad-hoc even-terminal on a laptop is offline most of the time by design, and
   * one sleeping machine must never blank the whole list. The host's `online`
   * flag carries that fact to the lens instead.
   */
  async sessions({ limit = 40, force = false } = {}) {
    const now = Date.now();
    if (!force && now - this._cache.at < LIST_TTL_MS) return this._cache.items;

    const perHost = await Promise.all(
      [...this.hosts.values()].map(async (h) => {
        try {
          const raw = await h.sessions(limit);
          return raw.map((s) => toSessionItem(h, s));
        } catch (err) {
          if (!(err instanceof HostOffline)) this.log(`[fleet] ${h.key} sessions failed: ${err.message}`);
          return [];
        }
      }),
    );

    const items = perHost.flat().sort((a, b) => b.updated - a.updated).slice(0, limit);
    this._cache = { at: now, items };
    return items;
  }

  /** Force the next `sessions()` to hit the network — used right after a spawn. */
  invalidate() {
    this._cache = { at: 0, items: [] };
  }
}

export function toSessionItem(host, s) {
  return {
    id: compositeId(host.key, s.id),
    title: (s.title ?? "").trim(),
    updated: Math.floor(new Date(s.timestamp ?? 0).getTime() / 1000) || 0,
    host: host.key,
    busy: s.status === "busy",
  };
}

/**
 * Watches every host for sessions that move while the wearer is elsewhere.
 *
 * Fires on two transitions, which are the two a wearer actually cares about:
 *   - the session's timestamp advanced (it said something new)
 *   - it went busy -> idle (it FINISHED, which is the notification worth a tap)
 *
 * Deliberately polls the cheap `/api/sessions` list rather than subscribing per
 * session: it is one request per host regardless of how many sessions exist, and
 * it keeps working for sessions that are not loaded in memory (`/api/status`
 * 404s for those, `/api/messages` returns empty).
 */
export class ActivityWatcher {
  constructor(fleet, { intervalMs = 5_000, log = () => {} } = {}) {
    this.fleet = fleet;
    this.intervalMs = intervalMs;
    this.log = log;
    /** @type {Map<string,{updated:number,busy:boolean}>} */
    this.seen = new Map();
    this.timer = undefined;
    this.listeners = new Set();
    this.primed = false;
  }

  onActivity(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.log(`[watch] ${e.message}`)), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    void this.tick().catch(() => {});
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick() {
    const items = await this.fleet.sessions({ force: true });
    const events = [];

    for (const item of items) {
      const prev = this.seen.get(item.id);
      this.seen.set(item.id, { updated: item.updated, busy: !!item.busy });
      if (!prev) continue; // first sight of a session is not "activity"
      const advanced = item.updated > prev.updated;
      const finished = prev.busy && !item.busy;
      if (advanced || finished) events.push({ item, finished });
    }

    // The very first tick populates the map; without this guard every session in
    // history would fire a notification the moment the bridge starts.
    if (!this.primed) {
      this.primed = true;
      return;
    }

    for (const e of events) {
      const preview = await this.previewFor(e.item, e.finished);
      for (const fn of this.listeners) fn({ ...e.item, preview, finished: e.finished });
    }
  }

  /** Last thing the session said, for the notification body. Falls back to the title. */
  async previewFor(item, finished) {
    const resolved = this.fleet.resolve(item.id);
    if (!resolved) return item.title;
    try {
      const hist = await resolved.host.history(resolved.sessionId);
      const last = [...hist].reverse().find((h) => (h.text ?? "").trim());
      if (last) return flatten(last.text).slice(0, 120);
    } catch {
      /* a preview is a nicety; never let it break the notification */
    }
    return finished ? `${item.title || "session"} finished` : item.title;
  }
}

function flatten(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
