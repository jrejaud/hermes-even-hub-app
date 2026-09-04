/**
 * A deterministic gallery of every screen the app can show.
 *
 * The UI is only checkable by LOOKING at it, and most states are awkward to
 * reach against a live backend: recording needs a mic, an unanswered permission
 * needs a blocked agent, a 4-page thread needs a long turn. Reaching them by
 * luck means most states never get looked at, which is how a header ended up
 * overlapping the connection dot without anyone noticing.
 *
 * So: fixed states, advanced by a tap, screenshotted one per frame. Enabled only
 * when `VITE_UI_GALLERY=1`, so it cannot ship — and it is driven by
 * `scripts/ui-gallery.mjs`, which captures the whole set into `docs/ui/`.
 */

import type { AppState } from "../state/store";
import { initialState } from "../state/store";
import type { HostItem, SessionItem } from "../protocol";

export const GALLERY_ENABLED = import.meta.env.VITE_UI_GALLERY === "1";

const HOSTS: HostItem[] = [
  { key: "ov", name: "overlord", online: true },
  { key: "ch", name: "chiba", online: true },
];

const NOW = 1_780_000_000;

const SESSIONS: SessionItem[] = [
  { id: "ov/1", title: "Execute Linear card SC-4983 end-to-end", updated: NOW - 20, host: "ov", busy: true },
  { id: "ch/2", title: "You route an incoming email to at most ONE of a set of waiting cards", updated: NOW - 400, host: "ch" },
  { id: "ov/3", title: "WinlatorXR Quest 3 setup", updated: NOW - 3_600, host: "ov" },
  { id: "ch/4", title: "Полное имя на кириллице для проверки ширины", updated: NOW - 90_000, host: "ch" },
  { id: "ov/5", title: "New session", updated: NOW - 200_000, host: "ov" },
];

const LONG_REPLY =
  "The deploy finished on chiba at 14:02. Three services restarted cleanly and the " +
  "health check passed on the first try. One thing worth knowing: the migration added " +
  "an index concurrently, so the table was never locked, but it means the old query " +
  "plan is still cached on two of the replicas until they cycle.";

function base(over: Partial<AppState>): AppState {
  return {
    ...initialState(),
    conn: "connected",
    sessionsLoaded: true,
    hosts: HOSTS,
    sessions: { items: SESSIONS, active: "ov/1" },
    ...over,
  };
}

export interface GalleryFrame {
  name: string;
  /** What a reviewer should be checking in this frame. */
  looking_for: string;
  state: AppState;
}

export const FRAMES: GalleryFrame[] = [
  {
    name: "01-loading",
    looking_for: "boot text is readable and not jammed into the top-left corner",
    state: { ...initialState(), conn: "connecting", sessionsLoaded: false },
  },
  {
    name: "02-setup",
    looking_for: "the not-configured message, when no bridge profile exists",
    state: { ...initialState(), conn: "not configured", sessionsLoaded: false },
  },
  {
    name: "03-list",
    looking_for: "two +New rows, host tags, ages; nothing clipped at the right edge",
    state: base({ screen: "list", sessions: { items: SESSIONS, active: null } }),
  },
  {
    name: "04-list-unread",
    looking_for: "the * unread marker reads as a marker, not as part of the title",
    state: base({ screen: "list", sessions: { items: SESSIONS, active: null }, unread: ["ch/2", "ov/3"] }),
  },
  {
    name: "05-list-host-offline",
    looking_for: "an offline host is legible on its +New row",
    state: base({
      screen: "list",
      hosts: [HOSTS[0], { key: "ch", name: "chiba", online: false }],
      sessions: { items: SESSIONS, active: null },
    }),
  },
  {
    name: "06-session-empty",
    looking_for: "header, dot and status bar with an empty thread — the header must NOT touch the dot",
    state: base({ screen: "session", stream: [] }),
  },
  {
    name: "07-session-thread",
    looking_for: "user / assistant / tool rows, and the page counter in the status bar",
    state: base({
      screen: "session",
      stream: [
        { kind: "user", text: "did the deploy finish on chiba" },
        { kind: "tool", name: "Bash", running: false, ok: true },
        { kind: "assistant", text: LONG_REPLY },
      ],
    }),
  },
  {
    name: "08-session-tool-running",
    looking_for: "a running tool row, and the status bar naming it",
    state: base({
      screen: "session",
      turn: "working",
      stream: [
        { kind: "user", text: "run the tests" },
        { kind: "tool", name: "Bash", running: true },
      ],
    }),
  },
  {
    name: "09-session-ask-permission",
    looking_for: "the blocked-agent row must be the loudest thing on screen",
    state: base({
      screen: "session",
      stream: [
        { kind: "user", text: "list my beeper accounts" },
        { kind: "ask", ask: "permission", text: "Allow Bash List Beeper accounts? — say yes or no", options: ["allow", "deny"] },
      ],
    }),
  },
  {
    name: "10-session-ask-question",
    looking_for: "the question and its spoken option labels both fit",
    state: base({
      screen: "session",
      stream: [
        { kind: "user", text: "deploy it" },
        { kind: "ask", ask: "question", text: "Which branch should I deploy? — say: main, or dev", options: ["main", "dev"] },
      ],
    }),
  },
  {
    name: "11-session-recording",
    looking_for: "the recording indicator is unmistakable at a glance",
    state: base({ screen: "session", phase: "recording", stream: [{ kind: "assistant", text: LONG_REPLY }] }),
  },
  {
    name: "12-session-review",
    looking_for: "the pending transcript reads as YOURS, not as the agent's",
    state: base({
      screen: "session",
      phase: "review",
      pending: { transcript: "restart the bridge on chiba and tell me when it is back" },
      stream: [{ kind: "assistant", text: "Ready." }],
    }),
  },
  {
    name: "13-session-long-thread",
    looking_for: "a thread longer than one viewport: page counter, no mid-word clipping",
    state: base({
      screen: "session",
      stream: [
        { kind: "user", text: "walk me through what happened" },
        { kind: "assistant", text: LONG_REPLY },
        { kind: "tool", name: "Read", running: false, ok: true },
        { kind: "assistant", text: LONG_REPLY },
        { kind: "tool", name: "Bash", running: false, ok: false },
        { kind: "assistant", text: LONG_REPLY },
      ],
    }),
  },
  {
    name: "14-alert",
    looking_for: "the notification names the machine and shows real preview text",
    state: base({
      screen: "alert",
      screenBeforeAlert: "list",
      notice: { id: "ch/2", host: "ch", title: "email router", preview: "Routed to SC-4991 — waiting-for-email card matched on the sender." },
    }),
  },
  {
    name: "15-session-long-title",
    looking_for: "a long title must be truncated BEFORE the connection dot, never under it",
    state: base({
      screen: "session",
      sessions: { items: SESSIONS, active: "ch/2" },
      stream: [{ kind: "assistant", text: "Ready." }],
    }),
  },
  {
    name: "16-disconnected",
    looking_for: "the reconnecting dot is distinguishable from the connected one",
    state: base({ screen: "session", conn: "reconnecting", stream: [{ kind: "assistant", text: "Ready." }] }),
  },
];

/** Fixed clock for the gallery, so row ages are identical across runs. */
export const GALLERY_NOW = 1_780_000_000;
