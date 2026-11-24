import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk';
import { describe, expect, it, vi } from 'vitest';
import { FakeGateway, ASKS, row } from '../src/dev/fake-gateway';
import { gatewayUrl } from '../src/gateway/client';
import { startApp } from '../src/lens/app';
import { Lens } from '../src/lens/draw';
import { toInput } from '../src/lens/input';
import { layout } from '../src/lens/layout';
import { MENU_LEAVE_QUIET, MENU_NEW_AGENT, MENU_QUIET, initialState, menuPick } from '../src/lens/state';
import { parseSaved } from '../src/lens/settings';

function fakeBridge() {
  const store = new Map<string, string>();
  let handler: (e: EvenHubEvent) => void = () => {};
  const b = {
    created: 0,
    rebuilt: 0,
    upgrades: [] as { id: number; content: string }[],
    createStartUpPageContainer: vi.fn(async () => {
      b.created++;
      return 0;
    }),
    rebuildPageContainer: vi.fn(async () => {
      b.rebuilt++;
      return true;
    }),
    textContainerUpgrade: vi.fn(async (u: { containerID: number; content: string }) => {
      b.upgrades.push({ id: u.containerID, content: u.content });
      return true;
    }),
    audioControl: vi.fn(async () => true),
    shutDownPageContainer: vi.fn(async () => true),
    getLocalStorage: vi.fn(async (k: string) => store.get(k) ?? ''),
    setLocalStorage: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return true;
    }),
    onEvenHubEvent: (cb: (e: EvenHubEvent) => void) => {
      handler = cb;
      return () => {};
    },
    fire: (e: EvenHubEvent) => handler(e),
    store,
  };
  return b;
}

/** Let every queued microtask run (the fake gateway and the fake bridge resolve on microtasks, never timers). */
const tick = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
const ev = (eventType?: number): EvenHubEvent =>
  ({ sysEvent: eventType === undefined ? {} : { eventType } }) as unknown as EvenHubEvent;

describe('input', () => {
  it('a tap arrives with no eventType (protobuf drops 0)', () => {
    expect(toInput(ev())).toBe('tap');
    expect(toInput(ev(OsEventTypeList.DOUBLE_CLICK_EVENT))).toBe('double');
    expect(toInput({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } } as unknown as EvenHubEvent)).toBe(
      'down',
    );
    expect(toInput(ev(OsEventTypeList.LONG_PRESS_EVENT))).toBe('hold');
    expect(toInput(ev(OsEventTypeList.LONG_PRESS_RELEASE_EVENT))).toBe('release');
  });
  it('an audio frame is never a tap', () => {
    expect(toInput({ audioEvent: { audioPcm: new Uint8Array(4) } } as unknown as EvenHubEvent)).toBeNull();
  });
});

describe('gateway url', () => {
  it('adds the glasses path and the token; http(s) becomes ws(s)', () => {
    expect(gatewayUrl({ url: 'https://chiba.example:8445', token: 't k' })).toBe(
      'wss://chiba.example:8445/api/glasses?token=t+k&caps=ask-whole',
    );
    expect(gatewayUrl({ url: 'ws://100.1.2.3:9/custom', token: 'x' })).toBe(
      'ws://100.1.2.3:9/custom?token=x&caps=ask-whole',
    );
  });
});

