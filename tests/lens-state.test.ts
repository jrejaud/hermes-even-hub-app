import { describe, expect, it } from 'vitest';
import type { GlassesServerFrame } from '../src/gateway/glasses';
import { ASKS, HOME, ROWS, threadFrame, viewFrame } from '../src/dev/fake-gateway';
import { layout } from '../src/lens/layout';
import {
  BANNER_MS,
  cursorIndex,
  expire,
  glideFrames,
  gesture,
  initialState,
  items,
  landing,
  MAX_LISTEN_MS,
  MENU_LEAVE_QUIET,
  MENU_NEW_AGENT,
  MORE_MESSAGES,
  MENU_QUIET,
  menuActions,
  menuPick,
  micEnded,
  peekFor,
  anchorFor,
  receive,
  reply,
  restore,
  toSaved,
  top,
  type Gesture,
  type State,
} from '../src/lens/state';

const T = 1_000_000;
const hello: GlassesServerFrame = { t: 'hello', protocol: 1, host: 'chiba', hosts: [] };
const feed = (s: State, ...f: GlassesServerFrame[]): State => f.reduce((a, x) => receive(a, x, T).state, s);
const press = (s: State, ...g: Gesture[]): State => g.reduce((a, x) => gesture(a, x, T).state, s);
const online = (): State => feed(initialState(), hello, { t: 'home', views: HOME });
const inbox = (): State => feed(press(online(), 'tap'), viewFrame('inbox'));
const open = (i: number): State => {
  let s = inbox();
  for (let k = 0; k < i; k++) s = press(s, 'down');
  return feed(press(s, 'tap'), threadFrame(ROWS[i].key));
};
const sends = (r: ReturnType<typeof gesture>) => r.effects.flatMap((e) => (e.kind === 'send' ? [e.frame] : []));

describe('navigation', () => {
  it('hello re-sends the open screen (a resume rebuilds from the gateway)', () => {
    const s = press(online(), 'tap');
    const r = receive(s, hello, T);
    expect(r.effects).toEqual([{ kind: 'send', frame: { t: 'open', screen: 'view', viewId: 'inbox' } }]);
  });

  it('tapping a view opens it and tells the gateway', () => {
    const r = gesture(online(), 'tap', T);
    expect(top(r.state)).toEqual({ kind: 'view', viewId: 'inbox', name: 'Inbox' });
    expect(sends(r)).toEqual([{ t: 'open', screen: 'view', viewId: 'inbox' }]);
  });

  it('double tap goes back one level, and exits from Home', () => {
    const back = gesture(inbox(), 'double', T);
    expect(top(back.state).kind).toBe('home');
    expect(sends(back)).toEqual([{ t: 'open', screen: 'home' }]);
    expect(gesture(online(), 'double', T).effects).toEqual([{ kind: 'exit' }]);
  });
});

describe("answers echo the gateway's payload", () => {
  it('tapping an option sends exactly option.answer, returns to the list with the cursor on top', () => {
    const s = press(open(0), 'down'); // Search only
    const r = gesture(s, 'tap', T);
    expect(sends(r)[0]).toEqual({
      t: 'answer',
      reqId: expect.any(String),
      key: 'overlord/kill',
      answer: ASKS['overlord/kill'].options[1].answer,
    });
    expect(top(r.state)).toMatchObject({ kind: 'view', viewId: 'inbox' });
    expect(cursorIndex(r.state)).toBe(0);
    expect(r.state.answered).toContain('p-kill');
  });

  it('the default cursor is the primary (safe) option', () => {
    expect(items(open(1))[cursorIndex(open(1))]).toEqual({ id: 'opt:0', kind: 'option', index: 0 });
  });

  it('a refused answer un-hides the ask and says why', () => {
    const r = gesture(open(0), 'tap', T);
    const reqId = Object.keys(r.pending)[0];
    const back = reply(r.state, r.pending[reqId], { t: 'refused', reqId, reason: 'gone', message: '' }, T);
    expect(back.state.answered).not.toContain('p-kill');
    expect(back.state.notice?.text).toBe('already answered');
  });
});

