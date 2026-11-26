/**
 * Aristo Lens: the whole app as a pure state machine (SC-9500, v2 SC-9703).
 *
 * The gateway (Aristo, on Chiba) owns every word, order and answer payload; this file only decides WHICH
 * screen is open, WHERE the cursor sits, and WHAT to send when a gesture lands. Nothing here interprets a
 * prompt or a view: a tap on an option echoes that option's `answer` payload verbatim.
 *
 * v2 (Jordan, 2026-11-12): voice is hold-to-talk only (right temple or ring), and the words stream in while
 * you hold (the gateway relays Soniox partials); the session screen is the conversation, scrolled a few
 * lines at a time, with its actions (Stop, Mark done, Set aside) behind a tap; hold on Home starts a new session.
 *
 * Gestures in, `{ state, effects }` out. The shell (app.ts) runs the effects: socket frames, the mic,
 * persisting the open screen, closing the app.
 */
import { GLASSES_THREAD_LIMIT, GLASSES_VIEW_LIMIT } from '../gateway/glasses';
import type {
  GlassesAsk,
  GlassesCard,
  GlassesHomeView,
  GlassesKey,
  GlassesOpen,
  GlassesRow,
  GlassesServerFrame,
} from '../gateway/glasses';
import type { GlassesClientFrame as ClientFrame, GlassesServerFrame as ServerFrame } from '../gateway/glasses';
import { CONVO_LINES, conversationLines, glide, messageLines, scrollAnchor, topLine } from './conversation';
// layout.ts imports this module too; shownWhole is only called inside functions, so the cycle is safe at load.
import { shownWhole } from './layout';
import { receiveVoice, voiceShown, type ShownVoice } from './voice';

export type ViewFrame = Extract<GlassesServerFrame, { t: 'view' }>;
export type ThreadFrame = Extract<GlassesServerFrame, { t: 'thread' }>;
export type BannerFrame = Extract<GlassesServerFrame, { t: 'banner' }>;
type Reply = Extract<ServerFrame, { t: 'ok' } | { t: 'refused' }>;

/** Connection as the lens reports it in the header's live-status slot. */
export type Conn = 'unconfigured' | 'connecting' | 'online' | 'reconnecting';

export type Screen =
  | { kind: 'home' }
  /** Quiet mode: the lens stays blank while the app runs; a banner appears when a session needs you. */
  | { kind: 'quiet' }
  | { kind: 'view'; viewId: string; name: string }
  | { kind: 'session'; key: GlassesKey; title: string }
  /** The session's actions, opened by a tap on its conversation. */
  | { kind: 'menu'; key: GlassesKey; title: string }
  | Dictation;

/**
 * Hold to talk, then confirm. `reply` talks to a session (a message, or a free-text answer to its ask);
 * `create` starts a new session from what was said.
 */
export interface Dictation {
  kind: 'dictate';
  purpose: 'reply' | 'create';
  /** The session it talks to; null for `create`. */
  key: GlassesKey | null;
  title: string;
  phase: 'listening' | 'finishing' | 'confirm' | 'empty' | 'sending' | 'failed';
  /** Settled words so far (live while listening, the final transcript after). */
  text: string;
  /** The not-yet-final tail Soniox is still deciding on, shown after `text` while listening. */
  interim: string;
  error: string | null;
  /** The reqId of the speech stream (`listen` / `audio` / `listen.end` all carry it). */
  listenId: string;
  /** When the hold started (ms epoch): the timer in the header, the short-hold and 60 s rules. */
  startedAt: number;
  /**
   * Started from the glasses menu, not a hold: only a tap ends it. A release that trails the menu's own
   * tap-then-hold must not end the recording before the wearer has said anything.
   */
  tapToEnd?: boolean;
}

export interface Banner extends BannerFrame {
  /** ms epoch it arrived; it goes away by itself after BANNER_MS. */
  at: number;
}

export interface ShownCard {
  card: GlassesCard;
  /** ms epoch it arrived (or was replaced in place). */
  at: number;
  /** Tapped: stays until dismissed. */
  pinned: boolean;
  /** First list/table row on screen. */
  offset: number;
}

export const BANNER_MS = 10_000;
/** Ask for the next page this many rows before the end of what is loaded. */
export const PAGE_AHEAD = 3;
/** How long a refused answer's reason stays in the header. */
export const NOTICE_MS = 4_000;
/** A hold shorter than this is an accidental press: nothing is recorded. */
export const SHORT_HOLD_MS = 600;
/** Longest recording; at the cap it behaves as if you let go. */
export const MAX_LISTEN_MS = 60_000;

export interface State {
  conn: Conn;
  /** Screens, root first. The top one is on the lens. Home is always the root. */
  stack: Screen[];
  /** The views starred in Aristo (SC-10526): Inbox only when it is starred, so never assume it is first. */
  home: GlassesHomeView[] | null;
  /** How many sessions need Jordan overall (the Inbox count), from the home frame. */
  needs: number;
  view: ViewFrame | null;
  thread: ThreadFrame | null;
  /** Cursor per screen, by ITEM ID (not index), so a reorder never moves it to another session. */
  cursor: Record<string, string>;
  /** Index the cursor had, used only when its item vanished (answered, moved out of the view). */
  cursorIndex: Record<string, number>;
  /** A show-me card an agent pushed (SC-11683): drawn over the open screen until it expires or is dismissed. */
  card: ShownCard | null;
  /** Voice mode on the phone, mirrored on the lens (SC-11683); null = off. */
  voice: ShownVoice | null;
  banner: Banner | null;
  bannerCursor: 0 | 1;
  /** A short transient line for the header ("already answered"), with when it expires. */
  notice: { text: string; until: number } | null;
  /** Answers sent and not yet confirmed: their sessions are hidden from the "needs you" picture. */
  answered: string[];
  /** Next request id. */
  seq: number;
  /** Rows asked for per view, when more than the gateway's default page (GLASSES_VIEW_LIMIT) was paged in. */
  limits: Record<string, number>;
  /** Conversation scroll per session: null/absent = follow the newest, a number = the pinned top line. */
  anchors: Record<string, number | null>;
  /**
   * On a question or permission screen: reading the conversation behind it, at this pinned top line. Absent =
   * the options are showing. Swipe up past the first option enters it; swipe down off the newest page, or a
   * tap, goes back to the options (Jordan, 2026-11-13: "I should always be able to scroll up and see the session").
   */
  peek: Record<string, number>;
}

