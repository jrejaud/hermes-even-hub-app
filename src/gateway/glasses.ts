// VENDORED from aristo-v2 packages/shared/glasses.ts (SC-9499) — do not edit by hand.
// `npm run contract:sync` re-copies it; `npm run contract:check` fails when it drifted.
// The three protocol.ts types it imports live in ./aristo-types.ts (copied by the same script).
// ---- BEGIN VENDORED ----
import type { AnswerArgs, Priority, SessionStatus } from "./aristo-types";

// The glasses gateway's wire format (SC-9499, parent SC-9497): what Aristo Lens (the Even G2 app) and the
// gateway on the views home (Chiba) say to each other over ONE socket.
//
// The rule that shapes every type here: the glasses never interpret a prompt, a view or a status. Aristo's
// shared presenters (prompt-present.ts, view-engine.ts) produce the words, the order and the ready-made answer
// payloads; the lens only lays them out, truncates them, and echoes a payload back. A field the lens would have
// to compute is a field missing from this file.
//
// Shape of the conversation:
//  - The phone opens `wss://<views home>/api/glasses?token=<token>` (a WebView cannot set headers; an
//    `Authorization: Bearer <token>` header is accepted too). A missing or wrong token is refused with HTTP 401
//    before the upgrade. Tailnet only, like the rest of aristod.
//  - The server says `hello`, then `home`.
//  - The client says which ONE screen is open (`open`). The server sends that screen's frame and re-sends it
//    whole, throttled, whenever what it shows changes. A screen frame is the complete state of that screen, so
//    a client that resumes (the WebView is suspended when the phone sleeps) just re-sends `open`.
//    Nothing else is streamed: no message firehose, no rows of screens that are not open.
//  - `banner` arrives on any screen when a new ask appears in a session the open screen does not show.
//  - Every client request carries a `reqId`; the server answers it with `ok` or `refused`.

/** Bump when a frame changes incompatibly; the server says its version in `hello`. */
export const GLASSES_PROTOCOL = 1;
/** The socket path on the views home. */
export const GLASSES_PATH = "/api/glasses";
/** Rows a `view` frame carries when the client does not say (the lens shows 6 to 8). */
export const GLASSES_VIEW_LIMIT = 20;
/** Audio one `listen` takes before it ends by itself (as if `listen.end` had come). */
export const GLASSES_LISTEN_MAX_MS = 60_000;
/** `partial` frames are sent at most this often. */
export const GLASSES_PARTIAL_MS = 200;
/** Messages a `thread` frame carries when the client does not say. */
export const GLASSES_THREAD_LIMIT = 12;

/** A session, everywhere on the glasses: `<hostId>/<sessionId>` (Aristo's own org key). */
export type GlassesKey = string;

/** The one fixed set of status markers (design rule 8). The lens maps each to a firmware glyph and a
 *  brightness; it never derives one from a raw status itself.
 *  needs = waiting on Jordan (a question or permission is pending), your-turn = idle, it is Jordan's move. */
export type GlassesMark = "needs" | "working" | "your-turn" | "asleep" | "done" | "error";

// ---------------------------------------------------------------------------------------------- server → lens

/** One entry on Home: Inbox first, then the views starred in Aristo, in Aristo's order. */
export interface GlassesHomeView {
  id: string;
  name: string;
  /** Sessions in it that need Jordan, by Aristo's Inbox rule: waiting on him, or his turn (idle, finished). */
  needs: number;
  /** Sessions in it working right now. */
  working: number;
  /** Every session it shows. */
  total: number;
}

/** One session row, already presented (design rule 6: marker, title, right-side detail). */
export interface GlassesRow {
  key: GlassesKey;
  hostId: string;
  /** The list title Aristo shows (card id and alert tags stripped), never empty. */
  title: string;
  mark: GlassesMark;
  /** The status in Aristo's words ("Waiting on you", "Working", "💤 Asleep"…). */
  status: string;
  /** One line: the pending ask's summary when it waits, else what it is doing, else "". Plain text. */
  detail: string;
  /** "3m", "2h", "4d": how long since it last changed in a way that matters. */
  age: string;
  /** The repo folder (`aristo-v2`), or "" when none. */
  project: string;
  /** The oldest pending prompt's id when it waits on Jordan; answer it with `answer`. */
  promptId: string | null;
  /** Nesting under a parent shown in the same view (0 = top level). */
  depth: number;
}

