import type { AskKind, HistoryItem, HostItem, ServerMsg, SessionItem } from "../protocol";

export type Screen = "list" | "session" | "alert";
export type Phase = "idle" | "recording" | "transcribing" | "review";
export type Turn = "idle" | "thinking" | "working";

export type StreamItem = HistoryItem;

/** A session other than the one on screen produced output. Tap opens it. */
export interface Notice {
  id: string;
  host?: string;
  title: string;
  preview: string;
}

export interface AppState {
  screen: Screen;
  phase: Phase;
  conn: string;
  sessions: { items: SessionItem[]; active: string | null };
  sessionsLoaded: boolean;
  hosts: HostItem[];
  history: { loadingFor: string | null; failedFor: string | null };
  stream: StreamItem[];
  pending: { transcript: string } | null;
  turn: Turn;
  scrollPage: number | null; // null = follow latest viewport; number = measured viewport index (held)
  /** Raised by an `activity` frame; owns the screen until opened or dismissed. */
  notice: Notice | null;
  /** Where dismissing the alert returns to. */
  screenBeforeAlert: Screen;
  /** Composite ids with activity the wearer has not looked at yet. */
  unread: string[];
}

export function initialState(): AppState {
  return {
    screen: "list",
    phase: "idle",
    conn: "connecting",
    sessions: { items: [], active: null },
    sessionsLoaded: false,
    hosts: [],
    history: { loadingFor: null, failedFor: null },
    stream: [],
    pending: null,
    turn: "idle",
    scrollPage: null,
    notice: null,
    screenBeforeAlert: "list",
    unread: [],
  };
}

// Assistant output before the first user item is the session banner (model,
// cwd, …); after the user has spoken it is normal assistant text. Either kind
// extends its own trailing segment so streamed deltas coalesce.
function appendStream(stream: StreamItem[], delta: string): StreamItem[] {
  const kind: "assistant" | "banner" =
    stream.some((it) => it.kind === "user") ? "assistant" : "banner";
  const last = stream[stream.length - 1];
  if (last && last.kind === kind) {
    return [...stream.slice(0, -1), { kind, text: last.text + delta }];
  }
  return [...stream, { kind, text: delta }];
}

function replaceAssistantSnapshot(stream: StreamItem[], text: string): StreamItem[] {
  const kind: "assistant" | "banner" =
    stream.some((it) => it.kind === "user") ? "assistant" : "banner";
  const last = stream[stream.length - 1];
  if (last && last.kind === kind) {
    return [...stream.slice(0, -1), { kind, text }];
  }
  return [...stream, { kind, text }];
}

function patchTool(stream: StreamItem[], name: string, ok: boolean): StreamItem[] {
  for (let i = stream.length - 1; i >= 0; i--) {
    const it = stream[i];
    if (it.kind === "tool" && it.running && it.name === name) {
      const patched: StreamItem = { kind: "tool", name: it.name, label: it.label, running: false, ok };
      return [...stream.slice(0, i), patched, ...stream.slice(i + 1)];
    }
  }
  return stream;
}

/** Mark the newest outstanding ask answered so the bar stops demanding a reply. */
function closeAsk(stream: StreamItem[]): StreamItem[] {
  for (let i = stream.length - 1; i >= 0; i--) {
    const it = stream[i];
    if (it.kind === "ask" && !it.answered) {
      return [...stream.slice(0, i), { ...it, answered: true }, ...stream.slice(i + 1)];
    }
  }
  return stream;
}

/** The newest ask still waiting on the wearer, if any. */
export function openAsk(s: AppState): (StreamItem & { kind: "ask" }) | null {
  for (let i = s.stream.length - 1; i >= 0; i--) {
    const it = s.stream[i];
    if (it.kind === "ask") return it.answered ? null : it;
  }
  return null;
}