export type Effect =
  | { kind: 'send'; frame: ClientFrame }
  /** Open the mic and stream its audio as `audio` frames for this listen. */
  | { kind: 'micStart'; reqId: string }
  | { kind: 'micStop' }
  | { kind: 'persist' }
  | { kind: 'exit' };

export type Gesture = 'up' | 'down' | 'tap' | 'double' | 'hold' | 'release';

export function initialState(conn: Conn = 'connecting'): State {
  return {
    conn,
    stack: [{ kind: 'home' }],
    home: null,
    needs: 0,
    view: null,
    thread: null,
    cursor: {},
    cursorIndex: {},
    card: null,
    voice: null,
    banner: null,
    bannerCursor: 0,
    notice: null,
    answered: [],
    seq: 1,
    limits: {},
    anchors: {},
    peek: {},
  };
}

export const top = (s: State): Screen => s.stack[s.stack.length - 1];

/** A stable id for a screen, so the cursor survives leaving and coming back. */
export function screenId(sc: Screen): string {
  if (sc.kind === 'home') return 'home';
  if (sc.kind === 'quiet') return 'quiet';
  if (sc.kind === 'view') return `view:${sc.viewId}`;
  if (sc.kind === 'session') return `session:${sc.key}`;
  if (sc.kind === 'menu') return `menu:${sc.key}`;
  return `dictate:${sc.key ?? 'new'}`;
}

/** What the gateway must be told is open. A menu or a dictation keeps its session open underneath. */
export function openFor(s: State): GlassesOpen {
  for (let i = s.stack.length - 1; i >= 0; i--) {
    const sc = s.stack[i];
    if (sc.kind === 'home' || sc.kind === 'quiet') return { screen: 'home' };
    if (sc.kind === 'view') {
      const limit = s.limits[sc.viewId];
      return limit ? { screen: 'view', viewId: sc.viewId, limit } : { screen: 'view', viewId: sc.viewId };
    }
    if (sc.kind === 'session' || sc.kind === 'menu') {
      const limit = s.limits[`session:${sc.key}`];
      return limit ? { screen: 'session', key: sc.key, limit } : { screen: 'session', key: sc.key };
    }
  }
  return { screen: 'home' };
}

// ------------------------------------------------------------------------------------------- items

/**
 * One selectable thing on the current screen. The layout draws these in order; the cursor points at one by
 * `id`. A tap resolves against the items the LAST DRAWN state produced (app.ts passes that state), never
 * against a frame that arrived since.
 */
export type Item =
  | { id: string; kind: 'view'; view: GlassesHomeView }
  | { id: string; kind: 'row'; row: GlassesRow }
  | { id: string; kind: 'option'; index: number }
  | { id: string; kind: 'stop' }
  | { id: string; kind: 'done' }
  | { id: string; kind: 'close' }
  | { id: string; kind: 'send' }
  | { id: string; kind: 'redo' }
  | { id: string; kind: 'cancel' };

/** The thread frame for a session screen, or null while it has not arrived (or belongs to another key). */
export function threadFor(s: State, key: GlassesKey): ThreadFrame | null {
  return s.thread && s.thread.row.key === key ? s.thread : null;
}

/** The view frame for a view screen, or null while it has not arrived. */
export function viewFor(s: State, viewId: string): ViewFrame | null {
  return s.view && s.view.viewId === viewId ? s.view : null;
}

/** A pending ask the lens should still offer: hidden once we sent an answer for it. */
export function liveAsk(s: State, key: GlassesKey | null): GlassesAsk | null {
  if (!key) return null;
  const ask = threadFor(s, key)?.ask ?? null;
  return ask && !s.answered.includes(ask.promptId) ? ask : null;
}

export function items(s: State, sc: Screen = top(s)): Item[] {
  if (sc.kind === 'home') {
    const views: Item[] = (s.home ?? []).map((v) => ({ id: v.id, kind: 'view', view: v }));
    return views;
  }
  if (sc.kind === 'quiet') return [];
  if (sc.kind === 'view') {
    const v = viewFor(s, sc.viewId);
    if (!v) return [];
    return v.sections.flatMap((sec) => sec.rows).map((row) => ({ id: row.key, kind: 'row', row }));
  }
  if (sc.kind === 'session') {
    // With an ask the options are the items; otherwise the screen is a conversation you scroll (no cursor).
    const ask = liveAsk(s, sc.key);
    if (!ask) return [];
    // A permission whose detail the lens cannot show whole offers only its refusing options: nobody approves a
    // command they could not read (SC-11683 review). Indexes stay the gateway's, so a tap echoes the right payload.
    const whole = ask.kind !== 'permission' || shownWhole(ask.detail || ask.context || '');
    return ask.options.flatMap((o, index) =>
      whole || o.kind === 'no' ? [{ id: `opt:${index}`, kind: 'option' as const, index }] : [],
    );
  }
  if (sc.kind === 'menu') {
    const t = threadFor(s, sc.key);
    const acts: Item[] = [];
    if (t?.row.mark === 'working') acts.push({ id: 'stop', kind: 'stop' });
    if (t?.row.mark !== 'done') acts.push({ id: 'done', kind: 'done' });
    acts.push({ id: 'close', kind: 'close' });
    return acts;
  }
  // dictation
  if (sc.phase === 'confirm')
    return [
      { id: 'send', kind: 'send' },
      { id: 'redo', kind: 'redo' },
      { id: 'cancel', kind: 'cancel' },
    ];
  if (sc.phase === 'empty' || sc.phase === 'failed')
    return [
      { id: 'redo', kind: 'redo' },
      { id: 'cancel', kind: 'cancel' },
    ];
  return [];
}

