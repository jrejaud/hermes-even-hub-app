import { describe, expect, it } from 'vitest';
import type { GlassesServerFrame } from '../src/gateway/glasses';
import { ASKS, HOME, ROWS, threadFrame, viewFrame } from '../src/dev/fake-gateway';
import {
  BANNER_MS,
  cursorIndex,
  expire,
  gesture,
  initialState,
  items,
  landing,
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

describe('voice', () => {
  it('dictation on a permission answers with text, which Aristo treats as a deny; never an approval option', () => {
    let s = press(open(1), 'hold');
    expect(top(s)).toMatchObject({ kind: 'dictate', phase: 'listening', via: 'hold' });
    const rel = gesture(s, 'release', T);
    expect(rel.effects).toEqual([{ kind: 'transcribe', reqId: expect.any(String) }]);
    const sttId = Object.keys(rel.pending)[0];
    s = reply(rel.state, rel.pending[sttId], { t: 'ok', reqId: sttId, text: 'yes go ahead' }, T).state;
    expect(top(s)).toMatchObject({ phase: 'confirm', text: 'yes go ahead' });
    const send = gesture(s, 'tap', T);
    expect(sends(send)).toEqual([
      { t: 'answer', reqId: expect.any(String), key: 'chiba/deploy', promptId: 'p-deploy', text: 'yes go ahead' },
    ]);
    expect(JSON.stringify(sends(send))).not.toContain('"option"');
  });

  it('dictation on a session with no ask sends a message', () => {
    let s = press(open(3), 'hold', 'release');
    s = {
      ...s,
      stack: [...s.stack.slice(0, -1), { ...(top(s) as never as object), phase: 'confirm', text: 'hi' } as never],
    };
    expect(sends(gesture(s, 'tap', T))[0]).toMatchObject({ t: 'say', key: 'overlord/g2', text: 'hi' });
  });

  it('an ask without free text cannot be dictated to', () => {
    const s = press(open(2), 'hold');
    expect(top(s).kind).toBe('session');
    expect(s.notice?.text).toBe('tap an option');
  });

  it("a tapped 'Talk to it' row ends listening on the next tap", () => {
    const s = press(open(3), 'tap'); // Talk to it
    expect(top(s)).toMatchObject({ kind: 'dictate', via: 'tap', phase: 'listening' });
    expect(top(press(s, 'tap'))).toMatchObject({ phase: 'transcribing' });
  });

  it('hold on a list row opens that session underneath and listens', () => {
    const r = gesture(press(inbox(), 'down'), 'hold', T);
    expect(r.state.stack.map((x) => x.kind)).toEqual(['home', 'view', 'session', 'dictate']);
    expect(sends(r)).toEqual([{ t: 'open', screen: 'session', key: 'chiba/deploy' }]);
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
