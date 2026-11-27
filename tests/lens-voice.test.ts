// Voice mode on the lens (SC-11683): the phone drives, the lens mirrors; minimal screens (Jordan, 2026-11-25).
import { describe, expect, it } from 'vitest';
import { HOME, HOME_NEEDS, threadFrame } from '../src/dev/fake-gateway';
import type { GlassesServerFrame, GlassesVoice } from '../src/gateway/glasses';
import { CORNER, ICONS, cornerOf } from '../src/lens/card';
import { layout } from '../src/lens/layout';
import { gesture, initialState, receive, top, type State } from '../src/lens/state';
import { voiceShown, voiceTag, voiceTicking } from '../src/lens/voice';

const T = 1_700_000_000_000;
const feed = (s: State, ...fs: GlassesServerFrame[]): State => fs.reduce((a, f) => receive(a, f, T).state, s);
const online = (): State =>
  feed(
    initialState('connecting'),
    { t: 'hello', protocol: 1, host: 'chiba', hosts: [] },
    { t: 'home', views: HOME, needs: HOME_NEEDS },
  );
const v = (state: GlassesVoice['state'], over: Partial<GlassesVoice> = {}): GlassesServerFrame => ({
  t: 'voice',
  voice: { key: 'overlord/g2', title: 'G2 app plan', state, since: T - 4_000, play: null, ...over },
});

describe('voice mode on the lens', () => {
  it('opens the voice session and asks the gateway for it', () => {
    const r = receive(online(), v('idle') as Extract<GlassesServerFrame, { t: 'voice' }>, T);
    expect(top(r.state)).toEqual({ kind: 'session', key: 'overlord/g2', title: 'G2 app plan' });
    expect(r.effects[0]).toEqual({ kind: 'send', frame: { t: 'open', screen: 'session', key: 'overlord/g2' } });
  });

  it('idle shows nothing at all: no header, no body, no corner', () => {
    const s = feed(online(), v('idle'), threadFrame('overlord/g2'));
    expect(voiceShown(s)).toBe(true);
    const f = layout(s, T);
    expect([f.left, f.right, f.body.length]).toEqual(['', '', 0]);
    expect(f.corner).toBe('none');
  });

  it('you talking: the dot and your talk time', () => {
    const s = feed(online(), v('listening'), threadFrame('overlord/g2'));
    const f = layout(s, T);
    expect(f.corner).toBe('you');
    expect(f.right).toBe('0:04');
    expect(f.body).toEqual([]);
    expect(voiceTicking(s)).toBe(true);
  });

  it('thinking: the corner only', () => {
    const f = layout(feed(online(), v('working'), threadFrame('overlord/g2')), T);
    expect([f.corner, f.right, f.body.length]).toEqual(['thinking', '', 0]);
  });

  it('agent talking: the bot and elapsed / total, never past the total', () => {
    const s = feed(
      online(),
      v('speaking', { play: { startedAt: T - 7_000, totalMs: 21_000 } }),
      threadFrame('overlord/g2'),
    );
    expect(layout(s, T).corner).toBe('agent');
    expect(layout(s, T).right).toBe('0:07 / 0:21');
    expect(voiceTag(s.voice!.v, T + 60_000)).toBe('0:21 / 0:21');
  });

  it('a question: the session ask screen with its options, the ? in the corner', () => {
    const s = feed(online(), v('idle', { key: 'chiba/deploy', title: 'Deploy' }), threadFrame('chiba/deploy'));
    expect(voiceShown(s)).toBe(false);
    expect(cornerOf(s)).toBe('ask');
    expect(layout(s, T).body.length).toBeGreaterThan(0);
  });

  it('a tap shows the conversation; the voice screen comes back when someone next talks', () => {
    let s = feed(online(), v('idle'), threadFrame('overlord/g2'));
    s = gesture(s, 'tap', T).state;
    expect(voiceShown(s)).toBe(false);
    expect(layout(s, T).body.length).toBeGreaterThan(0);
    s = feed(s, v('working'));
    expect(voiceShown(s)).toBe(false); // thinking alone does not take the lens back
    s = feed(s, v('speaking', { play: { startedAt: T, totalMs: 9_000 } }));
    expect(voiceShown(s)).toBe(true);
  });

  it('off: the lens goes back to the normal session screen', () => {
    const s = feed(online(), v('listening'), threadFrame('overlord/g2'), v('off'));
    expect(s.voice).toBeNull();
    expect(top(s).kind).toBe('session');
    expect(layout(s, T).left).not.toBe('');
  });

  it('never pulls the wearer out of their own dictation', () => {
    let s = feed(online(), threadFrame('overlord/g2'));
    s = gesture(s, 'hold', T).state; // hold on Home: a new session by voice
    const before = top(s).kind;
    s = feed(s, v('working', { key: 'box/churn' }));
    expect(top(s).kind).toBe(before);
  });

  // SC-12130 (Jordan, 2026-11-27): a spoken reply rang out unanswered on the phone; it never rings again, so the lens shows an
  // envelope in the corner while it waits, on every screen, until he hears it.
  it('a missed reply waiting: an envelope in the corner, on the voice screen and elsewhere; gone once it is heard', () => {
    let s = feed(online(), v('idle', { waiting: 1 }), threadFrame('overlord/g2'));
    expect(layout(s, T).corner).toBe('mail');
    s = gesture(s, 'tap', T).state; // the conversation instead of the voice screen: still there
    expect(cornerOf(s)).toBe('mail');
    s = feed(s, v('idle', { waiting: 0 }));
    expect(cornerOf(s)).toBe('none');
  });

  it('talking or thinking own the corner over the envelope; it comes back after', () => {
    let s = feed(online(), v('listening', { waiting: 2 }), threadFrame('overlord/g2'));
    expect(cornerOf(s)).toBe('you');
    s = feed(s, v('working', { waiting: 2 }));
    expect(cornerOf(s)).toBe('thinking');
    s = feed(s, v('idle', { waiting: 2 }));
    expect(cornerOf(s)).toBe('mail');
  });

  it('the envelope bitmap fits the corner box at 2x', () => {
    const rows = ICONS.mail;
    expect(rows.every((r) => r.length === rows[0]!.length)).toBe(true);
    expect(rows[0]!.length * 2).toBeLessThanOrEqual(CORNER.w);
    expect(rows.length * 2).toBeLessThanOrEqual(CORNER.h);
  });
});
