import type { AppState } from "../state/store";
import { sessionsNew, sessionsSwitch, textMsg, sessionsList } from "../protocol";
import { newSessionRows, sessionForListIndex } from "../ui/session-list";
import { nextThreadViewportCursor, previousThreadViewportIndex } from "../ui/stream";

export type Gesture = "click" | "doubleClick" | "scrollUp" | "scrollDown";

export type Effect =
  | { kind: "send"; frame: string }
  | { kind: "startMic" }
  | { kind: "stopMic" }
  | { kind: "exit" };

export interface DispatchResult { state: AppState; effects: Effect[]; }

const enterSession = (s: AppState, active: string | null): AppState => ({
  ...s, screen: "session", phase: "idle", stream: [], pending: null, turn: "idle",
  scrollPage: null,
  history: { loadingFor: active, failedFor: null },
  sessions: { ...s.sessions, active },
});

export function dispatch(s: AppState, g: Gesture, index?: number): DispatchResult {
  // The activity alert owns every gesture while it is up: tap goes straight to
  // the session that moved, anything else dismisses back to where you were.
  if (s.screen === "alert") {
    const notice = s.notice;
    const dismissed: AppState = { ...s, notice: null, screen: s.screenBeforeAlert };
    if (g === "click" && notice) {
      return {
        state: { ...enterSession(s, notice.id), notice: null, unread: s.unread.filter((id) => id !== notice.id) },
        effects: [{ kind: "send", frame: sessionsSwitch(notice.id) }],
      };
    }
    return {
      state: dismissed,
      effects: dismissed.screen === "list" ? [{ kind: "send", frame: sessionsList() }] : [],
    };
  }

  if (s.screen === "list") {
    if (!s.sessionsLoaded) return { state: s, effects: [] };
    if (g === "click") {
      const i = index ?? 0; // proto3 omits index 0 → undefined means the first ＋New row
      // A name lookup that found nothing yields -1. It must stay a no-op, not
      // fall into the ＋New branch and spawn a session nobody asked for.
      if (i < 0) return { state: s, effects: [] };
      const newRows = newSessionRows(s.hosts);
      if (i < newRows.length) {
        // With several hosts each ＋New row names one, so choosing where a
        // session spawns costs no extra screen and no extra gesture.
        const host = s.hosts.length > 1 ? s.hosts[i]?.key : undefined;
        return { state: enterSession(s, null), effects: [{ kind: "send", frame: sessionsNew(host) }] };
      }
      const item = sessionForListIndex(s.sessions.items, i, newRows.length);
      if (!item) return { state: s, effects: [] };
      return {
        state: { ...enterSession(s, item.id), unread: s.unread.filter((id) => id !== item.id) },
        effects: [{ kind: "send", frame: sessionsSwitch(item.id) }],
      };
    }
    if (g === "doubleClick") return { state: s, effects: [{ kind: "exit" }] };
    return { state: s, effects: [] };
  }
  // screen === "session"
  if (s.phase === "idle") {
    if (g === "click") return { state: { ...s, phase: "recording", scrollPage: null }, effects: [{ kind: "startMic" }] };
    if (g === "doubleClick") return { state: { ...s, screen: "list", phase: "idle", pending: null }, effects: [{ kind: "send", frame: sessionsList() }] };
    if (g === "scrollUp") {
      const prev = previousThreadViewportIndex(s.stream, s.scrollPage);
      return prev === s.scrollPage ? { state: s, effects: [] } : { state: { ...s, scrollPage: prev }, effects: [] };
    }
    if (g === "scrollDown") {
      const next = nextThreadViewportCursor(s.stream, s.scrollPage);
      return next === s.scrollPage ? { state: s, effects: [] } : { state: { ...s, scrollPage: next }, effects: [] };
    }
    return { state: s, effects: [] };
  }
  if (s.phase === "recording") {
    if (g === "click") return { state: { ...s, phase: "transcribing" }, effects: [{ kind: "stopMic" }] };
    if (g === "doubleClick") return { state: { ...s, phase: "idle" }, effects: [{ kind: "stopMic" }] };
    return { state: s, effects: [] };
  }
  if (s.phase === "transcribing") {
    if (g === "doubleClick") return { state: { ...s, phase: "idle" }, effects: [] };
    return { state: s, effects: [] };
  }
  if (s.phase === "review") {
    if (g === "click" && s.pending) {
      const text = s.pending.transcript;
      return {
        state: { ...s, stream: [...s.stream, { kind: "user", text }], pending: null, phase: "idle", turn: "thinking", scrollPage: null },
        effects: [{ kind: "send", frame: textMsg(text) }],
      };
    }
    if (g === "scrollDown") return { state: { ...s, pending: null, phase: "idle" }, effects: [] };
    if (g === "doubleClick") return { state: { ...s, screen: "list", phase: "idle", pending: null }, effects: [{ kind: "send", frame: sessionsList() }] };
    return { state: s, effects: [] };
  }
  return { state: s, effects: [] };
}
