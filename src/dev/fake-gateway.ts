/**
 * A fake glasses gateway speaking the real wire frames (`glasses.ts`), in-process (SC-9500).
 *
 * Used by the state gallery, the unit tests and `VITE_FAKE_GATEWAY=1` simulator runs. It is NOT the
 * end-to-end test: that runs against a real test aristod. Keep it dumb: it serves fixed presented frames
 * and records what the lens sent, so a test can assert the exact payload.
 */
import type { SocketLike } from '../gateway/client';
import type {
  GlassesAsk,
  GlassesClientFrame,
  GlassesHomeView,
  GlassesLine,
  GlassesRow,
  GlassesServerFrame,
} from '../gateway/glasses';

export function row(p: Partial<GlassesRow> & Pick<GlassesRow, 'key' | 'title' | 'mark'>): GlassesRow {
  return {
    hostId: p.key.split('/')[0],
    status: {
      needs: 'Waiting on you',
      working: 'Working',
      'your-turn': 'Your turn',
      asleep: '💤 Asleep',
      done: 'Done',
      error: 'Error',
    }[p.mark],
    detail: '',
    age: '3m',
    project: '',
    promptId: null,
    depth: 0,
    ...p,
  };
}

export const ASKS: Record<string, GlassesAsk> = {
  'overlord/kill': {
    key: 'overlord/kill',
    promptId: 'p-kill',
    kind: 'question',
    ask: 'Question',
    asker: null,
    detail: 'Spend is still running on 2 campaigns. Which do I pause?',
    context: 'Both campaigns are still spending about $40 a day.',
    options: [
      {
        label: 'Both',
        title: 'Both (Recommended)',
        kind: 'choice',
        primary: true,
        answer: { promptId: 'p-kill', answers: { 'Which do I pause?': 'Both' } },
      },
      {
        label: 'Search only',
        title: 'Search only',
        kind: 'choice',
        primary: false,
        answer: { promptId: 'p-kill', answers: { 'Which do I pause?': 'Search only' } },
      },
      {
        label: 'Display only',
        title: 'Display only',
        kind: 'choice',
        primary: false,
        answer: { promptId: 'p-kill', answers: { 'Which do I pause?': 'Display only' } },
      },
    ],
    freeText: true,
    more: 0,
    createdAt: '2026-11-11T02:00:00Z',
  },
  'chiba/deploy': {
    key: 'chiba/deploy',
    promptId: 'p-deploy',
    kind: 'permission',
    ask: 'Bash command',
    asker: null,
    detail: 'ssh chiba systemctl --user restart aristod',
    context: null,
    options: [
      { label: 'Yes', title: 'Yes', kind: 'yes', primary: true, answer: { promptId: 'p-deploy', option: 1 } },
      {
        label: 'Always',
        title: "Yes, and don't ask again for ssh chiba systemctl:*",
        kind: 'always',
        primary: false,
        answer: { promptId: 'p-deploy', option: 2 },
      },
      { label: 'No', title: 'No', kind: 'no', primary: false, answer: { promptId: 'p-deploy', option: 3 } },
    ],
    freeText: true,
    more: 0,
    createdAt: '2026-11-11T02:01:00Z',
  },
  'box/churn': {
    key: 'box/churn',
    promptId: 'p-churn',
    kind: 'question',
    ask: 'Question',
    asker: 'Explore asks:',
    detail: 'Include trial users in the cohort?',
    context: null,
    options: [],
    freeText: false,
    more: 1,
    createdAt: '2026-11-11T02:02:00Z',
  },
};

export const ROWS: GlassesRow[] = [
  row({
    key: 'overlord/kill',
    title: 'Ads kill switch',
    mark: 'needs',
    detail: 'Which do I pause?',
    age: '2m',
    promptId: 'p-kill',
  }),
  row({
    key: 'chiba/deploy',
    title: 'Deploy fix',
    mark: 'needs',
    detail: 'Bash: ssh chiba systemctl --user restart aristod',
    age: '5m',
    promptId: 'p-deploy',
  }),
  row({
    key: 'box/churn',
    title: 'Churn audit',
    mark: 'needs',
    detail: 'Include trial users in the cohort?',
    age: '12m',
    promptId: 'p-churn',
  }),
  row({ key: 'overlord/g2', title: 'G2 app plan', mark: 'working', detail: 'Reading protocol.ts', age: '4m' }),
  row({ key: 'chiba/invoice', title: 'Invoice sync', mark: 'done', detail: '', age: '1h' }),
  row({ key: 'overlord/blog', title: 'Blog draft', mark: 'your-turn', detail: '', age: '3h' }),
  row({ key: 'box/sleepy', title: 'Old research', mark: 'asleep', detail: '', age: '2d' }),
];

