// Show-me cards and the corner state icon (SC-11683).
import { describe, expect, it, vi } from 'vitest';
import { HOME, HOME_NEEDS, ROWS, threadFrame, viewFrame } from '../src/dev/fake-gateway';
import type { GlassesCard, GlassesServerFrame } from '../src/gateway/glasses';
import { CORNER, cardLayout, cornerOf } from '../src/lens/card';
import { Lens, geometry, imageSlots, slots } from '../src/lens/draw';
import { layout, shownWhole } from '../src/lens/layout';
import { rasterPixels } from '../src/lens/raster';
import { expire, gesture, initialState, items, receive, type State } from '../src/lens/state';

const T = 1_700_000_000_000;
const feed = (s: State, ...fs: GlassesServerFrame[]): State => fs.reduce((a, f) => receive(a, f, T).state, s);
const press = (s: State, ...gs: ('up' | 'down' | 'tap' | 'double' | 'hold' | 'release')[]): State =>
  gs.reduce((a, g) => gesture(a, g, T).state, s);
const online = (): State =>
  feed(
    initialState('connecting'),
    { t: 'hello', protocol: 1, host: 'chiba', hosts: [] },
    { t: 'home', views: HOME, needs: HOME_NEEDS },
  );
const openRow = (i: number): State => {
  let s = feed(press(online(), 'tap'), viewFrame('inbox'));
  for (let k = 0; k < i; k++) s = press(s, 'down');
  return feed(press(s, 'tap'), threadFrame(ROWS[i].key));
};
const stat: GlassesCard = {
  id: 'c1',
  key: null,
  title: 'Revenue · November',
  ttlMs: 20_000,
  body: { kind: 'stat', value: '$4,210', delta: '+18% vs October', spark: [1, 3, 2, 5], sparkLabel: 'last 30 days' },
};
const list: GlassesCard = {
  id: 'c2',
  key: null,
  title: 'Flights',
  ttlMs: null,
  body: { kind: 'list', rows: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
};

describe('show-me cards', () => {
  it('a card covers the open screen and goes away after its ttl', () => {
    const s = feed(online(), { t: 'card', card: stat });
    expect(layout(s, T).free?.length).toBeGreaterThan(1);
    expect(expire(s, T + 19_999).card).not.toBeNull();
    expect(expire(s, T + 20_000).card).toBeNull();
  });

  it('ttl null stays until dismissed; tap pins, double tap dismisses', () => {
    let s = feed(online(), { t: 'card', card: list });
    expect(expire(s, T + 3_600_000).card).not.toBeNull();
    s = feed(online(), { t: 'card', card: stat });
    s = press(s, 'tap');
    expect(s.card?.pinned).toBe(true);
    expect(layout(s, T).right).toBe('pinned');
    expect(expire(s, T + 60_000).card).not.toBeNull();
    expect(press(s, 'double').card).toBeNull();
  });

  it('swipes scroll a list card and do not move the screen underneath', () => {
    const base = feed(online(), { t: 'card', card: list });
    const s = press(base, 'down', 'down');
    expect(s.card?.offset).toBe(2);
    expect(s.cursor).toEqual(base.cursor);
    const lay = cardLayout(s.card!);
    expect(lay.free.some((b) => b.text.startsWith('c\n'))).toBe(true);
    expect(press(s, 'up', 'up', 'up').card?.offset).toBe(0);
  });

  it('the same id replaces in place and keeps the pin', () => {
    let s = press(feed(online(), { t: 'card', card: stat }), 'tap');
    s = feed(s, { t: 'card', card: { ...stat, title: 'Revenue · updated' } });
    expect(s.card?.pinned).toBe(true);
    expect(s.card?.card.title).toBe('Revenue · updated');
  });

  it('a table keeps at most 4 columns and right-aligns numeric columns', () => {
    const t: GlassesCard = {
      id: 't',
      key: null,
      title: 'Servers',
      ttlMs: null,
      body: {
        kind: 'table',
        head: ['host', 'disk', 'load', 'up', 'extra'],
        rows: [['chiba', '61%', '0.4', '12d', 'x']],
        align: ['l', 'r', 'r', 'r'],
      },
    };
    const lay = cardLayout({ card: t, at: T, pinned: false, offset: 0 });
    const cols = lay.free.slice(2);
    expect(cols).toHaveLength(4);
    expect(cols[1].text.split('\n')[1]).toMatch(/^ +61%$/);
  });

  it('a card page stays within the SDK limits (8 text, 4 image containers incl. the corner)', () => {
    for (const card of [stat, list]) {
      const f = layout(feed(online(), { t: 'card', card }), T);
      expect(slots(f).length).toBeLessThanOrEqual(8);
      expect(imageSlots(f).length).toBeLessThanOrEqual(4);
      for (const im of imageSlots(f)) {
        expect(im.w).toBeLessThanOrEqual(288);
        expect(im.h).toBeLessThanOrEqual(144);
      }
    }
  });
});

describe('corner state icon', () => {
  it('reads the open session: working → thinking, an ask → ?, a hold → you, else nothing', () => {
    expect(cornerOf(online())).toBe('none');
    expect(cornerOf(openRow(3))).toBe('thinking'); // G2 app plan, working
    expect(cornerOf(openRow(0))).toBe('ask'); // kill, needs
    expect(cornerOf(press(openRow(4), 'hold'))).toBe('you');
  });

  it('changing the corner never rebuilds the page: same geometry, only pixels move', async () => {
    const quiet = layout(online(), T);
    const working = layout(openRow(3), T);
    expect(imageSlots(quiet)[0]).toMatchObject({ ...CORNER, raster: null });
    const asking = layout(openRow(0), T);
    expect(geometry({ ...asking, corner: 'none' })).toBe(geometry(asking));

    const sent: { id: number }[] = [];
    const b = {
      createStartUpPageContainer: vi.fn(async () => 0),
      rebuildPageContainer: vi.fn(async () => true),
      textContainerUpgrade: vi.fn(async () => true),
      updateImageRawData: vi.fn(async (u: { containerID: number }) => {
        sent.push({ id: u.containerID });
        return 'success';
      }),
    };
    const lens = new Lens(b as never, async () => [1, 2, 3]);
    await lens.draw(working);
    expect(sent.map((x) => x.id)).toEqual([20]);
    await lens.draw({ ...working, corner: 'ask' });
    expect(b.rebuildPageContainer).not.toHaveBeenCalled();
    expect(sent.map((x) => x.id)).toEqual([20, 20]);
    await lens.draw({ ...working, corner: 'ask' });
    expect(sent).toHaveLength(2); // unchanged → nothing sent
  });

  it('bitmaps are centred in the corner and a sparkline stays inside its box', () => {
    const px = rasterPixels({ kind: 'bitmap', rows: ['#'], scale: 2 }, 30, 32)!;
    expect(px).toEqual([
      [14, 15],
      [14, 16],
      [15, 15],
      [15, 16],
    ]);
    const sp = rasterPixels({ kind: 'spark', points: [5, 1, 9, 3] }, 288, 100)!;
    expect(sp.every(([x, y]) => x >= 0 && y >= 0 && x < 288 && y < 100)).toBe(true);
  });
});

describe('a permission the lens cannot show whole offers only No (SC-11683 review)', () => {
  const askOn = (detail: string): State => {
    const s = openRow(0); // a session with a pending ask
    const t = s.thread!;
    const ask = {
      ...t.ask!,
      kind: 'permission' as const,
      detail,
      options: [
        {
          label: 'Yes',
          title: 'Yes',
          kind: 'yes' as const,
          primary: true,
          answer: { promptId: t.ask!.promptId, option: 1 },
        },
        {
          label: 'No',
          title: 'No',
          kind: 'no' as const,
          primary: false,
          answer: { promptId: t.ask!.promptId, option: 3 },
        },
      ],
    };
    return feed(s, { ...t, ask });
  };
  it('a short command keeps Yes and No', () => {
    expect(shownWhole('npm test')).toBe(true);
    expect(items(askOn('npm test')).map((i) => (i.kind === 'option' ? i.index : -1))).toEqual([0, 1]);
  });
  it('a command cut by the lens (by pixels, wide glyphs included) offers only No, and says why', () => {
    const wide = 'echo ' + 'W'.repeat(120) + ' && rm -rf ~'; // ~130 chars, but well past 2 lines in pixels
    expect(shownWhole(wide)).toBe(false);
    const s = askOn(wide);
    expect(items(s).map((i) => (i.kind === 'option' ? i.index : -1))).toEqual([1]);
    expect(
      layout(s, T)
        .body.map((b) => b.text)
        .join('\n'),
    ).toContain('too long to read here, so only No');
    // a tap on the only row answers No
    const r = gesture(s, 'tap', T);
    expect(r.effects).toContainEqual({
      kind: 'send',
      frame: expect.objectContaining({ t: 'answer', answer: { promptId: s.thread!.ask!.promptId, option: 3 } }),
    });
  });
  it('a glyph the firmware would drop means it is not shown whole', () => {
    expect(shownWhole('rm -rf 🦄 ~')).toBe(false);
  });
});

describe('review fixes (SC-11683)', () => {
  it('a banner wins over a card for drawing, as it does for gestures', () => {
    const s = feed(
      online(),
      { t: 'card', card: stat },
      { t: 'banner', key: 'box/churn', title: 'Churn audit', ask: 'Include trials?', promptId: 'p-churn' },
    );
    expect(layout(s, T).free).toBeUndefined();
    expect(layout(s, T).left).toContain('Churn audit');
    const after = press(s, 'double'); // dismisses the banner, not the card
    expect(after.banner).toBeNull();
    expect(after.card).not.toBeNull();
  });
});
