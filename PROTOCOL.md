# G2 ↔ Claude Code Bridge — Wire Protocol

Version: 2.0
Transport: WebSocket (text frames = JSON, binary frames = raw PCM)
Discriminator field: `t` (string, required on every frame)

Implemented by `src/protocol.ts` (client) and `bridge/protocol.mjs` (server).
**Change one, change the other.** Both halves have tests asserting the same
shapes, so a drift fails a test rather than failing silently on the lens.

Version 2 adds `host`, `ask`, `ask.done` and `activity` to the 1.0 contract. All
additions are optional fields or new frame types: a single-host bridge that never
sends them drives a v2 client correctly, and a v1 client ignores what it does not
know. That is deliberate — the backend swap is meant to be upstreamable.

---

## Client → Server (glasses app sends)

| `t`               | Fields                              | Description |
|-------------------|-------------------------------------|-------------|
| `hello`           | `token: string`, `device: string`   | First frame after connect. The server closes with **1008** on a bad token, or after 5s with no hello. |
| `sessions.list`   | _(none)_                            | Request the full session list. |
| `sessions.switch` | `id: string`                        | Open a session by composite id. |
| `sessions.new`    | `host?: string`, `title?: string`   | Arm a new session on `host` (defaults to the bridge's first host). **v2:** `host`. |
| `text`            | `text: string`                      | An utterance. **Not necessarily a prompt** — see routing below. |
| `stop`            | _(none)_                            | Interrupt the active turn. |
| `audio.start`     | _(none)_                            | Begin streaming PCM (see Binary Frames). |
| `audio.stop`      | _(none)_                            | End the stream; the server transcribes and replies with `transcript`. |

### How `text` is routed

A `text` frame is **not** unconditionally a new prompt. The bridge routes it, in
this order:

1. **An outstanding `ask` owns it.** A permission answer goes to
   `POST /api/permission-response`; a question answer to
   `POST /api/question-response`. Otherwise the agent sits blocked for 60s and
   auto-answers while the wearer talks past it.
2. **A reset phrase** (`new session`, `start over`, `reset`, …) detaches instead
   of prompting, so a session that has become unusable can be escaped without a
   keyboard.
3. **A status phrase** (`status`, `continue`, …) drains what has landed without
   re-prompting — otherwise the agent answers the word "status".
4. **Otherwise** it is a prompt.

Keeping this server-side is what lets voice answering work with no extra client
frames and no extra gesture.

---

## Server → Client

| `t`               | Fields | Description |
|-------------------|--------|-------------|
| `hello.ok`        | `caps: Record<string,unknown>`, `active: string \| null` | Handshake ack. `caps` advertises `{hosts, stt, multiHost, ask, activity}`. |
| `sessions`        | `items: SessionItem[]`, `active: string \| null`, `hosts?: HostItem[]` | The merged list. **v2:** `hosts`. |
| `active`          | `id: string` | Which session is now active. |
| `history`         | `id: string`, `items: HistoryItem[]`, `ok?: boolean` | The session's thread. `ok: false` means history could not be read. |
| `transcript`      | `text: string` | Transcription of the last audio stream. Empty = nothing heard. |
| `assistant`       | `text: string` | Authoritative snapshot; **replaces** the trailing assistant segment. |
| `assistant.delta` | `text: string` | Append-only chunk. The normal streaming path. |
| `tool.start`      | `name: string`, `label?: string`, `emoji?: string` | A tool call began. |
| `tool.end`        | `name: string`, `ok: boolean` | A tool call finished. |
| `ask`             | `ask: "permission" \| "question"`, `text: string`, `options?: string[]` | **v2.** The agent is blocked on the wearer. `text` is already rendered for the lens and carries its own spoken cue. |
| `ask.done`        | _(none)_ | **v2.** The outstanding ask was answered or superseded. |
| `activity`        | `id`, `host?`, `title`, `preview` | **v2.** A session *other than the active one* came to rest. |
| `turn.done`       | _(none)_ | The turn is complete. |
| `error`           | `msg: string` | Server-side error, in words a wearer can read. |

### `SessionItem`

```jsonc
{
  "id":      "ov/8bc524f6-…",  // composite: "<hostKey>/<sessionId>"
  "title":   "check the deploy",
  "updated": 1780000000,        // unix SECONDS
  "host":    "ov",              // v2: short host key, for the row tag
  "busy":    false,             // v2: mid-turn right now
  "tokens":  1024               // optional
}
```

**`id` is opaque to the client.** Only the bridge splits it. That is what lets
one list span several machines while the client knows nothing about hosts beyond
a two-character display tag. A session id from `even-terminal` is a UUID, so `/`
is an unambiguous separator.

### `HostItem`

```jsonc
{ "key": "ov", "name": "overlord", "online": true }
```

`online` is set by the bridge's last transport result for that host. A host that
is down contributes no sessions and does **not** fail the list.

### `HistoryItem`

```jsonc
{ "kind": "user",      "text": "…" }
{ "kind": "assistant", "text": "…" }
{ "kind": "banner",    "text": "…" }
{ "kind": "tool",      "name": "Bash", "label": "…", "running": true, "ok": true }
{ "kind": "ask",       "ask": "permission", "text": "…", "options": ["allow","deny"], "answered": false }
```

---

## Binary Frames

Between `audio.start` and `audio.stop`, the client sends **binary** frames of raw
PCM: **signed 16-bit little-endian, 16 kHz, mono**, 100 ms (3,200 bytes) per
frame — the format the Even Hub SDK delivers. No per-chunk acknowledgement.
Binary frames outside a stream window are ignored, and the buffer is capped
(default 60s) because a longer press is a stuck mic, not a sentence.

The server transcribes on `audio.stop` and replies with exactly one `transcript`.

---

## Mapping: `even-terminal` → protocol frames

Message types read out of `@evenrealities/even-terminal`'s `dist/claude/session.js`,
not guessed. Implemented in `bridge/translate.mjs`.

| even-terminal message | Fields used | Frame emitted |
|---|---|---|
| `text_delta` | `text` | `assistant.delta` |
| `result` | `text` | `assistant` (snapshot) then `turn.done`, plus `ask.done` if one was open |
| `tool_start` | `name` | `tool.start` |
| `tool_end` | `name`, `detail.output.is_error` | `tool.end{ok}` |
| `permission_request` | `description`/`detail`/`toolName`, `options[].key` | `ask{ask:"permission"}` |
| `user_question` | `questions[0].question`, `questions[0].options[].label` | `ask{ask:"question"}` |
| `error` | `message` | `error` |
| `status`, `notification` | — | **ignored** |

Two shape traps worth restating:

- **`user_question.questions` is an ARRAY.** Guessing `{question}` or `{text}`
  put the literal string "Claude is asking: a question" on the lens with the real
  content discarded.
- **`tool_end` carries no `ok`.** Failure is inferred, defaulting to success — a
  tool wrongly shown as failed is more alarming on a HUD than one wrongly shown
  as fine, and the assistant text says what actually happened.

### Session creation

`even-terminal` has no create route. A session comes into existence when
`POST /api/prompt` runs **without** a `sessionId`, and the response carries the
new id. So `sessions.new` only records which host was chosen; the first
utterance spawns the session and triggers `active`.

### Attaching to an existing session

Disk history (`GET /api/sessions/:id/history`) is replayed as the thread. The
in-memory ring (`GET /api/messages?after=0`) is replayed **only when the session
is busy** — that content belongs to a turn still running and is not on disk yet.
When idle it is discarded, because it would duplicate the history just sent.

### Activity

The bridge polls each host's session list and emits `activity` when a session
**comes to rest**: idle now, and either it was busy last tick or its timestamp
advanced, subject to a per-session cooldown. A session mid-turn ticks its
timestamp every few seconds; notifying on each tick put three identical alerts on
the lens inside ninety seconds. On a HUD an alert storm is worse than no alert,
because it buries the one that mattered.

---

## Speech to text

The Even Hub SDK hands the app raw PCM and nothing else — there is no
transcription API on the phone or the glasses — so the bridge owns it.

| `STT_ENGINE` | How |
|---|---|
| `whispercpp` | spawns `whisper-cli` on a temp WAV. No network, no API key. |
| `openai` | multipart POST to any OpenAI-compatible `/v1/audio/transcriptions` (Groq, OpenAI, or whisper.cpp's own `whisper-server`). |
| `none` | returns an explanatory `error` rather than hanging silently. |

Whisper emits bracketed non-speech markers on silence (`[BLANK_AUDIO]`,
`(wind blowing)`); these are stripped, and an empty result means "say again"
rather than becoming a prompt.
