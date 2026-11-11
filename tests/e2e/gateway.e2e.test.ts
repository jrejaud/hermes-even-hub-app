/**
 * End to end: the REAL app shell (startApp) against a REAL glasses gateway over a real WebSocket (SC-9500).
 *
 * Runs only when pointed at a gateway, so `npm test` stays hermetic:
 *   LENS_GATEWAY_URL=ws://127.0.0.1:8465 LENS_GATEWAY_TOKEN=test-token LENS_MOCK_ADMIN=http://127.0.0.1:8465 \
 *     npx vitest run tests/e2e          (or: npm run e2e:gateway)
 *
 * The gateway is aristo-v2's `tools/glasses-mock.ts`: the real gateway code over the fixture world, which
 * records every `prompt.answer` / `session.send` / patch it hands a host at GET /mock/answers. The assertion
 * that matters: what the HOST received is exactly the option payload Aristo presented (the same payload the
 * web client sends, since both come from the shared presenters), and a dictated answer is built by the
 * gateway, not the lens.
 */
import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SocketLike } from '../../src/gateway/client';
import type { GlassesServerFrame } from '../../src/gateway/glasses';
import { startApp } from '../../src/lens/app';

const URL_ = process.env.LENS_GATEWAY_URL;
const TOKEN = process.env.LENS_GATEWAY_TOKEN ?? '';
const ADMIN = process.env.LENS_MOCK_ADMIN;

