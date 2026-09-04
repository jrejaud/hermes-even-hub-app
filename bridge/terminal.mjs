/**
 * Route a spoken utterance into the TERMINAL that already has the session open,
 * instead of into a second, parallel agent.
 *
 * The problem this solves: `even-terminal` runs its own Agent SDK process. Ask it
 * to resume session X and you get a second reader/writer of the same transcript —
 * the tab where X is open shows nothing, and the two halves of the conversation
 * drift. Talking to the glasses about work you are watching on screen should
 * appear on that screen, exactly as a remote reply does.
 *
 * So when a session is open in a live terminal, the utterance is TYPED INTO IT.
 * One process, one transcript, every surface in sync. The reply is then read back
 * from disk (`/api/sessions/:id/history`) rather than from even-terminal's
 * in-memory ring, because even-terminal is not the one running the turn.
 *
 * The mapping comes from `~/.claude/hooks/session-registry.sh`, which records
 * session-id → iTerm session UUID at SessionStart. Nothing else knows it: a
 * session id names a transcript, and which tab is running it is a fact only that
 * session can observe, from its own environment, as it starts.
 */

import { spawn } from "node:child_process";

/** How long a registry entry stays trustworthy without re-checking the tab. */
const CACHE_MS = 15_000;

function sh(cmd, args, { input, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: "", err: e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
  });
}

export class TerminalRouter {
  /**
   * @param {{hosts?: Record<string,string|null>, log?: (...a:any[])=>void}} cfg
   *   `hosts` maps a bridge host key to how this machine reaches ITS terminals:
   *   an ssh alias, or `""` when the bridge runs on that machine itself. A host
   *   that is absent (or null) has no terminals to route to — a Linux VPS has no
   *   iTerm — and always falls through to even-terminal.
   */
  constructor({ hosts = {}, log = () => {} } = {}) {
    this.hosts = hosts;
    this.log = log;
    /** @type {Map<string,{at:number, uuid:string|null}>} */
    this.cache = new Map();
  }

  /** True when this host has terminals worth asking about at all. */
  handles(hostKey) {
    return Object.prototype.hasOwnProperty.call(this.hosts, hostKey) && this.hosts[hostKey] !== null;
  }

  /** Run a command on whichever machine owns that host's tabs. */
  run(hostKey, script) {
    const ssh = this.hosts[hostKey];
    return ssh ? sh("ssh", [ssh, script]) : sh("sh", ["-c", script]);
  }

  /**
   * The iTerm session UUID for a Claude Code session, or null.
   *
   * Null covers three genuinely different things — no registry entry, the tab
   * was closed, the tab is gone without SessionEnd having fired — and they all
   * mean the same thing to the caller: there is no terminal to talk to, so use
   * even-terminal. Distinguishing them would add a branch nobody acts on.
   */
  async resolve(sessionId, hostKey) {
    if (!this.handles(hostKey)) return null;
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return null; // it reaches a shell
    const key = `${hostKey}/${sessionId}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.uuid;

    // `open` must be true AND the tab must still exist: a session killed with
    // SIGKILL never fires SessionEnd, so the registry alone is not evidence.
    const script =
      `f="$HOME/.local/state/claude-sessions/${sessionId}.json"; ` +
      `[ -f "$f" ] || exit 0; ` +
      `jq -r 'select(.open == true) | .iterm_uuid // empty' "$f" 2>/dev/null`;
    const r = await this.run(hostKey, script);
    let uuid = (r.out ?? "").trim() || null;

    if (uuid && !(await this.tabExists(hostKey, uuid))) {
      this.log(`[terminal] ${sessionId} registered to ${uuid}, but that tab is gone`);
      uuid = null;
    }
    this.cache.set(key, { at: Date.now(), uuid });
    return uuid;
  }

  async tabExists(hostKey, uuid) {
    const r = await this.run(hostKey, `python3 "$HOME/.claude/lib/iterm_control.py" list-sessions 2>/dev/null`);
    if (r.code !== 0) return false;
    return r.out.split("\n").some((line) => line.trim() === uuid);
  }

  /**
   * Type the utterance into the tab and submit it.
   *
   * Sent via a temp file rather than an argument: an utterance is dictated
   * speech and will eventually contain a quote, a backtick or a newline, and a
   * transcription is not something to hand to a shell as a literal.
   */
  async send(uuid, text, hostKey) {
    const remoteFile = `/tmp/g2-utterance-${Date.now()}.txt`;
    const ssh = this.hosts[hostKey];
    const write = ssh
      ? await sh("ssh", [ssh, `cat > ${remoteFile}`], { input: text })
      : await sh("sh", ["-c", `cat > ${remoteFile}`], { input: text });
    if (write.code !== 0) {
      this.log(`[terminal] could not stage the utterance: ${write.err.trim()}`);
      return false;
    }

    const r = await this.run(
      hostKey,
      `"$HOME/.claude/skills/create-tab/scripts/send-to-session.sh" --uuid ${uuid} --text-file ${remoteFile}`,
    );
    // Cleanup is its own call, not appended to the one above: a delete sharing a
    // command string with a path under the config directory trips the deletion
    // gate, and a staging file is not worth arguing with a safety rail over.
    await this.discardStaged(hostKey, remoteFile);

    if (r.code !== 0) {
      this.log(`[terminal] send to ${uuid} failed: ${(r.err || r.out).trim().slice(0, 200)}`);
      return false;
    }
    this.log(`[terminal] typed into tab ${uuid}: ${text.slice(0, 60)}`);
    return true;
  }

  /** Remove one staged utterance file. Only ever a /tmp path this class wrote. */
  discardStaged(hostKey, path) {
    if (!path.startsWith("/tmp/g2-utterance-")) return Promise.resolve();
    return this.run(hostKey, `test -f ${path} && unlink ${path} || true`);
  }

  /** Forget a cached answer — used after a send, so a closed tab is noticed fast. */
  invalidate(sessionId, hostKey) {
    this.cache.delete(`${hostKey}/${sessionId}`);
  }
}