describe('the cursor', () => {
  it('stays on the same session when the list reorders', () => {
    const s = press(inbox(), 'down', 'down', 'down'); // G2 app plan
    expect(items(s)[cursorIndex(s)].id).toBe('overlord/g2');
    const reordered = feed(s, viewFrame('inbox', [ROWS[3], ...ROWS.filter((_, i) => i !== 3)]));
    expect(items(reordered)[cursorIndex(reordered)].id).toBe('overlord/g2');
    expect(cursorIndex(reordered)).toBe(0);
  });

  it('a tap opens what was DRAWN under the cursor, not what is there after a reorder', () => {
    const drawn = press(inbox(), 'down'); // Deploy fix drawn under the cursor
    const live = feed(drawn, viewFrame('inbox', [ROWS[0], ROWS[3], ROWS[1], ...ROWS.slice(4)])); // deploy moved down
    const r = gesture(live, 'tap', T, drawn);
    expect(top(r.state)).toMatchObject({ kind: 'session', key: 'chiba/deploy' });
  });

  it('keeps its height when its item disappears', () => {
    const s = press(inbox(), 'down', 'down'); // churn
    const gone = feed(
      s,
      viewFrame(
        'inbox',
        ROWS.filter((r) => r.key !== 'box/churn'),
      ),
    );
    expect(cursorIndex(gone)).toBe(2);
  });
});

