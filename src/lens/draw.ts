/**
 * LensFrame → the Even SDK (SC-9500).
 *
 * Container POSITION is fixed when a page is built and content is not, so a frame is split into its
 * geometry (header-right width, each body box's height) and its text. Same geometry as what is on the
 * lens → only the containers whose text or brightness changed get a flicker-free `textContainerUpgrade`.
 * Different geometry → one `rebuildPageContainer`. The very first page is `createStartUpPageContainer`,
 * which works once per session.
 *
 * Every SDK call is checked: the SDK resolves `false` (no throw, no log) when it rejects content, which
 * otherwise looks exactly like a stale screen. A rejection is logged with console.error so the simulator's
 * console (and the glasses UI gate) sees it.
 */
import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk';
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { BODY_TOP, BOX_GAP, HEADER_H, PAD, SCREEN, boxHeight, rightWidth, type LensFrame } from './layout';

interface Slot {
  id: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  bright: number;
  capture: boolean;
}

/** The containers a frame needs. Header-left carries input capture: it is the one box that always exists. */
export function slots(f: LensFrame): Slot[] {
  const rw = rightWidth(f.right);
  const out: Slot[] = [
    { id: 1, name: 'hl', x: 0, y: 0, w: SCREEN.w - rw, h: HEADER_H, text: f.left, bright: f.leftBright, capture: true },
    {
      id: 2,
      name: 'hr',
      x: SCREEN.w - rw,
      y: 0,
      w: rw,
      h: HEADER_H,
      text: f.right,
      bright: f.rightBright,
      capture: false,
    },
  ];
  let y = BODY_TOP;
  f.body.forEach((b, i) => {
    const h = boxHeight(b.lines);
    out.push({
      id: 3 + i,
      name: `b${i}`,
      x: 0,
      y,
      w: SCREEN.w,
      h: Math.min(h, SCREEN.h - y),
      text: b.text,
      bright: b.bright,
      capture: false,
    });
    y += h + BOX_GAP + (b.gap ?? 0);
  });
  return out;
}

export function geometry(f: LensFrame): string {
  return slots(f)
    .map((s) => `${s.id}:${s.x},${s.y},${s.w},${s.h}`)
    .join('|');
}

function property(s: Slot): TextContainerProperty {
  return new TextContainerProperty({
    containerID: s.id,
    containerName: s.name,
    xPosition: s.x,
    yPosition: s.y,
    width: s.w,
    height: s.h,
    paddingLength: PAD,
    textColor: s.bright,
    // An empty string is not a valid container content on the device; a space draws nothing.
    content: s.text || ' ',
    ...(s.capture ? { isEventCapture: 1 } : {}),
  });
}

/** The parts of the SDK this file uses, so tests can stand a fake in. */
export type LensBridge = Pick<
  EvenAppBridge,
  'createStartUpPageContainer' | 'rebuildPageContainer' | 'textContainerUpgrade'
>;

export class Lens {
  private created = false;
  private geom = '';
  private shown = new Map<number, { text: string; bright: number }>();
  /** Calls made, for tests and for the gallery's console line. */
  calls = { create: 0, rebuild: 0, upgrade: 0, rejected: 0 };

  private readonly bridge: LensBridge;

  constructor(bridge: LensBridge) {
    this.bridge = bridge;
  }

  async draw(f: LensFrame): Promise<void> {
    const want = slots(f);
    const geom = geometry(f);
    if (!this.created || geom !== this.geom) {
      const cfg = { containerTotalNum: want.length, textObject: want.map(property) };
      // create resolves a result code (0 = success); rebuild resolves a boolean.
      const ok: number | boolean = !this.created
        ? await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(cfg))
        : await this.bridge.rebuildPageContainer(new RebuildPageContainer(cfg));
      const success = this.created ? ok === true : ok === 0;
      if (!this.created) this.calls.create++;
      else this.calls.rebuild++;
      if (!success) {
        this.calls.rejected++;
        console.error(`[lens] page ${this.created ? 'rebuild' : 'create'} rejected (${String(ok)})`);
        // A failed create still consumes the one-shot create: every later page must be a rebuild.
        if (!this.created) {
          this.created = true;
          this.geom = '';
          return this.draw(f);
        }
        return;
      }
      this.created = true;
      this.geom = geom;
      this.shown = new Map(want.map((s) => [s.id, { text: s.text, bright: s.bright }]));
      return;
    }
    for (const s of want) {
      const prev = this.shown.get(s.id);
      if (prev && prev.text === s.text && prev.bright === s.bright) continue;
      const ok = await this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: s.id,
          containerName: s.name,
          contentOffset: 0,
          contentLength: 0,
          textColor: s.bright,
          content: s.text || ' ',
        }),
      );
      this.calls.upgrade++;
      if (ok === false) {
        this.calls.rejected++;
        console.error(`[lens] upgrade of ${s.name} rejected (${s.text.length} chars)`);
        continue;
      }
      this.shown.set(s.id, { text: s.text, bright: s.bright });
    }
  }
}
