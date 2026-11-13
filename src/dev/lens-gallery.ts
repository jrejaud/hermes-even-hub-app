/**
 * The Aristo Lens state gallery (SC-9500): one fixed state per screen and edge case, drawn one per tap.
 *
 * Every state is BUILT by feeding real wire frames and gestures through the real state machine (no
 * hand-written State objects), so a gallery frame cannot show a state the app cannot reach.
 *
 *   VITE_UI_GALLERY=1 npm run dev  +  npm run sim  +  npm run ui:capture
 */
import type { GlassesServerFrame } from '../gateway/glasses';
import { gesture, initialState, receive, reply, type Gesture, type State } from '../lens/state';
import { HOME, ROWS, row, threadFrame, viewFrame } from './fake-gateway';

export interface GalleryFrame {
  name: string;
  looking_for: string;
  state: State;
}

const T = 1_700_000_000_000;
/** The clock the gallery is drawn at: 4 s into a hold, so the listening timer reads a stable "● 4s". */
export const GALLERY_NOW = T + 4_000;

function feed(s: State, ...frames: GlassesServerFrame[]): State {
  return frames.reduce((acc, f) => receive(acc, f, T).state, s);
}

function press(s: State, ...gs: Gesture[]): State {
  return gs.reduce((acc, g) => gesture(acc, g, T).state, s);
}

const hello: GlassesServerFrame = { t: 'hello', protocol: 1, host: 'chiba', hosts: [] };
const online = (): State => feed(initialState('connecting'), hello, { t: 'home', views: HOME });
const inInbox = (): State => feed(press(online(), 'tap'), viewFrame('inbox'));
const openRow = (i: number): State => {
  let s = inInbox();
  for (let k = 0; k < i; k++) s = press(s, 'down');
  s = press(s, 'tap');
  return feed(s, threadFrame(ROWS[i].key));
};
/** Hold to talk on `s`; returns the listening state and the listen's reqId. */
const hold = (s: State): { s: State; id: string } => {
  const r = gesture(s, 'hold', T);
  return { s: r.state, id: Object.keys(r.pending)[0] };
};
/** Live words arriving while held, as the gateway relays Soniox. */
const hearing = (s: State, final: string, interim: string): State => {
  const h = hold(s);
  return receive(h.s, { t: 'partial', reqId: h.id, final, interim }, T).state;
};
/** Let go after a real utterance, and the gateway's final transcript comes back. */
const withTranscript = (s: State, text: string): State => {
  const h = hold(s);
  const rel = gesture(h.s, 'release', T + 2_000).state;
  return reply(rel, { kind: 'listen' }, { t: 'ok', reqId: h.id, text }, T).state;
};
const longThread = (): State => {
  const s = openRow(3);
  const t = s.thread!;
  const at = t.lines[0]?.at ?? '';
  const lines = [
    { who: 'you' as const, text: 'Pause the DroneID ads and tell me the final spend.', at },
    { who: 'tool' as const, text: 'google-ads set-campaign-status DroneID Search PAUSED', at },
    { who: 'agent' as const, text: 'Search is paused. Display was already off. Pulling the final numbers now.', at },
    { who: 'tool' as const, text: 'google-ads insights --campaign all --since 30d', at },
    {
      who: 'agent' as const,
      text: 'Final tally: $201.09 over 30 days, 59 clicks, no conversions. Nothing else is spending on the account.',
      at,
    },
    { who: 'you' as const, text: 'Good. Delete the old Display draft too.', at },
    {
      who: 'agent' as const,
      text: 'Deleted the stale DroneID Display draft. The account now has no enabled campaigns.',
      at,
    },
    ...t.lines,
  ];
  return feed(s, { ...t, lines });
};

/** An agent's status report, the shape Jordan reads most: headings, title lines, blank lines, indented steps. */
const reportThread = (): State => {
  const s = openRow(3);
  const t = s.thread!;
  const at = t.lines[0]?.at ?? '';
  const text = [
    '## ✅ DONE',
    '',
    '**Ads paused (DroneID)**',
    '',
    'Final tally: $201.09, 59 clicks, 0 conversions.',
    '',
    '## 🏁 1 of 2 goals finished',
    '',
    '⚪ **Ads**: stop the DroneID spend',
    '   🟢 search paused',
    '   ⚪ tracking tag (you)',
  ].join('\n');
  return feed(s, {
    ...t,
    lines: [
      { who: 'you' as const, text: 'Status?', at },
      { who: 'agent' as const, text, at },
    ],
  });
};
const LONG =
  'Investigate why the nightly Parakeet billing reconciliation job keeps double-counting refunds issued in the last week';
