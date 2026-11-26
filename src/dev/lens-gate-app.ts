/**
 * Aristo Lens under `ui-gate --surface glasses` (even-frontend skill → resources/glasses-gate.md).
 *
 * The gate jumps to each gallery state by name, then sends real gestures, which run through the app's
 * REAL input mapping (input.ts) and state machine (state.ts), so every screen a gesture reaches is
 * captured too. Only active when VITE_UI_GALLERY=1 AND the page was opened with ?lensGate=<url>.
 */
import type { EvenAppBridge, EvenHubEvent } from '@evenrealities/even_hub_sdk';
import { GALLERY_NOW, LENS_FRAMES } from './lens-gallery';
import { runLensGate } from './lens-gate-client';
import { Lens } from '../lens/draw';
import { canvasRasterize } from '../lens/raster';
import { toInput } from '../lens/input';
import { osMenuPick } from '../lens/os-menu';
import { layout } from '../lens/layout';
import { gesture, initialState, liveAsk, menuPick, micLive, top, type State } from '../lens/state';
import { voiceShown } from '../lens/voice';

/** The gallery's fixed clock, so banners and notices never expire mid-run. */
const T = 1_700_000_000_000;

export function screenOf(s: State): string {
  if (s.banner) return `banner:${s.banner.key}`;
  const sc = top(s);
  if (voiceShown(s)) return `voice:${s.voice?.v.state}`; // SC-11683: the minimal voice screens
  if (s.card && !s.banner && !micLive(sc)) return `card:${s.card.card.id}${s.card.pinned ? ':pinned' : ''}`;
  if (sc.kind === 'home') return `home:${s.conn}`;
  if (sc.kind === 'quiet') return 'quiet';
  if (sc.kind === 'view') return `view:${sc.viewId}`;
  if (sc.kind === 'session') return `session:${sc.key}:${liveAsk(s, sc.key) ? 'ask' : 'thread'}`;
  if (sc.kind === 'menu') return `menu:${sc.key}`;
  return `dictate:${sc.key ?? 'new'}:${sc.phase}`;
}

export function runGateGallery(bridge: EvenAppBridge): Promise<boolean> {
  let lens: Lens | null = null;
  const lensFor = (b: EvenAppBridge): Lens => (lens ??= new Lens(b, canvasRasterize));
  return runLensGate<State>({
    bridge,
    states: LENS_FRAMES.map((f) => {
      const sc = top(f.state);
      return {
        name: f.name,
        lookingFor: f.looking_for,
        root: !f.state.banner && sc.kind === 'home',
        approval: !!f.state.banner || (sc.kind === 'session' && !!liveAsk(f.state, sc.key)),
        // Quiet mode and voice mode's idle (SC-11683: "idle should show nothing") are meant to be fully dark.
        blank: !f.state.banner && (sc.kind === 'quiet' || (voiceShown(f.state) && f.state.voice?.v.state === 'idle')),
        menu: (layout(f.state, GALLERY_NOW).menu ?? []).length > 0,
        menuItems: layout(f.state, GALLERY_NOW).menu ?? [],
        state: f.state,
      };
    }),
    boot: async (b) => {
      await lensFor(b).draw(layout(initialState('connecting'), GALLERY_NOW));
    },
    render: async (b, s) => {
      await lensFor(b).draw(layout(s, GALLERY_NOW));
    },
    onEvent: (s, e) => {
      const picked = osMenuPick(e as EvenHubEvent);
      if (picked !== null) {
        const next = menuPick(s, picked, T).state;
        return next === s ? null : next;
      }
      const inp = toInput(e as EvenHubEvent);
      if (!inp || inp === 'foreground' || inp === 'background' || inp === 'exit') return null;
      const next = gesture(s, inp, T, s).state;
      return next === s ? null : next;
    },
    screenOf,
  });
}
