/**
 * State → what the lens shows (SC-9500). Pure: no SDK, no clock except the `now` passed in.
 *
 * The ten house rules (even-frontend `resources/design-rules.md`) are built in here:
 *  1. three zones: one header row, a body of at most six boxes, no footer
 *  2. header = where you are on the left, live status on the right in its OWN container
 *  3. hierarchy by brightness: the cursor row brightest, a row that needs you next, the rest dimmer
 *  4. one cursor style: the ▶ glyph (borders cannot move without a page rebuild)
 *  5. no gesture hints
 *  6. a row is marker, title, detail; one line, cut with …, never wrapped
 *  7. no drawn dividers: boxes are separated by a gap
 *  8. one fixed glyph set for status (MARK)
 *  9. a prompt is the ask, the detail, then the options with the safe one first
 * 10. sparse: six body rows at most
 */
import { getAdvW, getTextWidth } from '@evenrealities/pretext';
import type { GlassesMark, GlassesRow } from '../gateway/glasses';
import { wrapTextLines } from './wrap';
import { CONVO_LINES, conversationLines, convoWindow } from './conversation';
import type { OsMenuItem } from './os-menu';
import { HEADER_W, cardLayout, cornerOf, type Corner, type FreeBox, type ImageBox } from './card';
import {
  anchorFor,
  menuActions,
  peekFor,
  cursorIndex,
  items,
  liveAsk,
  micLive,
  sendTarget,
  threadFor,
  top,
  viewFor,
  type Dictation,
  type Item,
  type State,
} from './state';

/** Brightness levels (SDK textColor 0-4). 0 may be invisible on glass, so nothing uses it. */
/**
 * Measured in the simulator (glasses gate, 2026-11-11): textColor 4/3/2/1 draw at alpha 255/230/197/179, so the
 * whole scale spans ~30%. Hierarchy therefore uses the widest steps: the cursor and what is being read at 4,
 * needs-you at 3, chrome and choices at 2, everything quiet at 1.
 */
export const B = { cursor: 4, needs: 3, body: 4, normal: 2, dim: 1 } as const;
export type Bright = 1 | 2 | 3 | 4;

/** Design rule 8: the one fixed set of status markers, all in the firmware font. */
export const MARK: Record<GlassesMark, string> = {
  // Jordan's M1 set (2026-11-12, SC-9703): read like words, all in the firmware font (no emoji, no ✓).
  needs: '!',
  working: '…',
  'your-turn': '→',
  asleep: 'z',
  done: '·',
  error: '×',
};

const MARK_BRIGHT: Record<GlassesMark, Bright> = {
  needs: B.needs,
  working: B.dim,
  'your-turn': B.dim,
  asleep: B.dim,
  done: B.dim,
  error: B.needs,
};

export interface Box {
  text: string;
  bright: Bright;
  /** Height in text lines; fixed per screen shape so cursor moves never rebuild the page. */
  lines: number;
  /** Extra space below this box, in px: a half-row pause between a block of text and the choices under it. */
  gap?: number;
}

export interface LensFrame {
  left: string;
  right: string;
  leftBright: Bright;
  rightBright: Bright;
  /** At most BODY_BOXES. */
  body: Box[];
  /** The glasses' own tap-then-hold menu items for this screen (os-menu.ts). */
  menu?: OsMenuItem[];
  /** The corner state icon (SC-11683). */
  corner?: Corner;
  /** Free-placed boxes that replace `body` (a show-me card). */
  free?: FreeBox[];
  /** Image boxes (a card's big value, its sparkline). */
  images?: ImageBox[];
}

// ------------------------------------------------------------------------------------------- geometry

export const SCREEN = { w: 576, h: 288 } as const;
export const LINE = 27;
export const PAD = 2;
export const HEADER_H = 32;
export const BODY_TOP = 38;
export const BOX_GAP = 2;
/** The pause between a text block and the rows of choices under it (rule 7: space, never a drawn line). */
export const SECTION_GAP = 12;
export const BODY_BOXES = 6;
/** Visible rows in a list screen (rule 10: five to seven). */
export const LIST_ROWS = 6;
/** Visible options under an ask. */
export const OPTION_ROWS = 4;
/** Text width inside a full-width box. The firmware breaks at 568 px; pretext is an estimate, so keep slack. */
export const TEXT_W = SCREEN.w - 2 * PAD - 12;
/** Per-container byte budget. The SDK silently drops anything past ~999 bytes. */
export const BOX_BYTES = 900;

