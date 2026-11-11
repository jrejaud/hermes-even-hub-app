/**
 * What Aristo Lens keeps on the phone (Even app localStorage, the one store that survives an Android WebView
 * being killed): the gateway profile, and where the wearer was (SC-9500).
 *
 * The token is never baked into a build: a `.ehpk` is uploaded to Even's portal, which would put the
 * credential on a third party. It is typed into the phone form once.
 */
import type { GatewayProfile } from '../gateway/client';
import type { Saved, Screen } from './state';

export const KEYS = { profile: 'lens.profile.v1', saved: 'lens.saved.v1' } as const;

export interface Store {
  getLocalStorage(key: string): Promise<string>;
  setLocalStorage(key: string, value: string): Promise<boolean>;
}

export function validateProfile(p: GatewayProfile): string[] {
  const errors: string[] = [];
  if (!p.url.trim()) errors.push('Gateway URL is required.');
  else {
    try {
      const u = new URL(p.url.trim());
      if (!['wss:', 'ws:', 'https:', 'http:'].includes(u.protocol))
        errors.push('Gateway URL must start with wss://, ws://, https:// or http://.');
    } catch {
      errors.push('Gateway URL is not a URL.');
    }
  }
  if (!p.token.trim()) errors.push('Token is required.');
  return errors;
}

export async function loadProfile(store: Store): Promise<GatewayProfile | null> {
  const raw = await store.getLocalStorage(KEYS.profile);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<GatewayProfile>;
    if (typeof v.url === 'string' && typeof v.token === 'string') return { url: v.url, token: v.token };
    console.error('[lens] stored profile has the wrong shape; ignoring it');
  } catch (err) {
    console.error('[lens] stored profile is not JSON; ignoring it', err);
  }
  return null;
}

export async function saveProfile(store: Store, p: GatewayProfile): Promise<void> {
  await store.setLocalStorage(KEYS.profile, JSON.stringify({ url: p.url.trim(), token: p.token.trim() }));
}

function validScreen(x: unknown): x is Screen {
  if (!x || typeof x !== 'object') return false;
  const s = x as Record<string, unknown>;
  if (s.kind === 'home') return true;
  if (s.kind === 'view') return typeof s.viewId === 'string' && typeof s.name === 'string';
  if (s.kind === 'session') return typeof s.key === 'string' && typeof s.title === 'string';
  return false;
}

export function parseSaved(raw: string): Saved | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Saved>;
    if (!Array.isArray(v.stack) || !v.stack.every(validScreen) || typeof v.inboxNeeds !== 'number') return null;
    return { stack: v.stack, inboxNeeds: v.inboxNeeds, at: typeof v.at === 'number' ? v.at : 0 };
  } catch (err) {
    console.error('[lens] saved location is not JSON; starting at Home', err);
    return null;
  }
}

export async function loadSaved(store: Store): Promise<Saved | null> {
  return parseSaved(await store.getLocalStorage(KEYS.saved));
}

export async function save(store: Store, s: Saved): Promise<void> {
  await store.setLocalStorage(KEYS.saved, JSON.stringify(s));
}
