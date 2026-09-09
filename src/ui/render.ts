import {
  CreateStartUpPageContainer, RebuildPageContainer,
  ListContainerProperty, ListItemContainerProperty,
  TextContainerProperty, TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";

export const IDS = { header: 1, body: 2, status: 3, list: 4, dot: 5 } as const;
export const NAMES: Record<number, string> = {
  [IDS.header]: "header", [IDS.body]: "body", [IDS.status]: "status",
  [IDS.list]: "list", [IDS.dot]: "dot",
};

/**
 * Brightness is the ONLY visual hierarchy this display has.
 *
 * One font, one weight, no sizes, no colour — but `textColor` gives five
 * brightness levels (SDK 0.0.14+). Without it every glyph on screen carries
 * equal weight, which is exactly why a dense screen reads as a wall. The thread
 * is what the wearer is reading, so it burns brightest; the chrome around it
 * steps down.
 */
export const BRIGHT = { body: 4, header: 3, status: 2, dot: 4 } as const;

/**
 * The vertical budget, spent to the pixel.
 *
 * 288 px, a 27 px line pitch, and `paddingLength` is uniform on all four sides.
 * Header and status each need one line: 27 + 2*2 padding = 31, so 32 each.
 * That leaves 224 for the thread, which at 4 px padding is 216 inner and
 * floor(216/27) = **8 lines** — one more than the old 200 px body gave.
 *
 * There is deliberately no gap between containers. Containers clip their own
 * content, so a gap buys nothing but a lost line.
 */
export const LAYOUT = {
  header: { y: 0, h: 32, w: 540, pad: 2 },
  dot: { y: 0, h: 32, x: 540, w: 36, pad: 2 },
  body: { y: 32, h: 224, w: 576, pad: 4 },
  status: { y: 256, h: 32, w: 576, pad: 2 },
} as const;

// The 4 chat text containers (header, dot, body, status), shared by showSessionPage.
// createStartUpPageContainer is one-shot, so the startup page is the list;
// re-entering a session uses rebuildPageContainer with these 4 text containers.
function chatTextObjects(): TextContainerProperty[] {
  const L = LAYOUT;
  return [
    new TextContainerProperty({ containerID: IDS.header, containerName: "header", xPosition: 0,     yPosition: L.header.y, width: L.header.w, height: L.header.h, paddingLength: L.header.pad, textColor: BRIGHT.header, content: "Claude Code" }),
    new TextContainerProperty({ containerID: IDS.dot,    containerName: "dot",    xPosition: L.dot.x, yPosition: L.dot.y,   width: L.dot.w,    height: L.dot.h,    paddingLength: L.dot.pad,    textColor: BRIGHT.dot,    content: "◌" }),
    new TextContainerProperty({ containerID: IDS.body,   containerName: "body",   xPosition: 0,     yPosition: L.body.y,   width: L.body.w,   height: L.body.h,   paddingLength: L.body.pad,   textColor: BRIGHT.body,   content: "", isEventCapture: 1 }),
    new TextContainerProperty({ containerID: IDS.status, containerName: "status", xPosition: 0,     yPosition: L.status.y, width: L.status.w, height: L.status.h, paddingLength: L.status.pad, textColor: BRIGHT.status, content: "connecting…" }),
  ];
}

function loadingTextObject(content = "loading sessions...\nconnecting bridge"): TextContainerProperty[] {
  return [
    new TextContainerProperty({
      containerID: IDS.body,
      containerName: "body",
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      paddingLength: 12,
      isEventCapture: 1,
      content,
    }),
  ];
}

// Session page: the four text containers (header / dot / body / status), reused for
// every session render. createStartUpPageContainer is one-shot, so re-entering a
// session uses rebuildPageContainer; renderSession() then fills content in-place.
export async function showSessionPage(bridge: EvenAppBridge): Promise<void> {
  await bridge.rebuildPageContainer(new RebuildPageContainer({
    containerTotalNum: 4,
    textObject: chatTextObjects(),
  }));
}

function listContainer(rows: string[]): ListContainerProperty[] {
  const items = rows.slice(0, 20);
  return [
    new ListContainerProperty({
      containerID: IDS.list, containerName: "list",
      xPosition: 0, yPosition: 0, width: 576, height: 288,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: Math.max(1, items.length),
        itemWidth: 0,
        isItemSelectBorderEn: 1,
        itemName: items.length ? items : ["No sessions"],
      }),
    }),
  ];
}

// Boot lands on the list, so the one-shot startup page IS the list.
export async function createListStartup(bridge: EvenAppBridge, rows: string[]): Promise<void> {
  await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 1,
    listObject: listContainer(rows),
  }));
}

export async function createLoadingStartup(bridge: EvenAppBridge): Promise<void> {
  await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: loadingTextObject(),
  }));
}

export async function createSetupStartup(bridge: EvenAppBridge): Promise<void> {
  await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [
      new TextContainerProperty({
        containerID: IDS.body,
        containerName: "body",
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        paddingLength: 12,
        isEventCapture: 1,
        content: "Open phone app\nto configure bridge.",
      }),
    ],
  }));
}

// One full-height text container with event capture. Used for every page that
// is just words: loading, setup, and the activity alert.
async function showFullTextPage(bridge: EvenAppBridge, content: string): Promise<void> {
  await bridge.rebuildPageContainer(new RebuildPageContainer({
    containerTotalNum: 1,
    textObject: loadingTextObject(content),
  }));
}

export async function showLoadingPage(bridge: EvenAppBridge, content: string): Promise<void> {
  await showFullTextPage(bridge, content);
}

/**
 * The activity notification. Its own page rather than an overlay on the session
 * screen, because inside a session a tap already means "record" — an alert that
 * borrowed that gesture would be ambiguous exactly when it matters.
 */
export async function showAlertPage(bridge: EvenAppBridge, content: string): Promise<void> {
  await showFullTextPage(bridge, content);
}

export async function showListPage(bridge: EvenAppBridge, rows: string[]): Promise<void> {
  await bridge.rebuildPageContainer(new RebuildPageContainer({
    containerTotalNum: 1,
    listObject: listContainer(rows),
  }));
}

/**
 * `textColor` is a per-call override, and the SDK keeps the container's current
 * brightness when it is omitted — so a caller that cares passes one, and a
 * caller that does not leaves the page's declared level alone.
 */
export async function setText(bridge: EvenAppBridge, id: number, content: string, textColor?: number): Promise<void> {
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: id,
    containerName: NAMES[id],
    contentOffset: 0,
    contentLength: 0,   // full replacement (glasses-ui requirement)
    ...(textColor === undefined ? {} : { textColor }),
    content,
  }));
}
