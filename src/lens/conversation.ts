/**
 * A session's conversation as lens lines, and paging through it (Aristo Lens v2, SC-9703).
 *
 * Shared by the state machine (which pages) and the layout (which draws), so both agree on how many lines
 * there are. Your messages start `›`, tool calls `–`, the agent's replies are plain; a blank line separates
 * turns. Paging counts from the NEWEST end: `anchor === null` means "follow the bottom" (new replies show up
 * as they arrive); a number pins the top line while you read back.
 */
import type { GlassesLine } from '../gateway/glasses';
import { wrapTextLines } from './wrap';

/** Text width of the conversation box (full width minus padding and a little slack, as in layout.ts). */
export const CONVO_W = 576 - 4 - 12;
/** Lines the conversation box shows at once. */
export const CONVO_LINES = 7;

const prefix = (l: GlassesLine): string => (l.who === 'you' ? '› ' : l.who === 'tool' ? '– ' : '');

export function conversationLines(lines: GlassesLine[]): string[] {
  const out: string[] = [];
  lines.forEach((l, i) => {
    const text = l.text.replace(/\s+/g, ' ').trim();
    if (!text) return;
    // A blank line before each of your messages: it marks the start of a turn.
    if (i > 0 && l.who === 'you' && out.length) out.push('');
    for (const w of wrapTextLines(prefix(l) + text, CONVO_W)) out.push(w);
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
