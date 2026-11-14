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
import { osMenuKey, osMenuObject } from './os-menu';
import { getTextWidth } from '@evenrealities/pretext';
import { BODY_TOP, BOX_GAP, PAD, SCREEN, boxHeight, type LensFrame } from './layout';

/** Text width inside the header box (padding both sides, a little slack for the firmware's rounding). */
const HEADER_TEXT_W = SCREEN.w - 2 * PAD - 12;

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

/**
 * The containers a frame needs. The header is ONE box (where you are, then the status pushed to the right edge),
 * and it takes input. It is as tall as the space above the body (BODY_TOP - BOX_GAP), not just one line: a box whose
 * text barely fits counts as overflowing, and the firmware then scrolls it a little on each swipe (the title
 * "moving up and down slightly", Jordan 2026-11-14). An empty input strip fixed that but was too short to hold a line,
 * so swipes were spent scrolling inside it and felt slow; Jordan chose the title box over a shorter conversation.
 */
export function slots(f: LensFrame): Slot[] {
  const out: Slot[] = [
    {
      id: 1,
      name: 'hd',
      x: 0,
      y: 0,
      w: SCREEN.w,
      h: BODY_TOP - BOX_GAP,
      text: headerText(f),
      bright: f.leftBright,
      capture: true,
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

/** What forces a page rebuild: container positions, and the OS menu (items can only change on a build). */
/** Header text: the title flush left, the status flush right (measured spaces: the font is proportional). */
export function headerText(f: Pick<LensFrame, 'left' | 'right'>): string {
  if (!f.right) return f.left;
  if (!f.left)
    return ' '.repeat(Math.max(0, Math.floor((HEADER_TEXT_W - getTextWidth(f.right)) / getTextWidth(' ')))) + f.right;
  const gap = HEADER_TEXT_W - getTextWidth(f.left) - getTextWidth(f.right);
  return f.left + ' '.repeat(Math.max(2, Math.floor(gap / getTextWidth(' ')))) + f.right;
}

export function geometry(f: LensFrame): string {
  const boxes = slots(f)
    .map((s) => `${s.id}:${s.x},${s.y},${s.w},${s.h}`)
    .join('|');
  return `${boxes}#${osMenuKey(f.menu ?? [])}`;
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

/**
 * The SDK reaches the glasses only through `window.flutter_inappwebview`, which the Even app and the simulator
 * inject. In a plain browser (the phone page previewed on its own, the harness UI sweep) it is absent and every
 * draw resolves as rejected: that is not a lens failure, so it is said once as a warning, not as errors.
 */
export function hasEvenHost(): boolean {
  return typeof window === 'undefined' || 'flutter_inappwebview' in window;
}

let warnedNoHost = false;
function rejected(msg: string): void {
  if (hasEvenHost()) {
    console.error(msg);
    return;
  }
  if (!warnedNoHost) console.warn('[lens] no Even host in this page (plain browser): nothing is drawn on glasses');
  warnedNoHost = true;
}

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
      // The OS menu rides on every build: a rebuild without it clears the wearer's tap-then-hold items.
      const menuObject = osMenuObject(f.menu ?? []);
      const cfg = {
        containerTotalNum: want.length,
        textObject: want.map(property),
        ...(menuObject ? { menuObject } : {}),
      };
      // create resolves a result code (0 = success); rebuild resolves a boolean.
      const ok: number | boolean = !this.created
        ? await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(cfg))
        : await this.bridge.rebuildPageContainer(new RebuildPageContainer(cfg));
      const success = this.created ? ok === true : ok === 0;
      if (!this.created) this.calls.create++;
      else this.calls.rebuild++;
      if (!success) {
        this.calls.rejected++;
        rejected(`[lens] page ${this.created ? 'rebuild' : 'create'} rejected (${String(ok)})`);
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
        rejected(`[lens] upgrade of ${s.name} rejected (${s.text.length} chars)`);
        continue;
      }
      this.shown.set(s.id, { text: s.text, bright: s.bright });
    }
  }
}
