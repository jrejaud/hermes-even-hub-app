/**
 * Turning a spoken sentence into an answer to a blocked agent.
 *
 * Every rule here was learned from a live failure in
 * `~/.claude/skills/even-realities/scripts/even-agent-webhook.mjs` and is
 * carried over deliberately rather than rediscovered. Pure functions, so the
 * rules are unit-tested instead of being re-verified by talking to glasses.
 */

const YES = /\b(yes|yeah|yep|yup|sure|ok|okay|allow|approve|go ahead|do it|permit)\b/i;
const ALWAYS = /\b(always|every time|from now on|don'?t ask)\b/i;
const NO = /\b(no|nope|don'?t|do not|deny|cancel|stop|refuse)\b/i;
const DECISION_WORDS =
  /\b(yes|yeah|yep|yup|sure|ok|okay|allow|approve|go ahead|do it|permit|no|nope|don'?t|do not|deny|cancel|stop|refuse|always|every time|from now on)\b/gi;

/**
 * Map an utterance onto one of even-terminal's permission option keys.
 *
 * DEFAULTS TO DENY. An ambiguous noise, or a sentence that was actually meant as
 * a new request, must never be read as consent to run something — the wearer is
 * not looking at a confirm button, and the machine is unattended.
 *
 * @param {string} utterance
 * @param {string[]} options  option keys the agent offered (allow/allowAlways/deny)
 */
export function permissionDecision(utterance, options = []) {
  const yes = YES.test(utterance);
  const no = NO.test(utterance);
  if (yes && !no) {
    return ALWAYS.test(utterance) && options.includes("allowAlways") ? "allowAlways" : "allow";
  }
  return "deny";
}

/**
 * What is left of an utterance once the yes/no words are removed.
 *
 * A yes/no prompt must not swallow a sentence carrying NEW INTENT. Live case:
 * asked to allow playing a song via Spotify, the answer was "No. Jellyfin, not
 * Spotify." — a correction, not a refusal. Mapping that to a bare deny threw the
 * instruction away and left a "Blocked." on the lens with no explanation. So if
 * anything substantive survives the strip, it gets resubmitted as a real prompt.
 *
 * Returns null when nothing substantive remains.
 */
export function carriedCorrection(utterance) {
  const remainder = utterance
    .replace(DECISION_WORDS, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return remainder.split(/\s+/).filter(Boolean).length >= 2 ? utterance : null;
}

/** True when the wearer is asking to abandon a session rather than talk to it. */
export function isResetUtterance(text) {
  return /^\s*(new chat|new session|new conversation|start over|reset|forget that|nevermind)\b/i.test(text);
}

/** True when the wearer wants whatever landed since the last look, not a new turn. */
export function isStatusUtterance(text) {
  return /^\s*(status|continue|and\s+then|go\s+on)\b/i.test(text);
}

/**
 * The wake word bleeds into a transcript — "Hey Even, what's up" arrives as
 * "Even what's up". Harmless here (this app has no wake word) but transcripts
 * still pick it up when the wearer speaks out of habit.
 */
export function stripWakeWord(text) {
  return text.replace(/^\s*(hey\s+)?even[\s,.:;!?-]+/i, "").trim();
}

/**
 * Render a permission_request for a 576x288 monochrome lens.
 * Shape from even-terminal dist/claude/session.js:
 *   {type, toolName, description, detail, toolUseId, options:[{text,key}], suggestions}
 */
export function describePermission(m) {
  const what = (m.description ?? m.detail ?? m.toolName ?? "this action").toString();
  return {
    kind: "permission",
    text: `Allow ${flatten(what).slice(0, 180)}? — say yes or no`,
    options: (m.options ?? []).map((o) => o.key).filter(Boolean),
    toolUseId: m.toolUseId,
  };
}

/**
 * Render a user_question. `questions` is an ARRAY — guessing `{question}` or
 * `{text}` put the literal string "Claude is asking: a question" on the lens
 * with the real content discarded (2026-09-03).
 */
export function describeQuestion(m) {
  const qs = Array.isArray(m.questions) ? m.questions : [];
  const first = qs[0];
  if (!first) {
    return { kind: "question", text: "Claude is asking something, but sent no question text.", options: [], toolUseId: m.toolUseId };
  }
  const options = (first.options ?? []).map((o) => o.label).filter(Boolean);
  return {
    kind: "question",
    text: flatten(first.question) + (options.length ? ` — say: ${options.join(", or ")}` : ""),
    options,
    toolUseId: m.toolUseId,
  };
}

function flatten(text) {
  return String(text).replace(/\s+/g, " ").trim();
}
