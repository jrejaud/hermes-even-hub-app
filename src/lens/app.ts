/**
 * Aristo Lens: the shell that runs the state machine against the real world (SC-9500).
 *
 * state.ts decides, layout.ts words it, draw.ts paints it; this file only moves bytes: gateway frames in,
 * gestures in, effects out (socket frames, mic, persistence, exit).
 */
import type { EvenAppBridge, EvenHubEvent } from '@evenrealities/even_hub_sdk';
import { GatewayClient, type GatewayProfile, type SocketLike } from '../gateway/client';
import type { GlassesServerFrame as ServerFrame } from '../gateway/glasses';
import { serializeLatest } from '../util/coalesce';
import { Lens } from './draw';
import { canvasRasterize } from './raster';
import { toInput } from './input';
import { osMenuPick } from './os-menu';
import { layout } from './layout';
import { renderPhone } from './phone';
import { loadProfile, loadSaved, save, saveProfile, validateProfile } from './settings';
import {
  expire,
  glideFrames,
  gesture,
  menuPick,
  initialState,
  landing,
  MAX_LISTEN_MS,
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
import { voiceTicking } from './voice';

/** ~200 ms of 16 kHz mono s16le per `audio` frame. */
const CHUNK_BYTES = (16_000 * 2) / 5;
const TICK_MS = 1_000;
const LANDING_WINDOW_MS = 6_000;
/** Between the one-line frames of a scroll glide: one container upgrade each, well inside the BLE budget. */
const GLIDE_MS = 80;

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
  const lens = new Lens(bridge, canvasRasterize);

  let profile = (await loadProfile(bridge)) ?? d.defaultProfile ?? null;
  const saved: Saved | null = await loadSaved(bridge);
  let state: State = restore(initialState(profile ? 'connecting' : 'unconfigured'), saved);
  /** The state the lens is showing: taps resolve against it. */
  let drawn: State = state;
  /**
   * Landing on Inbox is decided by the Home frames that arrive before the wearer does anything: the gateway's
   * FIRST home is sent before its host feeds are open (empty, hosts down) and a populated one follows ~1 s
   * later (SC-9499 contract note), so the decision stays open for LANDING_WINDOW_MS or until a gesture.
   */
  let landed = false;
  const bootAt = now();
  let phoneErrors: string[] = [];
  const pending = new Map<string, Pending>();

  const paint = serializeLatest(async (s: State) => {
    await lens.draw(layout(s));
    drawn = s;
  });

  // ---- glide: a swipe slides the conversation a line per frame instead of jumping (see glideFrames).
  /** The state last handed to the painter, an in-between glide frame included: the next glide starts here. */
  let shown: State = state;
  let gliding: State[] = [];
  let glideTimer: ReturnType<typeof setTimeout> | null = null;

  const show = (s: State): void => {
    shown = s;
    paint(s);
  };

  function glideStep(): void {
    const s = gliding.shift();
    // The last step is the live state, so a frame that arrived mid-glide is not lost.
    show(s ?? state);
    glideTimer = s ? setTimeout(glideStep, GLIDE_MS) : null;
  }

  const phone = (): void => {
    if (d.root) renderPhone(d.root, { profile, conn: state.conn, errors: phoneErrors }, (p) => void onSaveProfile(p));
  };

  const set = (next: State, effects: Effect[] = [], frames: State[] = []): void => {
    const connChanged = next.conn !== state.conn;
    state = next;
    for (const e of effects) run(e);
    if (frames.length) {
      // A new swipe restarts the glide from wherever the lens is now.
      if (glideTimer) clearTimeout(glideTimer);
      gliding = frames;
      glideStep();
    } else if (!glideTimer) show(state);
    if (connChanged) phone();
  };

  // ---- mic: stream while held (v2). Audio goes out as ~200 ms `audio` frames for the current listen.
  let listenId: string | null = null;
  let buf: Uint8Array[] = [];
  let bufBytes = 0;

  function flushAudio(): void {
    if (!listenId || !bufBytes) return;
    const out = new Uint8Array(bufBytes);
    let at = 0;
    for (const c of buf) {
      out.set(c, at);
      at += c.length;
    }
    buf = [];
    bufBytes = 0;
    client.send({ t: 'audio', reqId: listenId, pcm: toBase64(out) });
  }

  async function micStart(reqId: string): Promise<void> {
    listenId = reqId;
    buf = [];
    bufBytes = 0;
    const ok = await bridge.audioControl(true);
    if (!ok) console.error('[lens] audioControl(true) refused');
  }

  async function micStop(): Promise<void> {
    if (!listenId) return;
    // Send what is buffered BEFORE the state machine's listen.end/cancel goes out (effects run in order).
    flushAudio();
    listenId = null;
    const ok = await bridge.audioControl(false);
    if (!ok) console.error('[lens] audioControl(false) refused');
  }

  function onPcm(pcm: Uint8Array): void {
    if (!listenId) return;
    buf.push(pcm);
    bufBytes += pcm.length;
    if (bufBytes >= CHUNK_BYTES) flushAudio();
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
    } else if (e.kind === 'micStart') void micStart(e.reqId);
    else if (e.kind === 'micStop') void micStop();
    else if (e.kind === 'persist') {
      void save(bridge, toSaved(state, now())).catch((err: unknown) =>
        console.error('[lens] could not save location', err),
      );
    } else if (e.kind === 'exit') {
      void bridge.shutDownPageContainer(1);
    }
  }

  // ---- gateway
  function onFrame(f: ServerFrame): void {
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
    if (f.t === 'home' && !landed && now() - bootAt < LANDING_WINDOW_MS) {
      const before = next.stack;
      next = landing(next, saved);
      const to = next.stack[next.stack.length - 1];
      if (next.stack !== before && to.kind === 'view') {
        landed = true;
        // The view landing picked, which need not be the first row: Home is the starred views (SC-10526).
        effects.push({ kind: 'send', frame: { t: 'open', screen: 'view', viewId: to.viewId } }, { kind: 'persist' });
      }
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
    // A pick from the glasses' own tap-then-hold menu (Quiet mode and friends).
    const picked = osMenuPick(e);
    if (picked !== null) {
      landed = true;
      const r = menuPick(state, picked, now());
      remember(r.pending);
      set(r.state, r.effects);
      return;
    }
    const inp = toInput(e);
    if (!inp) return;
    if (inp === 'foreground') {
      // Android may have suspended us: reconnect unless the socket is plainly alive. The glasses' menu opening
      // sends this same event, and must not drop a healthy socket. The hello re-sends `open`.
      if (profile) client.kick(now());
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
    landed = true; // the wearer is driving now: never move the screen under them
    const r = gesture(state, inp, now(), drawn);
    remember(r.pending);
    set(r.state, r.effects, glideFrames(shown, r.state));
  });

  setInterval(() => {
    const t = now();
    const sc = state.stack[state.stack.length - 1];
    if (sc.kind === 'dictate' && sc.phase === 'listening') {
      // The 60 s cap ends the recording as if the wearer let go; otherwise redraw so the timer counts up.
      if (t - sc.startedAt >= MAX_LISTEN_MS) {
        const r = micEnded(state, t);
        remember(r.pending);
        set(r.state, r.effects);
      } else show(state);
      return;
    }
    // Voice mode's timers (SC-11683): your talk time and the reply's elapsed / total count up.
    if (voiceTicking(state)) show(state);
    if (!state.banner && !state.notice && !state.card) return;
    const next = expire(state, t);
    if (next !== state) set(next);
  }, TICK_MS);

  show(state);
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
