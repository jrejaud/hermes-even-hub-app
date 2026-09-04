import assert from "node:assert/strict";
import test from "node:test";

import { startFakeEvenTerminal } from "./fake-even-terminal.mjs";
import { Fleet, ActivityWatcher } from "../fleet.mjs";
import { SessionPump } from "../pump.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness(hosts) {
  const frames = [];
  const fleet = new Fleet(hosts.map((h, i) => ({
    key: h.key ?? (i === 0 ? "ov" : "ch"),
    name: h.name,
    url: h.url,
    token: h.token,
  })));
  const pump = new SessionPump(fleet, (f) => frames.push(f));
  return { fleet, pump, frames, of: (t) => frames.filter((f) => f.t === t) };
}

/** Poll until `fn()` is truthy, so tests never race the 400 ms pump. */
async function until(fn, ms = 4_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(25);
  }
  throw new Error("condition never became true");
}

test("a merged session list spans every host, newest first", async (t) => {
  const ov = await startFakeEvenTerminal({ name: "overlord" });
  const ch = await startFakeEvenTerminal({ name: "chiba" });
  t.after(() => Promise.all([ov.close(), ch.close()]));

  ov.seed("a", { title: "on overlord", timestamp: "2026-09-04T10:00:00.000Z" });
  ch.seed("b", { title: "on chiba", timestamp: "2026-09-04T11:00:00.000Z" });

  const { fleet } = harness([ov, ch]);
  const items = await fleet.sessions({ force: true });

  assert.deepEqual(items.map((i) => i.id), ["ch/b", "ov/a"]);
  assert.deepEqual(items.map((i) => i.host), ["ch", "ov"]);
  assert.equal(items[0].title, "on chiba");
});

test("an unreachable host contributes nothing and never fails the list", async (t) => {
  const ch = await startFakeEvenTerminal({ name: "chiba" });
  t.after(() => ch.close());
  ch.seed("b", { title: "still here" });

  // Overlord asleep — an ad-hoc even-terminal on a laptop is off most of the time.
  const { fleet } = harness([{ key: "ov", name: "overlord", url: "http://127.0.0.1:1", token: "t0k" }, ch]);
  const items = await fleet.sessions({ force: true });

  assert.deepEqual(items.map((i) => i.id), ["ch/b"]);
  assert.deepEqual(fleet.hostList().map((h) => [h.key, h.online]), [["ov", false], ["ch", true]]);
});

test("opening a session replays its disk history then streams live output", async (t) => {
  const ov = await startFakeEvenTerminal();
  t.after(() => ov.close());
  ov.seed("a", { title: "deploy", history: [{ role: "user", text: "deploy it" }, { role: "assistant", text: "done" }] });

  const h = harness([ov]);
  await h.pump.attach("ov/a");

  const hist = h.of("history")[0];
  assert.equal(hist.id, "ov/a");
  assert.deepEqual(hist.items, [{ kind: "user", text: "deploy it" }, { kind: "assistant", text: "done" }]);

  ov.setState("a", "busy");
  ov.push("a", { type: "text_delta", text: "redeploying" }, { type: "result", success: true, text: "Redeployed." });

  await until(() => h.of("turn.done").length);
  assert.deepEqual(h.of("assistant").map((f) => f.text), ["Redeployed."]);
  h.pump.detach();
});

test("an in-flight turn is replayed on attach; a finished one is not duplicated", async (t) => {
  const ov = await startFakeEvenTerminal();
  t.after(() => ov.close());

  // Busy: the ring holds the CURRENT turn, which is not on disk yet.
  ov.seed("busy", { state: "busy", history: [] });
  ov.push("busy", { type: "text_delta", text: "half a sentence" });
  ov.setState("busy", "busy");

  const a = harness([ov]);
  await a.pump.attach("ov/busy");
  assert.deepEqual(a.of("assistant.delta").map((f) => f.text), ["half a sentence"]);
  a.pump.detach();

  // Idle: the same content is already in history, so replaying it would double up.
  ov.seed("idle", { state: "idle", history: [{ role: "assistant", text: "all done" }] });
  ov.push("idle", { type: "text_delta", text: "all done" });
  ov.setState("idle", "idle");

  const b = harness([ov]);
  await b.pump.attach("ov/idle");
  assert.deepEqual(b.of("assistant.delta"), []);
  assert.deepEqual(b.of("history")[0].items, [{ kind: "assistant", text: "all done" }]);
  b.pump.detach();
});

