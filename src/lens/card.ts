/**
 * The corner state icon and show-me cards (SC-11683).
 *
 * Corner: a 30x32 image container at the top-right of EVERY page, so a state change only pushes pixels (no page
 * rebuild). It shows what the open session is doing: you talking (a hold is open), thinking (the agent is
 * working), a question waiting, or nothing. `agent` (agent talking) and `ring` (incoming) come with voice mode.
 *
 * Card: an agent's visual (a big number with a sparkline, a list, a table) drawn over the open screen. Layout only;
 * pixels for the big value and the sparkline are rasterised by draw.ts.
 */
import { getTextWidth } from '@evenrealities/pretext';
import type { GlassesCard } from '../gateway/glasses';
import { liveAsk, micLive, threadFor, top, type ShownCard, type State } from './state';

export type Corner = 'none' | 'you' | 'thinking' | 'agent' | 'ask' | 'ring';

/** Pixel art, one string per row, '#' = lit. Drawn at 2x. Same bitmaps as the mockups (aristo-v2 docs/hackathon). */
export const ICONS: Record<Exclude<Corner, 'none'>, string[]> = {
  you: [
    '...#####...',
    '.#########.',
    '.#########.',
    '###########',
    '###########',
    '###########',
    '###########',
    '###########',
    '.#########.',
    '.#########.',
    '...#####...',
  ],
  thinking: ['##...##...##', '##...##...##'],
  agent: [
    '......#......',
    '.....###.....',
    '.###########.',
    '.#.........#.',
    '##..##.##..##',
    '##..##.##..##',
    '.#.........#.',
    '.#..#####..#.',
    '.#.........#.',
    '.###########.',
  ],
  ask: [
    '...#######...',
    '..##.....##..',
    '.##.......##.',
    '##....###..##',
    '##...#...#.##',
    '##.......#.##',
    '##......#..##',
    '##.....#...##',
    '##.........##',
    '##.....#...##',
    '.##.......##.',
    '..##.....##..',
    '...#######...',
  ],
  ring: [
    '#...........#',
    '.#....#....#.',
    '#...#####...#',
    '...#######...',
    '.#.#######.#.',
    '#..#######..#',
    '...#######...',
    '..#########..',
    '.###########.',
    '.............',
    '.....###.....',
  ],
};

export const CORNER = { x: 546, y: 0, w: 30, h: 32 } as const;
/** The header box ends here, left of the corner. */
export const HEADER_W = CORNER.x - 2;

/** What the corner shows for the screen that is open. */
export function cornerOf(s: State): Corner {
  const sc = top(s);
  if (micLive(sc)) return 'you';
  if (s.banner) return 'ask';
  if (sc.kind === 'dictate' && sc.phase === 'sending') return 'thinking';
  if (sc.kind === 'session' || sc.kind === 'menu') {
    if (liveAsk(s, sc.key)) return 'ask';
    if (threadFor(s, sc.key)?.row.mark === 'working') return 'thinking';
  }
  return 'none';
}

// ------------------------------------------------------------------------------------------- card layout

export type Raster =
  | { kind: 'bitmap'; rows: string[]; scale: number }
  /** A big value: drawn left-aligned, as tall as the box allows. */
  | { kind: 'text'; text: string }
  | { kind: 'spark'; points: number[] };

export interface ImageBox {
  x: number;
  y: number;
  w: number;
  h: number;
  raster: Raster | null;
}

export interface FreeBox {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  bright: 1 | 2 | 3 | 4;
  border?: { width: number; color: number; radius: number };
}

const CARD = { x: 4, y: 36, w: 568, h: 250 };
const IN_X = 16;
const IN_W = 540;
const LINE = 27;
/** Rows a list or table card shows at once. */
export const CARD_ROWS = 5;

/** Right-align each line in a box of width `w` with measured spaces (the font is proportional). */
function alignRight(lines: string[], w: number): string {
  const sp = Math.max(1, getTextWidth(' '));
  return lines.map((l) => ' '.repeat(Math.max(0, Math.floor((w - 8 - getTextWidth(l)) / sp))) + l).join('\n');
}

/** Cut a line to `w` px with …. */
function cut(t: string, w: number): string {
  if (getTextWidth(t) <= w) return t;
  let s = t;
  while (s && getTextWidth(s + '…') > w) s = s.slice(0, -1);
  return s.trimEnd() + '…';
}

export interface CardLayout {
  free: FreeBox[];
  images: ImageBox[];
}

export function cardLayout(sc: ShownCard): CardLayout {
  const c: GlassesCard = sc.card;
  const free: FreeBox[] = [
    { ...CARD, text: ' ', bright: 2, border: { width: 2, color: 8, radius: 8 } },
    { x: IN_X, y: 42, w: IN_W, h: 32, text: cut(c.title, IN_W - 8), bright: 2 },
  ];
  const images: ImageBox[] = [];
  const b = c.body;
  if (b.kind === 'stat') {
    images.push({ x: IN_X, y: 78, w: 288, h: 72, raster: { kind: 'text', text: b.value } });
    if (b.delta) free.push({ x: 320, y: 96, w: 240, h: 32, text: cut(b.delta, 230), bright: 3 });
    if (b.spark && b.spark.length >= 2) {
      images.push({ x: IN_X, y: 166, w: 288, h: 100, raster: { kind: 'spark', points: b.spark } });
      if (b.sparkLabel) free.push({ x: 320, y: 220, w: 240, h: 32, text: cut(b.sparkLabel, 230), bright: 1 });
    }
    return { free, images };
  }
  const rows = b.kind === 'list' ? b.rows.map((r) => [r]) : b.rows;
  const start = Math.min(sc.offset, Math.max(0, rows.length - CARD_ROWS));
  const shown = rows.slice(start, start + CARD_ROWS);
  const left = rows.length - start - shown.length;
  const more = left > 0 ? `+${left} more` : start > 0 ? `${start + 1}-${start + shown.length} of ${rows.length}` : '';
  if (b.kind === 'list') {
    free.push({
      x: IN_X,
      y: 80,
      w: IN_W,
      h: CARD_ROWS * LINE + 8,
      text: shown.map((r) => cut(r[0], IN_W - 8)).join('\n'),
      bright: 4,
    });
  } else {
    // ≤ 4 columns: the first takes what the others leave, each column its own box so values line up.
    const cols = Math.min(4, b.head.length);
    const rest = cols > 1 ? Math.floor((IN_W - 170) / (cols - 1)) : 0;
    let x = IN_X;
    for (let i = 0; i < cols; i++) {
      const w = i === 0 ? (cols > 1 ? 170 : IN_W) : rest;
      const lines = [b.head[i] ?? '', ...shown.map((r) => r[i] ?? '')].map((t) => cut(t, w - 10));
      const right = (b.align?.[i] ?? 'l') === 'r';
      // The header row is one brightness, the values another: a column box has one colour, so the head is dimmer
      // only in the first (label) column; numbers read by position.
      free.push({
        x,
        y: 80,
        w,
        h: (CARD_ROWS + 1) * LINE + 8,
        text: right ? alignRight(lines, w) : lines.join('\n'),
        bright: i === 0 ? 3 : 4,
      });
      x += w;
    }
  }
  if (more) free.push({ x: IN_X, y: 248, w: IN_W, h: 32, text: more, bright: 1 });
  return { free, images };
}
