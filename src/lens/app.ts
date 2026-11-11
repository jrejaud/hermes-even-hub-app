/**
 * Aristo Lens: the shell that runs the state machine against the real world (SC-9500).
 *
 * state.ts decides, layout.ts words it, draw.ts paints it; this file only moves bytes: gateway frames in,
 * gestures in, effects out (socket frames, mic, persistence, exit).
 */
import type { EvenAppBridge, EvenHubEvent } from '@evenrealities/even_hub_sdk';
import { GatewayClient, type GatewayProfile, type SocketLike } from '../gateway/client';
import type { GlassesServerFrame } from '../gateway/glasses';
import { serializeLatest } from '../util/coalesce';
import { Lens } from './draw';
import { toInput } from './input';
import { layout } from './layout';
import { renderPhone } from './phone';
import { loadProfile, loadSaved, save, saveProfile, validateProfile } from './settings';
import {
  expire,
  gesture,
  initialState,
  landing,
  micEnded,
  receive,
  reply,
  restore,
  toSaved,
  type Effect,
  type Pending,
  type Saved,
  type State,
} from './state';

/** The stt frame carries at most 60 s of 16 kHz mono s16le. */
const MAX_PCM_BYTES = 60 * 16_000 * 2;
const TICK_MS = 1_000;

export interface AppDeps {
  bridge: EvenAppBridge;
  /** Phone-side page root; absent in the gallery. */
  root?: HTMLElement;
  /** Socket factory override (the fake gateway). */
  connect?: (url: string) => SocketLike;
  /** Profile to use when none is stored (the fake gateway needs none typed). */
  defaultProfile?: GatewayProfile;
  now?: () => number;
}

export async function startApp(d: AppDeps): Promise<void> {
  const { bridge } = d;
  const now = d.now ?? (() => Date.now());
  const lens = new Lens(bridge);

  let profile = (await loadProfile(bridge)) ?? d.defaultProfile ?? null;
  const saved: Saved | null = await loadSaved(bridge);
  let state: State = restore(initialState(profile ? 'connecting' : 'unconfigured'), saved);
  /** The state the lens is showing: taps resolve against it. */
  let drawn: State = state;
  let landed = false;
  let phoneErrors: string[] = [];
  const pending = new Map<string, Pending>();

  const paint = serializeLatest(async (s: State) => {
    await lens.draw(layout(s));
    drawn = s;
  });

  const phone = (): void => {
    if (d.root) renderPhone(d.root, { profile, conn: state.conn, errors: phoneErrors }, (p) => void onSaveProfile(p));
  };

  const set = (next: State, effects: Effect[] = []): void => {
    const connChanged = next.conn !== state.conn;
    state = next;
    for (const e of effects) run(e);
    paint(state);
    if (connChanged) phone();
  };

  // ---- mic
  let recording = false;
  let chunks: Uint8Array[] = [];
  let pcmBytes = 0;

  async function micStart(): Promise<void> {
    chunks = [];
    pcmBytes = 0;
    recording = true;
    const ok = await bridge.audioControl(true);
    if (!ok) console.error('[lens] audioControl(true) refused');
  }

  async function micStop(): Promise<Uint8Array> {
    if (recording) {
      recording = false;
      const ok = await bridge.audioControl(false);
      if (!ok) console.error('[lens] audioControl(false) refused');
    }
    const out = new Uint8Array(pcmBytes);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    chunks = [];
    pcmBytes = 0;
    return out;
  }

  function onPcm(pcm: Uint8Array): void {
    if (!recording) return;
    if (pcmBytes + pcm.length > MAX_PCM_BYTES) {
      const r = micEnded(state);
      remember(r.pending);
      set(r.state, r.effects);
      return;
    }
    chunks.push(pcm);
    pcmBytes += pcm.length;
  }

  // ---- effects
  function remember(p: Record<string, Pending>): void {
    for (const [k, v] of Object.entries(p)) pending.set(k, v);
  }

  function run(e: Effect): void {
    if (e.kind === 'send') {
      if (!client.send(e.frame) && e.frame.t !== 'open' && 'reqId' in e.frame) {
        // Not connected: fail the request at once rather than leaving a screen saying "sending…" forever.
        const reqId = e.frame.reqId;
        queueMicrotask(() => onFrame({ t: 'refused', reqId, reason: 'host-down', message: 'offline' }));
      }
    } else if (e.kind === 'micStart') void micStart();
    else if (e.kind === 'micStop') void micStop();
    else if (e.kind === 'transcribe') {
      const reqId = e.reqId;
      void micStop().then((pcm) => {
        if (!pcm.length) {
          onFrame({ t: 'ok', reqId, text: '' });
          return;
        }
        if (!client.send({ t: 'stt', reqId, pcm: toBase64(pcm) }))
          onFrame({ t: 'refused', reqId, reason: 'host-down', message: 'offline' });
      });
    } else if (e.kind === 'persist') {
      void save(bridge, toSaved(state, now())).catch((err: unknown) =>
        console.error('[lens] could not save location', err),
      );
    } else if (e.kind === 'exit') {
      void bridge.shutDownPageContainer(1);
    }
  }

  // ---- gateway
  function onFrame(f: GlassesServerFrame): void {
    if (f.t === 'ok' || f.t === 'refused') {
      const p = pending.get(f.reqId);
      if (!p) return;
      pending.delete(f.reqId);
      const r = reply(state, p, f, now());
      set(r.state, r.effects);
      return;
    }
    const r = receive(state, f, now());
    let next = r.state;
    const effects = [...r.effects];
    if (f.t === 'home' && !landed) {
      landed = true;
      const before = next.stack;
      next = landing(next, saved);
      if (next.stack !== before)
        effects.push(
          { kind: 'send', frame: { t: 'open', screen: 'view', viewId: next.home![0].id } },
          { kind: 'persist' },
        );
    }
    set(next, effects);
  }

  const client = new GatewayClient({
    connect: d.connect,
    onFrame,
    onStatus: (s) => {
      // "online" comes from the server's hello; the socket only reports the way down.
      if (s !== 'online') set({ ...state, conn: s });
    },
  });

  async function onSaveProfile(p: GatewayProfile): Promise<void> {
    phoneErrors = validateProfile(p);
    if (phoneErrors.length) {
      phone();
      return;
    }
    profile = { url: p.url.trim(), token: p.token.trim() };
    await saveProfile(bridge, profile);
    set({ ...state, conn: 'connecting' });
    client.start(profile);
    phone();
  }

  // ---- input
  bridge.onEvenHubEvent((e: EvenHubEvent) => {
    const pcm = e.audioEvent?.audioPcm;
    if (pcm instanceof Uint8Array && pcm.length) {
      onPcm(pcm);
      return;
    }
    const inp = toInput(e);
    if (!inp) return;
    if (inp === 'foreground') {
      // Android may have suspended us: treat it as a cold start of the socket. The hello re-sends `open`.
      if (profile) client.kick();
      return;
    }
    if (inp === 'background') {
      run({ kind: 'persist' });
      return;
    }
    if (inp === 'exit') {
      run({ kind: 'persist' });
      client.stop();
      return;
    }
    const r = gesture(state, inp, now(), drawn);
    remember(r.pending);
    set(r.state, r.effects);
  });

  setInterval(() => {
    if (!state.banner && !state.notice) return;
    const next = expire(state, now());
    if (next !== state) set(next);
  }, TICK_MS);

  paint(state);
  phone();
  if (profile) client.start(profile);
  console.log('[glasses] ready');
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}
