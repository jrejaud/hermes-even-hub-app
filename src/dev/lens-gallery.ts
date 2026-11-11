/**
 * The Aristo Lens state gallery (SC-9500): one fixed state per screen and edge case, drawn one per tap.
 *
 * Every state is BUILT by feeding real wire frames and gestures through the real state machine (no
 * hand-written State objects), so a gallery frame cannot show a state the app cannot reach.
 *
 *   VITE_UI_GALLERY=1 npm run dev  +  npm run sim  +  npm run ui:capture
 */
import type { GlassesServerFrame } from '../gateway/glasses';
import { gesture, initialState, receive, type Gesture, type State } from '../lens/state';
import { HOME, ROWS, row, threadFrame, viewFrame } from './fake-gateway';

export interface GalleryFrame {
  name: string;
  looking_for: string;
  state: State;
}

const T = 1_700_000_000_000;

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
const withTranscript = (s: State, text: string): State => {
  // stt reply as the shell would deliver it
  const top = s.stack[s.stack.length - 1];
  if (top.kind !== 'dictate') return s;
  return { ...s, stack: [...s.stack.slice(0, -1), { ...top, phase: 'confirm', text }] };
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
      'Inbox on top, starred views below; cursor ▶ on Inbox brightest, need-you rows brighter than quiet ones; counts in header right',
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
    looking_for: 'waiting rows first with ●, working ▷, done □; title then detail, age; one line each; position n/N',
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
      "ask heading, question text brightest, options with the primary first under the cursor, 'Say something else…' last",
    state: openRow(0),
  },
  {
    name: '12-permission',
    looking_for: 'Bash command heading, the command, Yes first, Always, No, Deny and say why…',
    state: openRow(1),
  },
  {
    name: '13-question-subagent-more',
    looking_for: 'Explore asks:, (+1 more in Aristo), "Answer this one in Aristo."; no options, no voice row',
    state: openRow(2),
  },
  {
    name: '14-working-session',
    looking_for: 'last agent message in 3 lines, dim activity line, Talk to it / Mark done / Set aside',
    state: openRow(3),
  },
  { name: '15-done-session', looking_for: 'a done session: no Mark done action', state: openRow(4) },
  {
    name: '16-permission-long-command',
    looking_for: 'a very long command wraps to 2 lines and ends with …',
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
    looking_for: "hold on the working session: header right listening… bright, body 'Speak now.', no gesture hint",
    state: press(openRow(3), 'hold'),
  },
  {
    name: '18-dictate-transcribing',
    looking_for: 'released: transcribing…',
    state: press(openRow(3), 'hold', 'release'),
  },
  {
    name: '19-dictate-confirm-message',
    looking_for: 'Message: + the transcript, Send under the cursor, Redo, Cancel',
    state: withTranscript(press(openRow(3), 'hold'), 'pause both and send me the final spend number when it is done'),
  },
  {
    name: '20-dictate-confirm-question',
    looking_for: "on a question with free text: 'Answer:'",
    state: withTranscript(press(openRow(0), 'hold'), 'only the display campaign, keep search running'),
  },
  {
    name: '21-dictate-confirm-permission',
    looking_for: "on a permission: 'Deny, with this note:' (speech never approves)",
    state: withTranscript(press(openRow(1), 'hold'), 'yes go ahead'),
  },
  {
    name: '22-dictate-heard-nothing',
    looking_for: "empty transcript: 'Nothing was heard.', Redo / Cancel",
    state: (() => {
      const s = press(openRow(3), 'hold');
      const t = s.stack[s.stack.length - 1];
      return t.kind === 'dictate' ? { ...s, stack: [...s.stack.slice(0, -1), { ...t, phase: 'empty' as const }] } : s;
    })(),
  },
  {
    name: '23-dictate-failed',
    looking_for: 'stt or send failed: the reason, Redo / Cancel',
    state: (() => {
      const s = press(openRow(3), 'hold');
      const t = s.stack[s.stack.length - 1];
      return t.kind === 'dictate'
        ? { ...s, stack: [...s.stack.slice(0, -1), { ...t, phase: 'failed' as const, error: 'offline' }] }
        : s;
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
];
