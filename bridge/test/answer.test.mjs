import assert from "node:assert/strict";
import test from "node:test";

import {
  carriedCorrection,
  describePermission,
  describeQuestion,
  isResetUtterance,
  isStatusUtterance,
  permissionDecision,
  stripWakeWord,
} from "../answer.mjs";

test("a clear yes allows", () => {
  for (const u of ["yes", "yeah go ahead", "sure, do it", "okay", "approve that"]) {
    assert.equal(permissionDecision(u, ["allow", "deny"]), "allow", u);
  }
});

test("a clear no denies", () => {
  for (const u of ["no", "nope", "don't", "deny that", "cancel", "stop"]) {
    assert.equal(permissionDecision(u, ["allow", "deny"]), "deny", u);
  }
});

test("ambiguity DEFAULTS TO DENY — the machine is unattended", () => {
  for (const u of ["", "uh", "hmm what", "the weather is nice", "maybe later"]) {
    assert.equal(permissionDecision(u, ["allow", "allowAlways", "deny"]), "deny", JSON.stringify(u));
  }
});

test("yes AND no in one sentence denies", () => {
  assert.equal(permissionDecision("yes but no don't", ["allow", "deny"]), "deny");
});

test("'always' upgrades to allowAlways only when the agent offered it", () => {
  assert.equal(permissionDecision("yes, always", ["allow", "allowAlways", "deny"]), "allowAlways");
  assert.equal(permissionDecision("yes, always", ["allow", "deny"]), "allow");
});

test("a correction inside a refusal is carried forward, not thrown away", () => {
  // The live case: "No. Jellyfin, not Spotify." was a correction, and mapping it
  // to a bare deny left "Blocked." on the lens with the instruction discarded.
  const utterance = "No. Jellyfin, not Spotify.";
  assert.equal(permissionDecision(utterance, ["allow", "deny"]), "deny");
  assert.equal(carriedCorrection(utterance), utterance);
});

test("a bare yes or no carries nothing forward", () => {
  for (const u of ["yes", "no", "nope", "okay", "deny"]) {
    assert.equal(carriedCorrection(u), null, u);
  }
});

test("reset and status utterances are recognised", () => {
  assert.ok(isResetUtterance("new session"));
  assert.ok(isResetUtterance("start over please"));
  assert.ok(!isResetUtterance("start the deploy"));
  assert.ok(isStatusUtterance("status"));
  assert.ok(isStatusUtterance("continue"));
  assert.ok(!isStatusUtterance("statuses of the pods"));
});

test("the wake word is stripped when spoken out of habit", () => {
  assert.equal(stripWakeWord("Even, what's on my calendar"), "what's on my calendar");
  assert.equal(stripWakeWord("hey Even run the tests"), "run the tests");
  assert.equal(stripWakeWord("evening plans"), "evening plans");
});

test("a permission request renders with its yes/no cue and option keys", () => {
  const d = describePermission({
    type: "permission_request",
    toolName: "Bash",
    description: "Run `rm -rf build`",
    toolUseId: "tu_1",
    options: [{ text: "Allow", key: "allow" }, { text: "Always", key: "allowAlways" }, { text: "Deny", key: "deny" }],
  });
  assert.equal(d.kind, "permission");
  assert.match(d.text, /^Allow Run `rm -rf build`\? — say yes or no$/);
  assert.deepEqual(d.options, ["allow", "allowAlways", "deny"]);
});

test("a user_question reads its ARRAY of questions, not a guessed {question}", () => {
  // Guessing {question}/{text} here put the literal "Claude is asking: a
  // question" on the lens with the real content discarded (2026-09-03).
  const d = describeQuestion({
    type: "user_question",
    toolUseId: "tu_2",
    questions: [{
      question: "Tea or coffee?",
      header: "Drink",
      options: [{ label: "Tea", description: "" }, { label: "Coffee", description: "" }],
    }],
  });
  assert.equal(d.kind, "question");
  assert.equal(d.text, "Tea or coffee? — say: Tea, or Coffee");
  assert.deepEqual(d.options, ["Tea", "Coffee"]);
});

test("a question with no questions array degrades to a sentence, not a crash", () => {
  const d = describeQuestion({ type: "user_question", toolUseId: "x" });
  assert.match(d.text, /sent no question text/);
});