/** Where the cursor is on this screen, as an index into `items`. Falls back to the default position. */
export function cursorIndex(s: State, sc: Screen = top(s)): number {
  const list = items(s, sc);
  if (!list.length) return -1;
  const sid = screenId(sc);
  const want = s.cursor[sid];
  if (want !== undefined) {
    const at = list.findIndex((it) => it.id === want);
    if (at >= 0) return at;
    // Its item is gone (answered, moved out): stay at the same height rather than jumping to the top.
    const prev = s.cursorIndex[sid];
    if (prev !== undefined) return Math.min(prev, list.length - 1);
  }
  return defaultCursor(s, sc, list);
}

function defaultCursor(s: State, sc: Screen, list: Item[]): number {
  if (sc.kind === 'session') {
    const ask = liveAsk(s, sc.key);
    if (ask) {
      const primary = ask.options.findIndex((o) => o.primary);
      return primary >= 0 ? primary : 0;
    }
  }
  return list.length ? 0 : -1;
}

function setCursor(s: State, sc: Screen, index: number): State {
  const list = items(s, sc);
  if (!list.length) return s;
  const i = Math.max(0, Math.min(index, list.length - 1));
  const sid = screenId(sc);
  return { ...s, cursor: { ...s.cursor, [sid]: list[i].id }, cursorIndex: { ...s.cursorIndex, [sid]: i } };
}

function resetCursor(s: State, sc: Screen): State {
  const sid = screenId(sc);
  const cursor = { ...s.cursor };
  const cursorIndex = { ...s.cursorIndex };
  delete cursor[sid];
  delete cursorIndex[sid];
  return { ...s, cursor, cursorIndex };
}

/** Reading the conversation behind a session's ask: the pinned top line, or undefined when the options show. */
export function peekFor(s: State, key: GlassesKey): number | undefined {
  return liveAsk(s, key) ? s.peek[key] : undefined;
}

function withPeek(s: State, key: string, at: number | undefined): State {
  const peek = { ...s.peek };
  if (at === undefined) delete peek[key];
  else peek[key] = at;
  return { ...s, peek };
}

/** The conversation's scroll anchor for a session (null = following the newest). */
export function anchorFor(s: State, key: GlassesKey): number | null {
  return s.anchors[key] ?? null;
}

/**
 * The states to paint between `prev` (on the lens) and `next` when a swipe moved the conversation, one line
 * apart, so the text slides instead of jumping (Jordan, 2026-11-13). Empty when the screen, the session or
 * the mode (reading behind an ask vs the options) changed: those are cuts, not scrolls.
 */
export function glideFrames(prev: State, next: State): State[] {
  const a = top(prev);
  const b = top(next);
  if (a.kind !== 'session' || b.kind !== 'session' || a.key !== b.key) return [];
  const key = b.key;
  const t = threadFor(next, key);
  if (!t || threadFor(prev, key) !== t) return [];
  const all = conversationLines(t.lines);
  const peekA = peekFor(prev, key);
  const peekB = peekFor(next, key);
  if (liveAsk(next, key)) {
    if (peekA === undefined || peekB === undefined) return [];
    return glide(all, peekA, peekB).map((at) => withPeek(next, key, at));
  }
  if (liveAsk(prev, key)) return [];
  return glide(all, anchorFor(prev, key), anchorFor(next, key)).map((at) => ({
    ...next,
    anchors: { ...next.anchors, [key]: at },
  }));
}

// ------------------------------------------------------------------------------------------- frames in

/** Fold one server frame into the state. Returns effects only for what the frame itself demands. */
export function receive(s: State, f: ServerFrame, now: number): { state: State; effects: Effect[] } {
  switch (f.t) {
    case 'hello':
      // A (re)connect: say which screen is open; the server answers with its frame.
      return { state: { ...s, conn: 'online' }, effects: [{ kind: 'send', frame: { t: 'open', ...openFor(s) } }] };
    case 'home':
      return { state: { ...s, home: f.views, needs: f.needs }, effects: [] };
    case 'view':
      return { state: { ...s, view: f, answered: pruneAnswered(s.answered, f) }, effects: [] };
    case 'thread': {
      // A thread whose ask is no longer the one we answered means our answer landed.
      const answered = f.ask ? s.answered : s.answered.filter((id) => id !== s.thread?.ask?.promptId);
      return { state: keepPlace({ ...s, thread: f, answered }, s.thread, f), effects: [] };
    }
    case 'banner': {
      // Never banner the session already on screen, nor an ask we just answered.
      const sc = top(s);
      if ((sc.kind === 'session' || sc.kind === 'menu' || sc.kind === 'dictate') && sc.key === f.key)
        return { state: s, effects: [] };
      if (s.answered.includes(f.promptId)) return { state: s, effects: [] };
      return { state: { ...s, banner: { ...f, at: now }, bannerCursor: 0 }, effects: [] };
    }
    case 'card': {
      // Same id = replaced in place: keep the pin and the scroll, restart the clock.
      const same = s.card?.card.id === f.card.id ? s.card : null;
      return {
        state: {
          ...s,
          card: {
            card: f.card,
            at: now,
            pinned: same?.pinned ?? false,
            offset: same ? Math.min(same.offset, cardRows(f.card) - 1) : 0,
          },
        },
        effects: [],
      };
    }
    case 'voice':
      return receiveVoice(s, f.voice);
    case 'partial': {
      // Live words for the stream that is on screen; anything else is stale.
      const sc = top(s);
      if (sc.kind !== 'dictate' || sc.listenId !== f.reqId) return { state: s, effects: [] };
      if (sc.phase !== 'listening' && sc.phase !== 'finishing') return { state: s, effects: [] };
      return { state: replaceTop(s, { ...sc, text: f.final, interim: f.interim }), effects: [] };
    }
    case 'pong':
    case 'ok':
    case 'refused':
      return { state: s, effects: [] };
  }
}