export const HOME: GlassesHomeView[] = [
  { id: 'inbox', name: 'Inbox', needs: 3, working: 1, total: 7 },
  { id: 'fg', name: 'Foreground', needs: 2, working: 4, total: 9 },
  { id: 'parakeet', name: 'Parakeet', needs: 1, working: 2, total: 5 },
  { id: 'netrunner', name: 'Netrunner', needs: 0, working: 1, total: 2 },
  { id: 'daemon', name: 'Daemon', needs: 0, working: 0, total: 14 },
];

export const LINES: Record<string, GlassesLine[]> = {
  'overlord/g2': [
    { who: 'you', text: 'Plan the G2 app.', at: '' },
    { who: 'agent', text: 'Three research agents are running. The plan and mockups follow when they report.', at: '' },
    { who: 'tool', text: 'Agent: research G2 session apps', at: '' },
  ],
};

export function viewFrame(viewId: string, rows: GlassesRow[] = ROWS): Extract<GlassesServerFrame, { t: 'view' }> {
  const v = HOME.find((h) => h.id === viewId) ?? { id: viewId, name: viewId, needs: 0, working: 0, total: 0 };
  return {
    t: 'view',
    viewId,
    name: v.name,
    needs: rows.filter((r) => r.mark === 'needs').length,
    total: rows.length,
    sections: [{ label: v.name, rows }],
    more: 0,
  };
}

export function threadFrame(key: string, rows: GlassesRow[] = ROWS): Extract<GlassesServerFrame, { t: 'thread' }> {
  const r = rows.find((x) => x.key === key) ?? row({ key, title: key, mark: 'your-turn' });
  return {
    t: 'thread',
    row: r,
    ask: r.promptId ? (ASKS[key] ?? null) : null,
    lines: LINES[key] ?? [{ who: 'agent', text: `Last message of ${r.title}.`, at: '' }],
  };
}

/** The fake server: one per socket. `sent` records every client frame for assertions. */
export class FakeGateway {
  sent: GlassesClientFrame[] = [];
  rows: GlassesRow[] = ROWS.map((r) => ({ ...r }));
  /** Transcript the fake STT returns. */
  transcript = 'pause both and send me the final spend number';
  private sock: (SocketLike & { emit(f: GlassesServerFrame): void }) | null = null;

  connect = (): SocketLike => {
    const handle = (f: GlassesClientFrame): void => this.handle(f);
    const sock: SocketLike & { emit(f: GlassesServerFrame): void } = {
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(data: string) {
        handle(JSON.parse(data) as GlassesClientFrame);
      },
      close() {
        (sock as { readyState: number }).readyState = 3;
        sock.onclose?.({ code: 1000 });
      },
      emit(f: GlassesServerFrame) {
        queueMicrotask(() => sock.onmessage?.({ data: JSON.stringify(f) }));
      },
    } as never;
    this.sock = sock;
    queueMicrotask(() => {
      (sock as { readyState: number }).readyState = 1;
      sock.onopen?.(null);
      sock.emit({
        t: 'hello',
        protocol: 1,
        host: 'chiba',
        hosts: [
          { id: 'overlord', up: true },
          { id: 'chiba', up: true },
          { id: 'box', up: true },
        ],
      });
      sock.emit({ t: 'home', views: HOME });
    });
    return sock;
  };

  /** Push a frame as the server would (a banner, a changed view). */
  push(f: GlassesServerFrame): void {
    this.sock?.emit(f);
  }

  private handle(f: GlassesClientFrame): void {
    this.sent.push(f);
    const out = (x: GlassesServerFrame) => this.sock?.emit(x);
    if (f.t === 'ping') return out({ t: 'pong' });
    if (f.t === 'open') {
      if (f.screen === 'home') return out({ t: 'home', views: HOME });
      if (f.screen === 'view') return out(viewFrame(f.viewId, this.rows));
      return out(threadFrame(f.key, this.rows));
    }
    if (f.t === 'stt') return out({ t: 'ok', reqId: f.reqId, text: this.transcript });
    if (f.t === 'answer') {
      const r = this.rows.find((x) => x.key === f.key);
      if (!r?.promptId) return out({ t: 'refused', reqId: f.reqId, reason: 'gone', message: 'already answered' });
      r.promptId = null;
      r.mark = 'working';
      return out({ t: 'ok', reqId: f.reqId });
    }
    if (f.t === 'say' || f.t === 'patch') return out({ t: 'ok', reqId: f.reqId });
  }
}