/** A section of a view (its grouping); a view grouped by "none" has one section labelled with the view's name. */
export interface GlassesSection {
  label: string;
  rows: GlassesRow[];
}

/** One answer the lens can offer: the label, and the exact `prompt.answer` payload to echo back. */
export interface GlassesOption {
  /** Short label for the lens ("Yes", "Always", "No", a question's choice). */
  label: string;
  /** The full text Claude Code shows for it ("Yes, and don't ask again for git:*"), for a detail line. */
  title: string;
  /** yes / always / no for a permission; choice for a question's option. */
  kind: "yes" | "always" | "no" | "choice";
  /** The safe option first (design rule 9): the default cursor position. */
  primary: boolean;
  /** Echo this back verbatim in `answer.answer`. `promptId` is inside it. */
  answer: AnswerArgs;
}

/** A pending question or permission, presented (design rule 9: the ask, the detail, then the options). */
export interface GlassesAsk {
  key: GlassesKey;
  promptId: string;
  kind: "question" | "permission";
  /** The heading: "Question", "Bash command", "Edit file", "Ready to code?"… */
  ask: string;
  /** Who asks, when a subagent does ("Explore asks:"), else null. */
  asker: string | null;
  /** The question text, or the tool's target (the command, the file path). Plain text, may be long: the lens truncates. */
  detail: string;
  /** The agent's last message before it asked, plain text, or null. */
  context: string | null;
  /** Ready-made answers, in display order. Empty when only typed text can answer (see `freeText`). */
  options: GlassesOption[];
  /** The ask also takes a typed or dictated answer: send `answer` with `text`. */
  freeText: boolean;
  /** Questions beyond the first that the lens cannot show (answer the rest in Aristo); 0 normally. */
  more: number;
  /** ISO time it was asked. */
  createdAt: string;
}

/** One message of a thread, as plain text. */
export interface GlassesLine {
  who: "you" | "agent" | "tool";
  text: string;
  /** ISO time, or "" when the log had none. */
  at: string;
}

export type GlassesServerFrame =
  /** First frame; sent again whenever a host comes up or goes down. */
  | { t: "hello"; protocol: number; host: string; hosts: { id: string; up: boolean }[] }
  /** Home: Inbox + starred views. Re-sent when a count changes while Home is open. */
  | { t: "home"; views: GlassesHomeView[] }
  /** An open view. `more` = rows beyond `limit` that were left out. */
  | { t: "view"; viewId: string; name: string; needs: number; total: number; sections: GlassesSection[]; more: number }
  /** An open session: its row, its pending ask (null when none) and its last messages. */
  | { t: "thread"; row: GlassesRow; ask: GlassesAsk | null; lines: GlassesLine[] }
  /** A new ask in a session the open screen does not show. Tapping it opens that session. */
  | { t: "banner"; key: GlassesKey; title: string; ask: string; promptId: string }
  /** A request worked (`answer`, `say`, `patch`, `stt`, `listen.end`, `listen.cancel`, `interrupt`, `create` reply with
   *  this). `stt` and `listen.end` carry `text`; `create` carries the new session's `key`. */
  | { t: "ok"; reqId: string; text?: string; key?: GlassesKey }
  /** Streaming speech to text (SC-9704): sent while a `listen` is open whenever the recogniser returns words, at most
   *  ~5 per second. `final` = all settled text so far, `interim` = the not-yet-final tail (may still change). Show
   *  `final + interim`; the transcript to send is the `ok` that answers `listen.end`. */
  | { t: "partial"; reqId: string; final: string; interim: string }
  /** A request refused. `gone` = the prompt was already answered or withdrawn; `changed` = the payload is not one
   *  this prompt offers; `host-down` = the owning host did not answer; `bad` = the frame itself is wrong. */
  | { t: "refused"; reqId: string; reason: "gone" | "changed" | "host-down" | "bad" | "error"; message: string }
  | { t: "pong" };

