# claude-code-g2-bridge

The server half. Speaks the glasses WebSocket protocol on one side and
`even-terminal`'s HTTP API on the other, across as many hosts as
`hosts.json` lists.

Plain ESM, one dependency (`ws`), no build step, `node --test` for tests.

## Files

| File | What it owns |
|---|---|
| `server.mjs` | the WebSocket + `/health` server, auth, audio buffering |
| `fleet.mjs` | the host registry, the merged session list, the activity watcher |
| `pump.mjs` | ONE active session for ONE connection: attach, stream, route utterances |
| `translate.mjs` | `even-terminal` messages → protocol frames (pure) |
| `answer.mjs` | turning a spoken sentence into an answer to a blocked agent (pure) |
| `even-terminal.mjs` | HTTP client for one host |
| `hosts.mjs` | config loading + 1Password/env token resolution |
| `stt.mjs` | speech to text, pluggable |
| `cli.mjs` | drive the real protocol from a terminal |
| `protocol.mjs` | frame builders, mirroring `../src/protocol.ts` |

The two pure modules (`translate`, `answer`) hold everything that would otherwise
need glasses to verify. That is the point of them being pure.

## Configuration

`hosts.json` (gitignored; see `hosts.example.json`):

```jsonc
{ "hosts": [
  { "key": "ov", "name": "overlord", "url": "http://100.x.x.x:3457",
    "tokenOp": "Shared/<item-id>" },              // 1Password: <vault>/<item>[/<field>]
  { "key": "ch", "name": "chiba", "url": "http://100.x.x.x:3457",
    "tokenEnv": "EVEN_TERMINAL_TOKEN_CH" }        // or an env var
]}
```

**A token is never written into the file.** It is named, and resolved inside the
process, so it never reaches a command line, a shell history, or a transcript.

Environment (`.env`, gitignored):

| Var | Default | Meaning |
|---|---|---|
| `BRIDGE_TOKEN` / `BRIDGE_TOKEN_OP` | — | **required.** The shared secret the phone types in. `_OP` names a 1Password item instead. |
| `BRIDGE_PORT` | `8791` | |
| `BRIDGE_BIND` | `127.0.0.1` | Put `tailscale serve` in front for TLS. |
| `STT_ENGINE` | `whispercpp` if `WHISPER_MODEL` is set, else `none` | `whispercpp` \| `openai` \| `none` |
| `WHISPER_BIN` / `WHISPER_MODEL` / `WHISPER_THREADS` / `WHISPER_LANGUAGE` / `WHISPER_PROMPT` | `whisper-cli` / — / 4 / en / host names | whisper.cpp |
| `STT_URL` / `STT_API_KEY` / `STT_MODEL` | Groq / — / `whisper-large-v3-turbo` | the `openai` engine |
| `POLL_INTERVAL_MS` | `400` | active-session message polling |
| `ACTIVITY_INTERVAL_MS` | `5000` | session-list polling, per host |
| `DEDUPE_WINDOW_MS` | `6000` | identical utterances this close together are one |
| `MAX_AUDIO_BYTES` | 60s of PCM | a longer press is a stuck mic |

## Security

**Do not expose this.** One bearer token stands between a caller and an
agent-spawner on *every* configured host. It binds to loopback by default and
expects `tailscale serve` in front. The same is true of `even-terminal` itself:
its `--tailscale` flag is not a bind and not a security boundary — the listener
is `0.0.0.0` regardless, and a host firewall is what actually contains it.

## Testing

```bash
npm test        # 45 tests, node --test
```

`test/fake-even-terminal.mjs` is a stand-in faithful to the real package's routes
and payload shapes, read out of its `dist/`. It lets the whole bridge be driven
end to end — including a permission prompt answered by voice, a dead session
being respawned, and an alert storm being suppressed — with no live agent, no API
bill, and no glasses. Tests script the exact message sequence a turn should
produce, then assert what came out the other side.

## Driving it by hand

```bash
node --env-file-if-exists=.env cli.mjs health
node --env-file-if-exists=.env cli.mjs sessions
node --env-file-if-exists=.env cli.mjs open ov/<id>
node --env-file-if-exists=.env cli.mjs say ov/<id> "what changed"
node --env-file-if-exists=.env cli.mjs new ch "run the tests" --reply "yes"
node --env-file-if-exists=.env cli.mjs speak clip.wav
node --env-file-if-exists=.env cli.mjs watch --seconds 120
node --env-file-if-exists=.env cli.mjs app-env      # write ../.env.local for the simulator
```

Every defect found after the unit tests went green was found with this.