interface LogEntry {
  host: string;
  op: string;
  args: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const log = async (): Promise<LogEntry[]> => (await (await fetch(`${ADMIN}/mock/answers`)).json()) as LogEntry[];
/** Poll the gateway's host log until an entry matches. */
async function waitLog(what: string, pred: (l: LogEntry) => boolean, ms = 5000): Promise<LogEntry> {
  const end = Date.now() + ms;
  for (;;) {
    const hit = (await log()).find(pred);
    if (hit) return hit;
    if (Date.now() > end) throw new Error(`the gateway never handed a host: ${what}`);
    await sleep(50);
  }
}

describe.skipIf(!URL_ || !ADMIN)('Aristo Lens against a live glasses gateway', () => {
  const frames: GlassesServerFrame[] = [];
  const texts: string[] = [];
  let fire: (e: EvenHubEvent) => void = () => {};
  const store = new Map<string, string>();

  const tap = () => fire({ sysEvent: {} } as unknown as EvenHubEvent);
  const down = () => fire({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } } as unknown as EvenHubEvent);
  const hold = () => fire({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT } } as unknown as EvenHubEvent);
  const release = () =>
    fire({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_RELEASE_EVENT } } as unknown as EvenHubEvent);
  const speak = () => {
    for (let i = 0; i < 10; i++)
      fire({ audioEvent: { audioPcm: new Uint8Array(3200).fill(i) } } as unknown as EvenHubEvent);
  };
  const lastThread = (key: string) =>
    [...frames]
      .reverse()
      .find((f): f is Extract<GlassesServerFrame, { t: 'thread' }> => f.t === 'thread' && f.row.key === key);
  /** The lens shows `s` somewhere (header or body), as last drawn. */
  const shows = (s: string) => texts.slice(-12).some((t) => t.includes(s));
  const settle = () => sleep(150);

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await fetch(`${ADMIN}/mock/reset`, { method: 'POST' });
    const record = (c: { content?: string; textObject?: { content?: string }[] }) => {
      if (c.textObject) for (const t of c.textObject) texts.push(t.content ?? '');
      if (c.content !== undefined) texts.push(c.content);
    };
    const bridge = {
      createStartUpPageContainer: async (c: never) => (record(c), 0),
      rebuildPageContainer: async (c: never) => (record(c), true),
      textContainerUpgrade: async (c: never) => (record(c), true),
      audioControl: async () => true,
      shutDownPageContainer: async () => true,
      getLocalStorage: async (k: string) => store.get(k) ?? '',
      setLocalStorage: async (k: string, v: string) => (store.set(k, v), true),
      onEvenHubEvent: (cb: (e: EvenHubEvent) => void) => ((fire = cb), () => {}),
    };
    const connect = (url: string): SocketLike => {
      const ws = new WebSocket(url);
      ws.addEventListener('message', (e) => frames.push(JSON.parse(String(e.data)) as GlassesServerFrame));
      return ws as unknown as SocketLike;
    };
    await startApp({ bridge: bridge as never, connect, defaultProfile: { url: URL_!, token: TOKEN } });
  });

  afterAll(() => vi.restoreAllMocks());

  it('cold start with sessions waiting lands on Inbox, waiting rows first', async () => {
    await until('home', () => frames.find((f) => f.t === 'home'));
    const view = await until('inbox view', () => frames.find((f) => f.t === 'view' && f.viewId === 'inbox'));
    expect(view.t === 'view' && view.sections[0].rows[0].mark).toBe('needs');
    await until('Inbox on the lens', () => shows('Inbox'));
  });

  it('a permission answered by tap: the host receives the presented option payload verbatim', async () => {
    await settle();
    tap(); // top row: the Bash permission
    const t = await until('permission thread', () => lastThread('chiba/s-perm'));
    expect(t.ask?.kind).toBe('permission');
    await until('the command on the lens', () => shows('git push origin'));
    await settle();
    tap(); // primary option (Yes) is under the cursor by default
    const entry = await waitLog('p-perm', (l) => l.op === 'prompt.answer' && l.args.promptId === 'p-perm');
    expect(entry.host).toBe('chiba');
    expect(entry.args).toEqual(t.ask!.options.find((o) => o.primary)!.answer);
  });

  it('a question answered by tap on its second option', async () => {
    await settle();
    // Back on Inbox with the cursor on top; the answered permission leaves "needs" once the view updates.
    const key = await until('a waiting question on top', () => {
      const v = [...frames].reverse().find((f) => f.t === 'view' && f.viewId === 'inbox');
      const top = v && v.t === 'view' ? v.sections[0].rows[0] : null;
      return top && top.mark === 'needs' && top.key !== 'chiba/s-perm' ? top.key : null;
    });
    await settle();
    tap();
    const t = await until(`thread ${key}`, () => lastThread(key));
    expect(t.ask && t.ask.options.length).toBeGreaterThan(1);
    await settle();
    down();
    await settle();
    tap();
    const hit = await waitLog(t.ask!.promptId, (l) => l.op === 'prompt.answer' && l.args.promptId === t.ask!.promptId);
    expect(hit.args).toEqual(t.ask!.options[1].answer);
  });

  it('a free-text question answered by voice: dictate, confirm, send; the gateway builds the answer', async () => {
    await settle();
    const key = 'box/s-free';
    // Walk the Inbox cursor to the free-text question, then open it.
    for (let i = 0; i < 8; i++) {
      if (shows('▶ ● Box disk')) break;
      down();
      await settle();
    }
    tap();
    const t = await until('free-text thread', () => lastThread(key));
    expect(t.ask?.freeText).toBe(true);
    await settle();
    hold();
    speak();
    release();
    await until('the transcript on the confirm screen', () => shows('dictated text'));
    await settle();
    tap(); // Send
    const hit = await waitLog(t.ask!.promptId, (l) => l.op === 'prompt.answer' && l.args.promptId === t.ask!.promptId);
    expect(JSON.stringify(hit.args)).toContain('dictated text');
  });

  it('a banner appears when another session starts asking', async () => {
    await settle();
    const r = await fetch(`${ADMIN}/mock/ask`, {
      method: 'POST',
      body: JSON.stringify({ key: 'chiba/s-work' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(r.ok).toBe(true);
    await until('banner frame', () => frames.find((f) => f.t === 'banner'));
    await until('banner on the lens', () => shows('needs you') && shows('Answer now'));
  });
});
