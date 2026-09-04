/**
 * even-terminal messages -> glasses protocol frames.
 *
 * Pure, so the mapping is unit-tested against recorded message shapes instead of
 * being verified by wearing glasses. Message types are from
 * `@evenrealities/even-terminal` dist/claude/session.js, read directly:
 *
 *   text_delta        {text}
 *   result            {success, text, sessionId, costUsd, turns, durationMs, ...}
 *   tool_start        {name, toolId}
 *   tool_end          {name, toolId, summary, detail:{input, output}}
 *   permission_request{toolName, description, detail, toolUseId, options:[{text,key}], suggestions}
 *   user_question     {toolUseId, questions:[{question, header, options:[{label,description,preview}]}]}
 *   status            {state}      state: busy | idle | text_start | text_end | think_start | think_end
 *   error             {message}
 *   notification      {...}
 */

import { assistant, assistantDelta, ask, askDone, error, toolEnd, toolStart, turnDone } from "./protocol.mjs";
import { describePermission, describeQuestion } from "./answer.mjs";

/**
 * @param {object[]} messages
 * @returns {{frames: object[], ask: object|null, answered: boolean, lastId: number}}
 *   `ask` is the newest outstanding permission/question, which the caller must
 *   remember: it owns the wearer's next utterance.
 */
export function framesFor(messages) {
  const frames = [];
  let pending = null;
  let answered = false;
  let lastId = 0;

  for (const m of messages ?? []) {
    if (typeof m?.id === "number") lastId = Math.max(lastId, m.id);

    switch (m.type) {
      case "text_delta": {
        const text = m.text ?? "";
        if (text) frames.push(assistantDelta(text));
        break;
      }

      case "result": {
        // The authoritative end-of-turn text; replaces the streamed segment
        // rather than appending to it.
        const text = (m.text ?? "").trim();
        if (text) frames.push(assistant(text));
        frames.push(turnDone());
        // A turn that reaches `result` cannot still be blocked on an ask.
        if (pending) { pending = null; answered = true; frames.push(askDone()); }
        break;
      }

      case "tool_start":
        frames.push(toolStart(m.name ?? m.tool ?? "tool"));
        break;

      case "tool_end":
        frames.push(toolEnd(m.name ?? m.tool ?? "tool", !isToolError(m)));
        break;

      case "permission_request": {
        pending = describePermission(m);
        frames.push(ask("permission", pending.text, pending.options));
        break;
      }

      case "user_question": {
        pending = describeQuestion(m);
        frames.push(ask("question", pending.text, pending.options));
        break;
      }

      case "error":
        frames.push(error(String(m.message ?? "unknown error").slice(0, 200)));
        break;

      case "status":
      case "notification":
      default:
        break;
    }
  }

  return { frames, ask: pending, answered, lastId };
}

/**
 * even-terminal does not put an `ok` on tool_end, so failure has to be inferred.
 * Default to success: a tool wrongly shown as failed is more alarming on a lens
 * than one wrongly shown as fine, and the assistant text says what happened.
 */
function isToolError(m) {
  if (m.isError === true) return true;
  const output = m.detail?.output;
  if (output && typeof output === "object" && output.is_error === true) return true;
  return false;
}

/**
 * Sent once per session, never per turn, and APPENDED rather than prepended.
 *
 * even-terminal titles a session from the opening characters of its first
 * prompt, so a prepended preamble made every glasses-spawned session show up in
 * the list as "[You are being read on Even Realities G2 smart displa…" — the
 * same useless title on every row (seen live, 2026-09-04). Trailing it keeps the
 * wearer's own words as the title, and instructions at the end of a prompt are
 * if anything better attended to.
 */
export const LENS_PREAMBLE =
  "[You are being read on Even Realities G2 smart glasses: a 576x288 monochrome " +
  "heads-up display showing about 10 short lines at a time, read at a glance. Reply in " +
  "plain text. No markdown, no bullet lists, no tables, no code fences — those characters " +
  "render literally and waste the screen. Keep answers to a few short sentences unless " +
  "asked for more. The wearer answers by SPEAKING, so if you need a decision use " +
  "AskUserQuestion with short, distinct, easily-spoken option labels.]";

export const withPreamble = (text) => `${text}\n\n${LENS_PREAMBLE}`;

/**
 * Take the preamble back OUT when replaying a session's history.
 *
 * It is an instruction to the agent, not something the wearer said — and left in
 * it ate most of a 10-line screen with the app lecturing itself about how to use
 * the screen (seen live in the simulator, 2026-09-04). Matched loosely on the
 * bracketed block so an older session written by a previous wording is cleaned
 * up too.
 */
export function stripPreamble(text) {
  return String(text)
    .replace(/\[You are being read on Even Realities G2[\s\S]*?\]\s*$/i, "")
    .replace(/^\s*\[You are (?:being read on|answering out loud on) [\s\S]*?\]\s*/i, "")
    .trim();
}

/**
 * Disk history (`GET /api/sessions/:id/history` -> [{role,text}]) as thread items.
 * Used when opening an existing session, before the live pump takes over.
 */
export function historyItems(history) {
  const items = [];
  for (const h of history ?? []) {
    const text = (h.role === "user" ? stripPreamble(h.text ?? "") : (h.text ?? "")).trim();
    if (!text) continue;
    items.push(h.role === "user" ? { kind: "user", text } : { kind: "assistant", text });
  }
  return items;
}
