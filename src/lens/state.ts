/**
 * Aristo Lens: the whole app as a pure state machine (SC-9500).
 *
 * The gateway (Aristo, on Chiba) owns every word, order and answer payload; this file only decides WHICH
 * screen is open, WHERE the cursor sits, and WHAT to send when a gesture lands. Nothing here interprets a
 * prompt or a view: a tap on an option echoes that option's `answer` payload verbatim.
 *
 * Gestures in, `{ state, effects }` out. The shell (app.ts) runs the effects: socket frames, the mic,
 * persisting the open screen, closing the app.
 */
import type {
  GlassesAsk,
  GlassesClientFrame,
  GlassesHomeView,
  GlassesKey,
  GlassesOpen,
  GlassesRow,
  GlassesServerFrame,
} from '../gateway/glasses';

export type ViewFrame = Extract<GlassesServerFrame, { t: 'view' }>;
export type ThreadFrame = Extract<GlassesServerFrame, { t: 'thread' }>;
export type BannerFrame = Extract<GlassesServerFrame, { t: 'banner' }>;

/** Connection as the lens reports it in the header's live-status slot. */
export type Conn = 'unconfigured' | 'connecting' | 'online' | 'reconnecting';

export type Screen =
  | { kind: 'home' }
  | { kind: 'view'; viewId: string; name: string }
  | { kind: 'session'; key: GlassesKey; title: string }
  | Dictation;

/**
 * Dictate, then confirm (flow screen 6). `via` records HOW it started, because the gesture that ends
 * listening differs: a hold ends on release, a tapped "Talk to it" row ends on the next tap.
 */
export interface Dictation {
  kind: 'dictate';
  key: GlassesKey;
  title: string;
  via: 'hold' | 'tap';
  phase: 'listening' | 'transcribing' | 'confirm' | 'empty' | 'sending' | 'failed';
  text: string;
  /** Why the last stt/send failed, shown on the `failed` phase. */
  error: string | null;
}

export interface Banner extends BannerFrame {
  /** ms epoch it arrived; it goes away by itself after BANNER_MS. */
  at: number;
}

export const BANNER_MS = 10_000;
/** How long a refused answer's reason stays in the header. */
export const NOTICE_MS = 4_000;

export interface State {
  conn: Conn;
  /** Screens, root first. The top one is on the lens. Home is always the root. */
  stack: Screen[];
  home: GlassesHomeView[] | null;
  view: ViewFrame | null;
  thread: ThreadFrame | null;
  /** Cursor per screen, by ITEM ID (not index), so a reorder never moves it to another session. */
  cursor: Record<string, string>;
  /** Index the cursor had, used only when its item vanished (answered, moved out of the view). */
  cursorIndex: Record<string, number>;
  banner: Banner | null;
  bannerCursor: 0 | 1;
  /** A short transient line for the header ("already answered"), with when it expires. */
  notice: { text: string; until: number } | null;
  /** Answers sent and not yet confirmed: their sessions are hidden from the "needs you" picture. */
  answered: string[];
  /** Next request id. */
  seq: number;
}

export type Effect =
  | { kind: 'send'; frame: GlassesClientFrame }
  | { kind: 'micStart' }
  | { kind: 'micStop' }
  /** Stop the mic and ship what it heard as one `stt` request with this reqId. */
  | { kind: 'transcribe'; reqId: string }
  | { kind: 'persist' }
  | { kind: 'exit' };

export type Gesture = 'up' | 'down' | 'tap' | 'double' | 'hold' | 'release';

export function initialState(conn: Conn = 'connecting'): State {
  return {
    conn,
    stack: [{ kind: 'home' }],
    home: null,
    view: null,
    thread: null,
    cursor: {},
    cursorIndex: {},
    banner: null,
    bannerCursor: 0,
    notice: null,
    answered: [],
    seq: 1,
  };
}

export const top = (s: State): Screen => s.stack[s.stack.length - 1];

/** A stable id for a screen, so the cursor survives leaving and coming back. */
export function screenId(sc: Screen): string {
  if (sc.kind === 'home') return 'home';
  if (sc.kind === 'view') return `view:${sc.viewId}`;
  if (sc.kind === 'session') return `session:${sc.key}`;
  return `dictate:${sc.key}`;
}