// ---------------------------------------------------------------------------------------------- lens → server

export type GlassesOpen =
  | { screen: "home" }
  | { screen: "view"; viewId: string; limit?: number }
  | { screen: "session"; key: GlassesKey; limit?: number };

export type GlassesClientFrame =
  /** Which screen is open now; replaces the last one. */
  | ({ t: "open" } & GlassesOpen)
  /** Answer a prompt: echo one option's `answer` payload, or send dictated/typed `text` for a free-text ask. The
   *  prompt id must be the one shown: an answer to a prompt that changed or was answered elsewhere is refused. */
  | { t: "answer"; reqId: string; key: GlassesKey; answer: AnswerArgs }
  | { t: "answer"; reqId: string; key: GlassesKey; promptId: string; text: string }
  /** Send a message to the session (a dictated reply). */
  | { t: "say"; reqId: string; key: GlassesKey; text: string }
  /** Mark it done, close it (set it aside), or set its notification level. One field per frame. */
  | { t: "patch"; reqId: string; key: GlassesKey; done?: true; closed?: true; level?: Priority }
  /** Speech to text on the views home (whisper.cpp): base64 16 kHz mono signed 16-bit little-endian PCM, ≤ 60 s.
   *  The reply is `ok` with `text`; nothing is sent anywhere until the lens sends `say` or `answer`. */
  | { t: "stt"; reqId: string; pcm: string }
  /** Streaming speech to text (SC-9704, Soniox real-time on the views home; the key never leaves the server). Start a
   *  stream for this socket while the wearer holds to talk; `lang` = language hints (default `["en"]`, e.g.
   *  `["en", "ja"]`). No reply on success: `partial` frames follow, and `listen.end` gets the `ok`. Refused (same
   *  reqId) when the recogniser cannot start or fails mid-stream. One listen per socket: a new `listen` cancels the
   *  open one, which is answered `refused` `gone` ("replaced"); a socket that closes cancels its listen. */
  | { t: "listen"; reqId: string; lang?: string[] }
  /** Audio for the open listen with that reqId: base64 16 kHz mono signed 16-bit little-endian PCM (~100-200 ms a
   *  frame). No reply. After 60 s of audio the listen ends by itself, exactly as if `listen.end` had come: the
   *  `ok` with `text` is sent then, and a later `listen.end` for it gets the same `ok` again. */
  | { t: "audio"; reqId: string; pcm: string }
  /** The wearer let go: flush, wait for the final words, reply `ok` with `text` = the whole final transcript,
   *  trimmed ("" if nothing was heard). Nothing is sent to a session: the lens confirms, then sends `say`, `answer`
   *  or `create`. */
  | { t: "listen.end"; reqId: string }
  /** Discard the open listen: the recogniser is closed and `ok` (no text) is the reply. */
  | { t: "listen.cancel"; reqId: string }
  /** Stop a working session, as the web's Stop does (session.interrupt on the owning host). `ok`, or `refused`:
   *  `gone` = it is not working (or not listed), `host-down` = the owning host did not answer. */
  | { t: "interrupt"; reqId: string; key: GlassesKey }
  /** Start a new Aristo session with `text` as its first prompt, origin `glasses`, on the views home in the folder
   *  New Session would pick for it. `viewId` = the view the wearer started from (kept for a per-view default; views
   *  define none today). Reply `ok` with the new session's `key`. */
  | { t: "create"; reqId: string; text: string; viewId?: string }
  | { t: "ping" };

/** The marker for a raw status, for the presenter (not the lens). */
export function markOf(r: { status: SessionStatus; asleep?: boolean | undefined; lifecycle?: string | undefined }, waiting: boolean): GlassesMark {
  if (waiting || r.status === "waiting") return "needs";
  if (r.status === "error") return "error";
  if (r.lifecycle === "done" || r.status === "finished") return "done";
  if (r.status === "working" || r.status === "background" || r.status === "watching") return "working";
  return r.asleep ? "asleep" : "your-turn";
}
// ---- END VENDORED ----
