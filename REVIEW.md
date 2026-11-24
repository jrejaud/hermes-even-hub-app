# What reviewers should hold this repo to

## Open gateway (`open-gateway/`) — who is trusted, and what must never happen

**Threat model.** One person runs the gateway on their own machine for their own glasses. Whoever holds
`GATEWAY_TOKEN` is that person: they start sessions and approve tool calls, so the token holder is fully trusted.
The guard is against **everyone without the token**: other devices on the network, the internet, a page in a
browser, and tools loaded into a session from somewhere else (a project's `.mcp.json`, user settings).

**Must never allow:**

- control of a session (create, say, answer, interrupt, cards) without the token
- a crash of the gateway from anything sent before or after auth (one process holds every session)
- a tool call that runs without a "yes" on the lens, except the gateway's own `mcp__glasses__show_card` matched by its
  exact name (it only draws on the lens), and whatever the person opted into with `PERMISSION_MODE`
- a "yes" to something the lens did not show whole. Enforced in TWO places: the gateway sends the whole target
  (whitespace runs collapsed, never cut) and offers or accepts Yes/Always only from a client that declared the
  `ask-whole` capability (`caps=` on its URL or in its auth frame; `offered()` in `open-gateway/core.mjs`), and every
  other client, such as an older lens build, gets only No. A lens declaring `ask-whole` measures the detail in pixels
  (`shownWhole` in `src/lens/layout.ts`; dropped glyphs count as not whole) and offers only No for what it cannot
  show whole. The client check is trusted only because the token holder chose to install that lens.
- the token or approvals crossing a network in cleartext by default (plain HTTP binds 127.0.0.1; TLS or
  `tailscale serve` for the phone)

**Out of scope:** a token holder misusing their own gateway; a local process on the same machine as the same user
(it can read the token from the environment anyway).
