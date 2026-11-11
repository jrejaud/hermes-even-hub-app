import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk';
import { getTextWidth } from '@evenrealities/pretext';
import { describe, expect, it, vi } from 'vitest';
import { GatewayClient, type SocketLike } from '../src/gateway/client';
import { toInput } from '../src/lens/input';
import { KEYS, loadProfile, loadSaved, parseSaved, save, saveProfile, validateProfile } from '../src/lens/settings';
import { wrapTextLines } from '../src/lens/wrap';

const store = () => {
  const m = new Map<string, string>();
  return {
    m,
    getLocalStorage: async (k: string) => m.get(k) ?? '',
    setLocalStorage: async (k: string, v: string) => {
      m.set(k, v);
      return true;
    },
  };
};

describe('settings', () => {
  it('validates the gateway profile', () => {
    expect(validateProfile({ url: '', token: '' })).toEqual(['Gateway URL is required.', 'Token is required.']);
    expect(validateProfile({ url: 'not a url', token: 't' })).toEqual(['Gateway URL is not a URL.']);
    expect(validateProfile({ url: 'ftp://x', token: 't' })[0]).toMatch(/must start with/);
    expect(validateProfile({ url: 'wss://agent.alastor.space', token: 't' })).toEqual([]);
  });

  it('round-trips the profile trimmed, and ignores a corrupt one loudly', async () => {
    const s = store();
    await saveProfile(s, { url: ' wss://a.b ', token: ' tok ' });
    expect(await loadProfile(s)).toEqual({ url: 'wss://a.b', token: 'tok' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    s.m.set(KEYS.profile, '{nope');
    expect(await loadProfile(s)).toBeNull();
    s.m.set(KEYS.profile, '{"url":1}');
    expect(await loadProfile(s)).toBeNull();
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
    expect(await loadProfile(store())).toBeNull();
  });

  it('saved location: only home/view/session screens are restored', async () => {
    const s = store();
    await save(s, {
      stack: [{ kind: 'home' }, { kind: 'view', viewId: 'inbox', name: 'Inbox' }],
      inboxNeeds: 2,
      at: 5,
    });
    expect((await loadSaved(s))?.stack).toHaveLength(2);
    expect(parseSaved('')).toBeNull();
    expect(parseSaved('{"stack":[{"kind":"dictate"}],"inboxNeeds":0}')).toBeNull();
    expect(parseSaved('{"stack":[{"kind":"session","key":"a/b","title":"t"}],"inboxNeeds":1}')?.at).toBe(0);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseSaved('{bad')).toBeNull();
    err.mockRestore();
  });
});

describe('wrap', () => {
  it('splits a word wider than the line by glyph, and keeps explicit breaks', () => {
    const lines = wrapTextLines('x'.repeat(300) + ' tail\n\nnext', 200);
    for (const l of lines) expect(getTextWidth(l)).toBeLessThanOrEqual(200);
    expect(lines.join('')).toContain('tail');
    expect(lines).toContain('');
    expect(lines[lines.length - 1]).toBe('next');
    expect(wrapTextLines('')).toEqual(['']);
  });
});

describe('input', () => {
  const ev = (eventType: number) => ({ sysEvent: { eventType } }) as unknown as EvenHubEvent;
  it('maps lifecycle and scroll-up events, ignores unknown and empty ones', () => {
    expect(toInput({ textEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } } as unknown as EvenHubEvent)).toBe(
      'up',
    );
    expect(toInput(ev(OsEventTypeList.FOREGROUND_ENTER_EVENT))).toBe('foreground');
    expect(toInput(ev(OsEventTypeList.FOREGROUND_EXIT_EVENT))).toBe('background');
    expect(toInput(ev(OsEventTypeList.SYSTEM_EXIT_EVENT))).toBe('exit');
    expect(toInput(ev(OsEventTypeList.ABNORMAL_EXIT_EVENT))).toBe('exit');
    expect(toInput(ev(OsEventTypeList.IMU_DATA_REPORT))).toBeNull();
    expect(toInput({} as EvenHubEvent)).toBeNull();
  });
});

type FakeSocket = SocketLike & { sent: string[] };

function fakeSocket(): FakeSocket {
  const s = {
    readyState: 0,
    sent: [] as string[],
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(d: string) {
      s.sent.push(d);
    },
    close() {
      s.readyState = 3;
      s.onclose?.({ code: 1006 });
    },
  } as unknown as FakeSocket & { readyState: number };
  return s;
}

describe('gateway client', () => {
  it('reconnects with backoff after a drop, reports status, and drops a malformed frame', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const statuses: string[] = [];
    const frames: unknown[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new GatewayClient({
      connect: () => {
        const s = fakeSocket();
        sockets.push(s);
        return s;
      },
      onFrame: (f) => frames.push(f),
      onStatus: (st) => statuses.push(st),
    });
    c.start({ url: 'wss://x.example', token: 't' });
    const s1 = sockets[0] as FakeSocket & { readyState: number };
    s1.readyState = 1;
    s1.onopen?.(null);
    s1.onmessage?.({ data: '{"t":"pong"}' });
    s1.onmessage?.({ data: 'not json' });
    expect(frames).toEqual([{ t: 'pong' }]);
    expect(err).toHaveBeenCalled();
    expect(c.send({ t: 'ping' })).toBe(true);
    s1.close();
    expect(statuses).toContain('reconnecting');
    expect(c.send({ t: 'ping' })).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(sockets).toHaveLength(2);
    c.kick();
    expect(sockets).toHaveLength(3);
    c.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sockets).toHaveLength(3);
    err.mockRestore();
    vi.useRealTimers();
  });

  it('a bad URL is a retry, not a crash', () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const statuses: string[] = [];
    const c = new GatewayClient({
      connect: () => {
        throw new Error('boom');
      },
      onFrame: () => {},
      onStatus: (s) => statuses.push(s),
    });
    c.start({ url: 'wss://x.example', token: 't' });
    expect(statuses).toEqual(['connecting', 'reconnecting']);
    c.stop();
    err.mockRestore();
    vi.useRealTimers();
  });
});
