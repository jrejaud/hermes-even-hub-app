/**
 * Voice mode on the lens (SC-11683): the phone drives, the lens mirrors (Jordan, 2026-11-24: "Phone drives, lens mirrors").
 *
 * The phone's voice mode reports what it is doing (Aristo relays it as a `voice` frame). While it is on, the lens opens
 * that session and shows the minimal voice screens (Jordan, 2026-11-25): the corner icon carries the state and text appears
 * only where it adds something. Idle shows nothing; you talking shows your talk time (0:04); thinking shows only the corner;
 * the agent talking shows elapsed / total (0:07 / 0:21); a question shows the session's ask screen with its options.
 *
 * A tap or double tap shows the conversation instead (the voice screen comes back when you or the agent next talk); a hold
 * still dictates on the lens.
 */
import type { GlassesVoice } from '../gateway/glasses';
import type { Corner } from './card';
// state.ts imports this module too; everything below is only called inside functions, so the cycle is safe at load.
import { liveAsk, openFor, top, type Effect, type State } from './state';

export interface ShownVoice {
  v: GlassesVoice;
  /** The wearer chose the conversation over the voice screen; cleared when you or the agent next talk. */
  hidden: boolean;
}

/** A `voice` frame: voice mode moved, changed state, or ended. A new session is opened on the lens. */
export function receiveVoice(s: State, v: GlassesVoice): { state: State; effects: Effect[] } {
  if (v.state === 'off') return { state: s.voice?.v.key === v.key ? { ...s, voice: null } : s, effects: [] };
  const prev = s.voice?.v.key === v.key ? s.voice : null;
  const talk = v.state === 'listening' || v.state === 'speaking';
  const hidden = !!prev?.hidden && !(talk && prev.v.state !== v.state);
  let next: State = { ...s, voice: { v, hidden } };
  const sc = top(next);
  // Never pull the wearer off what they are doing with the lens mic or a menu; otherwise go where voice mode is.
  const here = (sc.kind === 'session' || sc.kind === 'menu' || sc.kind === 'dictate') && sc.key === v.key;
  if (!hidden && !here && sc.kind !== 'dictate' && sc.kind !== 'menu') {
    next = { ...next, stack: [...next.stack, { kind: 'session', key: v.key, title: v.title }] };
    return { state: next, effects: [{ kind: 'send', frame: { t: 'open', ...openFor(next) } }, { kind: 'persist' }] };
  }
  return { state: next, effects: [] };
}

/** The voice screen is drawn: voice mode is on for the open session, nothing covers it, and no question is waiting. */
export function voiceShown(s: State): boolean {
  const sv = s.voice;
  if (!sv || sv.hidden || s.banner || s.card) return false;
  const sc = top(s);
  return sc.kind === 'session' && sc.key === sv.v.key && !liveAsk(s, sc.key);
}

const mmss = (ms: number): string => {
  const secs = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
};

/** The one line of text the voice screen shows, left of the corner: your talk time, the reply's elapsed / total, or ''. */
export function voiceTag(v: GlassesVoice, now: number): string {
  if (v.state === 'listening') return mmss(now - v.since);
  if (v.state === 'speaking' && v.play)
    return `${mmss(Math.min(now - v.play.startedAt, v.play.totalMs))} / ${mmss(v.play.totalMs)}`;
  if (v.state === 'offline') return 'speech to text lost';
  return '';
}

/** The corner while voice mode is on: its state owns it (idle shows nothing, Jordan 2026-11-25, unless a missed reply waits:
 *  the envelope); null = voice mode is off. */
export function voiceCorner(s: State): Corner | null {
  const v = s.voice?.v;
  if (!v) return null;
  if (v.state === 'listening') return 'you';
  if (v.state === 'speaking') return 'agent';
  if (v.state === 'working') return 'thinking';
  // A reply rang out unanswered and waits (SC-12130, Jordan 2026-11-27): an envelope, until he hears it. Talking or thinking win.
  return (v.waiting ?? 0) > 0 ? 'mail' : 'none';
}

/** A timer is running on the voice screen, so the shell redraws it every tick. */
export function voiceTicking(s: State): boolean {
  const st = s.voice?.v.state;
  return voiceShown(s) && (st === 'listening' || st === 'speaking');
}
