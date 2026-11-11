import { getAdvW, getTextWidth } from '@evenrealities/pretext';
import { describe, expect, it } from 'vitest';
import { LENS_FRAMES } from '../src/dev/lens-gallery';
import { slots } from '../src/lens/draw';
import { BODY_BOXES, BOX_BYTES, LINE, SCREEN, TEXT_W, block, fit, layout, row } from '../src/lens/layout';

const bytes = (t: string): number => new TextEncoder().encode(t).length;
/** Firmware font has no emoji; anything astral is dropped on the lens. */
const EMOJI = /[\u{1F000}-\u{1FFFF}☀-⛿✀-➿]/u;

describe('every gallery frame fits the lens', () => {
  for (const f of LENS_FRAMES) {
    it(f.name, () => {
      const frame = layout(f.state);
      expect(frame.body.length).toBeLessThanOrEqual(BODY_BOXES);
      const all = slots(frame);
      expect(all.length).toBeLessThanOrEqual(8);
      expect(all.filter((s) => s.capture)).toHaveLength(1);
      for (const s of all) {
        expect(s.y + s.h, `${s.name} below the screen`).toBeLessThanOrEqual(SCREEN.h);
        expect(s.x + s.w).toBeLessThanOrEqual(SCREEN.w);
        expect(bytes(s.text), `${s.name} over the byte budget`).toBeLessThanOrEqual(BOX_BYTES);
        const missing = [...s.text].filter((ch) => ch !== '\n' && getAdvW(ch.codePointAt(0)!) === 0);
        expect(missing, `${s.name} draws glyphs the firmware lacks`).toEqual([]);
        const lines = s.text.split('\n');
        expect(lines.length * LINE, `${s.name} has more lines than its box`).toBeLessThanOrEqual(s.h);
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
