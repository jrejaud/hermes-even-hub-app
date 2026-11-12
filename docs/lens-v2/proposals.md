# Aristo Lens v2: proposals for review

Two changes are proposed: voice becomes press-and-hold with a live level bar and the words appearing as you speak, and the session screen becomes a scrollable conversation with Terminal mode's best patterns. Nothing here is built yet; each item has a number so you can accept, cut or change it.

## Plainer status markers (M, needs your pick)

The firmware font has no emoji and no ✓, ⚠ or ⏳ (emoji draw as an empty box). It does have `!` `?` `…` `→` `z` `×` `◐`, so the markers can read as words would.

<details><summary>Proposed set M1</summary>

| Status    | Now     | M1  |
| --------- | ------- | --- |
| Needs you | ●       | !   |
| Working   | ▷       | …   |
| Your turn | ○       | →   |
| Asleep    | ○ (dim) | z   |
| Done      | □       | ·   |
| Error     | ▲       | ×   |

The cursor stays `▶`, and "more below" stays `▽`.

</details>

## What the status markers mean today

One fixed set of glyphs, chosen by Aristo's status for each session. The lens is a single colour, so "brighter" is the only other signal: the row under the cursor is brightest, rows that need you are bright, everything else is dim.

<details><summary>Legend</summary>

| Marker                 | Meaning                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| ● filled circle        | Needs you: a question or permission is waiting, or it is your turn (Aristo's Inbox rule) |
| ▷ outline triangle     | Working right now                                                                        |
| ○ empty circle, normal | Your turn: it stopped and is idle                                                        |
| ○ empty circle, dim    | Asleep: Aristo parked it, it wakes when you send to it                                   |
| □ empty square         | Done                                                                                     |
| ▲ filled triangle      | Stopped with an error                                                                    |
| ▶ (left edge)          | The cursor: the row a tap opens                                                          |
| ▽ (end of a row)       | More rows below; scroll down                                                             |

On Home the marker sums up the view: ● if anything in it needs you, ▷ if something is only working, ○ if it is quiet.

</details>

## How it looks now

The session screen shows only the last agent message, cut to three lines, and the listening screen is a static "Speak now." with no feedback.

![Now: a working session shows one message, three lines, no scrolling](now-session.png)

![Now: listening shows no level and no words](now-listening.png)

## Voice: press and hold, live bar, live words

Hold to talk becomes the only way to start recording, and the screen shows that it hears you and what it heard, word by word, before you let go.

![Reference: muxway's listening screen, a level waveform under a title with a timer](ref-muxway-listening.png)

<details><summary>Proposed spec (V1-V9)</summary>

1. **V1 Hold to talk, release to stop.** The "Talk to it" and "Say something else…" rows go away; hold is the only start. A hold under 0.6 s is ignored (an accidental press).
2. **V2 Right temple or ring only.** The left temple's hold belongs to Even's system menu; command-center ignores it for the same reason.
3. **V3 Listening screen.** Title `● listening 6s` (seconds held, counting up), a level bar under it, then the words so far (last 4 lines). No gesture hints.
4. **V4 ~~Level bar~~ dropped (your call, 2026-11-12).** No waveform or meter; the counting title is the only sign it is recording.
5. **V5 Words as you speak.** Partial transcripts replace the tail of the text about once a second while you hold; settled words stay. Needs streaming speech-to-text on the gateway (decision S below).
6. **V6 Release → confirm.** "… finishing" for under a second, then the final text with Send / Redo / Cancel, as now. On a permission it still reads "Deny, with this note:" (speech never approves).
7. **V7 Cancel while holding.** Double tap discards; so does the app leaving the screen.
8. **V8 Safety.** 60 s cap with the counter turning into a countdown at 50 s; a lost release (the glasses never send it) ends on the next tap.
9. **V9 Standard component.** The whole thing ships as a reusable voice-capture module in the `even-frontend` skill (input handling, level meter, partial-transcript box, confirm), so any G2 app gets the same behaviour.

**Decision S, the speech engine (needs your pick):**

The glasses' own speech recognition ("Hey Even", Soniox inside the Even app) is not available to Hub apps: the SDK has no speech API, and Even's official `asr` template ships a blank stub and says to bring your own provider.

- **S1 Self-hosted on Chiba (recommended to start).** whisper.cpp, which the gateway already uses, re-transcribes the clip so far every second while you hold (glancecode's method). No new account or cost; words trail your voice by about 1-3 s (unverified on Chiba).
- **S2 Hosted streaming (Deepgram or Soniox, the engine Even itself uses).** Words in about 0.5 s; needs a new account and API key (none exists in 1Password) and costs per minute.

</details>

## Session screen: a scrollable conversation, ideas from Terminal mode

Terminal mode's on-lens layout is in Even's closed app and undocumented, so what can be copied is what its server sends: streamed replies, one-line tool rows, a busy/thinking status, allow/always/deny, hold to talk, interrupt, and blocked or waiting states in the list.

![Now: the list, for reference](now-list.png)

<details><summary>Proposed changes (T1-T10)</summary>

1. **T1 The session opens as a conversation.** Newest at the bottom, your messages marked `›`, the agent's plain, tool calls as one dim line each (`▷ Bash: npm test`). Swipe up/down scrolls a page at a time; the header shows `3/7`.
2. **T2 Read further back.** Starts with the last 12 messages; scrolling past the top asks Aristo for more (the gateway already takes a `limit`). Terminal mode itself only ever has the last 10.
3. **T3 Actions move to a tap.** Swipe is for reading, so Talk/Mark done/Set aside move behind a tap (a short menu over the conversation). Hold still talks to it straight away.
4. **T4 Live replies.** While the session works, new text appears at the bottom as Aristo sends it (the gateway already re-sends the open session on every change); the view stays put if you have scrolled up.
5. **T5 Status line.** The header's right side shows `thinking`, `working 4m`, `waiting on you` or `your turn`, plus the current step (`Reading protocol.ts`) in a dim line at the bottom.
6. **T6 Stop button.** A working session gets `Stop` in its tap menu (Terminal mode has an interrupt). Needs a new gateway request.
7. **T7 Asks inside the conversation.** A pending question or permission shows at the bottom of the conversation with its options; answered ones stay in the history as one line (`? Which do I pause? → Both`).
8. **T8 Task progress.** When the agent keeps a task list, the header shows `3/7 tasks` (Terminal mode sends task progress). Needs a field from the gateway.
9. **T9 Start a new session from the glasses.** Hold on Home dictates a new session in the open view's default project (Terminal mode's first prompt creates a session). Needs a new gateway request.
10. **T10 List rows show blocked vs working at a glance.** Already true (● / ▷); kept.

</details>

## What needs the gateway (Aristo side)

Most of this is app-only; four items need small additions to the glasses gateway.

<details><summary>Gateway additions</summary>

- Streaming speech-to-text (V5): audio frames in, partial and final text out, on the open socket.
- Interrupt a session (T6).
- Task progress on the session row (T8).
- Create a session from a dictated prompt (T9).

</details>
