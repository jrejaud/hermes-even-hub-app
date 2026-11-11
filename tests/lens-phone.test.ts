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
