/**
 * A session's conversation as lens lines, and paging through it (Aristo Lens v2, SC-9703).
 *
 * Shared by the state machine (which pages) and the layout (which draws), so both agree on how many lines
 * there are. Your messages start `›`, the agent's replies are plain; a blank line separates turns. Tool calls
 * are not shown at all (Jordan, 2026-11-13: "any tool calls should by default be hidden" on the glasses).
 * Scrolling counts from the NEWEST end: `anchor === null` means "follow the bottom" (new replies show up
 * as they arrive); a number pins the top line while you read back.
 */
import type { GlassesLine } from '../gateway/glasses';
import { getTextWidth } from '@evenrealities/pretext';
import { wrapTextLines } from './wrap';

/** Text width of the conversation box (full width minus padding and a little slack, as in layout.ts). */
export const CONVO_W = 576 - 4 - 12;
/** Lines the conversation box shows at once. */
export const CONVO_LINES = 7;
/**
 * Lines one swipe moves. Less than a page, so most of what you were reading stays on screen and slides
 * instead of the whole page being swapped (Jordan, 2026-11-13: "instead of changing the entire page at once,
 * the scrolling should be smooth").
 */
export const SCROLL_STEP = 3;

const prefix = (l: GlassesLine): string => (l.who === 'you' ? '› ' : '');

/** Frames a heading on both sides; ━ is in the firmware font. */
export const HEADING_RULE = '━━';
/** Opens a line that was all bold. */
export const TITLE_MARK = '▶';

const PICTO = /[\p{Extended_Pictographic}️‍]/gu;

/**
 * One source line of markdown as the lens can show it. The lens has one font, one weight and one brightness
 * per container, so there is no bold. Jordan picked glyph frames (2026-11-13): a heading is `━━ TITLE ━━`
 * (uppercase, its emoji dropped: the firmware cannot draw them), a line that is ALL bold (a report item's
 * title) opens with ▶, and inline `**bold**`, `__bold__` and `code` lose their markers. Leading spaces stay.
 */
export function lensMarkdown(src: string): string {
  // The report's status circles have firmware twins; other emoji vanish on the lens anyway.
  const line = src.replace(/🟢/g, '●').replace(/⚪/g, '○');
  const lead = /^[ \t]*/.exec(line)![0];
  const indent = lead.replace(/\t/g, '   ');
  let body = line.slice(lead.length).trimEnd();
  const heading = /^#{1,6}\s+(.*)$/.exec(body);
  if (heading) {
    const title = heading[1]
      .replace(PICTO, '')
      .replace(/\*\*|__|`/g, '')
      .trim()
      .toUpperCase();
    return title ? `${HEADING_RULE} ${title} ${HEADING_RULE}` : '';
  }
  const allBold = /^(?:\*\*|__)(.+?)(?:\*\*|__)$/.exec(body);
  if (allBold && !/\*\*|__/.test(allBold[1])) body = `${TITLE_MARK} ${allBold[1]}`;
  body = body
    .replace(/^>\s?/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
  return body ? indent + body : '';
}

/** A message's text as lens rows: its own line breaks, indents and (single) blank lines kept, then wrapped. */
function messageRows(text: string, lead: string): string[] {
  const src = text.replace(/\r\n?/g, '\n').split('\n');
  const rows: string[] = [];
  let fenced = false;
  for (const raw of src) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    const line = fenced ? raw.trimEnd() : lensMarkdown(raw);
    if (!line.trim()) {
      if (rows.length && rows[rows.length - 1] !== '') rows.push('');
      continue;
    }
    rows.push(line);
  }
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  const out: string[] = [];
  rows.forEach((row, i) => {
    if (row === '') return void out.push('');
    // An indented line wraps inside its indent (a hanging indent), so nesting still reads after a wrap.
    const indent = /^ */.exec(row)![0];
    const first = i === 0 ? lead : '';
    const width = CONVO_W - spaceWidth(indent) - spaceWidth(first);
    wrapTextLines(row.trimStart(), width).forEach((w, j) => out.push((j === 0 ? first : '') + indent + w));
  });
  return out;
}

const spaceWidth = (s: string): number => (s ? getTextWidth(s) : 0);

export function conversationLines(lines: GlassesLine[]): string[] {
  const out: string[] = [];
  lines.forEach((l) => {
    if (l.who === 'tool') return;
    const rows = messageRows(l.text, prefix(l));
    if (!rows.length) return;
    // A blank line before each of your messages: it marks the start of a turn.
    if (l.who === 'you' && out.length) out.push('');
    out.push(...rows);
  });
  return out.length ? out : ['No messages yet.'];
}

export interface ConvoWindow {
  lines: string[];
  /** 1-based page number counted from the top, and the page count. */
  page: number;
  pages: number;
  /** The anchor after clamping (null = following the newest). */
  anchor: number | null;
}

/** The slice on screen for a given anchor. */
export function convoWindow(all: string[], anchor: number | null, size = CONVO_LINES): ConvoWindow {
  const pages = Math.max(1, Math.ceil(all.length / size));
  const lastTop = Math.max(0, all.length - size);
  const top = anchor === null ? lastTop : Math.max(0, Math.min(anchor, lastTop));
  const following = anchor === null || top >= lastTop;
  const page = following ? pages : Math.min(pages, Math.floor(top / size) + 1);
  return { lines: all.slice(top, top + size), page, pages, anchor: following ? null : top };
}

/** Scroll one step (SCROLL_STEP lines): up = older, down = newer (back to following the bottom at the end). */
export function scrollAnchor(
  all: string[],
  anchor: number | null,
  dir: 'up' | 'down',
  size = CONVO_LINES,
  step = SCROLL_STEP,
): number | null {
  const lastTop = Math.max(0, all.length - size);
  const top = anchor === null ? lastTop : Math.min(anchor, lastTop);
  if (dir === 'up') return Math.max(0, top - step);
  const next = top + step;
  return next >= lastTop ? null : next;
}

/** The top line an anchor puts on screen (null = following the newest). */
export function topLine(all: string[], anchor: number | null, size = CONVO_LINES): number {
  const lastTop = Math.max(0, all.length - size);
  return anchor === null ? lastTop : Math.max(0, Math.min(anchor, lastTop));
}

/**
 * The top lines to show between two scroll positions, one line apart, excluding both ends. Painting them in
 * turn makes a swipe slide the text a line at a time rather than jump: each in-between frame is a flicker-free
 * textContainerUpgrade of the one conversation box.
 */
export function glide(all: string[], from: number | null, to: number | null, size = CONVO_LINES): number[] {
  const a = topLine(all, from, size);
  const b = topLine(all, to, size);
  const dir = Math.sign(b - a);
  const out: number[] = [];
  for (let t = a + dir; dir !== 0 && t !== b; t += dir) out.push(t);
  return out;
}