describe('voice (hold to talk, streamed: v2 SC-9703)', () => {
  /** Hold, then let go a second later (a real utterance, not an accidental press). */
  const talk = (s: State) => {
    const hold = gesture(s, 'hold', T);
    const listenId = Object.keys(hold.pending)[0];
    const rel = gesture(hold.state, 'release', T + 1_000);
    return { hold, rel, listenId };
  };
  const finish = (st: State, listenId: string, text: string) =>
    reply(st, { kind: 'listen' }, { t: 'ok', reqId: listenId, text }, T).state;

  it('hold opens the mic and starts a listen; release flushes it with listen.end', () => {
    const { hold, rel, listenId } = talk(open(1));
    expect(top(hold.state)).toMatchObject({ kind: 'dictate', phase: 'listening', listenId });
    expect(hold.effects).toEqual([
      { kind: 'send', frame: { t: 'listen', reqId: listenId, lang: ['en', 'ja'] } },
      { kind: 'micStart', reqId: listenId },
    ]);
    expect(rel.effects).toEqual([{ kind: 'micStop' }, { kind: 'send', frame: { t: 'listen.end', reqId: listenId } }]);
    expect(top(rel.state)).toMatchObject({ phase: 'finishing' });
  });

  it('a hold shorter than 600 ms is discarded (listen.cancel), nothing to confirm', () => {
    const hold = gesture(open(3), 'hold', T);
    const id = Object.keys(hold.pending)[0];
    const rel = gesture(hold.state, 'release', T + 200);
    expect(sends(rel)).toEqual([{ t: 'listen.cancel', reqId: id }]);
    expect(top(rel.state).kind).toBe('session');
  });

  it('partials show the words while holding; stale ones are ignored', () => {
    const { hold, listenId } = talk(open(3));
    const s = receive(hold.state, { t: 'partial', reqId: listenId, final: 'deploy the', interim: 'stag' }, T).state;
    expect(top(s)).toMatchObject({ text: 'deploy the', interim: 'stag' });
    const stale = receive(s, { t: 'partial', reqId: 'r999', final: 'other', interim: '' }, T).state;
    expect(top(stale)).toMatchObject({ text: 'deploy the' });
  });

  it('dictation on a permission answers with text, which Aristo treats as a deny; never an approval option', () => {
    const { rel, listenId } = talk(open(1));
    const s = finish(rel.state, listenId, 'yes go ahead');
    expect(top(s)).toMatchObject({ phase: 'confirm', text: 'yes go ahead' });
    const send = gesture(s, 'tap', T);
    expect(sends(send)).toEqual([
      { t: 'answer', reqId: expect.any(String), key: 'chiba/deploy', promptId: 'p-deploy', text: 'yes go ahead' },
    ]);
    expect(JSON.stringify(sends(send))).not.toContain('"option"');
  });

  it('dictation on a session with no ask sends a message', () => {
    const { rel, listenId } = talk(open(3));
    expect(sends(gesture(finish(rel.state, listenId, 'hi'), 'tap', T))[0]).toMatchObject({
      t: 'say',
      key: 'overlord/g2',
      text: 'hi',
    });
  });

  it('nothing heard shows the empty screen, not a blank confirm', () => {
    const { rel, listenId } = talk(open(3));
    expect(top(finish(rel.state, listenId, '  '))).toMatchObject({ phase: 'empty' });
  });

  it('a refused listen (Soniox down, out of credit) stops the mic and says why', () => {
    const { hold, listenId } = talk(open(3));
    const r = reply(
      hold.state,
      { kind: 'listen' },
      { t: 'refused', reqId: listenId, reason: 'host-down', message: 'speech offline' },
      T,
    );
    expect(top(r.state)).toMatchObject({ phase: 'failed', error: 'speech offline' });
    expect(r.effects).toEqual([{ kind: 'micStop' }]);
  });

  it('an ask without free text cannot be dictated to', () => {
    const s = press(open(2), 'hold');
    expect(top(s).kind).toBe('session');
    expect(s.notice).toBeNull();
  });

  it('a tap ends listening when the release was lost', () => {
    const hold = gesture(open(3), 'hold', T);
    expect(top(gesture(hold.state, 'tap', T + 1_000).state)).toMatchObject({ phase: 'finishing' });
  });

  it('the 60 s cap ends a recording as if the wearer let go', () => {
    const hold = gesture(open(3), 'hold', T);
    const r = micEnded(hold.state, T + MAX_LISTEN_MS);
    expect(top(r.state)).toMatchObject({ phase: 'finishing' });
    expect(sends(r)[0]).toMatchObject({ t: 'listen.end' });
  });

  it('hold on a list row opens that session underneath and listens', () => {
    const r = gesture(press(inbox(), 'down'), 'hold', T);
    expect(r.state.stack.map((x) => x.kind)).toEqual(['home', 'view', 'session', 'dictate']);
    expect(sends(r)[0]).toEqual({ t: 'open', screen: 'session', key: 'chiba/deploy' });
    expect(sends(r)[1]).toMatchObject({ t: 'listen' });
  });

  it('hold on Home dictates a NEW session; its ok opens that session', () => {
    const { rel, listenId } = talk(online());
    const confirm = finish(rel.state, listenId, 'audit the churn numbers');
    expect(top(confirm)).toMatchObject({ purpose: 'create', phase: 'confirm' });
    const send = gesture(confirm, 'tap', T);
    expect(sends(send)).toEqual([{ t: 'create', reqId: expect.any(String), text: 'audit the churn numbers' }]);
    const reqId = Object.keys(send.pending)[0];
    const done = reply(send.state, send.pending[reqId], { t: 'ok', reqId, key: 'chiba/new-1' }, T);
    expect(top(done.state)).toMatchObject({ kind: 'session', key: 'chiba/new-1' });
    expect(done.effects[0]).toEqual({ kind: 'send', frame: { t: 'open', screen: 'session', key: 'chiba/new-1' } });
  });
});

