// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { renderPhone } from '../src/lens/phone';

describe('phone page', () => {
  it('a status change does not rebuild the form: what is being typed survives (SC-9500, token saved as 44 of 64 chars)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const noop = () => {};
    renderPhone(root, { profile: null, conn: 'connecting', errors: [] }, noop);
    const token = root.querySelector<HTMLInputElement>('#lens-token')!;
    token.focus();
    token.value = 'half-typed-token';
    renderPhone(root, { profile: null, conn: 'reconnecting', errors: [] }, noop);
    renderPhone(root, { profile: null, conn: 'connecting', errors: ['Token is required.'] }, noop);
    expect(root.querySelector('#lens-token')).toBe(token);
    expect(token.value).toBe('half-typed-token');
    expect(document.activeElement).toBe(token);
    expect(root.querySelector('.setup-status')!.textContent).toBe('Connecting');
    expect(root.querySelector('.setup-errors li')!.textContent).toBe('Token is required.');
  });
});

describe('lens drawer in a plain browser (no Even host)', () => {
  it('says once that nothing reaches the glasses, as a warning, never as console errors', async () => {
    const { Lens } = await import('../src/lens/draw');
    const { layout } = await import('../src/lens/layout');
    const { initialState } = await import('../src/lens/state');
    const errors: unknown[] = [];
    const warns: unknown[] = [];
    const origErr = console.error;
    const origWarn = console.warn;
    console.error = (...a: unknown[]) => errors.push(a);
    console.warn = (...a: unknown[]) => warns.push(a);
    try {
      const bridge = {
        createStartUpPageContainer: async () => 1,
        rebuildPageContainer: async () => false,
        textContainerUpgrade: async () => false,
      };
      const lens = new Lens(bridge as never);
      await lens.draw(layout(initialState('connecting')));
      await lens.draw(layout(initialState('reconnecting')));
    } finally {
      console.error = origErr;
      console.warn = origWarn;
    }
    expect(errors).toEqual([]);
    expect(warns).toHaveLength(1);
  });
});
