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

import { active as activeFrame, askDone, assistant as assistantFrame, error as errorFrame, history as historyFrame, turnDone } from "./protocol.mjs";
import { framesFor, historyItems, withPreamble } from "./translate.mjs";
import { carriedCorrection, isResetUtterance, isStatusUtterance, permissionDecision, stripWakeWord } from "./answer.mjs";
import { isDeadSession } from "./even-terminal.mjs";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 400);
/** Two identical utterances this close together are one utterance, sent twice. */
const DEDUPE_WINDOW_MS = Number(process.env.DEDUPE_WINDOW_MS ?? 6_000);
/** Polls with no new transcript lines before a terminal-backed turn is called done. */
const TERMINAL_QUIET_TICKS = Number(process.env.TERMINAL_QUIET_TICKS ?? 6);
/** A terminal turn that produces nothing still has to end, or the lens sits on "thinking" forever. */
const TERMINAL_MAX_WAIT_MS = Number(process.env.TERMINAL_MAX_WAIT_MS ?? 300_000);

// LENS_PREAMBLE / withPreamble / stripPreamble live in translate.mjs, next to
// the history mapping that has to take the preamble back out again.
export { LENS_PREAMBLE, withPreamble } from "./translate.mjs";

export class SessionPump {
  /**
   * @param {import('./fleet.mjs').Fleet} fleet
   * @param {(frame: object) => void} emit
   */
  constructor(fleet, emit, { log = () => {}, terminal = null } = {}) {
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

    /** Routes an utterance into the tab that already has this session open. */
    this.terminal = terminal;
    /** True while the CURRENT turn is being run by a terminal, not even-terminal. */
    this.viaTerminal = false;
    /** How many disk-history items have already been emitted this turn. */
    this.historyCursor = 0;
    this.quietTicks = 0;
    this.sawReply = false;
    this.terminalSentAt = 0;
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

    // If this session is open in a live terminal, TYPE IT THERE instead.
    // Prompting even-terminal would start a second agent against the same
    // transcript: the tab shows nothing, and the two halves of the conversation
    // drift. One process, one transcript, every surface in sync.
    if (await this.routeToTerminal(text)) return;

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

  /**
   * Try to deliver the utterance to the terminal that owns this session.
   * Returns true when it was handled there; false to fall through to
   * even-terminal (no live tab, no router, or the send failed).
   *
   * The tradeoff, stated plainly: a terminal-backed turn is read back from the
   * transcript on disk, so there is NO token-by-token streaming — the reply
   * appears when it lands, not as it is written. That is the price of the tab
   * and the lens showing the same conversation, and it is the right trade: a
   * silent divergence between two agents is worse than a slower reply.
   */
  async routeToTerminal(text) {
    if (!this.terminal || !this.sessionId || !this.host) return false;
    const uuid = await this.terminal.resolve(this.sessionId, this.host.key);
    if (!uuid) return false;

    const items = await this.historyItemsSafe();
    if (!(await this.terminal.send(uuid, text, this.host.key, this.sessionId))) {
      this.terminal.invalidate(this.sessionId, this.host.key);
      this.log(`[pump] terminal send failed — falling back to even-terminal`);
      return false;
    }
    this.viaTerminal = true;
    this.historyCursor = items.length;
    this.sawReply = false;
    this.quietTicks = 0;
    this.terminalSentAt = Date.now();
    this.startPolling();
    return true;
  }

  async historyItemsSafe() {
    try {
      return historyItems(await this.host.history(this.sessionId));
    } catch {
      return [];
    }
  }

  /**
   * Read a terminal-backed turn back off disk.
   *
   * even-terminal is not running this turn, so its in-memory ring is empty and
   * `/api/messages` says nothing. The transcript is the only source. The turn is
   * treated as finished once the history stops growing for a few ticks — there
   * is no end-of-turn marker on disk to wait for.
   */
  async drainTerminal() {
    if (!this.attached) return;
    const items = await this.historyItemsSafe();
    if (items.length > this.historyCursor) {
      for (const item of items.slice(this.historyCursor)) {
        // The wearer's own line is already on the thread — the client appended
        // it when they tapped send. Re-emitting it would double it.
        if (item.kind === "assistant") {
          this.emit(assistantFrame(item.text));
          this.sawReply = true;
        }
      }
      this.historyCursor = items.length;
      this.quietTicks = 0;
      return;
    }

    // Quiet only counts AFTER something came back. Counting from the moment of
    // sending ends the turn during the agent's thinking time — the first live
    // run emitted turn.done with no reply at all, seconds before the answer
    // reached disk (2026-09-04).
    if (this.sawReply && ++this.quietTicks >= TERMINAL_QUIET_TICKS) return this.endTerminalTurn();

    // A turn that never produces anything still has to end, or the session is
    // stuck "thinking" on the lens forever.
    if (Date.now() - this.terminalSentAt > TERMINAL_MAX_WAIT_MS) {
      this.log(`[pump] terminal turn produced nothing in ${TERMINAL_MAX_WAIT_MS}ms`);
      this.endTerminalTurn();
    }
  }

  endTerminalTurn() {
    this.emit(turnDone());
    this.viaTerminal = false;
    this.quietTicks = 0;
    this.sawReply = false;
    this.terminalSentAt = 0;
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
    // A terminal-backed turn is not in even-terminal's ring at all — the tab is
    // running it, and the transcript on disk is the only place it appears.
    if (this.viaTerminal) return this.drainTerminal();
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
