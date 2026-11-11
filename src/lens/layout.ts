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
import { wrapTextLines } from '../ui/stream';
import {
  cursorIndex,
  items,
  liveAsk,
  sendTarget,
  threadFor,
  top,
  viewFor,
  type Dictation,
  type Item,
  type State,
} from './state';

/** Brightness levels (SDK textColor 0-4). 0 may be invisible on glass, so nothing uses it. */
export const B = { cursor: 4, needs: 3, body: 3, normal: 2, dim: 1 } as const;
export type Bright = 1 | 2 | 3 | 4;

/** Design rule 8: the one fixed set of status markers, all in the firmware font. */
export const MARK: Record<GlassesMark, string> = {
  needs: '●',
  working: '▷',
  'your-turn': '○',
  asleep: '○',
  done: '□',
  error: '▲',
};

const MARK_BRIGHT: Record<GlassesMark, Bright> = {
  needs: B.needs,
  working: B.normal,
  'your-turn': B.normal,
  asleep: B.dim,
  done: B.dim,
  error: B.needs,
};

export interface Box {
  text: string;
  bright: Bright;
  /** Height in text lines; fixed per screen shape so cursor moves never rebuild the page. */
  lines: number;
}

export interface LensFrame {
  left: string;
  right: string;
  leftBright: Bright;
  rightBright: Bright;
  /** At most BODY_BOXES. */
  body: Box[];
}

// ------------------------------------------------------------------------------------------- geometry

export const SCREEN = { w: 576, h: 288 } as const;
export const LINE = 27;
export const PAD = 2;
export const HEADER_H = 32;
export const BODY_TOP = 38;
export const BOX_GAP = 2;
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

/** Cut `text` to `maxPx` (and `maxBytes`) with an ellipsis. Never splits a UTF-8 sequence. */
/**
 * Drop every character the firmware font chain has no glyph for (the lens draws it as nothing, so a
 * leftover "💤 Asleep" would show as " Asleep" with a stray gap). Pretext's advance table is that chain.
 */
export function drawable(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 10 || getAdvW(cp) > 0) out += ch;
  }
  return out.replace(/[^\S\n]{2,}/g, ' ');
}

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

/** A one-line row: cursor slot, then `main`, then ` - detail` cut first so the title survives. */
export function row(on: boolean, rawMain: string, rawDetail = '', maxPx = TEXT_W): string {
  const main = drawable(rawMain).replace(/\s+/g, ' ').trim();
  const detail = drawable(rawDetail).replace(/\s+/g, ' ').trim();
  const prefix = cursorPrefix(on);
  const room = maxPx - getTextWidth(prefix);
  if (!detail) return prefix + fit(main, room);
  const full = `${main} - ${detail}`;
  if (getTextWidth(full) <= room) return prefix + full;
  // Title gets up to 60% of the row, the detail what is left (at least a few glyphs, else it is dropped).
  const title = fit(main, Math.max(room * 0.6, room - getTextWidth(` - ${detail}`)));
  const left = room - getTextWidth(`${title} - `);
  if (left < 40) return prefix + fit(main, room);
  return prefix + `${title} - ${fit(detail, left)}`;
}

// ------------------------------------------------------------------------------------------- lists

/** Which slice of a long list is visible: keep the cursor two rows from the top edge where possible. */
export function windowStart(cursor: number, total: number, size: number): number {
  if (total <= size) return 0;
  return Math.max(0, Math.min(cursor - 2, total - size));
}

function listBoxes<T>(all: T[], cursor: number, size: number, draw: (it: T, on: boolean) => Box): Box[] {
  const start = windowStart(cursor, all.length, size);
  return all.slice(start, start + size).map((it, i) => draw(it, start + i === cursor));
}

function viewRowBox(r: GlassesRow, on: boolean): Box {
  const indent = r.depth > 0 ? '  '.repeat(Math.min(2, r.depth)) : '';
  const detail = [r.detail || r.status, r.age].filter(Boolean).join(', ');
  return {
    text: row(on, `${indent}${MARK[r.mark]} ${r.title}`, detail),
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
    leftBright: B.body,
    rightBright,
    body: [{ text: block(text, 5).join('\n'), bright: B.normal, lines: 5 }],
  };
}

export function layout(s: State): LensFrame {
  const f = layoutRaw(s);
  return {
    ...f,
    left: fit(f.left, SCREEN.w - rightWidth(f.right) - 2 * PAD - 8),
    right: fit(f.right, 290),
    body: f.body.slice(0, BODY_BOXES).map((b) => ({ ...b, text: clampBytes(b.text) })),
  };
}

