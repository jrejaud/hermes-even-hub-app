import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';
import './style.css';
import { GALLERY_NOW, LENS_FRAMES } from './dev/lens-gallery';
import { FakeGateway } from './dev/fake-gateway';
import { lensGateUrl } from './dev/lens-gate-client';
import { runGateGallery } from './dev/lens-gate-app';
import { startApp } from './lens/app';
import { Lens } from './lens/draw';
import { layout } from './lens/layout';

/**
 * Aristo Lens entry (SC-9500).
 *   VITE_UI_GALLERY=1     draw the state gallery, one frame per tap (scripts/ui-gallery.mjs captures it)
 *   VITE_FAKE_GATEWAY=1   run the real app against the in-process fake gateway (simulator play-testing)
 *   otherwise             the real app; the gateway URL and token come from the phone page
 */
async function runGallery(bridge: EvenAppBridge): Promise<void> {
  const lens = new Lens(bridge);
  let i = 0;
  let busy = Promise.resolve();
  const draw = (): void => {
    const f = LENS_FRAMES[i];
    busy = busy.then(async () => {
      await lens.draw(layout(f.state, GALLERY_NOW));
      console.log(`[gallery] ${i + 1}/${LENS_FRAMES.length} ${f.name} — ${f.looking_for}`);
    });
  };
  bridge.onEvenHubEvent((e) => {
    if (e.audioEvent) return;
    i = (i + 1) % LENS_FRAMES.length;
    draw();
  });
  draw();
  await busy;
  console.log('[glasses] ready');
}

async function boot(): Promise<void> {
  const bridge = await waitForEvenAppBridge();
  if (import.meta.env.VITE_UI_GALLERY === '1') {
    // Under the glasses UI gate (?lensGate=…) the gate drives the states; otherwise tap forward.
    if (lensGateUrl()) {
      await runGateGallery(bridge);
      return;
    }
    return runGallery(bridge);
  }
  const root = document.querySelector<HTMLElement>('#app') ?? undefined;
  if (import.meta.env.VITE_FAKE_GATEWAY === '1') {
    const fake = new FakeGateway();
    (window as unknown as { fakeGateway: FakeGateway }).fakeGateway = fake;
    return startApp({
      bridge,
      root,
      connect: fake.connect,
      defaultProfile: { url: 'ws://fake.invalid', token: 'fake' },
    });
  }
  return startApp({ bridge, root });
}

boot().catch((err: unknown) => console.error('[glasses] boot failed', err));
