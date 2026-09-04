import { describe, it, expect, vi } from "vitest";
import {
  loadConnectionProfile,
  saveConnectionProfile,
  updateActiveSession,
  validateConnectionProfile,
  type ConnectionProfile,
} from "../src/storage/persist";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";

function makeBridge(stored: Record<string, string> = {}): EvenAppBridge {
  const db = { ...stored };
  return {
    setLocalStorage: vi.fn(async (key: string, value: string) => { db[key] = value; }),
    getLocalStorage: vi.fn(async (key: string) => db[key] ?? ""),
  } as unknown as EvenAppBridge;
}

describe("connection profile persistence", () => {
  it("saves the runtime profile as JSON under the v1 key", async () => {
    const bridge = makeBridge();
    const profile: ConnectionProfile = {
      url: " wss://node.tailnet.ts.net:8443 ",
      token: " tok ",
      activeSession: " sess-abc ",
      updatedAt: 1,
    };

    await saveConnectionProfile(bridge, profile);

    expect(bridge.setLocalStorage).toHaveBeenCalledWith(
      "ccg2.connectionProfile.v1",
      JSON.stringify({
        url: "wss://node.tailnet.ts.net:8443",
        token: "tok",
        activeSession: "sess-abc",
        updatedAt: 1,
      }),
    );
  });

  it("loads a saved runtime profile", async () => {
    const bridge = makeBridge({
      "ccg2.connectionProfile.v1": JSON.stringify({
        url: "wss://node.tailnet.ts.net:8443",
        token: "tok",
        activeSession: "sess-xyz",
        updatedAt: 2,
      }),
    });

    await expect(loadConnectionProfile(bridge)).resolves.toEqual({
      url: "wss://node.tailnet.ts.net:8443",
      token: "tok",
      activeSession: "sess-xyz",
      updatedAt: 2,
    });
  });

  it("migrates old url and session keys as an incomplete profile", async () => {
    const bridge = makeBridge({
      "hermes.lastUrl": "ws://100.64.0.1:8765",
      "hermes.activeSession": "sess-xyz",
    });

    const result = await loadConnectionProfile(bridge);

    expect(result).toMatchObject({
      url: "ws://100.64.0.1:8765",
      token: "",
      activeSession: "sess-xyz",
    });
    expect(typeof result?.updatedAt).toBe("number");
  });

  it("returns null when nothing is stored and nothing was baked in", async () => {
    // A production build: neither .env.development.local nor .env.beta.local is
    // loaded, so the phone setup form is the only way in.
    vi.stubEnv("VITE_BRIDGE_URL", "");
    vi.stubEnv("VITE_BRIDGE_TOKEN", "");
    const bridge = makeBridge();
    await expect(loadConnectionProfile(bridge)).resolves.toBeNull();
    vi.unstubAllEnvs();
  });

  it("adopts baked-in credentials when the build carries them", async () => {
    // Dev (.env.development.local) so the simulator can connect at all — there
    // is no phone in it — and beta (.env.beta.local) so a testing-group install
    // just runs. Which files load is decided by the BUILD MODE, not by a runtime
    // guard: a guard stops a value being used, not being shipped, and Vite
    // inlines these as literals. scripts/check-no-secrets.mjs enforces the rest.
    vi.stubEnv("VITE_BRIDGE_URL", "wss://host.ts.net:8791");
    vi.stubEnv("VITE_BRIDGE_TOKEN", "bakedtoken");
    const bridge = makeBridge();
    await expect(loadConnectionProfile(bridge)).resolves.toMatchObject({
      url: "wss://host.ts.net:8791",
      token: "bakedtoken",
    });
    vi.unstubAllEnvs();
  });

  it("a stored profile always beats a baked-in one, so the form can override", async () => {
    vi.stubEnv("VITE_BRIDGE_URL", "wss://baked.ts.net:8791");
    vi.stubEnv("VITE_BRIDGE_TOKEN", "bakedtoken");
    const bridge = makeBridge({
      "ccg2.connectionProfile.v1": JSON.stringify({
        url: "wss://typed-in.ts.net:8791",
        token: "typedtoken",
        updatedAt: 9,
      }),
    });
    await expect(loadConnectionProfile(bridge)).resolves.toMatchObject({
      url: "wss://typed-in.ts.net:8791",
      token: "typedtoken",
    });
    vi.unstubAllEnvs();
  });

  it("updates activeSession without changing url or token", async () => {
    const bridge = makeBridge();
    const profile: ConnectionProfile = {
      url: "wss://node.tailnet.ts.net:8443",
      token: "tok",
      updatedAt: 1,
    };

    const next = await updateActiveSession(bridge, profile, "sess-next");

    expect(next).toMatchObject({
      url: "wss://node.tailnet.ts.net:8443",
      token: "tok",
      activeSession: "sess-next",
    });
    expect(next.updatedAt).toBeGreaterThanOrEqual(1);
  });
});

describe("connection profile validation", () => {
  it("accepts production wss and dev ws URLs", () => {
    expect(validateConnectionProfile({ url: "wss://node.tailnet.ts.net:8443", token: "tok" }).valid).toBe(true);
    expect(validateConnectionProfile({ url: "ws://localhost:8765", token: "tok" }).valid).toBe(true);
  });

  it("requires a websocket URL and token", () => {
    const result = validateConnectionProfile({ url: "https://node.tailnet.ts.net:8443", token: "" });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      "Bridge URL must start with wss:// or ws://.",
      "Bridge token is required.",
    ]);
  });
});

describe("upstream migration", () => {
  it("adopts a profile left by the Hermes build instead of showing setup again", async () => {
    const bridge = makeBridge({
      "hermes.connectionProfile.v1": JSON.stringify({
        url: "wss://node.tailnet.ts.net:8443",
        token: "tok",
        updatedAt: 3,
      }),
    });

    await expect(loadConnectionProfile(bridge)).resolves.toMatchObject({
      url: "wss://node.tailnet.ts.net:8443",
      token: "tok",
    });
  });
});