describe('conversation and its menu (v2 SC-9703)', () => {
  const long = (): State => {
    const t = threadFrame(ROWS[3].key);
    const lines = Array.from({ length: 30 }, (_, i) => ({
      who: i % 2 ? ('agent' as const) : ('you' as const),
      text: `line ${i}`,
    }));
    return feed(press(inbox(), 'down', 'down', 'down', 'tap'), { ...t, lines });
  };

  it('swipe up pages back through the conversation, down returns to following the newest', () => {
    const s = long();
    const key = ROWS[3].key;
    const up = press(s, 'up');
    expect(typeof up.anchors[key]).toBe('number');
    expect(press(up, 'down', 'down', 'down', 'down', 'down', 'down').anchors[key]).toBeNull();
  });

  it('tap opens the menu; Stop on a working session sends interrupt and stays on the conversation', () => {
    let s = open(3);
    s = { ...s, thread: { ...s.thread!, row: { ...s.thread!.row, mark: 'working' } } };
    const m = press(s, 'tap');
    expect(top(m).kind).toBe('menu');
    expect(items(m).map((i) => i.kind)).toEqual(['stop', 'done', 'close']);
    const r = gesture(m, 'tap', T);
    expect(sends(r)).toEqual([{ t: 'interrupt', reqId: expect.any(String), key: 'overlord/g2' }]);
    expect(top(r.state)).toMatchObject({ kind: 'session', key: 'overlord/g2' });
  });

  it('Mark done patches and goes back to the list', () => {
    const m = press(open(3), 'tap');
    const at = items(m).findIndex((i) => i.kind === 'done');
    const r = gesture(press(m, ...Array<Gesture>(at).fill('down')), 'tap', T);
    expect(sends(r)[0]).toMatchObject({ t: 'patch', key: 'overlord/g2', done: true });
    expect(top(r.state).kind).toBe('view');
  });
});

describe('banner', () => {
  const banner: GlassesServerFrame = {
    t: 'banner',
    key: 'box/churn',
    title: 'Churn audit',
    ask: 'Include trial users?',
    promptId: 'p-churn',
  };

  it('is not shown for the session already open', () => {
    expect(feed(open(2), banner).banner).toBeNull();
  });

  it('Answer now opens that session; it expires after 10 s', () => {
    const s = feed(open(3), banner);
    expect(s.banner?.key).toBe('box/churn');
    const r = gesture(s, 'tap', T);
    expect(top(r.state)).toMatchObject({ kind: 'session', key: 'box/churn' });
    expect(expire(s, T + BANNER_MS).banner).toBeNull();
  });

  it('Later dismisses and leaves the screen alone', () => {
    const s = press(feed(open(3), banner), 'down', 'tap');
    expect(s.banner).toBeNull();
    expect(top(s)).toMatchObject({ kind: 'session', key: 'overlord/g2' });
  });
});

describe('resume', () => {
  it('restores where the wearer was, never a dictation', () => {
    const s = press(open(3), 'hold');
    const saved = toSaved(s, T);
    expect(saved.stack.map((x) => x.kind)).toEqual(['home', 'view', 'session']);
    expect(restore(initialState(), saved).stack).toEqual(saved.stack);
  });

  it('lands on Inbox when more sessions need Jordan than when he left (a lens notification)', () => {
    const saved = {
      stack: [{ kind: 'home' as const }, { kind: 'view' as const, viewId: 'parakeet', name: 'Parakeet' }],
      inboxNeeds: 1,
      at: 0,
    };
    const s = landing(feed(restore(initialState(), saved), hello, { t: 'home', views: HOME }), saved);
    expect(top(s)).toMatchObject({ kind: 'view', viewId: 'inbox' });
    const same = { ...saved, inboxNeeds: 3 };
    expect(top(landing(feed(restore(initialState(), same), hello, { t: 'home', views: HOME }), same))).toMatchObject({
      viewId: 'parakeet',
    });
  });
});

describe('a dictated answer gets its reply (review finding, SC-9500)', () => {
  const sendDictatedAnswer = () => {
    const hold = gesture(open(1), 'hold', T);
    const listenId = Object.keys(hold.pending)[0];
    const rel = gesture(hold.state, 'release', T + 1_000);
    const confirm = reply(
      rel.state,
      hold.pending[listenId],
      { t: 'ok', reqId: listenId, text: 'no, use the staging host' },
      T,
    ).state;
    const send = gesture(confirm, 'tap', T);
    const reqId = Object.keys(send.pending)[0];
    expect(top(send.state)).toMatchObject({ kind: 'dictate', phase: 'sending' });
    return { s: send.state, reqId, pending: send.pending[reqId] };
  };

  it('ok closes the confirm screen and returns to the session', () => {
    const { s, reqId, pending } = sendDictatedAnswer();
    const r = reply(s, pending, { t: 'ok', reqId }, T);
    expect(top(r.state)).toMatchObject({ kind: 'session', key: 'chiba/deploy' });
  });

  it('refused moves to failed with the reason, and the ask comes back', () => {
    const { s, reqId, pending } = sendDictatedAnswer();
    const r = reply(s, pending, { t: 'refused', reqId, reason: 'gone', message: '' }, T);
    expect(top(r.state)).toMatchObject({ kind: 'dictate', phase: 'failed', error: 'already answered' });
    expect(r.state.answered).not.toContain('p-deploy');
  });
});

