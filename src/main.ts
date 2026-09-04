import { waitForEvenAppBridge, OsEventTypeList } from "@evenrealities/even_hub_sdk";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { FRAMES, GALLERY_ENABLED, GALLERY_NOW } from "./dev/gallery";
import "./style.css";
import { loadBridgeDefaults } from "./config";
import { BridgeClient } from "./net/ws-client";
import { initialState, reduce, type AppState } from "./state/store";
import { createLoadingStartup, createSetupStartup, showListPage, showLoadingPage, showSessionPage } from "./ui/render";
import { loadingText, renderAlert, renderSession, buildListView, type ListView } from "./ui/views";
import { renderPhoneSetup } from "./ui/phone";
import { routeEvent, type ListSelection } from "./input/router";
import { dispatch, type Gesture, type Effect } from "./input/dispatch";
import { sessionsList } from "./protocol";
import { serializeLatest } from "./util/coalesce";
import { createCapture } from "./audio/capture";
import {
  loadConnectionProfile,
  saveConnectionProfile,
  updateActiveSession,
  validateConnectionProfile,
  type ConnectionProfile,
} from "./storage/persist";

const fireAndForget = (p: Promise<unknown>): void => { void p.catch(() => {}); };

/**
 * How long after a scroll the list is treated as "being read", and rebuilds are
 * held back. Long enough to page through 20 sessions without being yanked to the
 * top by a notification; short enough that a list left alone catches up quickly.
 */
const LIST_SCROLL_GRACE_MS = 8_000;

/**
 * Render the state gallery instead of connecting to a bridge: one fixed screen
 * per tap, so every state can be screenshotted and looked at. Dev-only, gated on
 * VITE_UI_GALLERY. See src/dev/gallery.ts and scripts/ui-gallery.mjs.
 */
async function runGallery(bridge: EvenAppBridge): Promise<void> {
  let i = 0;
  let built: "text" | "list" | "session" | null = null;

  const draw = async (): Promise<void> => {
    const frame = FRAMES[i];
    const s = frame.state;
    if (s.screen === "list" && s.sessionsLoaded) {
      built = "list";
      await showListPage(bridge, buildListView(s, GALLERY_NOW).rows);
    } else if (s.screen === "session") {
      if (built !== "session") { await showSessionPage(bridge); built = "session"; }
      await renderSession(bridge, s);
    } else if (s.screen === "alert") {
      built = "text";
      await renderAlert(bridge, s);
    } else {
      built = "text";
      await showLoadingPage(bridge, s.conn === "not configured" ? "Open phone app\nto configure bridge." : loadingText(s));
    }
    console.log(`[gallery] ${i + 1}/${FRAMES.length} ${frame.name} — ${frame.looking_for}`);
  };

  bridge.onEvenHubEvent(() => {
    i = (i + 1) % FRAMES.length;
    void draw();
  });

  await createLoadingStartup(bridge);
  await draw();
  console.log("[glasses] ready");
}

