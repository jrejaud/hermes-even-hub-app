# Open gateway: Claude Code on your G2 glasses

The Aristo Lens app (this repo) draws sessions, questions and show-me cards on Even Realities G2 glasses. It talks
to a **gateway** over one WebSocket (`/api/glasses`, protocol in `src/gateway/glasses.ts`). This folder is a gateway
anyone can run next to Claude Code: no Aristo, no server of ours.

```
G2 + phone (Aristo Lens)  ──wss──▶  open gateway (this folder)  ──Agent SDK──▶  Claude Code on your machine
```

## Run it

```bash
cd open-gateway && npm install
GATEWAY_TOKEN=$(openssl rand -hex 24) OPENAI_API_KEY=sk-… node server.mjs --cwd ~/code/my-project
```

The gateway listens on `127.0.0.1` only: the socket carries the token and your tool approvals, so it never goes
over a network in cleartext. Give the phone a `wss://` address one of two ways:

- **Tailscale (easiest):** `tailscale serve --bg 8787`, then use `wss://<machine>.<tailnet>.ts.net` (Tailscale
  provides the certificate; only your devices can reach it).
- **Your own certificate:** `TLS_CERT=cert.pem TLS_KEY=key.pem node server.mjs` serves `wss://` on all interfaces.

In the Even app, open Aristo Lens's phone page and enter that address and the same token. Claude Code signs in the
way it always does on that machine (`claude` login or `ANTHROPIC_API_KEY`).

| Env                     | Default                          | What                                                                                                  |
| ----------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GATEWAY_TOKEN`         | required                         | Shared secret with the lens (`?token=`, `Authorization: Bearer`, or a first `{t:"auth",token}` frame) |
| `PORT` / `--port`       | 8787                             |                                                                                                       |
| `HOST`                  | `127.0.0.1` (`0.0.0.0` with TLS) | Where it listens                                                                                      |
| `TLS_CERT`, `TLS_KEY`   | none                             | PEM files: serve `wss://` directly                                                                    |
| `GATEWAY_CWD` / `--cwd` | current folder                   | Where new sessions start                                                                              |
| `CLAUDE_MODEL`          | Claude Code's default            | Model for new sessions                                                                                |
| `PERMISSION_MODE`       | `default`                        | `default`: every tool asks on the lens. `acceptEdits`: edits go through                               |
| `STT_URL`               | `https://api.openai.com/v1`      | Any OpenAI-compatible `/audio/transcriptions` (OpenAI, Groq, a local whisper.cpp server)              |
| `STT_KEY`               | `OPENAI_API_KEY`                 | Its key                                                                                               |
| `STT_MODEL`             | `whisper-1`                      |                                                                                                       |

## What the lens gets

- **Sessions**: hold on Home and speak to start one; the list shows which are working or waiting on you.
- **Questions on the lens**: a tool permission (Yes / Always / No) or an `AskUserQuestion` shows its options; swipe
  and tap, or hold and answer aloud. A session you are not looking at raises a banner.
- **Show-me cards**: every session gets a `show_card` tool (a big number with a trend, a list, or a table, at most 4
  columns). The agent decides how long a card stays (`ttl_seconds`, 0 = until dismissed). On the lens: tap pins,
  double tap dismisses, swipe scrolls.
- **The corner icon** (top right): you talking, thinking, a question waiting.

## Cards from anything else

Any script or agent can push a card with the same arguments as the tool:

```bash
curl -H "Authorization: Bearer $GATEWAY_TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Build","kind":"stat","value":"142 passed","delta":"0 failed"}' http://localhost:8787/api/card
```

## Tests

`npm test`: a fake Agent SDK drives the real gateway and server (asks, answers, cards, speech to text, auth).
