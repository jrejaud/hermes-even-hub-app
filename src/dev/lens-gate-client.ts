/**
 * lens-gate client — the app side of `ui-gate --surface glasses` (even-frontend skill).
 *
 * Installed by `glasses-gate init <app-dir>` into `src/dev/lens-gate-client.ts`. Do not edit the
 * copy: re-run init to update it. Contract: even-frontend/resources/glasses-gate.md.
 *
 * What it does, only when the page was opened with `?lensGate=<control-url>` (the gate adds it):
 *  1. wraps the bridge so every draw call is logged as `[lens-gate] draw {...}` with its exact
 *     payload and return value. The gate rebuilds the page model from these lines, so its byte,
 *     line, width and glyph checks see exactly what the firmware was sent.
 *  2. logs `[lens-gate] ready {"states":[...]}` once, naming every fixture state.
 *  3. polls the control URL for `goto <state>` and renders that fixture state.
 *  4. hands every real gesture to the app's OWN handler, renders the result and logs
 *     `[lens-gate] event {"screen":...}`, so states reached by up/down/tap/double tap/hold are
 *     captured too, not only the fixtures.
 */
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';

export interface LensGateState<S> {
  /** Unique, filename-safe: `03-list`. */
  name: string;
  /** What a reviewer should check in this frame; goes to the critic. */
  lookingFor: string;
  /** A top-level screen: double tap here may exit, so "no way back" does not apply. */
  root?: boolean;
  /** A screen where one short dim gesture hint is allowed (house rule 5): an approval. */
  approval?: boolean;
  /** The capture container is MEANT to hold more lines than it shows (the firmware scrolls it). Otherwise overflow fails. */
  scrolls?: boolean;
  /** The lens is MEANT to be fully dark here (a quiet mode). Otherwise an all-dark frame fails as blank. */
  blank?: boolean;
  /** The screen declares glasses-menu items (tap, then hold): its page build must carry `menuObject`. */
  menu?: boolean;
  /** Its glasses-menu items: the gate opens the simulator's menu and picks each one. */
  menuItems?: { id: number; label: string }[];
  state: S;
}

export interface LensGateApp<S> {
  bridge: EvenAppBridge;
  states: LensGateState<S>[];
  /** Draw `state` on the (traced) bridge. Called after every goto and every gesture. */
  render: (bridge: EvenAppBridge, state: S) => Promise<void>;
  /** The app's real gesture handling: raw SDK event → next state, or null when nothing changes. */
  onEvent: (state: S, event: unknown) => S | null;
  /** A short id of the screen `state` shows (`list`, `session:thread`); used for "no way back". */
  screenOf: (state: S) => string;
  /** Draw whatever page the app boots on (createStartUpPageContainer is one-shot). */
  boot: (bridge: EvenAppBridge) => Promise<void>;
}

export const lensGateUrl = (): string | null => {
  try {
    return new URLSearchParams(location.search).get('lensGate');
  } catch {
    // error-ok: no location (not a browser page) means not under the gate
    return null;
  }
};

const DRAW_OPS = [
  'createStartUpPageContainer',
  'rebuildPageContainer',
  'textContainerUpgrade',
  'updateImageRawData',
  'shutDownPageContainer',
];

const plain = (v: unknown): unknown => {
  if (v == null || typeof v !== 'object') return v;
  const o = v as { toJson?: () => unknown };
  try {
    return typeof o.toJson === 'function' ? o.toJson() : JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
};

/** Every draw call logged with its payload and result. Image bytes are summarised, not dumped. */
export function traceBridge(bridge: EvenAppBridge): EvenAppBridge {
  return new Proxy(bridge, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof prop !== 'string' || !DRAW_OPS.includes(prop) || typeof v !== 'function') return v;
      return async (...args: unknown[]) => {
        let arg = plain(args[0]);
        if (prop === 'updateImageRawData' && arg && typeof arg === 'object') {
          const a = arg as Record<string, unknown>;
          const img = a.imageData as { length?: number } | undefined;
          arg = { containerID: a.containerID, containerName: a.containerName, bytes: img?.length ?? null };
        }
        let ret: unknown,
          err: string | null = null;
        try {
          ret = await v.apply(target, args);
        } catch (e) {
          err = String(e);
          throw e;
        } finally {
          console.log(`[lens-gate] draw ${JSON.stringify({ op: prop, arg, ret: plain(ret) ?? null, err })}`);
        }
        return ret;
      };
    },
  });
}

/** Longest a gallery render may take before the gate moves on. */
export const RENDER_TIMEOUT_MS = 8_000;

/** Run the app under the gate. Returns false (and does nothing) when not opened by the gate. */
export async function runLensGate<S>(app: LensGateApp<S>): Promise<boolean> {
  const url = lensGateUrl();
  if (!url) return false;
  const bridge = traceBridge(app.bridge);
  let state: S | null = null;
  let queue: Promise<void> = Promise.resolve();
  const draw = (s: S, tag: string, extra: Record<string, unknown>) => {
    queue = queue.then(async () => {
      // A simulator bridge call that never resolves must not stall every later frame (seen as "the app never
      // acknowledged goto #N" at a different state each run, 2026-11-12): give each render RENDER_TIMEOUT_MS.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          app.render(bridge, s),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`render did not finish in ${RENDER_TIMEOUT_MS} ms`)),
              RENDER_TIMEOUT_MS,
            );
          }),
        ]);
      } catch (e) {
        console.error(`[lens-gate] render threw: ${String(e)}`);
      } finally {
        clearTimeout(timer);
      }
      console.log(`[lens-gate] ${tag} ${JSON.stringify({ ...extra, screen: app.screenOf(s) })}`);
    });
  };

  app.bridge.onEvenHubEvent((event) => {
    if (state == null) return;
    let next: S | null = null;
    try {
      next = app.onEvent(state, event);
    } catch (e) {
      console.error(`[lens-gate] onEvent threw: ${String(e)}`);
    }
    const raw = plain(event);
    if (next == null) {
      console.log(`[lens-gate] event ${JSON.stringify({ raw, changed: false, screen: app.screenOf(state) })}`);
      return;
    }
    state = next;
    draw(state, 'event', { raw, changed: true });
  });

  await app.boot(bridge);
  console.log(
    `[lens-gate] ready ${JSON.stringify({ states: app.states.map(({ name, lookingFor, root, approval, scrolls, blank, menu, menuItems }) => ({ name, lookingFor, root: !!root, approval: !!approval, scrolls: !!scrolls, blank: !!blank, menu: !!menu, menuItems: menuItems ?? [] })) })}`,
  );

  let after = 0;
  const poll = async (): Promise<void> => {
    try {
      // Bounded (the server long-polls, so generously): one hung request would otherwise end polling for good.
      const r = await fetch(`${url}/cmd?after=${after}`, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
      if (r.ok) {
        const cmd = (await r.json()) as { seq?: number; goto?: string } | null;
        if (cmd && typeof cmd.seq === 'number' && cmd.seq > after) {
          after = cmd.seq;
          const fx = app.states.find((s) => s.name === cmd.goto);
          if (!fx) console.error(`[lens-gate] unknown state ${cmd.goto}`);
          else {
            state = fx.state;
            draw(state, 'at', { seq: cmd.seq, name: fx.name });
          }
        }
      }
    } catch {
      // error-ok: the gate control server is not up yet or already gone; polling again is the handling
      /* gate not up yet or gone; keep polling */
    }
    setTimeout(() => {
      void poll();
    }, 150);
  };
  void poll();
  return true;
}
