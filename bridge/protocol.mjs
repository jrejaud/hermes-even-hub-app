/**
 * Server half of the wire contract. Mirrors `src/protocol.ts` — change both.
 *
 * Frame builders only; no I/O. `bridge/test/protocol.test.mjs` asserts these
 * against the same shapes `tests/protocol.test.ts` asserts on the client, so a
 * drift between the halves fails a test instead of failing on the lens.
 */

export const CLIENT_TYPES = new Set([
  "hello",
  "sessions.list",
  "sessions.switch",
  "sessions.new",
  "text",
  "stop",
  "audio.start",
  "audio.stop",
]);

export const helloOk = (caps, active) => ({ t: "hello.ok", caps, active });
export const sessions = (items, active, hosts) => ({ t: "sessions", items, active, hosts });
export const active = (id) => ({ t: "active", id });
export const history = (id, items, ok = true) => ({ t: "history", id, items, ok });
export const transcript = (text) => ({ t: "transcript", text });
export const assistant = (text) => ({ t: "assistant", text });
export const assistantDelta = (text) => ({ t: "assistant.delta", text });
export const toolStart = (name, label) => (label ? { t: "tool.start", name, label } : { t: "tool.start", name });
export const toolEnd = (name, ok) => ({ t: "tool.end", name, ok });
export const ask = (kind, text, options) =>
  options?.length ? { t: "ask", ask: kind, text, options } : { t: "ask", ask: kind, text };
export const askDone = () => ({ t: "ask.done" });
export const activity = (id, host, title, preview) => ({ t: "activity", id, host, title, preview });
export const turnDone = () => ({ t: "turn.done" });
export const error = (msg) => ({ t: "error", msg });

/**
 * Composite session ids keep the client host-agnostic: it round-trips an opaque
 * string, and only the bridge knows it names a machine. A session id from
 * even-terminal is a UUID, so `/` is an unambiguous separator.
 */
export const compositeId = (hostKey, sessionId) => `${hostKey}/${sessionId}`;

export function splitId(composite) {
  if (typeof composite !== "string") return null;
  const slash = composite.indexOf("/");
  if (slash <= 0 || slash === composite.length - 1) return null;
  return { host: composite.slice(0, slash), sessionId: composite.slice(slash + 1) };
}

export function parseClient(raw) {
  const m = JSON.parse(raw);
  if (!m || typeof m.t !== "string" || !CLIENT_TYPES.has(m.t)) {
    throw new Error(`bad client msg: ${String(raw).slice(0, 120)}`);
  }
  return m;
}
