import { getAdvW, getTextWidth } from '@evenrealities/pretext';
import { describe, expect, it } from 'vitest';
import { GALLERY_NOW, LENS_FRAMES } from '../src/dev/lens-gallery';
import { slots } from '../src/lens/draw';
import {
  BODY_BOXES,
  BOX_BYTES,
  LINE,
  SCREEN,
  TEXT_W,
  block,
  drawable,
  fit,
  layout,
  row,
  windowStart,
} from '../src/lens/layout';

const bytes = (t: string): number => new TextEncoder().encode(t).length;
/** Firmware font has no emoji; anything astral is dropped on the lens. */
const EMOJI = /[\u{1F000}-\u{1FFFF}☀-⛿✀-➿]/u;

describe('every gallery frame fits the lens', () => {
  for (const f of LENS_FRAMES) {
    it(f.name, () => {
      const frame = layout(f.state, GALLERY_NOW);
      expect(frame.body.length).toBeLessThanOrEqual(BODY_BOXES);
      const all = slots(frame);
      expect(all.length).toBeLessThanOrEqual(8);
      expect(all.filter((s) => s.capture)).toHaveLength(1);
      // Swipes go to an EMPTY box: the firmware nudges the box that takes a swipe, and the title bounced when it was
      // the header (Jordan, 2026-11-14). The header is one box, the title left and the status right.
      expect(all.find((s) => s.capture)!.text).toBe('');
      expect(all.filter((s) => s.y === 0)).toHaveLength(1);
      for (const s of all) {
        expect(s.y + s.h, `${s.name} below the screen`).toBeLessThanOrEqual(SCREEN.h);
        expect(s.x + s.w).toBeLessThanOrEqual(SCREEN.w);
        expect(bytes(s.text), `${s.name} over the byte budget`).toBeLessThanOrEqual(BOX_BYTES);
        const missing = [...s.text].filter((ch) => ch !== '\n' && getAdvW(ch.codePointAt(0)!) === 0);
        expect(missing, `${s.name} draws glyphs the firmware lacks`).toEqual([]);
        const lines = s.text.split('\n');
        // The empty input strip draws nothing; only boxes with text must hold their lines.
        if (s.text) expect(lines.length * LINE, `${s.name} has more lines than its box`).toBeLessThanOrEqual(s.h);
        for (const l of lines)
          expect(getTextWidth(l), `${s.name}: "${l}" wider than its box`).toBeLessThanOrEqual(s.w - 4);
      }
      // No two containers overlap.
      for (const a of all)
        for (const b of all) {
          if (a === b) continue;
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap, `${a.name} overlaps ${b.name}`).toBe(false);
        }
    });
  }
});

describe('text fitting', () => {
  it('cuts with an ellipsis and keeps the detail when room allows', () => {
    const r = row(false, 'A very long session title that keeps going and going and going', 'the detail');
    expect(getTextWidth(r)).toBeLessThanOrEqual(TEXT_W);
    expect(r).toContain('…');
    expect(r).toContain(' - the detail');
  });

  it('never splits a multi-byte character', () => {
    const out = fit('日本語のメールを翻訳して返信を下書きする'.repeat(4), 200);
    expect(out.endsWith('…')).toBe(true);
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(out))).not.toThrow();
  });

  it('a block ends with … when text was left out', () => {
    const lines = block('word '.repeat(200), 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('…')).toBe(true);
  });

  it('emoji in titles are visible in the source data, so the gallery covers them', () => {
    expect(LENS_FRAMES.some((f) => EMOJI.test(JSON.stringify(f.state.view ?? {})))).toBe(true);
  });
});