export const boxHeight = (lines: number): number => lines * LINE + 2 * PAD;

/** Width of the right header container for a given status text, snapped so small changes do not rebuild. */
export function rightWidth(text: string): number {
  const w = getTextWidth(text) + 2 * PAD + 10;
  return Math.min(300, Math.max(48, Math.ceil(w / 32) * 32));
}

// ------------------------------------------------------------------------------------------- text

const ELL = '…';
const utf8 = new TextEncoder();
const bytes = (t: string): number => utf8.encode(t).length;

/** The firmware glyphs this app draws on purpose (even-frontend safe set); never stripped. */
const SAFE_GLYPHS = new Set([...'━─█▇▆▅▄▃▂▁▲△▶▷▼▽◀◁●○■□★☆╭╮╯╰│♠♣♥♦…→×·']);
const PICTO = /\p{Extended_Pictographic}/u;

/**
 * Drop what the lens cannot draw cleanly, from text that came from Aristo (titles, details, statuses):
 *  - characters with no advance in the firmware font chain (pretext's table): drawn as nothing;
 *  - every emoji / pictograph outside the safe glyph set, plus variation selectors and joiners: the chain has
 *    advances for some (✅), but the lens draws them as an empty box (glasses gate, 2026-11-11).
 * Then close the gaps they leave.
 */
export function drawable(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 10) out += ch;
    else if (cp === 0xfe0f || cp === 0xfe0e || cp === 0x200d) continue;
    else if (PICTO.test(ch) && !SAFE_GLYPHS.has(ch)) continue;
    else if (getAdvW(cp) > 0) out += ch;
  }
  return out.replace(/[^\S\n]{2,}/g, ' ');
}

/** Lines an ask's detail gets on the lens (the ask screen below cuts it there with …). */
export const ASK_DETAIL_LINES = 2;

/**
 * Does the lens show `text` WHOLE in `maxLines`: every glyph drawn (none dropped by the firmware font) and nothing
 * cut with …? A permission the wearer cannot read whole must not be approvable from the lens (SC-11683 review: a
 * padded command hid `; rm -rf ~` past the cut). Measured by pixel, like `block`, never by character count.
 */
export function shownWhole(text: string, maxLines = ASK_DETAIL_LINES, maxPx = TEXT_W): boolean {
  const t = text.trim();
  if (drawable(t) !== t.replace(/[^\S\n]{2,}/g, ' ')) return false;
  const lines = wrapTextLines(drawable(t), maxPx).filter((l, i, all) => l !== '' || (i > 0 && i < all.length - 1));
  return lines.length <= maxLines;
}

/** Cut `text` to `maxPx` (and `maxBytes`) with an ellipsis. Never splits a UTF-8 sequence. */

export function fit(text: string, maxPx: number, maxBytes = 200): string {
  const clean = drawable(text).replace(/\s+/g, ' ').trim();
  if (getTextWidth(clean) <= maxPx && bytes(clean) <= maxBytes) return clean;
  const chars = Array.from(clean);
  while (chars.length) {
    chars.pop();
    const cand = chars.join('').trimEnd() + ELL;
    if (getTextWidth(cand) <= maxPx && bytes(cand) <= maxBytes) return cand;
  }
  return ELL;
}

/** Wrap to at most `maxLines`, the last line ending in … when text was left out. */
export function block(text: string, maxLines: number, maxPx = TEXT_W): string[] {
  const lines = wrapTextLines(drawable(text).trim(), maxPx).filter(
    (l, i, all) => l !== '' || (i > 0 && i < all.length - 1),
  );
  if (lines.length <= maxLines) return lines.length ? lines : [''];
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = fit(kept[maxLines - 1] + ' ' + lines[maxLines], maxPx);
  if (!kept[maxLines - 1].endsWith(ELL)) kept[maxLines - 1] = fit(kept[maxLines - 1] + ELL, maxPx);
  return kept;
}

function clampBytes(text: string): string {
  if (bytes(text) <= BOX_BYTES) return text;
  const chars = Array.from(text);
  while (chars.length && bytes(chars.join('') + ELL) > BOX_BYTES) chars.pop();
  return chars.join('') + ELL;
}