/** What the gateway must be told is open. A dictation keeps its session open underneath. */
export function openFor(s: State): GlassesOpen {
  for (let i = s.stack.length - 1; i >= 0; i--) {
    const sc = s.stack[i];
    if (sc.kind === 'home') return { screen: 'home' };
    if (sc.kind === 'view') return { screen: 'view', viewId: sc.viewId };
    if (sc.kind === 'session') return { screen: 'session', key: sc.key };
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
  | { id: string; kind: 'voice' }
  | { id: string; kind: 'talk' }
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
export function liveAsk(s: State, key: GlassesKey): GlassesAsk | null {
  const ask = threadFor(s, key)?.ask ?? null;
  return ask && !s.answered.includes(ask.promptId) ? ask : null;
}

export function items(s: State, sc: Screen = top(s)): Item[] {
  if (sc.kind === 'home') return (s.home ?? []).map((v) => ({ id: v.id, kind: 'view', view: v }));
  if (sc.kind === 'view') {
    const v = viewFor(s, sc.viewId);
    if (!v) return [];
    return v.sections.flatMap((sec) => sec.rows).map((row) => ({ id: row.key, kind: 'row', row }));
  }
  if (sc.kind === 'session') {
    const t = threadFor(s, sc.key);
    if (!t) return [];
    const ask = liveAsk(s, sc.key);
    if (ask) {
      const opts: Item[] = ask.options.map((_, index) => ({ id: `opt:${index}`, kind: 'option', index }));
      return ask.freeText ? [...opts, { id: 'voice', kind: 'voice' }] : opts;
    }
    const acts: Item[] = [{ id: 'talk', kind: 'talk' }];
    if (t.row.mark !== 'done') acts.push({ id: 'done', kind: 'done' });
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

// ------------------------------------------------------------------------------------------- frames in

/** Fold one server frame into the state. Returns effects only for what the frame itself demands. */
export function receive(s: State, f: GlassesServerFrame, now: number): { state: State; effects: Effect[] } {
  switch (f.t) {
    case 'hello':
      // A (re)connect: say which screen is open; the server answers with its frame.
      return { state: { ...s, conn: 'online' }, effects: [{ kind: 'send', frame: { t: 'open', ...openFor(s) } }] };
    case 'home':
      return { state: { ...s, home: f.views }, effects: [] };
    case 'view':
      return { state: { ...s, view: f, answered: pruneAnswered(s.answered, f) }, effects: [] };
    case 'thread': {
      // A thread whose ask is no longer the one we answered means our answer landed.
      const answered = f.ask ? s.answered : s.answered.filter((id) => id !== s.thread?.ask?.promptId);
      return { state: { ...s, thread: f, answered }, effects: [] };
    }
    case 'banner': {
      // Never banner the session already on screen, nor an ask we just answered.
      const sc = top(s);
      if ((sc.kind === 'session' || sc.kind === 'dictate') && sc.key === f.key) return { state: s, effects: [] };
      if (s.answered.includes(f.promptId)) return { state: s, effects: [] };
      return { state: { ...s, banner: { ...f, at: now }, bannerCursor: 0 }, effects: [] };
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
export type Pending = { kind: 'answer'; promptId: string } | { kind: 'say' } | { kind: 'patch' } | { kind: 'stt' };

export function reply(
  s: State,
  pending: Pending,
  f: Extract<GlassesServerFrame, { t: 'ok' } | { t: 'refused' }>,
  now: number,
): { state: State; effects: Effect[] } {
  const sc = top(s);
  if (pending.kind === 'stt') {
    if (sc.kind !== 'dictate' || sc.phase !== 'transcribing') return { state: s, effects: [] };
    if (f.t === 'refused')
      return { state: replaceTop(s, { ...sc, phase: 'failed', error: f.message || f.reason }), effects: [] };
    const text = (f.text ?? '').trim();
    const next: Dictation = text
      ? { ...sc, phase: 'confirm', text, error: null }
      : { ...sc, phase: 'empty', text: '', error: null };
    return { state: resetCursor(replaceTop(s, next), next), effects: [] };
  }
  if (pending.kind === 'answer') {
    if (f.t === 'ok') return { state: s, effects: [] };
    // Refused: un-hide the ask and say why. `gone` = answered elsewhere, which is fine and common.
    const answered = s.answered.filter((id) => id !== pending.promptId);
    return { state: { ...s, answered, notice: { text: refusedText(f), until: now + NOTICE_MS } }, effects: [] };
  }
  // say / patch
  if (sc.kind === 'dictate' && sc.phase === 'sending') {
    if (f.t === 'refused')
      return { state: replaceTop(s, { ...sc, phase: 'failed', error: refusedText(f) }), effects: [] };
    return { state: pop(s), effects: [{ kind: 'persist' }] };
  }
  if (f.t === 'refused')
    return { state: { ...s, notice: { text: refusedText(f), until: now + NOTICE_MS } }, effects: [] };
  return { state: s, effects: [] };
}

function refusedText(f: Extract<GlassesServerFrame, { t: 'refused' }>): string {
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

/**
 * Apply one gesture. `drawn` is the state the lens is SHOWING (the last one drawn): a tap resolves against
 * its items, because the live state may have reordered underneath the wearer's finger.
 */
export function gesture(live: State, g: Gesture, now: number, drawn: State = live): GestureResult {
  const none = (state: State): GestureResult => ({ state, effects: [], pending: {} });
  let s = expire(live, now);

  if (s.banner) return bannerGesture(s, g);

  const sc = top(s);

  if (sc.kind === 'dictate') return dictateGesture(s, sc, g, drawn);

  if (g === 'up' || g === 'down') {
    const list = items(s, sc);
    if (!list.length) return none(s);
    const at = cursorIndex(s, sc);
    return none(setCursor(s, sc, at + (g === 'down' ? 1 : -1)));
  }

  if (g === 'double') {
    if (s.stack.length === 1) return { state: s, effects: [{ kind: 'exit' }], pending: {} };
    s = pop(s);
    return { state: s, effects: navEffects(s), pending: {} };
  }

  if (g === 'hold') return holdToTalk(s, sc, drawn, now);
  if (g === 'release') return none(s);

  // tap: resolve against what was drawn
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
  if (sc.kind !== 'session') return none(s);

  if (it.kind === 'option') {
    const ask = liveAsk(drawn, sc.key);
    const opt = ask?.options[it.index];
    if (!ask || !opt) return none(s);
    const r = nextReq(s);
    s = { ...r.s, answered: [...r.s.answered, ask.promptId] };
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
  if (it.kind === 'voice' || it.kind === 'talk') return startDictation(s, sc.key, sc.title, 'tap');
  if (it.kind === 'done' || it.kind === 'close') {
    const r = nextReq(s);
    s = pop(r.s);
    const frame: GlassesClientFrame =
      it.kind === 'done'
        ? { t: 'patch', reqId: r.reqId, key: sc.key, done: true }
        : { t: 'patch', reqId: r.reqId, key: sc.key, closed: true };
    return {
      state: s,
      effects: [{ kind: 'send', frame }, ...navEffects(s)],
      pending: { [r.reqId]: { kind: 'patch' } },
    };
  }
  return none(s);
}

function startDictation(s: State, key: GlassesKey, title: string, via: 'hold' | 'tap'): GestureResult {
  const d: Dictation = { kind: 'dictate', key, title, via, phase: 'listening', text: '', error: null };
  return { state: resetCursor(push(s, d), d), effects: [{ kind: 'micStart' }], pending: {} };
}

/** Hold talks to the highlighted session (a list row) or the open one. */
function holdToTalk(s: State, sc: Screen, drawn: State, now: number): GestureResult {
  if (sc.kind === 'session') {
    const ask = liveAsk(s, sc.key);
    // A permission or a question that takes no free text can only be answered by tapping an option.
    if (ask && !ask.freeText)
      return { state: { ...s, notice: { text: 'tap an option', until: now + NOTICE_MS } }, effects: [], pending: {} };
    return startDictation(s, sc.key, sc.title, 'hold');
  }
  if (sc.kind === 'view') {
    const it = items(drawn, sc)[cursorIndex(drawn, sc)];
    if (it?.kind !== 'row') return { state: s, effects: [], pending: {} };
    // Open the session underneath, so the confirm screen knows whether it answers an ask or sends a message.
    const opened = push(s, { kind: 'session', key: it.row.key, title: it.row.title });
    const r = startDictation(opened, it.row.key, it.row.title, 'hold');
    return {
      ...r,
      effects: [{ kind: 'send', frame: { t: 'open', screen: 'session', key: it.row.key } }, ...r.effects],
    };
  }
  return { state: s, effects: [], pending: {} };
}

/**
 * What Send will do, decided from the session's live ask. The lens never reads the words: a dictated
 * answer to an ask goes as `answer {text}` only when the gateway said the ask takes free text, and on a
 * permission that is never an approval (Aristo sends free text on a permission as "No, and say why"),
 * which is what makes an ambiguous spoken "yes" a deny. Anything else is a plain message (`say`).
 */
export function sendTarget(s: State, d: Dictation): { kind: 'answer'; ask: GlassesAsk } | { kind: 'say' } {
  const ask = liveAsk(s, d.key);
  return ask && ask.freeText ? { kind: 'answer', ask } : { kind: 'say' };
}

function dictateGesture(s: State, d: Dictation, g: Gesture, drawn: State): GestureResult {
  const none = (state: State): GestureResult => ({ state, effects: [], pending: {} });

  if (d.phase === 'listening') {
    const ends = (d.via === 'hold' && g === 'release') || (d.via === 'tap' && g === 'tap');
    if (ends) {
      const r = nextReq(s);
      return {
        state: replaceTop(r.s, { ...d, phase: 'transcribing' }),
        effects: [{ kind: 'transcribe', reqId: r.reqId }],
        pending: { [r.reqId]: { kind: 'stt' } },
      };
    }
    if (g === 'double') return { state: pop(s), effects: [{ kind: 'micStop' }], pending: {} };
    return none(s);
  }

  if (d.phase === 'transcribing' || d.phase === 'sending') {
    return g === 'double' ? none(pop(s)) : none(s);
  }

  if (g === 'up' || g === 'down') return none(setCursor(s, d, cursorIndex(s, d) + (g === 'down' ? 1 : -1)));
  if (g === 'double') return none(pop(s));
  if (g === 'hold') return redo(s, d, 'hold');
  if (g !== 'tap') return none(s);

  const it = items(drawn, d)[cursorIndex(drawn, d)];
  if (!it) return none(s);
  if (it.kind === 'cancel') return none(pop(s));
  if (it.kind === 'redo') return redo(s, d, 'tap');
  if (it.kind !== 'send') return none(s);

  const target = sendTarget(s, d);
  const r = nextReq(s);
  const sending = replaceTop(r.s, { ...d, phase: 'sending' });
  if (target.kind === 'answer') {
    const answered = { ...sending, answered: [...sending.answered, target.ask.promptId] };
    return {
      state: answered,
      effects: [
        {
          kind: 'send',
          frame: { t: 'answer', reqId: r.reqId, key: d.key, promptId: target.ask.promptId, text: d.text },
        },
      ],
      pending: { [r.reqId]: { kind: 'answer', promptId: target.ask.promptId } },
    };
  }
  return {
    state: sending,
    effects: [{ kind: 'send', frame: { t: 'say', reqId: r.reqId, key: d.key, text: d.text } }],
    pending: { [r.reqId]: { kind: 'say' } },
  };
}

function redo(s: State, d: Dictation, via: 'hold' | 'tap'): GestureResult {
  return {
    state: replaceTop(s, { ...d, via, phase: 'listening', text: '', error: null }),
    effects: [{ kind: 'micStart' }],
    pending: {},
  };
}

function bannerGesture(s: State, g: Gesture): GestureResult {
  const b = s.banner!;
  if (g === 'up' || g === 'down')
    return { state: { ...s, bannerCursor: g === 'down' ? 1 : 0 }, effects: [], pending: {} };
  if (g === 'double' || (g === 'tap' && s.bannerCursor === 1))
    return { state: { ...s, banner: null }, effects: [], pending: {} };
  if (g !== 'tap') return { state: s, effects: [], pending: {} };
  // Answer now: open that session on top of wherever we are; double tap comes back here.
  let next: State = { ...s, banner: null };
  const sc = top(next);
  if (sc.kind === 'dictate') next = pop(next);
  next = push(next, { kind: 'session', key: b.key, title: b.title });
  return { state: next, effects: navEffects(next), pending: {} };
}

/** Drop a banner or notice whose time is up. Pure in `now`; app.ts calls it on a timer too. */
export function expire(s: State, now: number): State {
  let out = s;
  if (out.banner && now - out.banner.at >= BANNER_MS) out = { ...out, banner: null };
  if (out.notice && now >= out.notice.until) out = { ...out, notice: null };
  return out;
}

/** Called when the mic stopped on its own (60 s cap, error) while listening: treat it as the end gesture. */
export function micEnded(s: State): GestureResult {
  const sc = top(s);
  if (sc.kind !== 'dictate' || sc.phase !== 'listening') return { state: s, effects: [], pending: {} };
  return dictateGesture(s, sc, sc.via === 'hold' ? 'release' : 'tap', s);
}

// ------------------------------------------------------------------------------------------- resume

/** What survives a cold start: the navigable screens (never a dictation) and the Inbox count at the time. */
export interface Saved {
  stack: Screen[];
  inboxNeeds: number;
  at: number;
}

export function toSaved(s: State, now: number): Saved {
  const stack = s.stack.filter((sc) => sc.kind !== 'dictate');
  return { stack, inboxNeeds: s.home?.[0]?.needs ?? 0, at: now };
}

/** Start where the wearer left off. */
export function restore(s: State, saved: Saved | null): State {
  if (!saved || !saved.stack.length || saved.stack[0].kind !== 'home') return s;
  return { ...s, stack: saved.stack };
}

/**
 * The first Home after a cold start decides the landing screen: if more sessions need Jordan than when the
 * app was last left, he most likely opened it from a lens notification, so land on Inbox (which Aristo sorts
 * waiting-first, so that session is on top). Otherwise stay where he was.
 */
export function landing(s: State, saved: Saved | null): State {
  const inbox = s.home?.[0];
  if (!inbox) return s;
  if (saved && inbox.needs <= saved.inboxNeeds) return s;
  if (!saved && inbox.needs === 0) return s;
  const stack: Screen[] = [{ kind: 'home' }, { kind: 'view', viewId: inbox.id, name: inbox.name }];
  return resetCursor({ ...s, stack }, stack[1]);
}