test("the first prompt of a session spawns it and carries the lens preamble", async (t) => {
  const ov = await startFakeEvenTerminal();
  t.after(() => ov.close());

  const h = harness([ov]);
  h.pump.armNew("ov");
  await h.pump.handleText("what is running");

  const prompt = ov.calls.find((c) => c.path === "/api/prompt");
  assert.equal(prompt.body.sessionId, undefined);
  assert.match(prompt.body.text, /576x288 monochrome/);
  assert.match(prompt.body.text, /what is running$/);
  assert.equal(h.of("active").at(-1).id, "ov/sess-1");
  h.pump.detach();
});

test("follow-up prompts reuse the session and drop the preamble", async (t) => {
  const ov = await startFakeEvenTerminal();
  t.after(() => ov.close());

  const h = harness([ov]);
  h.pump.armNew("ov");
  await h.pump.handleText("first");
  await h.pump.handleText("second");

  const prompts = ov.calls.filter((c) => c.path === "/api/prompt");
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].body.sessionId, "sess-1");
  assert.equal(prompts[1].body.text, "second");
  h.pump.detach();
});

test("a permission request is answered by voice and DEFAULTS TO DENY", async (t) => {
  const ov = await startFakeEvenTerminal();
  t.after(() => ov.close());
  ov.seed("a", { state: "busy" });

  const h = harness([ov]);
  await h.pump.attach("ov/a");
  ov.push("a", {
    type: "permission_request",
    toolName: "Bash",
    description: "Run `rm -rf /`",
    toolUseId: "tu",
    options: [{ text: "Allow", key: "allow" }, { text: "Deny", key: "deny" }],
  });

  await until(() => h.of("ask").length);
  assert.equal(h.of("ask")[0].ask, "permission");

  // A shrug is not consent.
  await h.pump.handleText("uh, hmm");
  const denied = ov.calls.filter((c) => c.path === "/api/permission-response");
  assert.equal(denied.at(-1).body.decision, "deny");
  assert.equal(h.of("ask.done").length, 1);
  h.pump.detach();
});

test("a spoken 'yes' allows, and the ask stops owning the next utterance", async (t) => {
  const ov = await startFakeEvenTerminal();
  t.after(() => ov.close());
  ov.seed("a", { state: "busy" });

  const h = harness([ov]);
  await h.pump.attach("ov/a");
  ov.push("a", {
    type: "permission_request", toolName: "Bash", description: "Run `git push`", toolUseId: "tu",
    options: [{ text: "Allow", key: "allow" }, { text: "Deny", key: "deny" }],
  });
  await until(() => h.of("ask").length);

  await h.pump.handleText("yes go ahead");
  assert.equal(ov.calls.filter((c) => c.path === "/api/permission-response").at(-1).body.decision, "allow");

  // The next thing said is a prompt again, not another answer.
  ov.setState("a", "idle");
  await h.pump.handleText("now run the tests");
  assert.equal(ov.calls.filter((c) => c.path === "/api/prompt").at(-1).body.text, "now run the tests");
  h.pump.detach();
});

test("a correction inside a refusal is denied AND resubmitted as a prompt", async (t) => {
  const ov = await startFakeEvenTerminal();
  t.after(() => ov.close());
  ov.seed("a", { state: "busy" });

  const h = harness([ov]);
  await h.pump.attach("ov/a");
  ov.push("a", {
    type: "permission_request", toolName: "Bash", description: "play via Spotify", toolUseId: "tu",
    options: [{ text: "Allow", key: "allow" }, { text: "Deny", key: "deny" }],
  });
  await until(() => h.of("ask").length);

  await h.pump.handleText("No. Jellyfin, not Spotify.");

  assert.equal(ov.calls.filter((c) => c.path === "/api/permission-response").at(-1).body.decision, "deny");
  const followUp = ov.calls.filter((c) => c.path === "/api/prompt").at(-1);
  assert.equal(followUp.body.text, "No. Jellyfin, not Spotify.");
  h.pump.detach();
});

test("an AskUserQuestion is answered by speaking an option label", async (t) => {
  const ov = await startFakeEvenTerminal();
  t.after(() => ov.close());
  ov.seed("a", { state: "busy" });

  const h = harness([ov]);
  await h.pump.attach("ov/a");
  ov.push("a", {
    type: "user_question", toolUseId: "tu",
    questions: [{ question: "Which branch?", header: "Branch", options: [{ label: "main" }, { label: "dev" }] }],
  });

  const askFrame = await until(() => h.of("ask")[0]);
  assert.equal(askFrame.text, "Which branch? — say: main, or dev");

  await h.pump.handleText("dev");
  assert.equal(ov.calls.filter((c) => c.path === "/api/question-response").at(-1).body.answer, "dev");
  h.pump.detach();
});