describe('draw', () => {
  it('creates once, upgrades only changed containers, rebuilds only when geometry changes', async () => {
    const b = fakeBridge();
    const lens = new Lens(b as never);
    const s = initialState('connecting');
    await lens.draw(layout(s));
    expect(b.created).toBe(1);
    await lens.draw(layout(s));
    expect(b.upgrades).toHaveLength(0);
    await lens.draw(layout({ ...s, conn: 'reconnecting' }));
    expect(b.rebuilt + b.upgrades.length).toBeGreaterThan(0);
  });

  it('every page build carries the glasses menu, and a changed menu forces a rebuild', async () => {
    const b = fakeBridge();
    const lens = new Lens(b as never);
    const s = initialState('online');
    await lens.draw(layout(s));
    const created = b.createStartUpPageContainer.mock.calls[0] as unknown as [
      { menuObject?: { menuItems: unknown[] } },
    ];
    expect(created[0].menuObject?.menuItems).toEqual([
      expect.objectContaining({ itemID: MENU_QUIET, itemName: 'Quiet mode' }),
      expect.objectContaining({ itemID: MENU_NEW_AGENT, itemName: 'New session' }),
    ]);
    await lens.draw(layout({ ...s, conn: 'reconnecting' }));
    const n = b.rebuilt;
    await lens.draw(layout(menuPick(s, MENU_QUIET, 0).state));
    expect(b.rebuilt).toBe(n + 1);
    const rebuilt = b.rebuildPageContainer.mock.calls.at(-1) as unknown as [{ menuObject?: { menuItems: unknown[] } }];
    expect(rebuilt[0].menuObject?.menuItems).toEqual([
      expect.objectContaining({ itemID: MENU_LEAVE_QUIET, itemName: 'Leave quiet mode' }),
      expect.objectContaining({ itemID: MENU_NEW_AGENT, itemName: 'New session' }),
    ]);
  });

  it('a rejected create falls through to rebuild (create is one-shot)', async () => {
    const b = fakeBridge();
    b.createStartUpPageContainer.mockResolvedValueOnce(1 as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lens = new Lens(b as never);
    await lens.draw(layout(initialState()));
    expect(b.rebuilt).toBe(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('app against the fake gateway', () => {
  it('a glasses-menu pick reaches the app: Quiet mode blanks the lens; opening the menu keeps the socket', async () => {
    const b = fakeBridge();
    const fake = new FakeGateway();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await startApp({
      bridge: b as never,
      connect: fake.connect,
      defaultProfile: { url: 'ws://fake.invalid', token: 'x' },
    });
    await tick();
    const opens = fake.sent.filter((f) => f.t === 'open').length;
    // The OS menu opening sends FOREGROUND_ENTER: a healthy socket must not be torn down for it.
    b.fire(ev(OsEventTypeList.FOREGROUND_ENTER_EVENT));
    await tick();
    expect(fake.sent.filter((f) => f.t === 'open').length).toBe(opens);
    b.fire({ menuItemClickEvent: { itemID: MENU_QUIET } } as unknown as EvenHubEvent);
    await tick();
    const last = b.upgrades
      .slice(-3)
      .map((u) => u.content.trim())
      .join('');
    const rebuilt = b.rebuildPageContainer.mock.calls.at(-1) as unknown as [{ textObject: { content: string }[] }];
    expect(rebuilt[0].textObject.map((t) => t.content.trim()).join('') + last).toBe('');
  });

  it("cold start with sessions waiting lands on Inbox; question → tap the second option: the gateway receives that option's exact payload", async () => {
    const b = fakeBridge();
    const fake = new FakeGateway();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await startApp({
      bridge: b as never,
      connect: fake.connect,
      defaultProfile: { url: 'ws://fake.invalid', token: 'x' },
    });
    await tick();
    b.fire(ev()); // open Ads kill switch (top row)
    await tick();
    b.fire({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } } as unknown as EvenHubEvent);
    await tick();
    b.fire(ev()); // Search only
    await tick();
    const answer = fake.sent.find((f) => f.t === 'answer');
    expect(answer).toEqual({
      t: 'answer',
      reqId: expect.any(String),
      key: 'overlord/kill',
      answer: ASKS['overlord/kill'].options[1].answer,
    });
    // back on the list, and the location was persisted for a cold start
    expect(fake.sent.filter((f) => f.t === 'open').map((f) => ('screen' in f ? f.screen : ''))).toEqual([
      'home',
      'view',
      'session',
      'view',
    ]);
    expect(parseSaved(b.store.get('lens.saved.v1') ?? '')?.stack.map((x) => x.kind)).toEqual(['home', 'view']);
  });
});

describe('production first frames and long views (SC-9499 contract note, 2026-11-11)', () => {
  it('first Home is empty (feeds not open yet), the second is populated: the app lands on Inbox', async () => {
    const b = fakeBridge();
    const fake = new FakeGateway();
    fake.coldFeeds = true;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await startApp({
      bridge: b as never,
      connect: fake.connect,
      defaultProfile: { url: 'ws://fake.invalid', token: 'x' },
    });
    await vi.waitFor(() =>
      expect(fake.sent.filter((f) => f.t === 'open').map((f) => ('viewId' in f ? f.viewId : f.screen))).toContain(
        'inbox',
      ),
    );
  });

  // SC-10526: Home is the starred views, so the view landed on need not be the first one. The app asked the gateway
  // for home[0] while the lens showed the landed view (found by the review, 2026-11-18).
  it('landing opens the view it landed on: the first starred view with someone waiting, not the first row', async () => {
    const b = fakeBridge();
    const fake = new FakeGateway();
    fake.views = [
      { id: 'daemon', name: 'Daemon', needs: 0, working: 0, total: 14 },
      { id: 'parakeet', name: 'Parakeet', needs: 1, working: 2, total: 5 },
    ];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await startApp({
      bridge: b as never,
      connect: fake.connect,
      defaultProfile: { url: 'ws://fake.invalid', token: 'x' },
    });
    await vi.waitFor(() =>
      expect(
        fake.sent.filter((f) => f.t === 'open' && 'viewId' in f).map((f) => ('viewId' in f ? f.viewId : '')),
      ).toEqual(['parakeet']),
    );
  });

  it('a 300-row view pages in: scrolling near the end asks for the next 20 rows and the cursor walks past 20', async () => {
    const b = fakeBridge();
    const fake = new FakeGateway();
    fake.rows = Array.from({ length: 300 }, (_, i) =>
      row({
        key: `chiba/s${i}`,
        title: `Session ${i}`,
        mark: i < 5 ? 'needs' : 'your-turn',
        promptId: i < 5 ? `p${i}` : null,
      }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await startApp({
      bridge: b as never,
      connect: fake.connect,
      defaultProfile: { url: 'ws://fake.invalid', token: 'x' },
    });
    await tick();
    for (let i = 0; i < 30; i++) {
      b.fire({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } } as unknown as EvenHubEvent);
      await tick();
    }
    const limits = fake.sent.flatMap((f) => (f.t === 'open' && 'limit' in f && f.limit ? [f.limit] : []));
    expect(limits).toEqual([40]);
    // the cursor is on row 31 of 300: the header shows the position against the full count
    expect(b.upgrades.some((u) => u.content.includes('31/300'))).toBe(true);
  });
});