function layoutRaw(s: State): LensFrame {
  if (s.banner) return bannerFrame(s);
  const sc = top(s);
  const status = connRight(s);

  if (s.conn === 'unconfigured') {
    return message('Aristo', 'setup', 'Open Aristo Lens on your phone and enter the gateway address and token.');
  }

  if (sc.kind === 'home') {
    if (!s.home)
      return message(
        'Aristo',
        status ?? 'loading…',
        s.conn === 'online' ? 'Loading views…' : 'Reaching Aristo on Chiba…',
      );
    const inbox = s.home[0];
    const right = status ?? (inbox?.needs ? `${inbox.needs} need you` : 'all clear');
    const list = items(s);
    const cur = cursorIndex(s);
    const body = listBoxes(list, cur, LIST_ROWS, (it, on) => {
      const v = (it as Extract<Item, { kind: 'view' }>).view;
      const glyph = v.needs ? MARK.needs : v.working ? MARK.working : MARK['your-turn'];
      const bright: Bright = on ? B.cursor : v.needs ? B.needs : B.normal;
      return { text: row(on, `${glyph} ${v.name}`, counts(v.needs, v.working, v.total)), bright, lines: 1 };
    });
    return {
      left: 'Aristo',
      right,
      leftBright: B.body,
      rightBright: inbox?.needs && !status ? B.needs : B.normal,
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
    return { left: v.name, right, leftBright: B.body, rightBright: v.needs && !status ? B.needs : B.normal, body };
  }

  if (sc.kind === 'session') {
    const t = threadFor(s, sc.key);
    if (!t) return message(sc.title, status ?? 'loading…', 'Loading…');
    const ask = liveAsk(s, sc.key);
    const list = items(s);
    const cur = cursorIndex(s);
    if (ask) {
      const heading = (ask.asker ? `${ask.asker} ` : '') + ask.ask + (ask.more ? ` (+${ask.more} more in Aristo)` : '');
      const optRows = Math.min(OPTION_ROWS, list.length);
      // 250 px of body: heading + 3 detail lines + 4 options would overflow by a few pixels.
      const detailLines = optRows >= OPTION_ROWS ? 2 : 3;
      const body: Box[] = [
        { text: fit(heading, TEXT_W), bright: B.normal, lines: 1 },
        { text: block(ask.detail || ask.context || '', detailLines).join('\n'), bright: B.cursor, lines: detailLines },
        ...listBoxes(list, cur, optRows, (it, on) => ({
          text: row(on, optionLabel(s, sc.key, it)),
          bright: on ? B.cursor : B.normal,
          lines: 1,
        })),
      ];
      // Several questions at once (`more`), or nothing the lens can offer: Aristo answers it, not the lens.
      if (!list.length) body.push({ text: fit('Answer this one in Aristo.', TEXT_W), bright: B.normal, lines: 1 });
      return { left: t.row.title, right: status ?? ask.kind, leftBright: B.body, rightBright: B.needs, body };
    }
    const last = [...t.lines].reverse().find((l) => l.who === 'agent') ?? t.lines[t.lines.length - 1];
    const right = status ?? [t.row.status, t.row.age].filter(Boolean).join(', ');
    const body: Box[] = [
      { text: block(last?.text ?? 'No messages yet.', 3).join('\n'), bright: B.body, lines: 3 },
      { text: fit(t.row.detail || ' ', TEXT_W), bright: B.dim, lines: 1 },
      ...listBoxes(list, cur, 3, (it, on) => ({
        text: row(on, actionLabel(it)),
        bright: on ? B.cursor : B.normal,
        lines: 1,
      })),
    ];
    return { left: t.row.title, right, leftBright: B.body, rightBright: B.normal, body };
  }

  return dictationFrame(s, sc, status);
}

function optionLabel(s: State, key: string, it: Item): string {
  const ask = liveAsk(s, key);
  if (it.kind === 'voice') return ask?.kind === 'permission' ? 'Deny and say why…' : 'Say something else…';
  if (it.kind === 'option' && ask) return ask.options[it.index]?.label ?? '';
  return '';
}

function actionLabel(it: Item): string {
  if (it.kind === 'talk') return 'Talk to it';
  if (it.kind === 'done') return 'Mark done';
  if (it.kind === 'close') return 'Set aside';
  return '';
}

const PHASE_RIGHT: Record<Dictation['phase'], string> = {
  listening: 'listening…',
  transcribing: 'transcribing…',
  confirm: 'confirm',
  empty: 'heard nothing',
  sending: 'sending…',
  failed: 'failed',
};

function dictationFrame(s: State, d: Dictation, status: string | null): LensFrame {
  const target = sendTarget(s, d);
  const what =
    target.kind === 'answer' ? (target.ask.kind === 'permission' ? 'Deny, with this note:' : 'Answer:') : 'Message:';
  const text =
    d.phase === 'listening'
      ? 'Speak now.'
      : d.phase === 'transcribing'
        ? '…'
        : d.phase === 'empty'
          ? 'Nothing was heard.'
          : d.phase === 'failed'
            ? `Could not finish: ${d.error ?? 'unknown error'}`
            : d.text;
  const list = items(s);
  const cur = cursorIndex(s);
  const body: Box[] = [
    { text: fit(what, TEXT_W), bright: B.normal, lines: 1 },
    { text: block(text, 3).join('\n'), bright: B.cursor, lines: 3 },
    ...list.map((it, i) => ({
      text: row(i === cur, dictLabel(it)),
      bright: (i === cur ? B.cursor : B.normal) as Bright,
      lines: 1,
    })),
  ];
  return {
    left: d.title,
    right: status && s.notice ? status : PHASE_RIGHT[d.phase],
    leftBright: B.body,
    rightBright: d.phase === 'listening' ? B.cursor : B.normal,
    body,
  };
}

function dictLabel(it: Item): string {
  if (it.kind === 'send') return 'Send';
  if (it.kind === 'redo') return 'Redo';
  if (it.kind === 'cancel') return 'Cancel';
  return '';
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
