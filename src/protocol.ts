/**
 * The wire contract between the glasses app and the bridge.
 *
 * Mirrored by `bridge/protocol.mjs` — when you change one, change the other.
 * `tests/protocol.test.ts` and `bridge/test/protocol.test.mjs` both assert the
 * frame shapes, so a drift between the two halves fails a test rather than
 * failing silently on the lens.
 *
 * Everything added for the Claude Code backend is an OPTIONAL field or a NEW
 * frame type. A bridge that never sends `ask`/`activity`/`hosts` still drives
 * this client correctly, which is what keeps the change upstreamable.
 */

export interface SessionItem {
  /**
   * Composite `"<hostKey>/<sessionId>"`. The client treats it as opaque; only
   * the bridge splits it. That is what lets one list span several machines
   * without the client knowing anything about hosts beyond a display tag.
   */
  id: string;
  title: string;
  /** Unix seconds of last activity. */
  updated: number;
  tokens?: number;
  /** Short host key for display, e.g. `ov` / `ch`. Absent on single-host bridges. */
  host?: string;
  /** The agent is mid-turn on this session right now. */
  busy?: boolean;
}

/** A machine the bridge can reach, as advertised in the `sessions` frame. */
export interface HostItem {
  key: string;
  name: string;
  online: boolean;
}

/**
 * `permission` = a blocked tool call (`allow` / `deny`).
 * `question`   = an AskUserQuestion with its own option labels.
 *
 * Both are answered by SPEAKING — the bridge routes the next `text` frame on
 * that session to the matching even-terminal endpoint instead of starting a
 * new turn. See bridge/session.mjs.
 */
export type AskKind = "permission" | "question";

export type HistoryItem =
  | { kind: "user"; text: string }
  | { kind: "tool"; name: string; label?: string; running: boolean; ok?: boolean }
  | { kind: "assistant"; text: string }
  | { kind: "banner"; text: string }
  | { kind: "ask"; ask: AskKind; text: string; options?: string[]; answered?: boolean };

export type ServerMsg =
  | { t: "hello.ok"; caps: Record<string, unknown>; active: string | null }
  | { t: "sessions"; items: SessionItem[]; active: string | null; hosts?: HostItem[] }
  | { t: "active"; id: string }
  | { t: "history"; id: string; items: HistoryItem[]; ok?: boolean }
  | { t: "transcript"; text: string }
  | { t: "assistant"; text: string }
  | { t: "assistant.delta"; text: string }
  | { t: "tool.start"; name: string; label?: string; emoji?: string }
  | { t: "tool.end"; name: string; ok: boolean }
  | { t: "ask"; ask: AskKind; text: string; options?: string[] }
  | { t: "ask.done" }
  | { t: "activity"; id: string; host?: string; title: string; preview: string }
  | { t: "turn.done" }
  | { t: "error"; msg: string };

const SERVER_TYPES = new Set([
  "hello.ok",
  "sessions",
  "active",
  "history",
  "transcript",
  "assistant",
  "assistant.delta",
  "tool.start",
  "tool.end",
  "ask",
  "ask.done",
  "activity",
  "turn.done",
  "error",
]);

export const hello = (token: string, device: string) =>
  JSON.stringify({ t: "hello", token, device });

export const sessionsList = () => JSON.stringify({ t: "sessions.list" });

export const sessionsSwitch = (id: string) =>
  JSON.stringify({ t: "sessions.switch", id });

/**
 * `host` picks the machine the new session spawns on. Omitted, the bridge uses
 * its first configured host — which is the single-host behaviour of the
 * original protocol.
 */
export const sessionsNew = (host?: string, title?: string) =>
  JSON.stringify({ t: "sessions.new", host, title });

export const textMsg = (text: string) => JSON.stringify({ t: "text", text });

export const stopMsg = () => JSON.stringify({ t: "stop" });

export const audioStart = () => JSON.stringify({ t: "audio.start" });
export const audioStop = () => JSON.stringify({ t: "audio.stop" });

export function parseServer(raw: string): ServerMsg {
  const m = JSON.parse(raw);
  if (!m || typeof m.t !== "string" || !SERVER_TYPES.has(m.t))
    throw new Error(`bad server msg: ${raw}`);
  return m as ServerMsg;
}
