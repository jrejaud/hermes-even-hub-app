import { getTextWidth } from '@evenrealities/pretext';
import { describe, expect, it } from 'vitest';
import {
  CONVO_W,
  YOU_W,
  conversationLines,
  convoWindow,
  glide,
  lensMarkdown,
  scrollAnchor,
  SCROLL_STEP,
} from '../src/lens/conversation';

// Jordan, 2026-11-13: an agent's status report read on the lens lost every line break and indent
// ("the new lines and the spaces … need to be respected"); the old code collapsed all whitespace.
const report = [
  '## 📋 QUEUED',
  '',
  '**Corrlinks fix (SC-4512)**',
  '',
  'needs: a coding session.',
  '',
  '',
  '## 🏁 1 of 2 goals finished',
  '',
  '⚪ **Lens v2**: hold to talk',
  '   🟢 app, tests',
  '   ⚪ merge',
].join('\n');

describe('conversation keeps the shape of a message', () => {
  it('keeps line breaks, single blank lines and indents', () => {
    const rows = conversationLines([{ who: 'agent', text: report } as never]);
    expect(rows).toEqual([
      '━━ QUEUED ━━',
      '',
      '▶ Corrlinks fix (SC-4512)',
      '',
      'needs: a coding session.',
      '',
      '━━ 1 OF 2 GOALS FINISHED ━━',
      '',
      '○ Lens v2: hold to talk',
      '   ● app, tests',
      '   ○ merge',
    ]);
  });

  it('frames a heading, marks an all-bold title line, strips inline markers', () => {
    expect(lensMarkdown('### ✅ Done')).toBe('━━ DONE ━━');
    expect(lensMarkdown('**Ads paused (DroneID)**')).toBe('▶ Ads paused (DroneID)');
    expect(lensMarkdown('**a** and **b**')).toBe('a and b');
    expect(lensMarkdown('use `npm test` and **bold** and __this__')).toBe('use npm test and bold and this');
    expect(lensMarkdown('> quoted')).toBe('quoted');
    expect(lensMarkdown('  - item')).toBe('  - item');
  });

  it('keeps the indent on wrapped continuation rows', () => {
    const long = '   ' + 'word '.repeat(60).trim();
    const rows = conversationLines([{ who: 'agent', text: long } as never]);
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(r.startsWith('   ')).toBe(true);
  });

  it('drops code fences but keeps the code lines', () => {
    const rows = conversationLines([{ who: 'agent', text: 'run:\n```text\nnpm test\n```' } as never]);
    expect(rows).toEqual(['run:', 'npm test']);
  });

  // Jordan, 2026-11-13: "put their messages on the left and put mine on the right", no "you" marker, and no
  // blank line between their messages and mine.
  it('the agent is flush left, you are flush right, with no marker and no blank line between turns', () => {
    const rows = conversationLines([
      { who: 'agent', text: 'hi' },
      { who: 'you', text: 'line one\nline two' },
    ] as never);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe('hi');
    for (const r of rows.slice(1)) {
      expect(r).toMatch(/^ {10,}line (one|two)$/);
      expect(r).not.toContain('›');
      const w = getTextWidth(r);
      expect(w).toBeLessThanOrEqual(CONVO_W);
      expect(w).toBeGreaterThan(CONVO_W - getTextWidth(' '));
    }
  });

  it('a long message of yours wraps narrower than the agent message, every row ending at the right edge', () => {
    const long = 'please check whether the nightly billing job double counts refunds and tell me what you find';
    const you = conversationLines([{ who: 'you', text: long }] as never);
    const agent = conversationLines([{ who: 'agent', text: long }] as never);
    expect(you.length).toBeGreaterThan(agent.length);
    for (const r of you) expect(getTextWidth(r)).toBeGreaterThan(CONVO_W - getTextWidth(' '));
    expect(Math.max(...you.map((r) => getTextWidth(r.trimStart())))).toBeLessThanOrEqual(YOU_W);
  });
});

// Jordan, 2026-11-13: "any tool calls should by default be hidden" on the glasses.
describe('tool calls stay off the lens', () => {
  it('drops tool lines entirely, and the turn spacing ignores them', () => {
    const rows = conversationLines([
      { who: 'you', text: 'pause the ads' },
      { who: 'tool', text: 'google-ads set-campaign-status DroneID PAUSED' },
      { who: 'agent', text: 'Paused.' },
    ] as never);
    expect(rows.map((r) => r.trim())).toEqual(['pause the ads', 'Paused.']);
  });

  it('a thread of only tool calls reads as empty', () => {
    expect(conversationLines([{ who: 'tool', text: 'Bash: ls' }] as never)).toEqual(['No messages yet.']);
  });
});

// Jordan, 2026-11-13: "instead of changing the entire page at once, the scrolling should be smooth".
describe('scrolling moves a few lines, not a page', () => {
  const all = Array.from({ length: 30 }, (_, i) => `line ${i}`);

  it('one swipe up moves SCROLL_STEP lines and keeps the rest of the screen', () => {
    expect(SCROLL_STEP).toBeLessThan(7);
    const up = scrollAnchor(all, null, 'up');
    expect(up).toBe(23 - SCROLL_STEP);
    const before = convoWindow(all, null).lines;
    const after = convoWindow(all, up).lines;
    // Lines still on screen after the swipe: everything but the step.
    expect(after.filter((l) => before.includes(l))).toHaveLength(7 - SCROLL_STEP);
  });

  it('swiping down from near the bottom goes back to following the newest', () => {
    expect(scrollAnchor(all, 21, 'down')).toBeNull();
    expect(scrollAnchor(all, 10, 'down')).toBe(13);
  });

  it('glide lists the in-between top lines one apart, both directions, ends excluded', () => {
    expect(glide(all, null, 20)).toEqual([22, 21]);
    expect(glide(all, 20, null)).toEqual([21, 22]);
    expect(glide(all, 5, 5)).toEqual([]);
    expect(glide(all, 0, 1)).toEqual([]);
  });
});
