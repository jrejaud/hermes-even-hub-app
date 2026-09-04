import { describe, expect, it } from "vitest";
import { dispatch } from "../src/input/dispatch";
import { initialState, openAsk, reduce, barText, type AppState } from "../src/state/store";
import { sessionsNew, sessionsSwitch, sessionsList, type HostItem, type SessionItem } from "../src/protocol";
import { listRows, alertText, buildListView, headerText } from "../src/ui/views";
import { getTextWidth } from "@evenrealities/pretext";
import { newSessionRows, sessionForListIndex } from "../src/ui/session-list";
import { byteLength, clampToBudget, threadPages, VIEWPORT_BYTE_BUDGET } from "../src/ui/stream";

const HOSTS: HostItem[] = [
  { key: "ov", name: "overlord", online: true },
  { key: "ch", name: "chiba", online: true },
];

const SESSIONS: SessionItem[] = [
  { id: "ch/b", title: "deploy parakeet", updated: 1_780_000_000, host: "ch" },
  { id: "ov/a", title: "romhack build", updated: 1_779_999_000, host: "ov" },
];

function loaded(over: Partial<AppState> = {}): AppState {
  return {
    ...initialState(),
    sessionsLoaded: true,
    hosts: HOSTS,
    sessions: { items: SESSIONS, active: null },
    ...over,
  };
}

describe("multi-host session list", () => {
  it("offers one ＋New row per host, naming the machine", () => {
    expect(newSessionRows(HOSTS)).toEqual(["＋ New · overlord", "＋ New · chiba"]);
  });

  it("falls back to the single upstream row when there is one host", () => {
    expect(newSessionRows([HOSTS[0]])).toEqual(["＋ New session"]);
    expect(newSessionRows([])).toEqual(["＋ New session"]);
  });

  it("marks a host that is currently unreachable", () => {
    expect(newSessionRows([HOSTS[0], { key: "ch", name: "chiba", online: false }]))
      .toEqual(["＋ New · overlord", "＋ New · chiba (off)"]);
  });

  it("tags each session row with the machine it lives on, newest first", () => {
    const rows = listRows(loaded(), 1_780_000_000);
    expect(rows).toEqual([
      "＋ New · overlord",
      "＋ New · chiba",
      "  now ch deploy parakeet",
      "  16m ov romhack build",
    ]);
  });

  it("omits the host tag when only one machine is configured", () => {
    const rows = listRows(loaded({ hosts: [HOSTS[0]] }), 1_780_000_000);
    expect(rows[1]).toBe("  now deploy parakeet");
  });

  it("indexes past every ＋New row when resolving a tap", () => {
    expect(sessionForListIndex(SESSIONS, 0, 2)).toBeUndefined();
    expect(sessionForListIndex(SESSIONS, 1, 2)).toBeUndefined();
    expect(sessionForListIndex(SESSIONS, 2, 2)?.id).toBe("ch/b");
    expect(sessionForListIndex(SESSIONS, 3, 2)?.id).toBe("ov/a");
  });

  it("spawns on the host whose ＋New row was tapped", () => {
    expect(dispatch(loaded(), "click", 0).effects).toEqual([{ kind: "send", frame: sessionsNew("ov") }]);
    expect(dispatch(loaded(), "click", 1).effects).toEqual([{ kind: "send", frame: sessionsNew("ch") }]);
  });

  it("opens the right session when a row below the ＋New rows is tapped", () => {
    const r = dispatch(loaded(), "click", 2);
    expect(r.state.screen).toBe("session");
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsSwitch("ch/b") }]);
  });

  it("opens the row the wearer actually touched, even after the list re-sorts", () => {
    // The list re-sorts by recency, and every activity notification reorders it.
    // A tap arrives as an INDEX into the rows ON SCREEN, so resolving it against
    // live state opens whatever moved into that slot — the wrong session.
    const shown = buildListView(loaded());
    expect(shown.ids).toEqual([null, null, "ch/b", "ov/a"]);

    const reordered = loaded({
      sessions: {
        items: [
          { id: "ov/a", title: "romhack build", updated: 1_780_000_500, host: "ov" },
          { id: "ch/b", title: "deploy parakeet", updated: 1_780_000_000, host: "ch" },
        ],
        active: null,
      },
    });

    // Row 2 still displays "deploy parakeet" — open that, not the row now sorted there.
    const r = dispatch(reordered, "click", 2, shown);
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsSwitch("ch/b") }]);
    expect(r.state.sessions.active).toBe("ch/b");

    // Without the snapshot it resolves against live state and opens the wrong one.
    expect(dispatch(reordered, "click", 2).effects).toEqual([
      { kind: "send", frame: sessionsSwitch("ov/a") },
    ]);
  });

  it("spawns on the host named by the ＋New row on screen", () => {
    const shown = buildListView(loaded());
    expect(dispatch(loaded(), "click", 1, shown).effects).toEqual([
      { kind: "send", frame: sessionsNew("ch") },
    ]);
  });

  it("keeps an unresolved selection a no-op instead of spawning a session", () => {
    const r = dispatch(loaded(), "click", -1);
    expect(r.state.screen).toBe("list");
    expect(r.effects).toEqual([]);
  });

  it("takes the host list from the server's sessions frame", () => {
    const s = reduce(initialState(), { t: "sessions", items: SESSIONS, active: null, hosts: HOSTS });
    expect(s.hosts).toEqual(HOSTS);
  });
});

