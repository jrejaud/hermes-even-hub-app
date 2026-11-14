/**
 * The one socket to the glasses gateway (SC-9499 contract, `glasses.ts`).
 *
 * Owns reconnect, keepalive and request ids. It knows nothing about screens: the app tells it which screen is
 * open with `open()` and it re-sends that after every reconnect (the server's `hello` triggers the app to do
 * so via the state machine), and forwards every server frame to `onFrame`.
 */
import { GLASSES_PATH } from './glasses';
import type { GlassesClientFrame as ClientFrame, GlassesServerFrame as ServerFrame } from './glasses';

export interface GatewayProfile {
  /** Base URL of the views home, e.g. `wss://agent.alastor.space`. */
  url: string;
  token: string;
}

export type SocketLike = Pick<WebSocket, 'send' | 'close' | 'readyState'> & {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

interface Deps {
  /** Socket factory; tests and the fake gateway pass their own. */
  connect?: (url: string) => SocketLike;
  onFrame: (f: ServerFrame) => void;
  onStatus: (s: 'connecting' | 'online' | 'reconnecting') => void;
}

const PING_MS = 20_000;
const SILENT_MS = 45_000;

/** `<base>/api/glasses?token=…`: a WebView cannot set headers on a WebSocket, so the token rides the query. */
export function gatewayUrl(p: GatewayProfile): string {
  const u = new URL(p.url.trim());
  if (u.protocol === 'https:') u.protocol = 'wss:';
  if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.pathname === '/' || u.pathname === '') u.pathname = GLASSES_PATH;
  u.searchParams.set('token', p.token.trim());
  return u.toString();
}

export class GatewayClient {
  private ws: SocketLike | null = null;
  private profile: GatewayProfile | null = null;
  private alive = false;
  private delay = 500;
  private lastRecv = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private pinger: ReturnType<typeof setInterval> | undefined;

  private readonly d: Deps;

  constructor(d: Deps) {
    this.d = d;
  }

  start(p: GatewayProfile): void {
    this.stop();
    this.profile = p;
    this.alive = true;
    this.delay = 500;
    this.open();
  }

  stop(): void {
    this.alive = false;
    this.clear();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState < 2) ws.close();
  }

  /**
   * Reconnect now (a WebView resume): the old socket may be dead without having said so. Skipped when the
   * socket is open and heard from within the last ping interval: the glasses' menu opening sends the same
   * "foreground" event as a resume, and must not drop a healthy socket.
   */
  kick(now: number = Date.now()): void {
    if (!this.profile) return;
    if (this.ws?.readyState === 1 && now - this.lastRecv < PING_MS + 5_000) return;
    this.start(this.profile);
  }

  send(f: ClientFrame): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(f));
    return true;
  }

  private open(): void {
    if (!this.profile) return;
    this.d.onStatus('connecting');
    const make = this.d.connect ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    let ws: SocketLike;
    try {
      ws = make(gatewayUrl(this.profile));
    } catch (err) {
      console.error('[gateway] bad url', err);
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.delay = 500;
      this.lastRecv = Date.now();
      // "online" is said by the server's hello (the state machine), not by the TCP open.
      clearInterval(this.pinger);
      this.pinger = setInterval(() => {
        if (Date.now() - this.lastRecv > SILENT_MS) {
          ws.close();
          return;
        }
        this.send({ t: 'ping' });
      }, PING_MS);
    };
    ws.onmessage = (ev) => {
      this.lastRecv = Date.now();
      let frame: ServerFrame;
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as ServerFrame;
      } catch (err) {
        console.error('[gateway] malformed frame', err);
        return;
      }
      this.d.onFrame(frame);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      clearInterval(this.pinger);
      if (this.alive) this.retry();
    };
    ws.onerror = () => {
      // onclose follows; the reason is not visible to a WebView (a 401 before upgrade reads the same as down).
    };
  }

  private retry(): void {
    this.d.onStatus('reconnecting');
    const t = setTimeout(() => this.open(), this.delay);
    this.timers.push(t);
    this.delay = Math.min(this.delay * 2, 8_000);
  }

  private clear(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    clearInterval(this.pinger);
  }
}
