/**
 * Host configuration. "Host" is config, never a constant — adding a third
 * machine is a line in hosts.json.
 *
 * Tokens are referenced by ENV NAME (`tokenEnv`), never written into the file,
 * so hosts.json is safe to commit as an example and safe to read on a shared box.
 */

import { readFileSync } from "node:fs";

export function loadHosts(path, env = process.env) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const hosts = Array.isArray(raw) ? raw : (raw.hosts ?? []);
  if (!hosts.length) throw new Error(`${path} defines no hosts`);

  return hosts.map((h) => {
    if (!h.key || !h.url) throw new Error(`host entry needs key and url: ${JSON.stringify(h)}`);
    const token = h.tokenEnv ? env[h.tokenEnv] : h.token;
    if (!token) {
      throw new Error(
        `host "${h.key}" has no token — set ${h.tokenEnv ?? "its `token` field"}. ` +
          `even-terminal 401s every route without one.`,
      );
    }
    return {
      key: h.key,
      name: h.name ?? h.key,
      url: h.url,
      token,
      provider: h.provider ?? "claude",
    };
  });
}