describe('hold while offline (glasses gate dead-frame, SC-9703)', () => {
  it('does nothing when unconfigured or reconnecting: no listen, no mic', () => {
    for (const s of [initialState('unconfigured'), { ...online(), conn: 'reconnecting' as const }]) {
      const r = gesture(s, 'hold', T);
      expect(r.state).toBe(s);
      expect(r.effects).toEqual([]);
    }
  });
});

describe('reading the conversation behind an ask (Jordan, 2026-11-13)', () => {
  // "If I'm in high priority, I can see the questions, but I don't see a way that I can scroll up and see
  // the actual session." Up past the first option reads it; down off the newest page or a tap comes back.
  const key = 'overlord/kill';
  it('up on the first option opens the conversation; up again pages back; down returns to the options', () => {
    const s = open(0);
    expect(cursorIndex(s)).toBe(0);
    const peeking = press(s, 'up');
    expect(peekFor(peeking, key)).toBeTypeOf('number');
    const newest = peekFor(peeking, key)!;
    const older = press(peeking, 'up');
    if (newest > 0) expect(peekFor(older, key)!).toBeLessThan(newest);
    let back = older;
    for (let i = 0; i < 10 && peekFor(back, key) !== undefined; i++) back = press(back, 'down');
    expect(peekFor(back, key)).toBeUndefined();
    expect(cursorIndex(back)).toBe(0);
  });

  it('a tap while reading goes back to the options and answers nothing', () => {
    const peeking = press(open(0), 'up');
    const r = gesture(peeking, 'tap', T, peeking);
    expect(sends(r)).toEqual([]);
    expect(peekFor(r.state, key)).toBeUndefined();
    expect(top(r.state)).toMatchObject({ kind: 'session', key });
  });

  it('up below the first option still moves the cursor', () => {
    const s = press(open(0), 'down', 'up');
    expect(cursorIndex(s)).toBe(0);
    expect(peekFor(s, key)).toBeUndefined();
  });

  it('back from a session forgets the reading position', () => {
    const s = press(open(0), 'up', 'double');
    expect(s.peek[key]).toBeUndefined();
  });
});