describe("permission and question prompts", () => {
  const asked = (kind: "permission" | "question", text: string, options?: string[]) =>
    reduce({ ...initialState(), screen: "session" }, { t: "ask", ask: kind, text, options });

  it("puts an unanswered ask on the thread and says speaking is the answer", () => {
    const s = asked("permission", "Allow Run `git push`? — say yes or no", ["allow", "deny"]);
    expect(openAsk(s)?.text).toMatch(/git push/);
    expect(barText(s)).toBe("tap to answer · yes or no");
  });

  it("uses a different cue for a question than for a permission", () => {
    const s = asked("question", "Which branch? — say: main, or dev", ["main", "dev"]);
    expect(barText(s)).toBe("tap to answer aloud");
  });

  it("renders an unanswered ask as the loudest row on the thread", () => {
    const s = asked("permission", "Allow deleting build? — say yes or no");
    const page = threadPages(s.stream)[0];
    expect(page).toContain("? Allow deleting build?");
    expect(page.split("\n")[0]).toMatch(/^─+$/);
  });

  it("stops demanding an answer once ask.done arrives", () => {
    const s = reduce(asked("question", "Which branch?"), { t: "ask.done" });
    expect(openAsk(s)).toBeNull();
    expect(s.turn).toBe("thinking");
    expect(threadPages(s.stream)[0].split("\n")[0]).toBe("? Which branch?");
  });
});

describe("activity notification", () => {
  const act = { t: "activity", id: "ch/b", host: "ch", title: "deploy parakeet", preview: "Deployed in 4m." } as const;

  it("raises an alert screen for a session you are not looking at", () => {
    const s = reduce(loaded({ screen: "list" }), act);
    expect(s.screen).toBe("alert");
    expect(s.notice?.id).toBe("ch/b");
    expect(s.unread).toEqual(["ch/b"]);
  });

  it("never fires for the session already on screen", () => {
    const s = reduce(loaded({ screen: "session", sessions: { items: SESSIONS, active: "ch/b" } }), act);
    expect(s.screen).toBe("session");
    expect(s.notice).toBeNull();
  });

  it("never steals the screen mid-utterance — that would drop the mic", () => {
    const s = reduce(loaded({ screen: "session", phase: "recording" }), act);
    expect(s.screen).toBe("session");
    expect(s.notice).toBeNull();
    expect(s.unread).toEqual(["ch/b"]); // still counted, just not shown yet
  });

  it("names the machine and shows the preview", () => {
    const text = alertText(reduce(loaded({ screen: "list" }), act));
    expect(text).toContain("● ch · deploy parakeet");
    expect(text).toContain("Deployed in 4m.");
    expect(text).toContain("tap = open · swipe↓ = dismiss");
  });

  it("taps through straight to the session that moved", () => {
    const alert = reduce(loaded({ screen: "list" }), act);
    const r = dispatch(alert, "click");
    expect(r.state.screen).toBe("session");
    expect(r.state.sessions.active).toBe("ch/b");
    expect(r.state.notice).toBeNull();
    expect(r.state.unread).toEqual([]);
    expect(r.effects).toEqual([{ kind: "send", frame: sessionsSwitch("ch/b") }]);
  });

  it("dismisses back to wherever you were, refreshing the list if that is where", () => {
    const fromList = dispatch(reduce(loaded({ screen: "list" }), act), "scrollDown");
    expect(fromList.state.screen).toBe("list");
    expect(fromList.effects).toEqual([{ kind: "send", frame: sessionsList() }]);

    const fromSession = dispatch(reduce(loaded({ screen: "session" }), act), "doubleClick");
    expect(fromSession.state.screen).toBe("session");
    expect(fromSession.effects).toEqual([]);
  });

  it("marks unread sessions in the list and counts them in the bar", () => {
    const s = reduce(loaded({ screen: "list" }), act);
    expect(listRows(s, 1_780_000_000)[2]).toBe("* now ch deploy parakeet");
  });

  it("clears the unread mark once that session is opened", () => {
    const s = reduce(reduce(loaded({ screen: "list" }), act), { t: "active", id: "ch/b" });
    expect(s.unread).toEqual([]);
  });
});

