import { describe, expect, it } from 'vitest';
import { conversationLines, lensMarkdown } from '../src/lens/conversation';

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
      'QUEUED',
      '',
      'Corrlinks fix (SC-4512)',
      '',
      'needs: a coding session.',
      '',
      '1 OF 2 GOALS FINISHED',
      '',
      '○ Lens v2: hold to talk',
      '   ● app, tests',
      '   ○ merge',
    ]);
  });

  it('simulates a heading as uppercase and strips inline markers', () => {
    expect(lensMarkdown('### ✅ Done')).toBe('DONE');
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

  it('still prefixes your messages and puts a blank line before each turn', () => {
    const rows = conversationLines([
      { who: 'agent', text: 'hi' },
      { who: 'you', text: 'line one\nline two' },
    ] as never);
    expect(rows).toEqual(['hi', '', '› line one', 'line two']);
  });
});