describe('quiet mode (Jordan, 2026-11-13)', () => {
  // "I can run it in a way where it doesn't actually show anything … if an agent needs me, it would show up
  // like a notification … I would tap a button and be taken to the session."
  const banner: GlassesServerFrame = {
    t: 'banner',
    key: 'box/churn',
    title: 'Churn audit',
    ask: 'Include trial users?',
    promptId: 'p-churn',
  };
  const quiet = (): State => menuPick(online(), MENU_QUIET, T).state;

  // Jordan, 2026-11-13: "the way you access it should be from tapping and holding the menu … add quiet mode in
  // there"; "quiet mode should just look totally quiet".
  it('Home has no Quiet row; the glasses menu offers Quiet mode, and Leave quiet mode once in it', () => {
    expect(items(online()).map((i) => i.kind)).not.toContain('quiet');
    expect(menuActions(online())).toEqual([
      { id: MENU_QUIET, label: 'Quiet mode' },
      { id: MENU_NEW_AGENT, label: 'New session' },
    ]);
    expect(menuActions(quiet())).toEqual([
      { id: MENU_LEAVE_QUIET, label: 'Leave quiet mode' },
      { id: MENU_NEW_AGENT, label: 'New session' },
    ]);
    expect(menuActions({ ...online(), conn: 'reconnecting' })).toEqual([{ id: MENU_QUIET, label: 'Quiet mode' }]);
    expect(menuActions(press(online(), 'hold'))).toEqual([]); // dictating: the mic is open
  });

  it('Quiet mode from inside a session sits on top of Home (the gateway is told Home, so banners keep coming)', () => {
    const inSession = press(online(), 'tap', 'tap');
    expect(top(inSession).kind).not.toBe('home');
    const r = menuPick(inSession, MENU_QUIET, T);
    expect(r.state.stack).toEqual([{ kind: 'home' }, { kind: 'quiet' }]);
    expect(r.effects).toContainEqual({ kind: 'send', frame: { t: 'open', screen: 'home' } });
    expect(menuPick(r.state, MENU_LEAVE_QUIET, T).state.stack).toEqual([{ kind: 'home' }]);
  });

  // Jordan, 2026-11-13: "we should also put like new agent there".
  it('New session from the glasses menu opens the mic for a new session from any screen; only a tap ends it', () => {
    for (const from of [online(), quiet(), press(online(), 'tap', 'tap')]) {
      const r = menuPick(from, MENU_NEW_AGENT, T);
      expect(top(r.state)).toMatchObject({ kind: 'dictate', purpose: 'create', phase: 'listening', key: null });
      expect(r.effects.map((e) => e.kind)).toEqual(['send', 'micStart']);
      // The release that trails the menu's tap-then-hold does not end it; a tap does.
      const later = (st: State, g: Gesture) => gesture(st, g, T + 3_000).state;
      expect(top(later(r.state, 'release'))).toMatchObject({ kind: 'dictate', phase: 'listening' });
      expect(top(later(r.state, 'tap'))).toMatchObject({ kind: 'dictate', phase: 'finishing' });
    }
    expect(menuPick({ ...online(), conn: 'reconnecting' }, MENU_NEW_AGENT, T).effects).toEqual([]);
  });

  it('a menu id this screen does not offer changes nothing', () => {
    const s = online();
    expect(menuPick(s, MENU_LEAVE_QUIET, T).state).toBe(s);
    expect(menuPick(s, 99, T).state).toBe(s);
  });

  it('the quiet lens draws nothing at all, not even a corner label, even while reconnecting', () => {
    for (const s of [quiet(), { ...quiet(), conn: 'reconnecting' as const }]) {
      const f = layout(s);
      expect([f.left, f.right, ...f.body.map((b) => b.text)].join('')).toBe('');
    }
  });

  it('a banner in quiet mode stays until dismissed; Answer now opens the session, answering returns to quiet', () => {
    const s = feed(quiet(), banner);
    expect(expire(s, T + BANNER_MS * 10).banner?.key).toBe('box/churn');
    const opened = press(s, 'tap');
    expect(top(opened)).toMatchObject({ kind: 'session', key: 'box/churn' });
    expect(top(press(opened, 'double'))).toEqual({ kind: 'quiet' });
  });

  it('Later or a double tap on the banner goes back to the blank lens', () => {
    expect(top(press(feed(quiet(), banner), 'double'))).toEqual({ kind: 'quiet' });
    const later = press(feed(quiet(), banner), 'down', 'tap');
    expect(later.banner).toBeNull();
    expect(top(later)).toEqual({ kind: 'quiet' });
  });

  it('tap or double tap on the blank lens goes back to Home; swipes do nothing', () => {
    expect(top(press(quiet(), 'tap'))).toEqual({ kind: 'home' });
    expect(top(press(quiet(), 'double'))).toEqual({ kind: 'home' });
    expect(top(press(quiet(), 'up', 'down'))).toEqual({ kind: 'quiet' });
  });

  it('a cold start with more sessions waiting does not pull the wearer out of quiet mode', () => {
    const s = quiet();
    expect(s.home?.[0]?.needs).toBeGreaterThan(0);
    expect(top(landing(s, { ...toSaved(s, T), inboxNeeds: 0 }))).toEqual({ kind: 'quiet' });
  });
});

