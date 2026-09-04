/**
 * Host configuration. "Host" is config, never a constant — adding a third
 * machine is a line in hosts.json.
 *
 * A token is NEVER written into this file. It is named, either as an env var
 * (`tokenEnv`) or as a 1Password item (`tokenOp: "<vault>/<item-id>"`), and
 * resolved inside this process — so the secret never reaches a command line,
 * a shell history, or a transcript.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Resolve `"<vault>/<item-id-or-title>[/<field>]"` through the `op` CLI.
 * `--vault` is mandatory for a service account even when the item is addressed
 * by its unique id, so the vault is part of the reference by construction.
 */
export function readOp(ref) {
  const [vault, item, field = "password"] = String(ref).split("/");
  if (!vault || !item) throw new Error(`bad 1Password ref "${ref}" — want "<vault>/<item>[/<field>]"`);
  const r = spawnSync("op", ["item", "get", item, "--vault", vault, "--fields", field, "--reveal"], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`1Password read of "${ref}" failed: ${(r.stderr || "").trim()}`);
  const value = r.stdout.trim();
  if (!value) throw new Error(`1Password returned an empty value for "${ref}"`);
  return value;
}

function resolveToken(h, env) {
  if (h.tokenEnv && env[h.tokenEnv]) return env[h.tokenEnv];
  if (h.tokenOp) return readOp(h.tokenOp);
  if (h.token) return h.token;
  throw new Error(
    `host "${h.key}" has no token — set ${h.tokenEnv ?? "tokenOp"}. ` +
      `even-terminal 401s every route without one.`,
  );
}

export function loadHosts(path, env = process.env) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const hosts = Array.isArray(raw) ? raw : (raw.hosts ?? []);
  if (!hosts.length) throw new Error(`${path} defines no hosts`);

  return hosts.map((h) => {
    if (!h.key || !h.url) throw new Error(`host entry needs key and url: ${JSON.stringify(h)}`);
    return {
      key: h.key,
      name: h.name ?? h.key,
      url: h.url,
      token: resolveToken(h, env),
      provider: h.provider ?? "claude",
      // How this machine reaches that host's terminals. Absent = it has none.
      terminalSsh: h.terminalSsh,
    };
  });
}