/** An answered prompt leaves `answered` once the view no longer shows it as waiting. */
function pruneAnswered(answered: string[], v: ViewFrame): string[] {
  if (!answered.length) return answered;
  const waiting = new Set(
    v.sections
      .flatMap((sec) => sec.rows)
      .map((r) => r.promptId)
      .filter(Boolean),
  );
  return answered.filter((id) => waiting.has(id));
}

/** A request came back. `pending` names what it was, which app.ts remembers by reqId. */
export type Pending =
  | { kind: 'answer'; promptId: string }
  | { kind: 'say' }
  | { kind: 'patch' }
  | { kind: 'listen' }
  | { kind: 'create' }
  | { kind: 'interrupt' };

export function reply(s: State, pending: Pending, f: Reply, now: number): { state: State; effects: Effect[] } {
  const sc = top(s);
  const notice = (st: State, text: string): State => ({ ...st, notice: { text, until: now + NOTICE_MS } });

  if (pending.kind === 'listen') {
    if (sc.kind !== 'dictate' || sc.listenId !== f.reqId) return { state: s, effects: [] };
    if (f.t === 'refused') {
      // The stream failed (Soniox down, out of funds, …): stop listening and say why.
      const failed: Dictation = { ...sc, phase: 'failed', interim: '', error: f.message || f.reason };
      return { state: resetCursor(replaceTop(s, failed), failed), effects: [{ kind: 'micStop' }] };
    }
    if (sc.phase !== 'finishing') return { state: s, effects: [] };
    const text = (f.text ?? sc.text).trim();
    const next: Dictation = text
      ? { ...sc, phase: 'confirm', text, interim: '', error: null }
      : { ...sc, phase: 'empty', text: '', interim: '', error: null };
    return { state: resetCursor(replaceTop(s, next), next), effects: [] };
  }

  if (pending.kind === 'create') {
    if (f.t === 'refused') {
      if (sc.kind === 'dictate' && sc.phase === 'sending')
        return { state: replaceTop(s, { ...sc, phase: 'failed', error: refusedText(f) }), effects: [] };
      return { state: notice(s, refusedText(f)), effects: [] };
    }
    // Open the new session in place of the dictation.
    const key = f.t === 'ok' ? f.key : undefined;
    // Never pop a dictation whose mic is still open (a new recording started since): that would leave it streaming.
    if (micLive(sc)) return { state: s, effects: [] };
    let next = sc.kind === 'dictate' ? pop(s) : s;
    if (key)
      next = push(next, { kind: 'session', key, title: sc.kind === 'dictate' ? sc.text.slice(0, 60) : 'New session' });
    return { state: next, effects: navEffects(next) };
  }

  // A refused answer un-hides its ask, wherever it was sent from. `gone` = answered elsewhere, common and fine.
  const base =
    pending.kind === 'answer' && f.t === 'refused'
      ? { ...s, answered: s.answered.filter((id) => id !== pending.promptId) }
      : s;
  // A send from the confirm screen (a dictated `say` OR a dictated `answer`): ok closes it, refused shows why.
  if (sc.kind === 'dictate' && sc.phase === 'sending' && (pending.kind === 'say' || pending.kind === 'answer')) {
    if (f.t === 'refused')
      return { state: replaceTop(base, { ...sc, phase: 'failed', error: refusedText(f) }), effects: [] };
    return { state: pop(base), effects: [{ kind: 'persist' }] };
  }
  if (f.t === 'refused') return { state: notice(base, refusedText(f)), effects: [] };
  return { state: s, effects: [] };
}

function refusedText(f: Extract<ServerFrame, { t: 'refused' }>): string {
  if (f.reason === 'gone') return 'already answered';
  if (f.reason === 'changed') return 'the ask changed';
  if (f.reason === 'host-down') return 'its host is down';
  return f.message || 'refused';
}

// ------------------------------------------------------------------------------------------- gestures

function replaceTop(s: State, sc: Screen): State {
  return { ...s, stack: [...s.stack.slice(0, -1), sc] };
}

function push(s: State, sc: Screen): State {
  return { ...s, stack: [...s.stack, sc] };
}

function pop(s: State): State {
  return s.stack.length > 1 ? { ...s, stack: s.stack.slice(0, -1) } : s;
}

function nextReq(s: State): { s: State; reqId: string } {
  return { s: { ...s, seq: s.seq + 1 }, reqId: `r${s.seq}` };
}

/** The open frame for the (new) top screen, plus persisting where we are. */
function navEffects(s: State): Effect[] {
  return [{ kind: 'send', frame: { t: 'open', ...openFor(s) } }, { kind: 'persist' }];
}

export interface GestureResult {
  state: State;
  effects: Effect[];
  /** Requests to remember by reqId, so their `ok`/`refused` can be matched. */
  pending: Record<string, Pending>;
}

const none = (state: State): GestureResult => ({ state, effects: [], pending: {} });