export function reduce(s: AppState, m: ServerMsg): AppState {
  switch (m.t) {
    case "hello.ok":
      return { ...s, sessions: { ...s.sessions, active: m.active } };
    case "sessions":
      return {
        ...s,
        sessionsLoaded: true,
        hosts: m.hosts ?? s.hosts,
        sessions: {
          items: m.items,
          active: isHistoryLoading(s) ? s.sessions.active : m.active,
        },
      };
    case "active":
      return {
        ...s,
        sessions: { ...s.sessions, active: m.id },
        history: { loadingFor: m.id, failedFor: null },
        unread: s.unread.filter((id) => id !== m.id),
      };
    case "history":
      if (m.id !== s.sessions.active && m.id !== s.history.loadingFor) return s;
      return {
        ...s,
        sessions: { ...s.sessions, active: m.id },
        history: { loadingFor: null, failedFor: m.ok === false ? m.id : null },
        stream: m.items,
        pending: null,
        phase: "idle",
        turn: "idle",
        scrollPage: null,
        unread: s.unread.filter((id) => id !== m.id),
      };
    case "error":
      return { ...s, conn: `error: ${m.msg}` };
    case "assistant.delta":
      return { ...s, history: { loadingFor: null, failedFor: null }, stream: appendStream(s.stream, m.text), scrollPage: null };
    case "assistant":
      return { ...s, history: { loadingFor: null, failedFor: null }, stream: replaceAssistantSnapshot(s.stream, m.text), scrollPage: null };
    case "tool.start":
      return {
        ...s,
        history: { loadingFor: null, failedFor: null },
        stream: [...s.stream, { kind: "tool", name: m.name, label: m.label, running: true }],
        turn: "working",
        scrollPage: null,
      };
    case "tool.end":
      return { ...s, stream: patchTool(s.stream, m.name, m.ok) };
    case "ask":
      // A blocked agent is the one thing that must never scroll off unseen:
      // jump to the newest viewport and say what it is waiting for.
      return {
        ...s,
        stream: [...s.stream, { kind: "ask", ask: m.ask as AskKind, text: m.text, options: m.options }],
        turn: "idle",
        scrollPage: null,
      };
    case "ask.done":
      return { ...s, stream: closeAsk(s.stream), turn: "thinking" };
    case "activity": {
      if (m.id === s.sessions.active) return s;
      const unread = s.unread.includes(m.id) ? s.unread : [...s.unread, m.id];
      // Never steal the screen mid-utterance — an alert raised while recording
      // would drop the mic and lose what was being said.
      if (s.phase !== "idle" || s.screen === "alert") return { ...s, unread };
      return {
        ...s,
        unread,
        notice: { id: m.id, host: m.host, title: m.title, preview: m.preview },
        screenBeforeAlert: s.screen,
        screen: "alert",
      };
    }
    case "turn.done":
      return { ...s, turn: "idle" };
    case "transcript":
      if (s.phase !== "transcribing") return s;
      return m.text.trim()
        ? { ...s, pending: { transcript: m.text }, phase: "review", scrollPage: null }
        : { ...s, phase: "idle" };
    default:
      return s;
  }
}

export function barText(s: AppState): string {
  switch (s.phase) {
    case "recording": return "🎤 recording…";
    case "transcribing": return "transcribing…";
    case "review": return "tap = send · swipe↓ = redo";
    case "idle":
    default: {
      if (isHistoryLoading(s)) return "loading session...";
      if (isHistoryUnavailable(s)) return "history unavailable";
      const asking = openAsk(s);
      // The wearer has no keyboard: say plainly that speaking IS the answer.
      if (asking) return asking.ask === "permission" ? "tap to answer · yes or no" : "tap to answer aloud";
      if (s.turn === "working") {
        for (let i = s.stream.length - 1; i >= 0; i--) {
          const it = s.stream[i];
          if (it.kind === "tool" && it.running) return `working… (${it.name})`;
        }
        return "working…";
      }
      return s.turn === "thinking" ? "thinking…" : "ready";
    }
  }
}

export function connDot(conn: string): string {
  return conn === "connected" ? "●" : "◌";
}

export function isHistoryLoading(s: AppState): boolean {
  return Boolean(s.sessions.active && s.history.loadingFor === s.sessions.active);
}

export function isHistoryUnavailable(s: AppState): boolean {
  return Boolean(s.sessions.active && s.history.failedFor === s.sessions.active);
}