const longRows = [
  row({
    key: 'overlord/long',
    title: LONG,
    mark: 'needs',
    detail: "Allow Bash: psql -c 'select * from refunds where created_at > now() - interval 7 days'",
    age: '1m',
    promptId: 'p-long',
  }),
  row({
    key: 'box/jp',
    title: '日本語のメールを翻訳して返信を下書きする',
    mark: 'working',
    detail: '読み込み中: 受信トレイ',
    age: '6m',
  }),
  row({
    key: 'chiba/ru',
    title: 'Проверить счета за ноябрь и сверить с банком',
    mark: 'your-turn',
    detail: 'Готово к проверке',
    age: '1h',
  }),
  row({
    key: 'overlord/emoji',
    title: '🚀 Launch checklist ✅ with emoji in the title',
    mark: 'error',
    detail: 'Stopped with an error: rate limited',
    age: '2h',
  }),
  row({
    key: 'overlord/child',
    title: 'Subagent: scan the repo for dead exports',
    mark: 'working',
    detail: 'Grep: export function',
    age: '1m',
    depth: 1,
  }),
  ...ROWS,
];

export const LENS_FRAMES: GalleryFrame[] = [
  {
    name: '01-unconfigured',
    looking_for: 'no profile: header says setup, body says where to enter it',
    state: initialState('unconfigured'),
  },
  {
    name: '02-connecting',
    looking_for: "cold start, no data yet: header right 'connecting…', body explains",
    state: initialState('connecting'),
  },
  {
    name: '03-home',
    looking_for:
      'Inbox on top, starred views below; cursor ▶ on Inbox; M1 markers (! needs you, … working, → quiet); counts in header right',
    state: online(),
  },
  {
    name: '04-home-cursor-down',
    looking_for: 'cursor on Foreground; rows do not shift sideways',
    state: press(online(), 'down'),
  },
  {
    name: '05-home-reconnecting',
    looking_for: 'data kept, header right says reconnecting…',
    state: { ...online(), conn: 'reconnecting' },
  },
  {
    name: '06-view-inbox',
    looking_for:
      "waiting rows first; Jordan's M1 markers (2026-11-12): ! needs you, … working, → your turn, z asleep, · done, × error; marker, title, then the age at the right edge (no detail or command); one line each; position n/N",
    state: inInbox(),
  },
  {
    name: '07-view-scrolled',
    looking_for: 'cursor deep in the list, window scrolled, n/N updates',
    state: press(inInbox(), 'down', 'down', 'down', 'down', 'down'),
  },
  {
    name: '08-view-long-and-nonascii',
    looking_for: 'long title cut with …; Japanese, Russian rows present; emoji dropped not garbled; subagent indented',
    state: feed(press(online(), 'tap'), viewFrame('inbox', longRows)),
  },
  {
    name: '09-view-empty',
    looking_for: "an empty view says 'Nothing here.'",
    state: feed(press(online(), 'down', 'down', 'down', 'tap'), viewFrame('netrunner', [])),
  },
  { name: '10-view-loading', looking_for: 'view opened, frame not here yet: Loading…', state: press(online(), 'tap') },
  {
    name: '11-question',
    looking_for:
      'the question text at full brightness (alpha 255); options under it at textColor 2 (alpha 197) with the primary first under the bright ▶ cursor; no voice row (hold to talk instead)',
    state: openRow(0),
  },
  {
    name: '12-permission',
    looking_for: 'Bash command heading, the command, Yes first, Always, No; no voice row',
    state: openRow(1),
  },
  {
    name: '13-question-subagent-more',
    looking_for: 'Explore asks:, (+1 more in Aristo), "Answer this one in Aristo."; no options, no voice row',
    state: openRow(2),
  },
  {
    name: '14-working-session',
    looking_for:
      'the conversation: › your lines, – tool lines, agent replies plain; newest at the bottom; the activity line starts with the … marker and is dimmer (textColor 1 = alpha 179 vs 255: the whole range glass has); no action rows',
    state: openRow(3),
  },
  {
    name: '15-done-session',
    looking_for: 'a done session (the fake has one message): that message, no activity line',
    state: openRow(4),
  },
  {
    name: '16-permission-long-command',
    looking_for: 'a very long command is cut to 2 lines ending with …, options right under it',
    state: feed(press(feed(press(online(), 'tap'), viewFrame('inbox', longRows)), 'tap'), {
      ...threadFrame('chiba/deploy'),
      row: longRows[0],
      ask: {
        ...threadFrame('chiba/deploy').ask!,
        key: 'overlord/long',
        promptId: 'p-long',
        detail:
          'psql -c "select r.id, r.amount, r.created_at, i.customer_email from refunds r join invoices i on i.id = r.invoice_id where r.created_at > now() - interval \'7 days\' order by r.created_at desc"',
      },
    }),
  },
  {
    name: '17-dictate-listening',
    looking_for: "hold on the working session: header right '● 4s' bright, body 'Speak now.', no gesture hint",
    state: press(openRow(3), 'hold'),
  },
  {
    name: '18-dictate-live-words',
    looking_for:
      'holding: settled words bright (newest lines kept); the tail Soniox may still change on its own line in parentheses ending …, one brightness step dimmer',
    state: hearing(openRow(3), 'pause both campaigns and send me the final spend number', 'when it is'),
  },
  {
    name: '19-dictate-confirm-message',
    looking_for: 'Message: + the transcript, Send under the cursor, Redo, Cancel',
    state: withTranscript(openRow(3), 'pause both and send me the final spend number when it is done'),
  },
  {
    name: '20-dictate-confirm-question',
    looking_for: "on a question with free text: 'Answer:'",
    state: withTranscript(openRow(0), 'only the display campaign, keep search running'),
  },
  {
    name: '21-dictate-confirm-permission',
    looking_for: "on a permission: 'Deny, with this note:' (speech never approves)",
    state: withTranscript(openRow(1), 'yes go ahead'),
  },
  {
    name: '22-dictate-heard-nothing',
    looking_for: "empty transcript: 'Nothing was heard.', Redo / Cancel",
    state: withTranscript(openRow(3), ''),
  },
  {
    name: '23-dictate-failed',
    looking_for: 'speech failed (Soniox down or out of credit): the reason, Say it again / Cancel',
    state: (() => {
      const h = hold(openRow(3));
      return reply(
        h.s,
        { kind: 'listen' },
        { t: 'refused', reqId: h.id, reason: 'host-down', message: 'speech service offline' },
        T,
      ).state;
    })(),
  },
  {
    name: '24-banner',
    looking_for: 'another session asks: ● title, needs you, the ask, Answer now / Later',
    state: feed(openRow(3), {
      t: 'banner',
      key: 'box/churn',
      title: 'Churn audit',
      ask: 'Include trial users in the cohort?',
      promptId: 'p-churn',
    }),
  },
  {
    name: '25-answered-back-to-list',
    looking_for: 'after tapping an option: back on Inbox, cursor on top, the answered row is no longer ●',
    state: feed(
      press(openRow(0), 'tap'),
      viewFrame(
        'inbox',
        ROWS.map((r) =>
          r.key === 'overlord/kill'
            ? { ...r, mark: 'working' as const, promptId: null, detail: 'Pausing both campaigns' }
            : r,
        ),
      ),
    ),
  },
  {
    name: '26-refused-notice',
    looking_for: "an answer refused as gone: header right says 'already answered'",
    state: { ...inInbox(), notice: { text: 'already answered', until: Number.MAX_SAFE_INTEGER } },
  },
  {
    name: '27-conversation-long',
    looking_for: 'a long conversation follows the newest: last 7 lines, header right shows status and n/N pages',
    state: longThread(),
  },
  {
    name: '28-conversation-scrolled-back',
    looking_for: 'swiped up once: an older page, page number drops, text not cut mid-line',
    state: press(longThread(), 'up'),
  },
  {
    name: '29-session-menu',
    looking_for: 'tap on a working conversation: Stop under the cursor, Mark done, Set aside',
    state: press(openRow(3), 'tap'),
  },
  {
    name: '30-new-session-listening',
    looking_for:
      "hold on Home: 'New session' header, '● 4s', 'First message:' label, live words with the undecided tail on a dim line",
    state: hearing(online(), 'look into why the nightly billing job', 'double counts'),
  },
  {
    name: '31-new-session-confirm',
    looking_for: "new session confirm: 'First message:' + the prompt, Send / Say it again / Cancel",
    state: withTranscript(online(), 'look into why the nightly billing job double counts refunds'),
  },
  {
    name: '32-conversation-report',
    looking_for:
      'a status report keeps its shape: headings framed ━━ TITLE ━━ in uppercase, an all-bold title line opens with ▶, a blank line between blocks, steps indented under their goal with ● done and ○ open',
    state: reportThread(),
  },
  {
    name: '33-permission-reading-session',
    looking_for:
      'swiped up on the first option of a permission: the conversation behind it, newest page; dim last line "! <ask> ▽" says the options wait below',
    state: press(openRow(1), 'up'),
  },
  {
    name: '34-question-reading-session',
    looking_for: 'swiped up on a question: its conversation, header right names the ask kind (and page if several)',
    state: press(openRow(0), 'up'),
  },
];