const CURSOR = '▶ ';
/** Spaces as wide as the cursor, so rows do not shift sideways as it moves (the font is proportional). */
const INDENT = ' '.repeat(Math.max(1, Math.round(getTextWidth(CURSOR) / Math.max(1, getTextWidth(' ')))));

function cursorPrefix(on: boolean): string {
  return on ? CURSOR : INDENT;
}

export interface RowOpts {
  /** Kept whole at the end of the row, after the detail: the age (rule 6: right-side metadata). */
  tail?: string;
  /** Nesting depth: each level indents by one cursor width. */
  depth?: number;
  maxPx?: number;
}

/**
 * A one-line row: cursor slot, indent, then `main`, then ` - detail`, then `, tail`. When it does not fit,
 * the detail is cut first, then the title; the tail always survives.
 */
export function row(on: boolean, rawMain: string, rawDetail = '', o: RowOpts = {}): string {
  const clean = (t: string) => drawable(t).replace(/\s+/g, ' ').trim();
  const main = clean(rawMain);
  const detail = clean(rawDetail);
  const tail = clean(o.tail ?? '');
  const prefix = cursorPrefix(on) + INDENT.repeat(Math.min(2, o.depth ?? 0));
  if (!detail && tail) {
    // Title, then the age pushed to the right edge with measured spaces (rule 6: right-side metadata).
    const max = o.maxPx ?? TEXT_W;
    const gap = getTextWidth('   ');
    const title = fit(main, max - getTextWidth(prefix) - getTextWidth(tail) - gap);
    const used = getTextWidth(prefix + title) + getTextWidth(tail);
    const pad = Math.max(3, Math.floor((max - used) / getTextWidth(' ')));
    return prefix + title + ' '.repeat(pad) + tail;
  }
  const end = tail ? `, ${tail}` : '';
  const room = (o.maxPx ?? TEXT_W) - getTextWidth(prefix) - getTextWidth(end);
  if (!detail) return prefix + fit(main, room) + end;
  const full = `${main} - ${detail}`;
  if (getTextWidth(full) <= room) return prefix + full + end;
  // Title gets up to 60% of the row, the detail what is left (at least a few glyphs, else it is dropped).
  const title = fit(main, Math.max(room * 0.6, room - getTextWidth(` - ${detail}`)));
  const left = room - getTextWidth(`${title} - `);
  if (left < 40) return prefix + fit(main, room) + (tail ? ` - ${tail}` : '');
  return prefix + `${title} - ${fit(detail, left)}` + end;
}

// ------------------------------------------------------------------------------------------- lists

/**
 * Which slice of a long list is visible: lists PAGE (even-frontend design rule 11, Jordan 2026-11-13). The cursor
 * walks down to the last row of the page; one more step flips the next page in with the cursor on its top row.
 * Never a window that slides under a cursor pinned mid-screen.
 */
export function windowStart(cursor: number, total: number, size: number): number {
  if (total <= size || size <= 0) return 0;
  return Math.floor(Math.max(0, Math.min(cursor, total - 1)) / size) * size;
}

/** Marks the last visible row when more rows sit below the window. */
export const MORE_BELOW = '▽';

function listBoxes<T>(
  all: T[],
  cursor: number,
  size: number,
  draw: (it: T, on: boolean, moreBelow: boolean) => Box,
): Box[] {
  const start = windowStart(cursor, all.length, size);
  const below = start + size < all.length;
  const shown = all.slice(start, start + size);
  return shown.map((it, i) => draw(it, start + i === cursor, below && i === shown.length - 1));
}

function viewRowBox(r: GlassesRow, on: boolean, moreBelow: boolean): Box {
  const tail = [r.age, moreBelow ? MORE_BELOW : ''].filter(Boolean).join(' ');
  return {
    // Marker, title, age: nothing else (Jordan, 2026-11-13: no "Bash: …" command after the title).
    text: row(on, `${MARK[r.mark]} ${r.title}`, '', { tail, depth: r.depth }),
    bright: on ? B.cursor : MARK_BRIGHT[r.mark],
    lines: 1,
  };
}

function counts(needs: number, working: number, total: number): string {
  const parts: string[] = [];
  if (needs) parts.push(`${needs} need you`);
  if (working) parts.push(`${working} working`);
  if (!parts.length) parts.push(total ? `${total} quiet` : 'empty');
  return parts.join(', ');
}

// ------------------------------------------------------------------------------------------- screens