test("a session that died underneath us is respawned, not reported", async (t) => {
  const ov = await startFakeEvenTerminal();
  t.after(() => ov.close());
  ov.seed("ghost", {});

  const h = harness([ov]);
  await h.pump.attach("ov/ghost");
  ov.sessions.delete("ghost"); // archived / deleted / service restarted

  await h.pump.handleText("still there?");

  assert.deepEqual(h.of("error"), []);
  const prompts = ov.calls.filter((c) => c.path === "/api/prompt");
  assert.equal(prompts[0].body.sessionId, "ghost");   // tried the remembered id
  assert.equal(prompts[1].body.sessionId, undefined); // then started fresh
  assert.equal(h.of("active").at(-1).id, "ov/sess-1");
  h.pump.detach();
});

test("the same utterance twice in a row is sent once", async (t) => {
  const ov = await startFakeEvenTerminal();
  t.after(() => ov.close());

  const h = harness([ov]);
  h.pump.armNew("ov");
  await h.pump.handleText("deploy");
  await h.pump.handleText("deploy");

  assert.equal(ov.calls.filter((c) => c.path === "/api/prompt").length, 1);
  h.pump.detach();
});

test("'new session' escapes a poisoned session instead of prompting it", async (t) => {
  const ov = await startFakeEvenTerminal();
  t.after(() => ov.close());
  ov.seed("stuck", {});

  const h = harness([ov]);
  await h.pump.attach("ov/stuck");
  await h.pump.handleText("start over");

  assert.equal(ov.calls.filter((c) => c.path === "/api/prompt").length, 0);
  assert.equal(h.pump.sessionId, null);
  assert.equal(h.pump.pendingHost, "ov");
  h.pump.detach();
});

test("'status' drains what landed without re-prompting the agent", async (t) => {
  const ov = await startFakeEvenTerminal();
  t.after(() => ov.close());
  ov.seed("a", { state: "busy" });

  const h = harness([ov]);
  await h.pump.attach("ov/a");
  h.pump.stopPolling(); // simulate having stopped listening
  ov.push("a", { type: "result", success: true, text: "Finished while you were away." });

  await h.pump.handleText("status");

  assert.equal(ov.calls.filter((c) => c.path === "/api/prompt").length, 0);
  assert.equal(h.of("assistant").at(-1).text, "Finished while you were away.");
  h.pump.detach();
});

test("a question raised after we stopped listening still owns the next utterance", async (t) => {
  const ov = await startFakeEvenTerminal();
  t.after(() => ov.close());
  ov.seed("a", { state: "busy" });

  const h = harness([ov]);
  await h.pump.attach("ov/a");
  h.pump.stopPolling(); // the turn outran our attention
  ov.push("a", {
    type: "user_question", toolUseId: "tu",
    questions: [{ question: "Overwrite?", options: [{ label: "Yes" }, { label: "No" }] }],
  });

  // Without the catch-up drain this would be POSTed as a fresh prompt into a
  // blocked session and simply hang.
  await h.pump.handleText("Yes");

  assert.equal(ov.calls.filter((c) => c.path === "/api/prompt").length, 0);
  assert.equal(ov.calls.filter((c) => c.path === "/api/question-response").at(-1).body.answer, "Yes");
  h.pump.detach();
});

test("activity on another host fires a notification carrying a real preview", async (t) => {
  const ov = await startFakeEvenTerminal();
  const ch = await startFakeEvenTerminal();
  t.after(() => Promise.all([ov.close(), ch.close()]));
  ch.seed("b", { title: "long build", state: "busy" });

  const { fleet } = harness([ov, ch]);
  const watcher = new ActivityWatcher(fleet, { intervalMs: 50 });
  const seen = [];
  watcher.onActivity((e) => seen.push(e));
  t.after(() => watcher.stop());

  watcher.start();
  await sleep(150); // first tick primes; it must not notify about history

  ch.push("b", { type: "result", success: true, text: "Build green in 4m12s." });

  const event = await until(() => seen.find((e) => e.id === "ch/b"), 3_000);
  assert.equal(event.host, "ch");
  assert.equal(event.preview, "Build green in 4m12s.");
  assert.ok(event.finished, "busy -> idle is the transition worth a tap");
});

test("the watcher does not fire for sessions that existed before it started", async (t) => {
  const ov = await startFakeEvenTerminal();
  t.after(() => ov.close());
  ov.seed("old", { title: "ancient" });

  const { fleet } = harness([ov]);
  const watcher = new ActivityWatcher(fleet, { intervalMs: 30 });
  const seen = [];
  watcher.onActivity((e) => seen.push(e));
  t.after(() => watcher.stop());

  watcher.start();
  await sleep(200);
  assert.deepEqual(seen, []);
});
