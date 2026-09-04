import assert from "node:assert/strict";
import test from "node:test";

import { startFakeEvenTerminal } from "./fake-even-terminal.mjs";
import { Fleet } from "../fleet.mjs";
import { SessionPump } from "../pump.mjs";
import { TerminalRouter } from "../terminal.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A router that answers from a script instead of touching ssh or iTerm. */
function fakeRouter({ tabs = {}, sendOk = true } = {}) {
  const sent = [];
  return {
    sent,
    handles: (hostKey) => hostKey === "ov",
    resolve: async (sessionId, hostKey) => (hostKey === "ov" ? (tabs[sessionId] ?? null) : null),
    send: async (uuid, text, hostKey) => {
      sent.push({ uuid, text, hostKey });
      return sendOk;
    },
    invalidate: () => {},
  };
}

function harness(host, terminal) {
  const frames = [];
  const fleet = new Fleet([{ key: "ov", name: "overlord", url: host.url, token: host.token }]);
  const pump = new SessionPump(fleet, (f) => frames.push(f), { terminal });
  return { fleet, pump, frames, of: (t) => frames.filter((f) => f.t === t) };
}

async function until(fn, ms = 4_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(25);
  }
  throw new Error("condition never became true");
}

test("a session open in a live terminal is TYPED INTO, not prompted twice", async (t) => {
  const ov = await startFakeEvenTerminal();
  t.after(() => ov.close());
  ov.seed("live", { title: "open in a tab", history: [{ role: "user", text: "hi" }] });

  const router = fakeRouter({ tabs: { live: "TAB-UUID" } });
  const h = harness(ov, router);
  await h.pump.attach("ov/live");
  await h.pump.handleText("restart the bridge");

  // The whole point: even-terminal must NOT be asked to run this turn, or two
  // agents write the same transcript and the tab shows none of it.
  assert.deepEqual(ov.calls.filter((c) => c.path === "/api/prompt"), []);
  assert.equal(router.sent.length, 1);
  assert.equal(router.sent[0].uuid, "TAB-UUID");
  assert.equal(router.sent[0].text, "restart the bridge");
  h.pump.detach();
});

test("the terminal's reply is read back off disk and closes the turn", async (t) => {
  const ov = await startFakeEvenTerminal();
  t.after(() => ov.close());
  ov.seed("live", { history: [{ role: "user", text: "hi" }] });

  const h = harness(ov, fakeRouter({ tabs: { live: "TAB-UUID" } }));
  await h.pump.attach("ov/live");
  await h.pump.handleText("restart the bridge");

  // even-terminal is not running this turn, so its message ring stays empty —
  // the transcript is the only place the answer appears.
  ov.sessions.get("live").history.push({ role: "assistant", text: "Bridge is back up." });

  const said = await until(() => h.of("assistant").find((f) => f.text === "Bridge is back up."));
  assert.ok(said);
  await until(() => h.of("turn.done").length);
  h.pump.detach();
});

test("no live tab falls through to even-terminal unchanged", async (t) => {
  const ov = await startFakeEvenTerminal();
  t.after(() => ov.close());
  ov.seed("headless", {});

  const h = harness(ov, fakeRouter({ tabs: {} }));
  await h.pump.attach("ov/headless");
  await h.pump.handleText("what is running");

  assert.equal(ov.calls.filter((c) => c.path === "/api/prompt").length, 1);
  h.pump.detach();
});

test("a failed send falls back rather than losing the utterance", async (t) => {
  const ov = await startFakeEvenTerminal();
  t.after(() => ov.close());
  ov.seed("live", {});

  // The tab resolved but typing into it failed — the wearer already spoke, so
  // dropping it silently is the one unacceptable outcome.
  const h = harness(ov, fakeRouter({ tabs: { live: "TAB-UUID" }, sendOk: false }));
  await h.pump.attach("ov/live");
  await h.pump.handleText("deploy it");

  assert.equal(ov.calls.filter((c) => c.path === "/api/prompt").length, 1);
  h.pump.detach();
});

test("a host with no terminals is never asked about them", async (t) => {
  const ov = await startFakeEvenTerminal();
  t.after(() => ov.close());
  const router = new TerminalRouter({ hosts: { ov: "" } });
  assert.equal(router.handles("ov"), true);
  assert.equal(router.handles("ch"), false);
  assert.equal(await router.resolve("anything", "ch"), null);
  await ov.close();
});

test("a session id that is not a plain identifier never reaches a shell", async () => {
  const router = new TerminalRouter({ hosts: { ov: "" } });
  for (const bad of ["a; rm -rf ~", "$(whoami)", "../../etc/passwd", "a`id`b"]) {
    assert.equal(await router.resolve(bad, "ov"), null, bad);
  }
});