async function boot(): Promise<void> {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("Missing #app root");

  const bridge = await waitForEvenAppBridge();
  if (GALLERY_ENABLED) return runGallery(bridge);

  const defaults = loadBridgeDefaults();
  let profile = await loadConnectionProfile(bridge);
  let state: AppState = initialState();
  let phoneErrors: string[] = [];
  let glassesView: "setup" | "list" = profileIsReady(profile) ? "list" : "setup";
  let shownList: ListView = buildListView(state);
  let visibleListRows = shownList.rows;
  /** When the wearer last scrolled the list — a rebuild while reading is hostile. */
  let lastListScrollAt = 0;
  let helloOk = false;
  let sessionsRetryTimer: ReturnType<typeof setInterval> | undefined;

  if (glassesView === "list") {
    await createLoadingStartup(bridge);
  } else {
    state = { ...state, conn: "not configured" };
    await createSetupStartup(bridge);
  }

  // Which page shape is currently built on the glasses. The session page is the
  // only one with several containers, so it must be rebuilt when we arrive and
  // NOT on every streamed delta. Tracking it here (rather than only on gesture,
  // as before) is what lets the SERVER move the screen — an activity alert
  // arrives with no gesture behind it.
  let builtPage: "loading" | "list" | "session" | "alert" | null = null;

  const scheduleRender = serializeLatest(async (s: AppState) => {
    if (glassesView === "setup") return;
    if (s.screen === "alert") {
      builtPage = "alert";
      await renderAlert(bridge, s);
      return;
    }
    if (s.screen === "list") {
      if (!s.sessionsLoaded) {
        builtPage = "loading";
        await showLoadingPage(bridge, loadingText(s));
        return;
      }
      const next = buildListView(s);
      // Lists cannot update in place — every list render is a full rebuild,
      // and a rebuild throws away the native scroll position and selection.
      // Two guards, because an activity notification re-renders the list and
      // otherwise yanks the wearer back to the top mid-scroll:
      //   1. identical rows → nothing to show, skip
      //   2. scrolled in the last few seconds → they are reading, defer
      const unchanged =
        next.rows.length === shownList.rows.length && next.rows.every((r, i) => r === shownList.rows[i]);
      const browsing = Date.now() - lastListScrollAt < LIST_SCROLL_GRACE_MS;
      if (builtPage === "list" && (unchanged || browsing)) return;

      // Only adopt the snapshot when we actually draw it: a tap is resolved
      // against what is on screen, so a stale snapshot would open the wrong row.
      shownList = next;
      visibleListRows = next.rows;
      builtPage = "list";
      await showListPage(bridge, next.rows);
      return;
    }
    if (builtPage !== "session") {
      await showSessionPage(bridge);
      builtPage = "session";
    }
    await renderSession(bridge, s);
  });

  const renderPhone = (): void => {
    renderPhoneSetup(root, {
      profile,
      defaults,
      status: state.conn,
      errors: phoneErrors,
    }, {
      onSaveConnect: (url, token) => {
        fireAndForget(saveAndConnect(url, token));
      },
      onDisconnect: () => {
        client.disconnect();
      },
    });
  };

  const setStatus = (conn: string): void => {
    state = { ...state, conn };
    scheduleRender(state);
    renderPhone();
  };

  const persistActiveSession = (activeSession: string | null): void => {
    if (!profile) return;
    fireAndForget(updateActiveSession(bridge, profile, activeSession).then((next) => {
      profile = next;
      renderPhone();
    }));
  };

  const startSessionsRetry = (): void => {
    if (sessionsRetryTimer) return;
    sessionsRetryTimer = setInterval(() => {
      if (helloOk && !state.sessionsLoaded) client.send(sessionsList());
    }, 2000);
  };

  const stopSessionsRetry = (): void => {
    clearInterval(sessionsRetryTimer);
    sessionsRetryTimer = undefined;
  };

  const client = new BridgeClient({
    onMessage: (m) => {
      state = reduce(state, m);
      scheduleRender(state);
      if (m.t === "hello.ok") {
        helloOk = true;
        client.send(sessionsList());
        startSessionsRetry();
        persistActiveSession(m.active);
      }
      if (m.t === "sessions") stopSessionsRetry();
      if (m.t === "active") persistActiveSession(m.id);
    },
    onStatus: setStatus,
  });

  async function saveAndConnect(url: string, token: string): Promise<void> {
    const candidate: ConnectionProfile = {
      url,
      token,
      activeSession: profile?.activeSession,
      updatedAt: Date.now(),
    };
    const validation = validateConnectionProfile(candidate);
    if (!validation.valid) {
      phoneErrors = validation.errors;
      setStatus("not configured");
      return;
    }

    phoneErrors = [];
    profile = await saveConnectionProfile(bridge, candidate);
    if (glassesView === "setup") {
      glassesView = "list";
      await showLoadingPage(bridge, loadingText(state));
    }
    helloOk = false;
    client.connect(profile);
    renderPhone();
  }

  renderPhone();
  if (profileIsReady(profile)) {
    helloOk = false;
    client.connect(profile);
  }

  const capture = createCapture(bridge, client);

  function runEffect(e: Effect): void {
    if (e.kind === "send") client.send(e.frame);
    else if (e.kind === "startMic") void capture.start();
    else if (e.kind === "stopMic") void capture.stop();
    else if (e.kind === "exit") bridge.shutDownPageContainer(1);
  }

  function selectedListIndex(selection?: ListSelection): number | undefined {
    if (selection?.index !== undefined) return selection.index;
    if (selection?.name !== undefined) {
      const index = visibleListRows.indexOf(selection.name);
      return index >= 0 ? index : -1;
    }
    return undefined;
  }

  async function applyGesture(g: Gesture, index?: number): Promise<void> {
    if (glassesView === "setup") {
      if (g === "doubleClick") bridge.shutDownPageContainer(1);
      return;
    }

    if (state.screen === "list" && (g === "scrollUp" || g === "scrollDown")) lastListScrollAt = Date.now();

    // `shownList` is what the glasses are displaying right now; the tap index
    // is meaningless against anything else.
    const r = dispatch(state, g, index, shownList);
    state = r.state;
    for (const e of r.effects) runEffect(e);
    // Page construction lives in scheduleRender so gesture-driven and
    // server-driven screen changes take exactly the same path.
    scheduleRender(state);
  }

  let torn = false;
  function teardown(): void {
    if (torn) return;
    torn = true;
    off();
    void capture.stop();
    stopSessionsRetry();
    client.disconnect();
  }

  const off = bridge.onEvenHubEvent((e) => {
    capture.handleEvent(e);
    const et = e.sysEvent?.eventType ?? e.listEvent?.eventType ?? e.textEvent?.eventType;
    if (et === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      if (profile) fireAndForget(updateActiveSession(bridge, profile, state.sessions.active ?? ""));
      return;
    }
    if (et === OsEventTypeList.SYSTEM_EXIT_EVENT || et === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      teardown();
      return;
    }
    routeEvent(e, {
      onClick: (selection) => { fireAndForget(applyGesture("click", selectedListIndex(selection))); },
      onDoubleClick: () => { fireAndForget(applyGesture("doubleClick")); },
      onScrollUp: () => { fireAndForget(applyGesture("scrollUp")); },
      onScrollDown: () => { fireAndForget(applyGesture("scrollDown")); },
    });
  });

  window.addEventListener("beforeunload", teardown);
  console.log("[glasses] ready");
}

function profileIsReady(profile: ConnectionProfile | null): profile is ConnectionProfile {
  return !!profile && validateConnectionProfile(profile).valid;
}

boot().catch((err) => console.error("[glasses] boot failed", err));
