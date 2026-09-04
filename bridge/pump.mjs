/**
 * Drives ONE active Claude Code session for one glasses connection: attach,
 * stream, and route the wearer's next utterance to the right endpoint.
 *
 * The routing rules are the load-bearing part, all ported from
 * `even-agent-webhook.mjs` where each was learned from a live failure:
 *
 *   - an outstanding permission or question OWNS the next utterance, otherwise
 *     the agent sits blocked (60s) and auto-answers while the wearer talks past it
 *   - a permission answer DEFAULTS TO DENY, and any correction inside it is
 *     carried forward as a real prompt instead of being thrown away
 *   - a remembered session can die underneath us; respawn instead of reporting it
 *   - catch up on anything raised after we stopped listening, before routing
 */

import { active as activeFrame, askDone, error as errorFrame, history as historyFrame } from "./protocol.mjs";
import { framesFor, historyItems, withPreamble } from "./translate.mjs";
import { carriedCorrection, isResetUtterance, isStatusUtterance, permissionDecision, stripWakeWord } from "./answer.mjs";
import { isDeadSession } from "./even-terminal.mjs";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 400);
/** Two identical utterances this close together are one utterance, sent twice. */
const DEDUPE_WINDOW_MS = Number(process.env.DEDUPE_WINDOW_MS ?? 6_000);

// LENS_PREAMBLE / withPreamble / stripPreamble live in translate.mjs, next to
// the history mapping that has to take the preamble back out again.
export { LENS_PREAMBLE, withPreamble } from "./translate.mjs";

export class SessionPump {
  /**
   * @param {import('./fleet.mjs').Fleet} fleet
   * @param {(frame: object) => void} emit
   */
  constructor(fleet, emit, { log = () => {} } = {}) {
    this.fleet = fleet;
    this.emit = emit;
    this.log = log;

    this.host = null;
    this.sessionId = null;
    /** Composite id, or null when a `＋New` row was picked but nothing spawned yet. */
    this.compositeId = null;
    /** Host a not-yet-spawned session will land on. */
    this.pendingHost = null;
    this.lastSeenId = 0;
    this.pendingAsk = null;
    this.primed = false;
    this.lastPrompt = { text: null, at: 0 };
    this.timer = undefined;
  }

  get attached() {
    return Boolean(this.host && this.sessionId);
  }

  /** Open an existing session: replay its thread, then stream from now on. */
  async attach(compositeId) {
    const resolved = this.fleet.resolve(compositeId);
    if (!resolved) {
      this.emit(errorFrame(`unknown session ${compositeId}`));
      return;
    }
    this.stopPolling();
    this.host = resolved.host;
    this.sessionId = resolved.sessionId;
    this.compositeId = compositeId;
    this.pendingHost = null;
    this.pendingAsk = null;
    this.primed = false;
    this.lastSeenId = 0;

    this.emit(activeFrame(compositeId));

    let items = [];
    let ok = true;
    try {
      items = historyItems(await this.host.history(this.sessionId));
    } catch (err) {
      ok = false;
      this.log(`[pump] history for ${compositeId} failed: ${err.message}`);
    }

    // Everything already in the in-memory ring belongs to a turn that is still
    // running, so it is NOT on disk yet. Replay it when busy; discard it when
    // idle, where it would duplicate the history we just sent.
    try {
      const r = await this.host.messages(this.sessionId, 0);
      const msgs = r.messages ?? [];
      this.lastSeenId = msgs.length ? msgs[msgs.length - 1].id : 0;
      if (r.state === "busy") {
        const live = framesFor(msgs);
        this.pendingAsk = live.ask;
        this.emit(historyFrame(compositeId, items, ok));
        for (const f of live.frames) this.emit(f);
      } else {
        this.emit(historyFrame(compositeId, items, ok));
      }
    } catch (err) {
      this.log(`[pump] cursor for ${compositeId} failed: ${err.message}`);
      this.emit(historyFrame(compositeId, items, ok));
    }

    this.primed = true;
    this.startPolling();
  }

  /**
   * Arm a new session on `hostKey`. even-terminal has no create route — a
   * session comes into existence when `POST /api/prompt` runs without a
   * sessionId — so this only records the choice; the first utterance spawns it.
   */
  armNew(hostKey) {
    this.stopPolling();
    const key = this.fleet.hosts.has(hostKey) ? hostKey : this.fleet.defaultHost;
    this.host = this.fleet.host(key);
    this.sessionId = null;
    this.compositeId = null;
    this.pendingHost = key;
    this.pendingAsk = null;
    this.lastSeenId = 0;
    this.primed = true;
    this.emit(historyFrame(`${key}/new`, [], true));
  }

  detach() {
    this.stopPolling();
    this.host = null;
    this.sessionId = null;
    this.compositeId = null;
    this.pendingHost = null;
    this.pendingAsk = null;
    this.lastSeenId = 0;
  }