/** Messages a session asks for at a time when the wearer scrolls past the top (the gateway caps it). */
export const MORE_MESSAGES = 24;
export const MAX_MESSAGES = 300;

/**
 * Scrolled to the very top: ask the gateway for MORE_MESSAGES more (Jordan, 2026-11-13: "scroll up forever").
 * Only when the frame came back full, i.e. there may be older ones; the reader's place is kept when they land.
 */
function olderMessages(s: State, key: GlassesKey, t: ThreadFrame): GestureResult {
  const limKey = `session:${key}`;
  const have = t.lines.filter((l) => l.who !== 'tool').length;
  const asked = s.limits[limKey] ?? GLASSES_THREAD_LIMIT;
  if (have < asked || asked >= MAX_MESSAGES) return none(s);
  const next = { ...s, limits: { ...s.limits, [limKey]: Math.min(MAX_MESSAGES, asked + MORE_MESSAGES) } };
  return { state: next, effects: [{ kind: 'send', frame: { t: 'open', ...openFor(next) } }], pending: {} };
}

/**
 * A new thread frame for the same session that starts EARLIER (older messages loaded above) moves every line
 * down by the rows those messages take: shift the pinned top line by as much, so the screen does not jump.
 */
function keepPlace(s: State, prev: ThreadFrame | null, f: ThreadFrame): State {
  if (!prev || prev.row.key !== f.row.key) return s;
  const key = f.row.key;
  const first = prev.lines.find((l) => l.who !== 'tool');
  if (!first) return s;
  const at = f.lines.findIndex((l) => l.who === first.who && l.text === first.text && l.at === first.at);
  if (at <= 0) return s;
  const added = f.lines.slice(0, at).flatMap(messageLines).length;
  const anchor = s.anchors[key];
  const peek = s.peek[key];
  return {
    ...s,
    anchors: anchor == null ? s.anchors : { ...s.anchors, [key]: anchor + added },
    peek: peek === undefined ? s.peek : { ...s.peek, [key]: peek + added },
  };
}

// ------------------------------------------------------------------------------------------- OS menu

/** Ids of the glasses' own tap-then-hold menu items (os-menu.ts). Stable: a click means the same thing always. */
export const MENU_QUIET = 1;
export const MENU_LEAVE_QUIET = 2;
export const MENU_NEW_AGENT = 3;

/**
 * The items this screen adds to the glasses' menu. Quiet mode lives here, not on Home (Jordan, 2026-11-13:
 * "the way you access it should be from tapping and holding the menu"). None while dictating: the mic is open.
 */
export function menuActions(s: State): { id: number; label: string }[] {
  const sc = top(s);
  if (sc.kind === 'dictate') return [];
  const quiet =
    sc.kind === 'quiet' ? { id: MENU_LEAVE_QUIET, label: 'Leave quiet mode' } : { id: MENU_QUIET, label: 'Quiet mode' };
  // Jordan, 2026-11-13: "next to quiet mode, we should also put like new agent there". Speech needs the gateway.
  return s.conn === 'online' ? [quiet, { id: MENU_NEW_AGENT, label: 'New session' }] : [quiet];
}

/**
 * A pick from the glasses' menu. Quiet mode sits on top of Home (so the gateway keeps sending banners for every
 * session) wherever it was picked from; leaving it lands on Home.
 */
export function menuPick(s: State, id: number, now: number): GestureResult {
  const valid = menuActions(s).some((a) => a.id === id);
  if (!valid) return none(s);
  if (id === MENU_QUIET) {
    const q: State = { ...s, stack: [{ kind: 'home' }, { kind: 'quiet' }], peek: {} };
    return { state: q, effects: navEffects(q), pending: {} };
  }
  if (id === MENU_LEAVE_QUIET) {
    const home: State = { ...s, stack: [{ kind: 'home' }] };
    return { state: home, effects: navEffects(home), pending: {} };
  }
  if (id === MENU_NEW_AGENT)
    return listen(s, { kind: 'dictate', purpose: 'create', key: null, title: 'New session', tapToEnd: true }, now);
  return none(s);
}

/**
 * Apply one gesture. `drawn` is the state the lens is SHOWING (the last one drawn): a tap resolves against
 * its items, because the live state may have reordered underneath the wearer's finger.
 */