// Jordan, 2026-11-13: "instead of changing the entire page at once, the scrolling should be smooth".
describe('a swipe glides the conversation a line at a time', () => {
  const key = ROWS[3].key;
  const long = (): State => {
    const t = threadFrame(key);
    const lines = Array.from({ length: 30 }, (_, i) => ({ who: 'agent' as const, text: `line ${i}`, at: '' }));
    return feed(press(inbox(), 'down', 'down', 'down', 'tap'), { ...t, lines });
  };

  it('swipe up: the in-between frames step the anchor one line each, ending next to the target', () => {
    const s = long();
    const up = press(s, 'up');
    const target = anchorFor(up, key)!;
    const frames = glideFrames(s, up);
    // A 3-line step has 2 frames in between: target+2, target+1.
    expect(frames.map((f) => anchorFor(f, key))).toEqual([target + 2, target + 1]);
  });

  it('no glide for a cut: opening another screen, or the menu', () => {
    const s = long();
    expect(glideFrames(s, press(s, 'tap'))).toEqual([]);
    expect(glideFrames(inbox(), s)).toEqual([]);
  });
});

// Jordan, 2026-11-13: tool calls stay off the lens, including the "what it is doing" line.
describe('the activity line never names a tool', () => {
  const key = ROWS[3].key;
  const working = (detail: string, promptId: string | null): State => {
    const t = threadFrame(key);
    return feed(press(inbox(), 'down', 'down', 'down', 'tap'), {
      ...t,
      row: { ...t.row, mark: 'working', detail, promptId },
    });
  };
  const text = (s: State): string =>
    layout(s)
      .body.map((b) => b.text)
      .join('\n');

  it('a working session shows "working", not the tool it runs', () => {
    const out = text(working('Edit packages/shared/view-engine.ts', null));
    expect(out).not.toContain('view-engine');
    expect(out).toContain('working');
  });
});

// Jordan, 2026-11-13: "can you make it so I can scroll down, scroll up forever? I can only scroll like five screens".
describe('scrolling back through a long session', () => {
  const key = 'overlord/g2';
  const msgs = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ who: 'agent' as const, text: `message ${from + i}`, at: `t${from + i}` }));
  const frame = (lines: ReturnType<typeof msgs>): GlassesServerFrame => ({ ...threadFrame(key), lines });
  const opened = (): State => feed(open(ROWS.findIndex((r) => r.key === key)), frame(msgs(100, 12)));

  it('scrolling up past the top asks the gateway for more messages, and the open carries the bigger limit', () => {
    let s = opened();
    const sent = [];
    for (let i = 0; i < 10; i++) {
      const r = gesture(s, 'up', T);
      sent.push(...r.effects);
      s = r.state;
    }
    expect(sent).toEqual([{ kind: 'send', frame: { t: 'open', screen: 'session', key, limit: 12 + MORE_MESSAGES } }]);
  });

  it('when the older messages land, the screen keeps showing the same line (no jump)', () => {
    let s = opened();
    for (let i = 0; i < 10; i++) s = press(s, 'up');
    s = gesture(s, 'up', T).state;
    const before = layout(s).body[0]!.text;
    const after = feed(s, frame([...msgs(76, 24), ...msgs(100, 12)]));
    expect(layout(after).body[0]!.text).toBe(before);
  });

  it('a frame that came back short (the whole session is loaded) asks for nothing more', () => {
    let s = feed(open(ROWS.findIndex((r) => r.key === key)), frame(msgs(100, 5)));
    for (let i = 0; i < 5; i++) s = press(s, 'up');
    expect(gesture(s, 'up', T).effects).toEqual([]);
  });

  it('the header does not change while the text scrolls (no page number)', () => {
    let s = opened();
    const right = layout(s).right;
    for (let i = 0; i < 3; i++) {
      s = press(s, 'up');
      expect(layout(s).right).toBe(right);
    }
  });
});

describe('starting the app', () => {
  // Jordan, 2026-11-13: "don't start automatically in quiet mode when you start the app".
  it('never restores quiet mode: it opens on the screen under it', () => {
    const q = menuPick(online(), MENU_QUIET, T).state;
    expect(restore(initialState(), toSaved(q, T)).stack).toEqual([{ kind: 'home' }]);
  });
});