  /** The wearer said something. Route it; do not assume it is a new prompt. */
  async handleText(rawText) {
    const text = stripWakeWord(String(rawText ?? "")).trim();
    if (!text) return;
    if (!this.host) {
      this.emit(errorFrame("no session open"));
      return;
    }

    // A question or permission can arrive AFTER we stopped looking. The session
    // is then blocked and will not accept a new prompt — it just hangs. So drain
    // once before routing anything.
    if (this.sessionId && !this.pendingAsk) await this.drain();

    if (this.pendingAsk?.kind === "permission") return this.answerPermission(text);
    if (this.pendingAsk?.kind === "question") return this.answerQuestion(text);

    if (isResetUtterance(text)) {
      // A session can become unusable while still alive — e.g. it judged
      // something a prompt injection and now refuses that whole topic. Without
      // an escape the wearer is stuck in it with no keyboard.
      const host = this.host.key;
      this.log(`[pump] reset — dropping ${this.compositeId ?? "(none)"}`);
      this.armNew(host);
      return;
    }

    if (isStatusUtterance(text) && this.sessionId) {
      // The stream already carries everything; a "status" utterance must not be
      // sent to the agent as a prompt or it answers the word "status".
      await this.drain();
      return;
    }

    await this.prompt(text);
  }

  async prompt(text) {
    const now = Date.now();
    if (this.lastPrompt.text === text && now - this.lastPrompt.at < DEDUPE_WINDOW_MS) {
      this.log(`[pump] dropped duplicate utterance`);
      return;
    }
    this.lastPrompt = { text, at: now };

    const body = this.sessionId ? text : withPreamble(text);
    let spawned;
    try {
      spawned = await this.host.prompt(body, this.sessionId ?? undefined);
    } catch (err) {
      if (this.sessionId && isDeadSession(err)) {
        this.log(`[pump] session ${this.sessionId} is gone — starting a fresh one`);
        this.sessionId = null;
        this.lastSeenId = 0;
        spawned = await this.host.prompt(withPreamble(text)).catch((e) => {
          this.emit(errorFrame(e.message));
          return null;
        });
      } else {
        this.emit(errorFrame(err.message));
        return;
      }
    }
    if (!spawned?.sessionId) return;

    if (spawned.sessionId !== this.sessionId) {
      this.sessionId = spawned.sessionId;
      this.lastSeenId = 0;
      this.compositeId = `${this.host.key}/${this.sessionId}`;
      this.pendingHost = null;
      this.fleet.invalidate();
      this.emit(activeFrame(this.compositeId));
    }
    this.startPolling();
  }

  async answerPermission(utterance) {
    const p = this.pendingAsk;
    this.pendingAsk = null;
    const decision = permissionDecision(utterance, p.options);
    this.log(`[pump] permission "${utterance.slice(0, 60)}" -> ${decision}`);

    try {
      await this.host.permissionResponse(this.sessionId, decision);
    } catch (err) {
      this.emit(errorFrame(err.message));
      return;
    }
    this.emit(askDone());

    const correction = carriedCorrection(utterance);
    if (correction) {
      this.log(`[pump] carrying the correction forward as a new prompt`);
      // Let the denial land before re-prompting, or the session is still unwinding.
      await sleep(600);
      this.lastPrompt = { text: null, at: 0 }; // a correction is never a duplicate
      await this.prompt(correction);
      return;
    }
    this.startPolling();
  }

  async answerQuestion(utterance) {
    this.pendingAsk = null;
    this.log(`[pump] answering question with: ${utterance.slice(0, 60)}`);
    try {
      await this.host.questionResponse(this.sessionId, utterance);
    } catch (err) {
      this.emit(errorFrame(err.message));
      return;
    }
    this.emit(askDone());
    this.startPolling();
  }

  async interrupt() {
    if (!this.attached) return;
    try {
      await this.host.interrupt(this.sessionId);
    } catch (err) {
      this.log(`[pump] interrupt failed: ${err.message}`);
    }
  }

  /** One poll: pull everything new and turn it into frames. */
  async drain() {
    if (!this.attached) return;
    let r;
    try {
      r = await this.host.messages(this.sessionId, this.lastSeenId);
    } catch (err) {
      if (isDeadSession(err)) {
        this.log(`[pump] active session vanished; detaching`);
        this.stopPolling();
        this.sessionId = null;
        return;
      }
      this.log(`[pump] drain failed: ${err.message}`);
      return;
    }

    const msgs = r.messages ?? [];
    if (!msgs.length) return;
    const { frames, ask, lastId } = framesFor(msgs);
    if (lastId) this.lastSeenId = Math.max(this.lastSeenId, lastId);
    if (ask) this.pendingAsk = ask;
    for (const f of frames) this.emit(f);
  }

  startPolling() {
    if (this.timer || !this.attached) return;
    this.timer = setInterval(() => void this.drain(), POLL_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stopPolling() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
