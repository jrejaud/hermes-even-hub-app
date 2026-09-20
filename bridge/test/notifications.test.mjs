/**
 * The notifications feed (SC-5538 phase 4), driven end to end against the fake
 * even-terminal: only sessions the FLAGGED instance lists are subscribed, each
 * forwarded kind maps to one frame, replayed SSE ids are dropped, a busy→idle
 * transition is one "finished", and unflagged sessions never appear.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { startFakeEvenTerminal } from "./fake-even-terminal.mjs";
import { NotificationFeed } from "../notifications.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await sleep(25);
  }
  throw new Error("timed out waiting");
}

test("feed forwards question/permission/notification from flagged sessions only, dedups replay, emits one finished", async () => {
  const flagged = await startFakeEvenTerminal({ token: "flag", name: "chiba-flagged" });
  const unflagged = await startFakeEvenTerminal({ token: "main", name: "chiba" });
  try {
    flagged.seed("s-flag", { title: "flagged one", state: "idle" });
    unflagged.seed("s-plain", { title: "gopher bridge", state: "idle" });

    const feed = new NotificationFeed(
      [{ key: "ch", name: "chiba", flaggedUrl: flagged.url, flaggedToken: "flag" }],
      { intervalMs: 100, log: () => {} },
    );
    const got = [];
    feed.onEvent((f) => got.push(f));
    feed.start();

    await waitFor(() => feed.subs.has("ch/s-flag"));
    assert.equal(feed.subs.has("ch/s-plain"), false, "unflagged host is never consulted");
    // the SSE reader must be attached before we push
    await waitFor(() => flagged.calls.some((c) => c.path === "/api/events"));
    await sleep(50);

    flagged.push("s-flag",
      { type: "user_question", toolUseId: "t1", questions: [{ question: "Tea or coffee?", header: "Drink", options: [{ label: "Tea" }, { label: "Coffee" }] }] },
      { type: "permission_request", toolName: "Bash", description: "Bash Check Beeper auth", detail: "beeper auth status", options: [{ text: "Yes" }, { text: "No" }] },
      { type: "notification", title: "API Retry", message: "Retrying (1/3)..." },
      { type: "notification", title: "Notice", message: "hello lens" },
      { type: "status", state: "text_start" },
    );
    await waitFor(() => got.length >= 3);
    assert.deepEqual(got.map((g) => g.kind), ["question", "permission", "notification"]);
    assert.equal(got[0].text, "Tea or coffee?");
    assert.deepEqual(got[0].options, ["Tea", "Coffee"]);
    assert.equal(got[0].host, "ch");
    assert.equal(got[0].sessionId, "s-flag");
    assert.match(got[1].text, /^Bash: Bash Check Beeper auth — beeper auth status$/);
    assert.equal(got[2].text, "Notice: hello lens");
    assert.ok(got.every((g) => typeof g.id === "string" && g.t === "notification"));

    // Replay of already-seen ids (what a reconnect with needReplay would send) is dropped.
    const st = feed.subs.get("ch/s-flag");
    feed.onFrame({ key: "ch", name: "chiba" }, "s-flag", st, 1, JSON.stringify({ type: "user_question", questions: [{ question: "again?" }] }));
    assert.equal(got.length, 3, "a replayed frame id must not re-emit");

    // busy → idle is exactly one "finished"; idle → idle is nothing.
    flagged.setState("s-flag", "busy");
    await sleep(250);
    flagged.setState("s-flag", "idle");
    await waitFor(() => got.some((g) => g.kind === "finished"));
    await sleep(300);
    assert.equal(got.filter((g) => g.kind === "finished").length, 1);

    // A session that drops off the flagged list is unsubscribed.
    flagged.sessions.delete("s-flag");
    await waitFor(() => !feed.subs.has("ch/s-flag"));
    feed.stop();
  } finally {
    await flagged.close();
    await unflagged.close();
  }
});

test("a host with no flagged instance configured contributes nothing and does not throw", async () => {
  const feed = new NotificationFeed([{ key: "x", name: "x" }], { log: () => {} });
  assert.equal(feed.hosts.size, 0);
  feed.start(); // no-op
  feed.stop();
});