describe('glasses gate critic finds (2026-11-11)', () => {
  it('emoji with a font advance (✅) are still dropped; the app own glyphs survive', () => {
    expect(drawable('🚀 Launch checklist ✅ with emoji')).toBe(' Launch checklist with emoji');
    expect(drawable('▶ ● ▷ ○ □ ▲ ▽ … done')).toBe('▶ ● ▷ ○ □ ▲ ▽ … done');
    expect(drawable('Ship it ❤️ now')).toBe('Ship it now');
  });

  it('a subagent row is indented (the indent survives whitespace cleanup)', () => {
    const top = row(false, '▷ Parent', '', {});
    const child = row(false, '▷ Child', '', { depth: 1 });
    expect(getTextWidth(child.slice(0, child.indexOf('▷')))).toBeGreaterThan(
      getTextWidth(top.slice(0, top.indexOf('▷'))),
    );
  });

  it('the age is kept when a long detail is cut', () => {
    const r = row(false, '● Deploy fix', 'Bash: ssh chiba systemctl --user restart aristod and then some more words', {
      tail: '2m',
    });
    expect(r.endsWith(', 2m')).toBe(true);
    expect(getTextWidth(r)).toBeLessThanOrEqual(TEXT_W);
  });
});

describe('brightness hierarchy (rule 3), with the widest steps the scale allows', () => {
  const frame = (name: string) => layout(LENS_FRAMES.find((f) => f.name === name)!.state, GALLERY_NOW);
  it('home: cursor row 4, need-you rows 3, quiet rows 1', () => {
    const b = frame('03-home').body;
    expect(b[0].bright).toBe(4);
    expect(b.find((x) => x.text.includes('Foreground'))!.bright).toBe(3);
    expect(b.find((x) => x.text.includes('From glasses'))!.bright).toBe(1);
  });
  it('a question: the asked text 4 (no heading that only repeats "question"), a heading when there is one is 1', () => {
    const b = frame('11-question').body;
    expect(b[0].bright).toBe(4);
    expect(b[0].text).toContain('Which do I pause');
    const sub = frame('13-question-subagent-more').body;
    expect(sub[0]).toMatchObject({ bright: 1 });
    expect(sub[0].text).toMatch(/^Explore asks:/);
    expect(sub[1].bright).toBe(4);
  });
  it('a working session: the message 4, the activity line 1', () => {
    const b = frame('14-working-session').body;
    expect(b[0].bright).toBe(4);
    expect(b[1].bright).toBe(1);
  });
});

describe('session rows: marker, title, age (Jordan, 2026-11-13)', () => {
  it('a view row carries no detail ("Bash: …" command) and ends with its age at the right edge', () => {
    const f = LENS_FRAMES.find((x) => x.name === '06-view-inbox')!;
    const rows = layout(f.state, GALLERY_NOW).body.map((b) => b.text);
    expect(rows.some((r) => /ssh chiba|Which do I pause/.test(r))).toBe(false);
    for (const r of rows.filter((x) => /\d+[smhd]( ▽)?$/.test(x))) {
      expect(r).not.toMatch(/ - \d+[smhd]/);
      expect(getTextWidth(r)).toBeGreaterThan(TEXT_W - 40);
      expect(getTextWidth(r)).toBeLessThanOrEqual(TEXT_W);
    }
  });

  it('a short row is padded out to the edge, a long title is cut and the age survives', () => {
    const short = row(false, '! Fix it', '', { tail: '2m' });
    expect(short).toMatch(/^.*! Fix it {3,}2m$/);
    const long = row(false, '! ' + 'very long title '.repeat(10), '', { tail: '14m' });
    expect(long.endsWith('14m')).toBe(true);
    expect(long).toContain('…');
    expect(getTextWidth(long)).toBeLessThanOrEqual(TEXT_W);
  });
});

// Design rule 11 (Jordan, 2026-11-13): lists page; the cursor is never pinned mid-screen while rows slide under it.
describe('list paging', () => {
  it('the cursor walks to the last row of a page, then the next page flips in with it on the top row', () => {
    expect([0, 1, 5].map((c) => windowStart(c, 14, 6))).toEqual([0, 0, 0]);
    expect([6, 11].map((c) => windowStart(c, 14, 6))).toEqual([6, 6]);
    expect(windowStart(12, 14, 6)).toBe(12); // a short last page, not a window backed up to fill it
    expect(windowStart(3, 5, 6)).toBe(0);
    expect(windowStart(99, 14, 6)).toBe(12);
  });
});
