import assert from "node:assert/strict";
import test from "node:test";

import { framesFor, historyItems, stripPreamble, withPreamble, LENS_PREAMBLE } from "../translate.mjs";
import { compositeId, splitId } from "../protocol.mjs";

test("text_delta streams, result replaces and closes the turn", () => {
  const { frames } = framesFor([
    { id: 1, type: "text_delta", text: "Deploy" },
    { id: 2, type: "text_delta", text: "ing…" },
    { id: 3, type: "result", success: true, text: "Deployed to prod." },
  ]);
  assert.deepEqual(frames, [
    { t: "assistant.delta", text: "Deploy" },
    { t: "assistant.delta", text: "ing…" },
    { t: "assistant", text: "Deployed to prod." },
    { t: "turn.done" },
  ]);
});

test("tool_start/tool_end become the terminal-style rows", () => {
  const { frames } = framesFor([
    { id: 1, type: "tool_start", name: "Bash", toolId: "t1" },
    { id: 2, type: "tool_end", name: "Bash", toolId: "t1", summary: "npm test" },
  ]);
  assert.deepEqual(frames, [
    { t: "tool.start", name: "Bash" },
    { t: "tool.end", name: "Bash", ok: true },
  ]);
});

test("a tool that reported an error is marked failed", () => {
  const { frames } = framesFor([
    { id: 1, type: "tool_end", name: "Bash", detail: { output: { is_error: true } } },
  ]);
  assert.deepEqual(frames, [{ t: "tool.end", name: "Bash", ok: false }]);
});

test("a permission request surfaces as an ask the caller must remember", () => {
  const { frames, ask } = framesFor([
    {
      id: 7,
      type: "permission_request",
      toolName: "Bash",
      description: "Run `git push`",
      toolUseId: "tu",
      options: [{ text: "Allow", key: "allow" }, { text: "Deny", key: "deny" }],
    },
  ]);
  assert.equal(frames[0].t, "ask");
  assert.equal(frames[0].ask, "permission");
  assert.deepEqual(frames[0].options, ["allow", "deny"]);
  assert.equal(ask.kind, "permission");
});

test("a result clears an outstanding ask", () => {
  const { frames, ask } = framesFor([
    { id: 1, type: "user_question", toolUseId: "tu", questions: [{ question: "Which?", options: [{ label: "A" }] }] },
    { id: 2, type: "result", success: true, text: "Done." },
  ]);
  assert.equal(ask, null);
  assert.ok(frames.some((f) => f.t === "ask.done"));
});

test("status and notification messages are swallowed, not rendered", () => {
  const { frames } = framesFor([
    { id: 1, type: "status", state: "busy" },
    { id: 2, type: "status", state: "think_start" },
    { id: 3, type: "notification", text: "whatever" },
  ]);
  assert.deepEqual(frames, []);
});

test("the cursor advances to the highest message id seen", () => {
  const { lastId } = framesFor([{ id: 4, type: "text_delta", text: "a" }, { id: 9, type: "text_delta", text: "b" }]);
  assert.equal(lastId, 9);
});

test("an unknown message type is ignored rather than throwing", () => {
  const { frames } = framesFor([{ id: 1, type: "some_future_type", payload: 1 }]);
  assert.deepEqual(frames, []);
});

test("disk history maps roles onto thread items and drops blanks", () => {
  assert.deepEqual(
    historyItems([{ role: "user", text: "hi" }, { role: "assistant", text: "  " }, { role: "assistant", text: "hello" }]),
    [{ kind: "user", text: "hi" }, { kind: "assistant", text: "hello" }],
  );
});

test("composite ids round-trip and reject malformed input", () => {
  const id = compositeId("ch", "92564c80-d77d-4d91-8390-9db43f24e92f");
  assert.equal(id, "ch/92564c80-d77d-4d91-8390-9db43f24e92f");
  assert.deepEqual(splitId(id), { host: "ch", sessionId: "92564c80-d77d-4d91-8390-9db43f24e92f" });
  for (const bad of ["", "nohost", "/leading", "trailing/", null, 42]) {
    assert.equal(splitId(bad), null, JSON.stringify(bad));
  }
});

test("the lens preamble is taken back out when replaying history", () => {
  // It is an instruction to the agent, not something the wearer said. Left in,
  // it ate most of a 10-line screen with the app lecturing itself about how to
  // use the screen (seen live in the simulator, 2026-09-04).
  const prompted = withPreamble("check the deploy");
  const items = historyItems([
    { role: "user", text: prompted },
    { role: "assistant", text: "Deploy is green." },
  ]);
  assert.deepEqual(items, [
    { kind: "user", text: "check the deploy" },
    { kind: "assistant", text: "Deploy is green." },
  ]);
});

test("an older leading-preamble session is cleaned up too", () => {
  const legacy = `${LENS_PREAMBLE}\n\nwhat is running`;
  assert.equal(stripPreamble(legacy), "what is running");
  // And the even-agent-webhook wording, for sessions that shim created.
  assert.equal(
    stripPreamble('[You are answering out loud on smart glasses: keep it short.]\n\nhello'),
    "hello",
  );
});

test("a user turn that is ONLY the preamble disappears rather than showing blank", () => {
  assert.deepEqual(historyItems([{ role: "user", text: LENS_PREAMBLE }]), []);
});
