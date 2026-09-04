# claude-code-g2-hub

Drive **Claude Code sessions on any number of machines** from Even Realities G2
smart glasses. Talk to a session, watch the reply stream on the lens, approve a
blocked tool call by saying "yes", and get tapped on the shoulder when a session
on another host finishes.

It is an ordinary **Even Hub app**, which is the entire point. The G2's built-in
Terminal mode does something similar but is *modal and exclusive*: entering it
disables the rest of the glasses. This multitasks like any other Hub app.

> Forked from **[huntsyea/hermes-even-hub-app](https://github.com/huntsyea/hermes-even-hub-app)** (MIT),
> whose list-first, voice-only, terminal-styled UI already mirrored Terminal mode.
> The client's structure, gesture model and measured text wrapping are its work.
> This fork replaces the backend: the Hermes bridge is gone, and in its place is
> one that speaks `even-terminal`'s HTTP API across several hosts.

## Architecture

```
G2 glasses (576×288 + mic)
        ▲
        │  Even Hub WebView, on the phone
  this app (TypeScript / Vite)
        │  JSON frames + PCM, wss:// over Tailscale
        ▼
  bridge/  (Node, no build step)
        │  HTTP, one client per host
        ├──▶ even-terminal :3457 on overlord ──▶ Claude Code
        └──▶ even-terminal :3457 on chiba    ──▶ Claude Code
```

**Host is config, not a constant.** Adding a third machine is a line in
`bridge/hosts.json`. A host that is unreachable contributes no sessions and never
fails the list — an ad-hoc `even-terminal` on a laptop is offline most of the
time by design.

## What it does

- **One session list across every machine.** Newest first, each row tagged with
  the host it lives on, `*` for activity you have not seen. One `＋New` row per
  host, so choosing where a session spawns costs no extra screen or gesture.
- **Streaming replies** with tool-call rows (`/ Bash` running → `/ Bash ok`).
- **Voice in.** Tap to record, tap to stop, review the transcript, tap to send.
  Transcription runs on the bridge (`whisper.cpp` locally, or any
  OpenAI-compatible endpoint).
- **Permission prompts and `AskUserQuestion` answered by speaking.** The bridge
  routes your next utterance to the right endpoint instead of starting a new turn.
  **An ambiguous answer denies** — see below.
- **Activity notifications with tap-to-open.** A session elsewhere finishes; the
  lens says which machine and what it said; a tap goes straight there.

## Interaction model

Boots to the session list; open or create a session, then drive it by voice.

| State | Swipe ↑/↓ | Tap | Double-press |
|-------|-----------|-----|--------------|
| **List** | scroll sessions | open row / `＋New` | **exit app** |
| **Session · idle** | scroll history | **start recording** | back to list |
| **Session · recording** | — | stop → transcribe → review | cancel |
| **Session · review** | ↓ = **redo** | **send** | back to list (discard) |
| **Alert** | dismiss | **open that session** | dismiss |

The alert is its own screen rather than an overlay, because inside a session a
tap already means "record" — an alert borrowing that gesture would be ambiguous
exactly when it matters. It never appears while you are recording.

## The rules that are load-bearing

These are ported from `even-agent-webhook.mjs`, where each was learned from a
live failure. They are unit-tested rather than re-verified by wearing glasses.

- **An ambiguous permission answer DENIES.** A mumble, or a sentence meant as a
  new request, must never read as consent to run something on an unattended
  machine.
- **A correction inside a refusal is carried forward.** "No. Jellyfin, not
  Spotify." denies the call *and* resubmits the instruction. Mapping it to a bare
  deny threw the correction away and left "Blocked." on the lens.
- **An outstanding ask owns the next utterance.** Otherwise the agent sits
  blocked for 60s and auto-answers while the wearer talks past it — including an
  ask raised *after* the app stopped listening, which is why every utterance
  drains once before it is routed.
- **A dead session is respawned, not reported.** A remembered session can be
  archived or deleted underneath you; that is recoverable, not news.
- **"new session" escapes a poisoned session.** A session can stay alive but
  refuse a topic; without an escape the wearer is stuck in it with no keyboard.

## Setup

**1. Run `even-terminal` on each host** (Even Realities' own package). Use a
fixed `--token` — without it a restart mints a new one and invalidates the
phone's pairing. Never pass `--cwd`; it silently empties the session list.

**2. Configure the bridge.** Copy `bridge/hosts.example.json` to
`bridge/hosts.json`. Tokens are named, never written in:

```jsonc
{ "hosts": [
  { "key": "ov", "name": "overlord", "url": "http://100.x.x.x:3457",
    "tokenOp": "Shared/<1password-item-id>" },
  { "key": "ch", "name": "chiba", "url": "http://100.x.x.x:3457",
    "tokenEnv": "EVEN_TERMINAL_TOKEN_CH" }
]}
```

**3. Run the bridge** (`bridge/.env` or the environment):

```bash
BRIDGE_TOKEN=<shared secret the phone will use>   # or BRIDGE_TOKEN_OP=<vault/item>
STT_ENGINE=whispercpp
WHISPER_MODEL=/path/to/ggml-large-v3-turbo.bin

npm --prefix bridge start
```

**4. Give it TLS** — the Even app requires an HTTPS/WSS origin:

```bash
tailscale serve --https=8791 --bg http://localhost:8791
```

**5. Point the app at it.** How depends on which build you packed — see below.

## Build modes, and where credentials come from

Vite only loads a mode's own env files, and `import.meta.env.VITE_*` is inlined
as a **string literal** at build time. So which mode you build in is the only
thing that decides whether a package carries credentials. There is no runtime
guard, deliberately: a guard stops a value being *used*, not being *shipped*.

| Build | Env file loaded | Result |
|---|---|---|
| `npm run dev` | `.env.development.local` | the simulator connects — there is no phone in it to configure |
| `npm run pack` | `.env.beta.local` | **testing-group build: bridge URL + token baked in**, installs and just runs |
| `npm run pack:release` | *(neither)* | nothing baked; the phone setup form is the only way in |

```bash
# write .env.beta.local from the DEPLOYED bridge (token resolved from 1Password,
# never on a command line)
node bridge/cli.mjs beta-env --url wss://<node>.<tailnet>.ts.net:8791
npm run pack
```

A stored profile always beats a baked-in one, so the phone form stays a working
override rather than dead weight.

🔑 **Baking a token is acceptable only while the bridge is `tailscale serve` with
no funnel.** It is then unreachable from the public internet, so the token is
useless to anyone not already on the tailnet — that network boundary, not the
token, is the real control. Anyone with an `.ehpk` can extract what is inside it,
so **if the bridge is ever exposed publicly, stop baking and require the form.**

`scripts/check-no-secrets.mjs` enforces both directions and runs inside `pack`:
in `beta` it asserts the two intended values *are* present (a beta build that
boots to a setup screen is a broken beta build) and that nothing from any other
env file is; in `release` it fails on anything at all.

## Commands

```bash
npm run dev          # Vite dev server (for the simulator or sideloading)
npm run sim          # Even Hub simulator, automation on :9898
npm run sim:check    # scripted smoke test against the simulator
npm run qr           # QR for sideloading to real glasses
npm run pack         # build + package as .ehpk
npm test             # client tests (vitest)
npm run test:bridge  # bridge tests (node --test)
npm run test:all     # both
npm run bridge       # start the bridge
```

### Driving the real protocol from a terminal

`bridge/cli.mjs` speaks the same frames the glasses do. This is how you tell a
bridge problem from an app problem, and how you reproduce a report from the
glasses without wearing anything.

```bash
cd bridge
node --env-file-if-exists=.env cli.mjs health
node --env-file-if-exists=.env cli.mjs sessions              # merged, all hosts
node --env-file-if-exists=.env cli.mjs open ov/<session-id>
node --env-file-if-exists=.env cli.mjs new ch "what is failing in CI"
node --env-file-if-exists=.env cli.mjs new ov "..." --reply "yes"   # auto-answer an ask
node --env-file-if-exists=.env cli.mjs speak clip.wav        # exercise the STT path
node --env-file-if-exists=.env cli.mjs watch --seconds 120   # activity notifications
```

`--reply` answers on the **same connection**: `AskUserQuestion` blocks for only
60s before auto-answering "skip", so splitting ask and answer across two runs
loses the race, and losing it looks exactly like a broken answer path.

## Protocol

The wire contract is [`PROTOCOL.md`](PROTOCOL.md), implemented by
`src/protocol.ts` and mirrored by `bridge/protocol.mjs`. **Change one, change the
other** — both halves have tests asserting the same frame shapes, so a drift
fails a test instead of failing on the lens.

Everything this fork adds is an optional field or a new frame type, so a
single-host bridge that never sends them still drives this client unchanged.

## Display constraints worth knowing before you edit the UI

- **576 × 288, 4-bit greyscale**, ~10 lines of proportional text. No fonts, no
  sizes, no alignment. Glyphs outside the firmware font are **silently dropped**
  (`✓` vanishes; no emoji at all).
- **A list cannot be updated in place** — changing one row rebuilds the page, and
  a rebuild discards the native scroll position. Hence the redraw guards in
  `src/main.ts`.
- **`rebuildPageContainer` and `textContainerUpgrade` reject content over ~999
  bytes by resolving `false`** — no throw, no log, the screen simply does not
  change, which is indistinguishable from a stale screenshot. Wrapping is by
  *pixel* width and does not bound UTF-8 length, so every viewport is
  byte-clamped per line and in total (`src/ui/stream.ts`).
- **A tap arrives as an index into the rows on screen**, while the list re-sorts
  by recency underneath. Taps resolve against a snapshot of what was drawn, never
  against live state.

## References

- [Even Hub docs](https://hub.evenrealities.com/docs)
- [`@evenrealities/even-terminal`](https://www.npmjs.com/package/@evenrealities/even-terminal) — the per-host server this bridges to
- [huntsyea/hermes-even-hub-app](https://github.com/huntsyea/hermes-even-hub-app) — upstream
- [Tohoso/tmux-on-g2](https://github.com/Tohoso/tmux-on-g2) — secondary reference for temple-swipe scrolling