function connRight(s: State): string | null {
  if (s.notice) return s.notice.text;
  if (s.conn === 'reconnecting') return 'reconnecting…';
  if (s.conn === 'connecting') return 'connecting…';
  if (s.conn === 'unconfigured') return 'setup';
  return null;
}

function message(left: string, right: string, text: string, rightBright: Bright = B.normal): LensFrame {
  return {
    left,
    right,
    leftBright: B.normal,
    rightBright,
    body: [{ text: block(text, 5).join('\n'), bright: B.normal, lines: 5 }],
  };
}

export function layout(s: State, now: number = Date.now()): LensFrame {
  // A banner (someone needs you) wins over a card, for drawing as for gestures (state.ts gesture order).
  const f = s.card && !s.banner && !micLive(top(s)) ? cardFrame(s) : layoutRaw(s, now);
  return {
    ...f,
    menu: menuActions(s),
    corner: cornerOf(s),
    // A clear gutter between where-you-are and the live status (the critic saw them nearly touch).
    left: fit(f.left, HEADER_W - rightWidth(f.right) - 2 * PAD - 40),
    right: fit(f.right, 290),
    body: f.body.slice(0, BODY_BOXES).map((b) => ({ ...b, text: clampBytes(b.text) })),
  };
}

function layoutRaw(s: State, now: number): LensFrame {
  if (s.banner) return bannerFrame(s);
  const sc = top(s);
  const status = connRight(s);

  if (s.conn === 'unconfigured') {
    return message('Aristo', 'setup', 'Open Agent on your phone and enter the gateway address and token.');
  }

  // Quiet mode draws nothing at all (Jordan, 2026-11-13: "quiet mode should just look totally quiet"). A banner
  // (drawn above, before this) is the only thing that shows; the tap-then-hold menu leaves it.
  if (sc.kind === 'quiet') return { left: '', right: '', leftBright: B.dim, rightBright: B.dim, body: [] };

  if (sc.kind === 'home') {
    if (!s.home)
      return message(
        'Aristo',
        status ?? 'loading…',
        s.conn === 'online' ? 'Loading views…' : 'Reaching Aristo on Chiba…',
      );
    // The home is exactly Aristo's Favorites (SC-10526): the Inbox count comes with the frame, not from a first row.
    const right = status ?? (s.needs ? `${s.needs} need you` : 'all clear');
    if (!s.home.length)
      return message(
        'Aristo',
        right,
        'No favorites yet. Star views in Aristo to see them here.',
        s.needs && !status ? B.needs : B.normal,
      );
    const list = items(s);
    const cur = cursorIndex(s);
    const body = listBoxes(list, cur, LIST_ROWS, (it, on) => {
      const v = (it as Extract<Item, { kind: 'view' }>).view;
      const glyph = v.needs ? MARK.needs : v.working ? MARK.working : MARK['your-turn'];
      const bright: Bright = on ? B.cursor : v.needs ? B.needs : B.dim;
      return { text: row(on, `${glyph} ${v.name}`, counts(v.needs, v.working, v.total)), bright, lines: 1 };
    });
    return {
      left: 'Aristo',
      right,
      leftBright: B.normal,
      rightBright: s.needs && !status ? B.needs : B.normal,
      body,
    };
  }

  if (sc.kind === 'view') {
    const v = viewFor(s, sc.viewId);
    if (!v) return message(sc.name, status ?? 'loading…', 'Loading…');
    const list = items(s);
    const rows = list.map((it) => (it as Extract<Item, { kind: 'row' }>).row);
    const cur = cursorIndex(s);
    const working = rows.filter((r) => r.mark === 'working').length;
    const shownTotal = rows.length + v.more;
    const pos = rows.length > LIST_ROWS ? `, ${cur + 1}/${shownTotal}` : '';
    const right = status ?? counts(v.needs, working, v.total) + pos;
    if (!rows.length) return message(v.name, right, 'Nothing here.');
    const body = listBoxes(rows, cur, LIST_ROWS, viewRowBox);
    return { left: v.name, right, leftBright: B.normal, rightBright: v.needs && !status ? B.needs : B.normal, body };
  }

  if (sc.kind === 'session') {
    const t = threadFor(s, sc.key);
    if (!t) return message(sc.title, status ?? 'loading…', 'Loading…');
    const ask = liveAsk(s, sc.key);
    const list = items(s);
    const cur = cursorIndex(s);
    const reading = peekFor(s, sc.key);
    if (ask && reading !== undefined) {
      // Reading the conversation behind the ask; the dim last line names what is waiting below (▽).
      const win = convoWindow(conversationLines(t.lines), reading);
      const waiting = `${MARK.needs} ${ask.ask || ask.kind} ${MORE_BELOW}`;
      const body: Box[] = [
        { text: win.lines.join('\n'), bright: B.body, lines: Math.min(CONVO_LINES, Math.max(1, win.lines.length)) },
        { text: fit(waiting, TEXT_W), bright: B.dim, lines: 1 },
      ];
      // The header stays still while the text glides (Jordan, 2026-11-13): no page number that changes per swipe.
      const right = status ?? ask.kind;
      return { left: t.row.title, right, leftBright: B.normal, rightBright: B.needs, body };
    }
    if (ask) {
      // A label that only repeats the header's ask kind ("Question" under "question") is dropped.
      const label = ask.ask.trim().toLowerCase() === ask.kind.toLowerCase() ? '' : ask.ask;
      // Cut short below, so only its refusing options are offered (items()): say why.
      const cut = ask.kind === 'permission' && !shownWhole(ask.detail || ask.context || '');
      const heading = [
        ask.asker ?? '',
        label,
        ask.more ? `(+${ask.more} more in Aristo)` : '',
        cut ? '· too long to read here, so only No' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const optRows = Math.min(OPTION_ROWS, list.length);
      // The detail is at most 2 lines, cut with …; its box is as tall as its text so the options sit right under it.
      const detail = block(ask.detail || ask.context || '', 2);
      const body: Box[] = [
        ...(heading ? [{ text: fit(heading, TEXT_W), bright: B.dim, lines: 1 } as Box] : []),
        { text: detail.join('\n'), bright: B.cursor, lines: Math.max(1, detail.length), gap: SECTION_GAP },
        ...listBoxes(list, cur, optRows, (it, on) => ({
          text: row(on, optionLabel(s, sc.key, it)),
          bright: on ? B.cursor : B.normal,
          lines: 1,
        })),
      ];
      // Several questions at once (`more`), or nothing the lens can offer: Aristo answers it, not the lens.
      if (!list.length) body.push({ text: fit('Answer this one in Aristo.', TEXT_W), bright: B.normal, lines: 1 });
      return { left: t.row.title, right: status ?? ask.kind, leftBright: B.normal, rightBright: B.needs, body };
    }
    // The conversation, a few lines per swipe, with what the session is doing on a dim last line.
    const win = convoWindow(conversationLines(t.lines), anchorFor(s, sc.key));
    // The header stays still while the text glides (Jordan, 2026-11-13): no page number that changes per swipe.
    const right = status ?? t.row.status;
    // Opens with the session's marker, so it reads as status, not one more message (brightness alone spans ~30% on glass).
    // A working row's detail is the tool it is running ("Edit src/x.ts"): tool calls stay off the lens (Jordan,
    // 2026-11-13), so only a pending ask's summary is shown; otherwise just "working".
    const activity =
      t.row.detail && t.row.promptId
        ? `${MARK[t.row.mark]} ${t.row.detail}`
        : t.row.mark === 'working'
          ? `${MARK.working} working`
          : '';
    const body: Box[] = [
      // As tall as the page (at most CONVO_LINES), so a short conversation keeps its activity line right under it.
      { text: win.lines.join('\n'), bright: B.body, lines: Math.min(CONVO_LINES, Math.max(1, win.lines.length)) },
      ...(activity ? [{ text: fit(activity, TEXT_W), bright: B.dim, lines: 1 } as Box] : []),
    ];
    return { left: t.row.title, right, leftBright: B.normal, rightBright: B.normal, body };
  }

  if (sc.kind === 'menu') {
    const list = items(s);
    const cur = cursorIndex(s);
    const t = threadFor(s, sc.key);
    const body = listBoxes(list, cur, 3, (it, on) => ({
      text: row(on, actionLabel(it)),
      bright: on ? B.cursor : B.normal,
      lines: 1,
    }));
    return { left: sc.title, right: status ?? t?.row.status ?? '', leftBright: B.normal, rightBright: B.normal, body };
  }

  return dictationFrame(s, sc, status, now);
}

function optionLabel(s: State, key: string, it: Item): string {
  const ask = liveAsk(s, key);
  if (it.kind === 'option' && ask) return ask.options[it.index]?.label ?? '';
  return '';
}

function actionLabel(it: Item): string {
  if (it.kind === 'stop') return 'Stop';
  if (it.kind === 'done') return 'Mark done';
  if (it.kind === 'close') return 'Set aside';
  return '';
}

const PHASE_RIGHT: Record<Dictation['phase'], string> = {
  listening: '● listening',
  finishing: 'finishing…',
  confirm: 'send this?',
  empty: 'heard nothing',
  sending: 'sending…',
  failed: 'failed',
};

/** Lines of transcript on the dictation screen: live words while you hold, the final text after. */
const DICT_LINES = 4;

function dictationFrame(s: State, d: Dictation, status: string | null, now: number): LensFrame {
  const target = sendTarget(s, d);
  const what =
    target.kind === 'create'
      ? 'First message:'
      : target.kind === 'answer'
        ? target.ask.kind === 'permission'
          ? 'Deny, with this note:'
          : 'Answer:'
        : 'Message:';
  const live = d.phase === 'listening' || d.phase === 'finishing';
  const text = live
    ? d.text || (d.interim ? '' : d.phase === 'listening' ? 'Speak now.' : '…')
    : d.phase === 'empty'
      ? 'Nothing was heard.'
      : d.phase === 'failed'
        ? `Could not finish: ${d.error ?? 'unknown error'}`
        : d.text;
  // Live: settled words bright (newest lines kept), the tail Soniox may still change on its own DIM line below.
  // Confirm: 3 lines, so Send / Say it again / Cancel fit under them.
  const n = DICT_LINES - 1;
  const shown = live ? wrapTextLines(text, TEXT_W).slice(-n) : block(text, n);
  // In parentheses: these words may still change (a dim line alone is too subtle on glass).
  const tail = live && d.interim ? fit(`(${d.interim}…)`, TEXT_W) : '';
  const list = items(s);
  const cur = cursorIndex(s);
  const body: Box[] = [
    { text: fit(what, TEXT_W), bright: B.normal, lines: 1 },
    ...(shown.join('').trim()
      ? [
          {
            text: shown.join('\n'),
            bright: B.cursor,
            lines: Math.max(1, shown.length),
            gap: list.length ? SECTION_GAP : 0,
          } as Box,
        ]
      : []),
    ...(tail ? [{ text: tail, bright: B.dim, lines: 1 } as Box] : []),
    ...list.map((it, i) => ({
      text: row(i === cur, dictLabel(it)),
      bright: (i === cur ? B.cursor : B.normal) as Bright,
      lines: 1,
    })),
  ];
  const secs = Math.max(0, Math.floor((now - d.startedAt) / 1000));
  const right = status && s.notice ? status : d.phase === 'listening' ? `${secs}s` : PHASE_RIGHT[d.phase];
  return {
    left: d.title,
    right,
    leftBright: B.normal,
    rightBright: d.phase === 'listening' ? B.cursor : B.normal,
    body,
  };
}

function dictLabel(it: Item): string {
  if (it.kind === 'send') return 'Send';
  if (it.kind === 'redo') return 'Say it again';
  if (it.kind === 'cancel') return 'Cancel';
  return '';
}

/** A show-me card over the open screen: the header keeps where you are; "pinned" once tapped. */
function cardFrame(s: State): LensFrame {
  const sc = top(s);
  const left = sc.kind === 'home' || sc.kind === 'quiet' ? 'Aristo' : 'title' in sc ? sc.title : 'Aristo';
  const { free, images } = cardLayout(s.card!);
  return {
    left,
    right: s.card!.pinned ? 'pinned' : '',
    leftBright: B.normal,
    rightBright: B.dim,
    body: [],
    free,
    images,
  };
}

function bannerFrame(s: State): LensFrame {
  const b = s.banner!;
  return {
    left: `${MARK.needs} ${b.title}`,
    right: 'needs you',
    leftBright: B.cursor,
    rightBright: B.needs,
    body: [
      { text: block(b.ask, 3).join('\n'), bright: B.body, lines: 3 },
      { text: row(s.bannerCursor === 0, 'Answer now'), bright: s.bannerCursor === 0 ? B.cursor : B.normal, lines: 1 },
      { text: row(s.bannerCursor === 1, 'Later'), bright: s.bannerCursor === 1 ? B.cursor : B.normal, lines: 1 },
    ],
  };
}