export function gesture(live: State, g: Gesture, now: number, drawn: State = live): GestureResult {
  let s = expire(live, now);

  // While the mic is open, gestures belong to the recording (a tap ends it), not to a banner that arrived meanwhile.
  if (s.banner && !micLive(top(s))) return bannerGesture(s, g);
  // A hold still talks to the screen under the card, so the wearer can answer what the card shows.
  if (s.card && !micLive(top(s)) && g !== 'hold' && g !== 'release') return cardGesture(s, g);

  const sc = top(s);

  // The voice screen (SC-11683): a tap or double tap shows the conversation; a hold still dictates on the lens.
  if (voiceShown(s) && s.voice && (g === 'tap' || g === 'double' || g === 'up' || g === 'down'))
    return none({ ...s, voice: { ...s.voice, hidden: true } });

  if (sc.kind === 'dictate') return dictateGesture(s, sc, g, now, drawn);
  if (sc.kind === 'menu') return menuGesture(s, sc, g, drawn);
  if (sc.kind === 'quiet') {
    // Nothing to move through; a tap or double tap goes back to Home, a hold starts a new session.
    if (g === 'tap' || g === 'double') {
      const home = pop(s);
      return { state: home, effects: navEffects(home), pending: {} };
    }
    if (g === 'hold') return holdToTalk(s, sc, now, drawn);
    return none(s);
  }

  if (g === 'up' || g === 'down') {
    // An ask screen: up past the first option reads the conversation behind it, a few lines at a time.
    if (sc.kind === 'session' && liveAsk(s, sc.key)) {
      const t = threadFor(s, sc.key);
      const reading = s.peek[sc.key];
      if (t && (reading !== undefined || (g === 'up' && cursorIndex(s, sc) === 0))) {
        const all = conversationLines(t.lines);
        const lastTop = Math.max(0, all.length - CONVO_LINES);
        if (reading === undefined) return none(withPeek(s, sc.key, lastTop));
        if (g === 'down' && reading >= lastTop) return none(withPeek(s, sc.key, undefined));
        const moved = withPeek(s, sc.key, scrollAnchor(all, reading, g) ?? lastTop);
        return g === 'up' && reading === 0 ? olderMessages(moved, sc.key, t) : none(moved);
      }
    }
    // The conversation scrolls SCROLL_STEP lines; any other screen moves the cursor.
    if (sc.kind === 'session' && !liveAsk(s, sc.key)) {
      const t = threadFor(s, sc.key);
      if (!t) return none(s);
      const all = conversationLines(t.lines);
      const was = topLine(all, anchorFor(s, sc.key));
      const anchor = scrollAnchor(all, anchorFor(s, sc.key), g);
      const next = { ...s, anchors: { ...s.anchors, [sc.key]: anchor } };
      return g === 'up' && was === 0 ? olderMessages(next, sc.key, t) : none(next);
    }
    const list = items(s, sc);
    if (!list.length) return none(s);
    const at = cursorIndex(s, sc);
    s = setCursor(s, sc, at + (g === 'down' ? 1 : -1));
    // Paging: the gateway sends GLASSES_VIEW_LIMIT rows plus a `more` count (Inbox holds 300+). Near the end of
    // what is loaded, ask for the next page; the frame comes back whole and the cursor stays on its row.
    if (g === 'down' && sc.kind === 'view') {
      const v = viewFor(s, sc.viewId);
      const want = list.length + GLASSES_VIEW_LIMIT;
      if (v && v.more > 0 && at + 1 >= list.length - PAGE_AHEAD && (s.limits[sc.viewId] ?? 0) < want) {
        s = { ...s, limits: { ...s.limits, [sc.viewId]: want } };
        return { state: s, effects: [{ kind: 'send', frame: { t: 'open', ...openFor(s) } }], pending: {} };
      }
    }
    return none(s);
  }

  if (g === 'double') {
    if (s.stack.length === 1) return { state: s, effects: [{ kind: 'exit' }], pending: {} };
    if (sc.kind === 'session') s = withPeek(s, sc.key, undefined);
    s = pop(s);
    return { state: s, effects: navEffects(s), pending: {} };
  }

  if (g === 'hold') return holdToTalk(s, sc, now, drawn);
  if (g === 'release') return none(s);

  // tap
  // Reading behind an ask: a tap goes back to the options (never answers what is not on screen).
  if (sc.kind === 'session' && drawn.peek[sc.key] !== undefined) return none(withPeek(s, sc.key, undefined));
  if (sc.kind === 'session' && !liveAsk(drawn, sc.key)) {
    // The conversation's actions live behind a tap.
    const menu: Screen = { kind: 'menu', key: sc.key, title: sc.title };
    return none(resetCursor(push(s, menu), menu));
  }
  const shown = items(drawn, sc);
  const at = cursorIndex(drawn, sc);
  const it = shown[at];
  if (!it) return none(s);
  s = setCursor(s, sc, at);

  if (it.kind === 'view') {
    s = push(s, { kind: 'view', viewId: it.view.id, name: it.view.name });
    return { state: s, effects: navEffects(s), pending: {} };
  }
  if (it.kind === 'row') {
    s = push(s, { kind: 'session', key: it.row.key, title: it.row.title });
    return { state: s, effects: navEffects(s), pending: {} };
  }
  if (sc.kind !== 'session' || it.kind !== 'option') return none(s);

  const ask = liveAsk(drawn, sc.key);
  const opt = ask?.options[it.index];
  if (!ask || !opt) return none(s);
  const r = nextReq(s);
  s = withPeek({ ...r.s, answered: [...r.s.answered, ask.promptId] }, sc.key, undefined);
  // Answered: back to the list, cursor on top, where the next waiting session already is.
  s = pop(s);
  s = resetCursor(s, top(s));
  return {
    state: s,
    effects: [
      { kind: 'send', frame: { t: 'answer', reqId: r.reqId, key: sc.key, answer: opt.answer } },
      ...navEffects(s),
    ],
    pending: { [r.reqId]: { kind: 'answer', promptId: ask.promptId } },
  };
}

function menuGesture(s: State, m: Extract<Screen, { kind: 'menu' }>, g: Gesture, drawn: State): GestureResult {
  if (g === 'up' || g === 'down') return none(setCursor(s, m, cursorIndex(s, m) + (g === 'down' ? 1 : -1)));
  if (g === 'double') return none(pop(s));
  if (g !== 'tap') return none(s);
  const it = items(drawn, m)[cursorIndex(drawn, m)];
  if (!it) return none(s);
  const r = nextReq(s);
  if (it.kind === 'stop') {
    // Stop keeps you on the conversation: you watch it stop.
    const next = pop(r.s);
    return {
      state: next,
      effects: [{ kind: 'send', frame: { t: 'interrupt', reqId: r.reqId, key: m.key } }],
      pending: { [r.reqId]: { kind: 'interrupt' } },
    };
  }
  if (it.kind === 'done' || it.kind === 'close') {
    // Done or set aside: back past the session to the list.
    const next = pop(pop(r.s));
    const frame: ClientFrame =
      it.kind === 'done'
        ? { t: 'patch', reqId: r.reqId, key: m.key, done: true }
        : { t: 'patch', reqId: r.reqId, key: m.key, closed: true };
    return {
      state: next,
      effects: [{ kind: 'send', frame }, ...navEffects(next)],
      pending: { [r.reqId]: { kind: 'patch' } },
    };
  }
  return none(s);
}

