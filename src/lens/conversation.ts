/**
 * A session's conversation as lens lines, and paging through it (Aristo Lens v2, SC-9703).
 *
 * Shared by the state machine (which pages) and the layout (which draws), so both agree on how many lines
 * there are. Your messages start `›`, tool calls `–`, the agent's replies are plain; a blank line separates
 * turns. Paging counts from the NEWEST end: `anchor === null` means "follow the bottom" (new replies show up
 * as they arrive); a number pins the top line while you read back.
 */
import type { GlassesLine } from '../gateway/glasses';
import { getTextWidth } from '@evenrealities/pretext';
import { wrapTextLines } from './wrap';

/** Text width of the conversation box (full width minus padding and a little slack, as in layout.ts). */
export const CONVO_W = 576 - 4 - 12;
/** Lines the conversation box shows at once. */
export const CONVO_LINES = 7;

const prefix = (l: GlassesLine): string => (l.who === 'you' ? '› ' : l.who === 'tool' ? '– ' : '');

const PICTO = /[\p{Extended_Pictographic}️‍]/gu;

/**
 * One source line of markdown as the lens can show it. The lens has one font, one weight and one brightness
 * per container, so there is no bold: a heading is simulated as UPPERCASE (its emoji dropped, the firmware
 * cannot draw them), and inline `**bold**`, `__bold__` and `code` lose their markers. Leading spaces stay.
 */
export function lensMarkdown(src: string): string {
  // The report's status circles have firmware twins; other emoji vanish on the lens anyway.
  const line = src.replace(/🟢/g, '●').replace(/⚪/g, '○');
  const lead = /^[ \t]*/.exec(line)![0];
  const indent = lead.replace(/\t/g, '   ');
  let body = line.slice(lead.length).trimEnd();
  const heading = /^#{1,6}\s+(.*)$/.exec(body);
  if (heading)
    return heading[1]
      .replace(PICTO, '')
      .replace(/\*\*|__|`/g, '')
      .trim()
      .toUpperCase();
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
  lines.forEach((l, i) => {
    const rows = messageRows(l.text, prefix(l));
    if (!rows.length) return;
    // A blank line before each of your messages: it marks the start of a turn.
    if (i > 0 && l.who === 'you' && out.length) out.push('');
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

/** Scroll one page: up = older, down = newer (back to following the bottom at the end). */
export function scrollAnchor(
  all: string[],
  anchor: number | null,
  dir: 'up' | 'down',
  size = CONVO_LINES,
): number | null {
  const lastTop = Math.max(0, all.length - size);
  const top = anchor === null ? lastTop : Math.min(anchor, lastTop);
  if (dir === 'up') return Math.max(0, top - size);
  const next = top + size;
  return next >= lastTop ? null : next;
}