describe("the silent byte limit", () => {
  // rebuildPageContainer and textContainerUpgrade reject over ~999 bytes by
  // resolving false — no throw, no log, the screen just does not change.
  it("keeps every viewport under the budget even for wide non-ASCII text", () => {
    const stream = [{ kind: "assistant" as const, text: "日本語のとても長い返事。".repeat(60) }];
    for (const page of threadPages(stream)) {
      expect(byteLength(page)).toBeLessThanOrEqual(VIEWPORT_BYTE_BUDGET);
    }
  });

  it("caps a single oversized line, not just the joined total", () => {
    const oneLongLine = ["x".repeat(5_000)];
    expect(byteLength(clampToBudget(oneLongLine))).toBeLessThanOrEqual(VIEWPORT_BYTE_BUDGET);
  });

  it("drops from the front so the newest text survives", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i} ${"y".repeat(60)}`);
    const out = clampToBudget(lines);
    expect(out).toContain("line 39");
    expect(out).not.toContain("line 0 ");
  });
});

describe("things the firmware silently drops or clips", () => {
  // Both of these shipped and were only found by LOOKING at the state gallery.
  // They are cheap to assert and expensive to notice.

  it("no user-facing string contains an emoji — the font has none and drops them silently", () => {
    // A dropped glyph leaves a stray space and no error anywhere. The 🎤 in the
    // recording bar rendered as nothing, on the one screen that most needs to
    // be obvious at a glance.
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    const strings = [
      ...(["idle", "recording", "transcribing", "review"] as const).map((phase) =>
        barText({ ...loaded({ screen: "session", phase }) }),
      ),
      ...listRows(loaded(), 1_780_000_000),
      alertText(reduce(loaded({ screen: "list" }), {
        t: "activity", id: "ch/b", host: "ch", title: "t", preview: "p",
      })),
      headerText("ov", "a title"),
    ];
    for (const s of strings) expect(s, `emoji in ${JSON.stringify(s)}`).not.toMatch(emoji);
  });

  it("the header never runs under the connection dot, however long the title", () => {
    // The dot owns x=540..576. Truncating the TITLE to the container width and
    // then prepending a host tag overflows it: the line wraps, the 40px header
    // has no room, and it lands on top of the body's first line.
    const usable = 540 - 8;
    const long = "You route an incoming email to at most ONE of a set of waiting cards, deciding by sender";
    for (const host of [undefined, "ov", "chiba"]) {
      const text = headerText(host, long);
      expect(getTextWidth(text), `"${text}" overflows the header`).toBeLessThanOrEqual(usable);
      expect(text).not.toContain("\n");
    }
  });

  it("a short title is left intact rather than needlessly truncated", () => {
    expect(headerText("ov", "deploy")).toBe("ov · deploy");
    expect(headerText(undefined, "deploy")).toBe("deploy");
  });
});