function listen(
  s: State,
  d: Omit<Dictation, 'listenId' | 'startedAt' | 'phase' | 'text' | 'interim' | 'error'>,
  now: number,
): GestureResult {
  const r = nextReq(s);
  const dict: Dictation = {
    ...d,
    phase: 'listening',
    text: '',
    interim: '',
    error: null,
    listenId: r.reqId,
    startedAt: now,
  };
  return {
    state: resetCursor(push(r.s, dict), dict),
    effects: [
      { kind: 'send', frame: { t: 'listen', reqId: r.reqId, lang: ['en', 'ja'] } },
      { kind: 'micStart', reqId: r.reqId },
    ],
    pending: { [r.reqId]: { kind: 'listen' } },
  };
}

/** Hold talks: on Home it starts a new session, on a list row or the open session it talks to that session. */
function holdToTalk(s: State, sc: Screen, now: number, drawn: State): GestureResult {
  // Speech needs the gateway: offline (or not set up) a hold does nothing rather than open a dead mic.
  if (s.conn !== 'online') return none(s);
  if (sc.kind === 'home' || sc.kind === 'quiet')
    return listen(s, { kind: 'dictate', purpose: 'create', key: null, title: 'New session' }, now);
  if (sc.kind === 'session') {
    const ask = liveAsk(s, sc.key);
    // A permission or a question that takes no free text can only be answered by tapping an option.
    if (ask && !ask.freeText) return none(s);
    return listen(s, { kind: 'dictate', purpose: 'reply', key: sc.key, title: sc.title }, now);
  }
  if (sc.kind === 'view') {
    const it = items(drawn, sc)[cursorIndex(drawn, sc)];
    if (it?.kind !== 'row') return none(s);
    // Open the session underneath, so the confirm screen knows whether it answers an ask or sends a message.
    const opened = push(s, { kind: 'session', key: it.row.key, title: it.row.title });
    const r = listen(opened, { kind: 'dictate', purpose: 'reply', key: it.row.key, title: it.row.title }, now);
    return {
      ...r,
      effects: [{ kind: 'send', frame: { t: 'open', screen: 'session', key: it.row.key } }, ...r.effects],
    };
  }
  return none(s);
}

/**
 * What Send will do. A new session is `create`. Otherwise it is decided from the session's live ask; the
 * lens never reads the words: a dictated answer to an ask goes as `answer {text}` only when the gateway said
 * the ask takes free text, and on a permission that is never an approval (Aristo sends free text on a
 * permission as "No, and say why"), which is what makes an ambiguous spoken "yes" a deny. Anything else is
 * a plain message (`say`).
 */
export function sendTarget(
  s: State,
  d: Dictation,
): { kind: 'create' } | { kind: 'answer'; ask: GlassesAsk } | { kind: 'say' } {
  if (d.purpose === 'create') return { kind: 'create' };
  const ask = liveAsk(s, d.key);
  return ask && ask.freeText ? { kind: 'answer', ask } : { kind: 'say' };
}

/** Stop recording: a short hold is discarded, anything else is finished and transcribed. */
function endListen(s: State, d: Dictation, now: number): GestureResult {
  if (now - d.startedAt < SHORT_HOLD_MS) {
    return {
      state: pop(s),
      effects: [{ kind: 'micStop' }, { kind: 'send', frame: { t: 'listen.cancel', reqId: d.listenId } }],
      pending: {},
    };
  }
  return {
    state: replaceTop(s, { ...d, phase: 'finishing' }),
    effects: [{ kind: 'micStop' }, { kind: 'send', frame: { t: 'listen.end', reqId: d.listenId } }],
    pending: {},
  };
}

function cancelListen(s: State, d: Dictation): GestureResult {
  return {
    state: pop(s),
    effects: [{ kind: 'micStop' }, { kind: 'send', frame: { t: 'listen.cancel', reqId: d.listenId } }],
    pending: {},
  };
}

function dictateGesture(s: State, d: Dictation, g: Gesture, now: number, drawn: State): GestureResult {
  if (d.phase === 'listening') {
    // Release ends it; a tap ends it too (the glasses sometimes lose the release); double tap discards.
    if ((g === 'release' && !d.tapToEnd) || g === 'tap') return endListen(s, d, now);
    if (g === 'double') return cancelListen(s, d);
    return none(s);
  }
  if (d.phase === 'finishing') return g === 'double' ? cancelListen(s, d) : none(s);
  if (d.phase === 'sending') return g === 'double' ? none(pop(s)) : none(s);

  if (g === 'up' || g === 'down') return none(setCursor(s, d, cursorIndex(s, d) + (g === 'down' ? 1 : -1)));
  if (g === 'double') return none(pop(s));
  if (g === 'hold') return redo(s, d, now);
  if (g !== 'tap') return none(s);

  const it = items(drawn, d)[cursorIndex(drawn, d)];
  if (!it) return none(s);
  if (it.kind === 'cancel') return none(pop(s));
  if (it.kind === 'redo') return redo(s, d, now);
  if (it.kind !== 'send') return none(s);

  const target = sendTarget(s, d);
  const r = nextReq(s);
  const sending = replaceTop(r.s, { ...d, phase: 'sending' });
  if (target.kind === 'create') {
    return {
      state: sending,
      effects: [{ kind: 'send', frame: { t: 'create', reqId: r.reqId, text: d.text } }],
      pending: { [r.reqId]: { kind: 'create' } },
    };
  }
  if (target.kind === 'answer') {
    const answered = { ...sending, answered: [...sending.answered, target.ask.promptId] };
    return {
      state: answered,
      effects: [
        {
          kind: 'send',
          frame: { t: 'answer', reqId: r.reqId, key: d.key!, promptId: target.ask.promptId, text: d.text },
        },
      ],
      pending: { [r.reqId]: { kind: 'answer', promptId: target.ask.promptId } },
    };
  }
  return {
    state: sending,
    effects: [{ kind: 'send', frame: { t: 'say', reqId: r.reqId, key: d.key!, text: d.text } }],
    pending: { [r.reqId]: { kind: 'say' } },
  };
}

