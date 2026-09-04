import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";

export interface ConnectionProfile {
  url: string;
  token: string;
  activeSession?: string;
  updatedAt: number;
}

export interface ProfileValidation {
  valid: boolean;
  errors: string[];
}

// `hermes.*` keys are read as a migration fallback so an install carried over
// from the upstream app keeps its bridge URL instead of landing on the setup
// screen. New writes always go to the `ccg2.*` key.
const KEYS = {
  profile: "ccg2.connectionProfile.v1",
  legacyProfile: "hermes.connectionProfile.v1",
  oldUrl: "hermes.lastUrl",
  oldSession: "hermes.activeSession",
} as const;

export function normalizeConnectionProfile(profile: ConnectionProfile): ConnectionProfile {
  return {
    url: profile.url.trim(),
    token: profile.token.trim(),
    activeSession: profile.activeSession?.trim() || undefined,
    updatedAt: profile.updatedAt,
  };
}

export function validateConnectionProfile(profile: Pick<ConnectionProfile, "url" | "token">): ProfileValidation {
  const errors: string[] = [];
  const url = profile.url.trim();
  const token = profile.token.trim();

  if (!url) {
    errors.push("Bridge URL is required.");
  } else {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
        errors.push("Bridge URL must start with wss:// or ws://.");
      }
    } catch {
      errors.push("Bridge URL is invalid.");
    }
  }

  if (!token) errors.push("Bridge token is required.");
  return { valid: errors.length === 0, errors };
}

export async function saveConnectionProfile(
  bridge: EvenAppBridge,
  profile: ConnectionProfile,
): Promise<ConnectionProfile> {
  const next = normalizeConnectionProfile(profile);
  await bridge.setLocalStorage(KEYS.profile, JSON.stringify(next));
  return next;
}

/**
 * Bridge credentials baked in at build time, used only when nothing is stored.
 *
 * Whether these exist at all is decided by WHICH BUILD MODE ran, because Vite
 * only loads a mode's own env files:
 *
 *   dev server     `.env.development.local`  the simulator can connect — there
 *                                            is no phone in it to configure
 *   `--mode beta`  `.env.beta.local`         a private / testing-group build the
 *                                            wearer installs and just runs
 *   production     neither                   `undefined`, so the phone setup
 *                                            form is the only way in
 *
 * There is deliberately NO runtime guard here. A guard stops a value being USED,
 * not being SHIPPED — Vite inlines `import.meta.env.VITE_*` as string literals,
 * so the only thing that keeps a token out of a package is it not being defined
 * when that package is built. `scripts/check-no-secrets.mjs` enforces exactly
 * that, per mode.
 *
 * Baking a token is acceptable ONLY because the bridge sits behind
 * `tailscale serve` with no funnel: it is unreachable from the public internet,
 * so the token is useless to anyone not already on the tailnet. **If the bridge
 * is ever exposed publicly, stop baking and require the form.**
 */
function bakedInProfile(): ConnectionProfile | null {
  const url = import.meta.env.VITE_BRIDGE_URL ?? "";
  const token = import.meta.env.VITE_BRIDGE_TOKEN ?? "";
  if (!url || !token) return null;
  return { url, token, updatedAt: Date.now() };
}

export async function loadConnectionProfile(bridge: EvenAppBridge): Promise<ConnectionProfile | null> {
  for (const key of [KEYS.profile, KEYS.legacyProfile]) {
    const stored = await bridge.getLocalStorage(key);
    if (!stored) continue;
    const parsed = parseProfile(stored);
    if (parsed) return parsed;
  }

  const url = await bridge.getLocalStorage(KEYS.oldUrl);
  const activeSession = await bridge.getLocalStorage(KEYS.oldSession);
  if (url) {
    return {
      url,
      token: "",
      activeSession: activeSession || undefined,
      updatedAt: Date.now(),
    };
  }

  return bakedInProfile();
}

export async function updateActiveSession(
  bridge: EvenAppBridge,
  profile: ConnectionProfile,
  activeSession: string | null,
): Promise<ConnectionProfile> {
  return saveConnectionProfile(bridge, {
    ...profile,
    activeSession: activeSession || undefined,
    updatedAt: Date.now(),
  });
}

function parseProfile(raw: string): ConnectionProfile | null {
  try {
    const value = JSON.parse(raw) as Partial<ConnectionProfile>;
    if (typeof value.url !== "string" || typeof value.token !== "string") return null;
    return normalizeConnectionProfile({
      url: value.url,
      token: value.token,
      activeSession: typeof value.activeSession === "string" ? value.activeSession : undefined,
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
    });
  } catch {
    return null;
  }
}