/** Record again from the confirm/empty/failed screen. */
function redo(s: State, d: Dictation, now: number): GestureResult {
  const back = pop(s);
  return listen(back, { kind: 'dictate', purpose: d.purpose, key: d.key, title: d.title }, now);
}

/** A dictation whose mic is open: audio is (or may still be) streaming to the gateway. */
export function micLive(sc: Screen): boolean {
  return sc.kind === 'dictate' && (sc.phase === 'listening' || sc.phase === 'finishing');
}

function bannerGesture(s: State, g: Gesture): GestureResult {
  const b = s.banner!;
  if (g === 'up' || g === 'down') return none({ ...s, bannerCursor: g === 'down' ? 1 : 0 });
  if (g === 'double' || (g === 'tap' && s.bannerCursor === 1)) return none({ ...s, banner: null });
  if (g !== 'tap') return none(s);
  // Answer now: open that session on top of wherever we are; double tap comes back here.
  let next: State = { ...s, banner: null };
  const sc = top(next);
  let stop: Effect[] = [];
  if (sc.kind === 'dictate' && micLive(sc)) {
    // A recording left open would keep streaming audio for a listen nobody ends: cancel it first.
    const c = cancelListen(next, sc as Dictation);
    next = c.state;
    stop = c.effects;
  } else if (sc.kind === 'dictate' || sc.kind === 'menu') next = pop(next);
  next = push(next, { kind: 'session', key: b.key, title: b.title });
  return { state: next, effects: [...stop, ...navEffects(next)], pending: {} };
}

/** Rows a card can scroll through (list or table rows; 1 for a stat). */
export function cardRows(c: GlassesCard): number {
  return c.body.kind === 'stat' ? 1 : Math.max(1, c.body.rows.length);
}

/** On a card: tap pins (or unpins) it, double tap dismisses it, a swipe scrolls its rows. Nothing is sent. */
function cardGesture(s: State, g: Gesture): GestureResult {
  const c = s.card!;
  if (g === 'double') return none({ ...s, card: null });
  if (g === 'tap') return none({ ...s, card: { ...c, pinned: !c.pinned } });
  if (g === 'up' || g === 'down') {
    const offset = Math.max(0, Math.min(cardRows(c.card) - 1, c.offset + (g === 'down' ? 1 : -1)));
    return none({ ...s, card: { ...c, offset } });
  }
  return none(s);
}

/** Drop a banner or notice whose time is up. Pure in `now`; app.ts calls it on a timer too. */
export function expire(s: State, now: number): State {
  let out = s;
  if (out.banner && top(out).kind !== 'quiet' && now - out.banner.at >= BANNER_MS) out = { ...out, banner: null };
  if (out.notice && now >= out.notice.until) out = { ...out, notice: null };
  const c = out.card;
  if (c && !c.pinned && c.card.ttlMs !== null && now - c.at >= c.card.ttlMs) out = { ...out, card: null };
  return out;
}

/**
 * Called by the shell's clock while listening: at the 60 s cap, or when the mic stopped on its own, it ends
 * as if you let go.
 */
export function micEnded(s: State, now: number): GestureResult {
  const sc = top(s);
  if (sc.kind !== 'dictate' || sc.phase !== 'listening') return none(s);
  return endListen(s, sc, Math.max(now, sc.startedAt + SHORT_HOLD_MS));
}

// ------------------------------------------------------------------------------------------- resume

/** What survives a cold start: the navigable screens (never a dictation or a menu) and the Inbox count. */
export interface Saved {
  stack: Screen[];
  inboxNeeds: number;
  at: number;
}

export function toSaved(s: State, now: number): Saved {
  const stack = s.stack.filter((sc) => sc.kind !== 'dictate' && sc.kind !== 'menu');
  return { stack, inboxNeeds: s.needs, at: now };
}

/** Start where the wearer left off. */
export function restore(s: State, saved: Saved | null): State {
  if (!saved || !saved.stack.length || saved.stack[0].kind !== 'home') return s;
  // The app always opens awake: quiet mode is never restored (Jordan, 2026-11-13: "don't start automatically in quiet mode").
  const stack = saved.stack.filter((sc) => sc.kind !== 'quiet');
  return { ...s, stack };
}

/**
 * The first Home after a cold start decides the landing screen: if more sessions need Jordan than when the
 * app was last left, he most likely opened it from a lens notification, so land on the first starred view that
 * has someone waiting (Inbox when it is starred: Aristo sorts it waiting-first, so that session is on top). The
 * home is exactly Aristo's Favorites (SC-10526), so a view that is not starred is never opened here. Otherwise stay.
 */
export function landing(s: State, saved: Saved | null): State {
  if (!s.home) return s;
  if (top(s).kind === 'quiet') return s;
  if (saved && s.needs <= saved.inboxNeeds) return s;
  if (!saved && s.needs === 0) return s;
  const to = s.home.find((v) => v.needs > 0);
  if (!to) return s;
  const stack: Screen[] = [{ kind: 'home' }, { kind: 'view', viewId: to.id, name: to.name }];
  return resetCursor({ ...s, stack }, stack[1]);
}
