// The open gateway's brain (SC-11683): Claude Code sessions (Agent SDK) presented as the glasses protocol that the
// Aristo Lens app speaks (src/gateway/glasses.ts). One process, one machine, no Aristo needed.
//
// What it does for the lens:
//  - one view, "Sessions": every session this gateway started, newest first
//  - a session's thread: what you said, what the agent said, one line per tool call
//  - asks: a permission prompt (Yes / Always / No) or an AskUserQuestion (its options), answered from the lens
//  - show-me cards: the agent calls the `show_card` tool and every connected lens draws it
//
// Everything that talks to the outside (the SDK's `query`, the clock, ids) is injected, so tests run it with fakes.
import { randomUUID } from 'node:crypto';

export const PROTOCOL = 1;
export const VIEW_ID = 'sessions';
export const THREAD_LIMIT = 12;
const HOST = 'local';

const TOOL_TARGET = {
  Bash: 'command',
  Edit: 'file_path',
  Write: 'file_path',
  Read: 'file_path',
  MultiEdit: 'file_path',
  WebFetch: 'url',
  WebSearch: 'query',
  Glob: 'pattern',
  Grep: 'pattern',
};
const ASK_TITLE = {
  Bash: 'Bash command',
  Edit: 'Edit file',
  Write: 'Write file',
  MultiEdit: 'Edit file',
  WebFetch: 'Fetch page',
  WebSearch: 'Web search',
};
const CARD_TOOL = 'show_card';

export const CARD_PROMPT = `You are being used through smart glasses (Even Realities G2): the user reads a 576x288 monochrome lens and talks to you.
Keep replies short. When numbers, a list of more than 3 items, a table, or anything that is hard to say aloud would help,
call the ${CARD_TOOL} tool to put a card on the lens, then mention it in one sentence instead of reading it out.`;

/** One line of tool input for the thread ("Bash npm test"). */
function toolLine(name, input) {
  const k = TOOL_TARGET[name];
  const arg = k && typeof input?.[k] === 'string' ? input[k] : '';
  const short = name.startsWith('mcp__') ? name.split('__').pop() : name;
  return `${short}${arg ? ' ' + arg.split('\n')[0].slice(0, 120) : ''}`;
}

function age(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function titleOf(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 40 ? t.slice(0, 39).trimEnd() + '…' : t || 'New session';
}

/** A card body from the tool's flat arguments; throws on a shape the lens cannot draw. */
// The HTTP route has no zod in front of it, so every field is checked here: a card the lens cannot lay out would
// freeze its display until the card expires.
const isStr = (v) => typeof v === 'string';
const strs = (v) => (Array.isArray(v) && v.every(isStr) ? v : null);
export function cardBody(a) {
  if (!a || typeof a !== 'object') throw new Error('a card is a JSON object');
  if (a.kind === 'stat') {
    if (!isStr(a.value) || !a.value) throw new Error('a stat card needs `value` (a string)');
    const spark =
      Array.isArray(a.spark) && a.spark.length >= 2 && a.spark.every((n) => Number.isFinite(n)) ? a.spark : null;
    return {
      kind: 'stat',
      value: a.value,
      ...(isStr(a.delta) && a.delta ? { delta: a.delta } : {}),
      ...(spark ? { spark } : {}),
      ...(isStr(a.spark_label) && a.spark_label ? { sparkLabel: a.spark_label } : {}),
    };
  }
  if (a.kind === 'list') {
    const rows = strs(a.rows);
    if (!rows?.length) throw new Error('a list card needs `rows` (strings)');
    return { kind: 'list', rows };
  }
  if (a.kind === 'table') {
    const head = strs(a.head);
    const rows = Array.isArray(a.table) ? a.table.map(strs) : null;
    if (!head?.length || !rows?.length || rows.some((r) => !r))
      throw new Error('a table card needs `head` and `table` (strings)');
    const align = Array.isArray(a.align) ? a.align.filter((x) => x === 'l' || x === 'r').slice(0, 4) : [];
    return {
      kind: 'table',
      head: head.slice(0, 4),
      rows: rows.map((r) => r.slice(0, 4)),
      ...(align.length ? { align } : {}),
    };
  }
  throw new Error(`unknown card kind ${a.kind}`);
}

/**
 * The options a client may see and answer. A permission is approvable only from a lens that guards what it shows
 * (`ask-whole`: it offers only No for a detail it cannot show whole); any other client, or none, gets the refusing
 * options only, so an older lens build can never approve a command it showed cut short (REVIEW.md).
 */
export function offered(ask, c) {
  return ask.kind === 'permission' && !c?.whole ? ask.options.filter((o) => o.kind === 'no') : ask.options;
}

/** A queue that is also the session's streaming prompt: `push` a message, the SDK pulls it. */
function inbox() {
  const items = [];
  let wake = null;
  let closed = false;
  return {
    push(m) {
      items.push(m);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (items.length) yield items.shift();
        if (closed) return;
        await new Promise((r) => (wake = r));
        wake = null;
      }
    },
  };
}

export class Gateway {
  /**
   * @param {object} d
   * @param {(p: {prompt: AsyncIterable<unknown>, options: object}) => AsyncIterable<any> & {interrupt?: () => Promise<void>}} d.query
   * @param {(name: string, desc: string, shape: object, fn: Function) => unknown} [d.tool] the SDK's `tool`
   * @param {(o: object) => unknown} [d.mcp] the SDK's `createSdkMcpServer`
   * @param {object} [d.cardShape] zod shape for show_card (from server.mjs, so core needs no zod)
   * @param {string} [d.cwd]
   * @param {string} [d.model]
   * @param {string} [d.permissionMode]
   * @param {() => number} [d.now]
   */
  constructor(d) {
    this.d = d;
    this.now = d.now ?? (() => Date.now());
    /** @type {Map<string, any>} */
    this.sessions = new Map();
    /** @type {Set<{send: (f: object) => void, open: object | null, banned: Set<string>}>} */
    this.clients = new Set();
    this.cardSeq = 0;
  }

  // ------------------------------------------------------------------------------------------ presentation

  row(s) {
    const mark = s.ask ? 'needs' : s.status === 'error' ? 'error' : s.status === 'working' ? 'working' : 'your-turn';
    const status = { needs: 'Waiting on you', error: 'Error', working: 'Working', 'your-turn': 'Your turn' }[mark];
    const detail = s.ask ? `${s.ask.ask}: ${s.ask.detail}`.slice(0, 120) : s.status === 'working' ? s.activity : '';
    return {
      key: s.key,
      hostId: HOST,
      title: s.title,
      mark,
      status,
      detail,
      age: age(this.now() - s.changedAt),
      project: s.project,
      promptId: s.ask?.promptId ?? null,
      depth: 0,
    };
  }

  rows() {
    return [...this.sessions.values()].sort((a, b) => b.changedAt - a.changedAt).map((s) => this.row(s));
  }

  homeFrame() {
    const rows = this.rows();
    const needs = rows.filter((r) => r.mark === 'needs' || r.mark === 'your-turn').length;
    return {
      t: 'home',
      views: [
        {
          id: VIEW_ID,
          name: 'Sessions',
          needs,
          working: rows.filter((r) => r.mark === 'working').length,
          total: rows.length,
        },
      ],
      needs,
    };
  }

  viewFrame(limit = 20) {
    const rows = this.rows();
    const needs = rows.filter((r) => r.mark === 'needs' || r.mark === 'your-turn').length;
    return {
      t: 'view',
      viewId: VIEW_ID,
      name: 'Sessions',
      needs,
      total: rows.length,
      sections: [{ label: 'Sessions', rows: rows.slice(0, limit) }],
      more: Math.max(0, rows.length - limit),
    };
  }

  /** `c` = the client it is for: one without the `ask-whole` capability gets a permission's refusing options only. */
  threadFrame(key, limit = THREAD_LIMIT, c = null) {
    const s = this.sessions.get(key);
    if (!s) return null;
    const a = s.ask;
    const ask = a
      ? {
          key,
          promptId: a.promptId,
          kind: a.kind,
          ask: a.ask,
          asker: null,
          detail: a.detail,
          context: a.context,
          options: offered(a, c),
          freeText: a.freeText,
          more: a.more,
          createdAt: new Date(a.at).toISOString(),
        }
      : null;
    return { t: 'thread', row: this.row(s), ask, lines: s.lines.slice(-limit) };
  }

  frameFor(open, c = null) {
    if (!open || open.screen === 'home') return this.homeFrame();
    if (open.screen === 'view') return this.viewFrame(open.limit);
    return this.threadFrame(open.key, open.limit, c);
  }

  // ------------------------------------------------------------------------------------------ clients

  /** `caps` = what the client declared (`caps=` on its URL or in its auth frame). */
  attach(send, caps = []) {
    const c = { send, open: null, whole: caps.includes('ask-whole') };
    this.clients.add(c);
    send({ t: 'hello', protocol: PROTOCOL, host: HOST, hosts: [{ id: HOST, up: true }] });
    send(this.homeFrame());
    return c;
  }

  detach(c) {
    this.clients.delete(c);
  }

  /** Re-send every client's open screen (cheap: one session list, one thread). */
  changed() {
    for (const c of this.clients) {
      const f = this.frameFor(c.open, c);
      if (f) c.send(f);
    }
  }

  broadcast(f) {
    for (const c of this.clients) c.send(f);
  }

  // ------------------------------------------------------------------------------------------ sessions

  create(text) {
    const id = randomUUID();
    const key = `${HOST}/${id.slice(0, 8)}`;
    const box = inbox();
    const s = {
      key,
      id,
      title: titleOf(text),
      project: (this.d.cwd ?? process.cwd()).split('/').pop() ?? '',
      status: 'working',
      activity: 'thinking',
      lines: [],
      ask: null,
      changedAt: this.now(),
      box,
      q: null,
    };
    this.sessions.set(key, s);
    this.say(s, text);
    const options = {
      cwd: this.d.cwd ?? process.cwd(),
      ...(this.d.model ? { model: this.d.model } : {}),
      permissionMode: this.d.permissionMode ?? 'default',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: CARD_PROMPT },
      canUseTool: (name, input, o) => this.permission(s, name, input, o),
      ...(this.d.mcp && this.d.tool && this.d.cardShape ? { mcpServers: { glasses: this.cardServer(s) } } : {}),
    };
    s.q = this.d.query({ prompt: box, options });
    void this.pump(s);
    this.changed();
    return s;
  }

  say(s, text) {
    s.lines.push({ who: 'you', text, at: new Date(this.now()).toISOString() });
    s.status = 'working';
    s.activity = 'thinking';
    s.changedAt = this.now();
    s.box.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  }

  async pump(s) {
    try {
      for await (const m of s.q) this.onMessage(s, m);
      s.status = 'idle';
    } catch (e) {
      s.status = 'error';
      s.lines.push({ who: 'agent', text: `Error: ${e?.message ?? e}`, at: new Date(this.now()).toISOString() });
    }
    s.changedAt = this.now();
    this.changed();
  }

  onMessage(s, m) {
    const at = new Date(this.now()).toISOString();
    if (m.type === 'assistant' && m.parent_tool_use_id == null) {
      for (const b of m.message?.content ?? []) {
        if (b.type === 'text' && b.text.trim()) s.lines.push({ who: 'agent', text: b.text.trim(), at });
        if (b.type === 'tool_use') {
          const line = toolLine(b.name, b.input);
          s.lines.push({ who: 'tool', text: line, at });
          s.activity = line;
        }
      }
    } else if (m.type === 'result') {
      s.status = m.is_error ? 'error' : 'idle';
      s.activity = '';
    } else return;
    s.changedAt = this.now();
    this.changed();
  }

  // ------------------------------------------------------------------------------------------ asks

  /** The SDK's canUseTool: our own card tool runs; everything else becomes an ask on the lens. */
  permission(s, name, input, o) {
    // Exactly our own server's tool: another MCP server could ship a tool with the same short name.
    if (name === `mcp__glasses__${CARD_TOOL}`) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    // The lens shows one ask per session: parallel tool calls wait their turn instead of overwriting the open one.
    const turn = (s.asks ?? Promise.resolve()).then(() => this.ask(s, name, input, o));
    s.asks = turn.catch(() => {}); // error-ok: the queue only orders asks; the rejection reaches the SDK through `turn`
    return turn;
  }

  ask(s, name, input, o) {
    if (o?.signal?.aborted) return Promise.resolve({ behavior: 'deny', message: 'Cancelled.' });
    const promptId = randomUUID();
    let ask;
    if (name === 'AskUserQuestion') {
      const qs = Array.isArray(input.questions) ? input.questions : [];
      const q = qs[0] ?? { question: 'Question', options: [] };
      ask = {
        kind: 'question',
        ask: q.header || 'Question',
        detail: q.question,
        options: (q.options ?? []).map((op, i) => ({
          label: op.label,
          title: op.description || op.label,
          kind: 'choice',
          primary: i === 0,
          answer: { promptId, answers: { [q.question]: op.label } },
        })),
        freeText: true,
        more: Math.max(0, qs.length - 1),
        finish: (a) => ({
          behavior: 'allow',
          updatedInput: { ...input, answers: a.answers ?? { [q.question]: a.text ?? '' } },
        }),
      };
    } else {
      const k = TOOL_TARGET[name];
      // The whole target, whitespace runs collapsed so padding cannot push the end out of sight. Never cut here: the
      // lens measures it in pixels and offers only No for what it cannot show whole (src/lens/state.ts, REVIEW.md).
      const full = (k && typeof input[k] === 'string' ? input[k] : JSON.stringify(input)).replace(/\s+/g, ' ').trim();
      ask = {
        kind: 'permission',
        ask: ASK_TITLE[name] ?? name.split('__').pop(),
        detail: full,
        options: [
          { label: 'Yes', title: 'Yes', kind: 'yes', primary: true, answer: { promptId, option: 1 } },
          ...(o?.suggestions?.length
            ? [
                {
                  label: 'Always',
                  title: "Yes, and don't ask again",
                  kind: 'always',
                  primary: false,
                  answer: { promptId, option: 2 },
                },
              ]
            : []),
          { label: 'No', title: 'No', kind: 'no', primary: false, answer: { promptId, option: 3 } },
        ],
        freeText: true,
        more: 0,
        finish: (a) =>
          a.option === 1
            ? { behavior: 'allow', updatedInput: input }
            : a.option === 2
              ? { behavior: 'allow', updatedInput: input, updatedPermissions: o?.suggestions ?? [] }
              : { behavior: 'deny', message: a.text ? `The user said no: ${a.text}` : 'The user said no.' },
      };
    }
    const last = [...s.lines].reverse().find((l) => l.who === 'agent');
    return new Promise((resolve) => {
      s.ask = { ...ask, promptId, context: last?.text ?? null, at: this.now(), resolve };
      s.changedAt = this.now();
      o?.signal?.addEventListener?.('abort', () => {
        if (s.ask?.promptId === promptId) {
          s.ask = null;
          resolve({ behavior: 'deny', message: 'Cancelled.' });
          this.changed();
        }
      });
      for (const c of this.clients)
        if (!(c.open?.screen === 'session' && c.open.key === s.key))
          c.send({ t: 'banner', key: s.key, title: s.title, ask: `${ask.ask}: ${ask.detail}`.slice(0, 120), promptId });
      this.changed();
    });
  }

  /** Resolve an ask. Returns a refusal reason, or null when it landed. */
  answer(key, raw, c = null) {
    if (!raw || typeof raw !== 'object') return 'changed';
    // A dictated answer is ONLY its words: any option or answers riding along are dropped, so text can refuse a
    // permission or answer a question but never approve (REVIEW.md). Every other answer must be one offered to `c`.
    const a = typeof raw.text === 'string' ? { promptId: raw.promptId, text: raw.text } : raw;
    const s = this.sessions.get(key);
    if (!s?.ask || s.ask.promptId !== a.promptId) return 'gone';
    const ask = s.ask;
    if (
      a.text === undefined &&
      !offered(ask, c).some(
        (op) =>
          JSON.stringify(op.answer) ===
          JSON.stringify({
            promptId: a.promptId,
            ...(a.option !== undefined ? { option: a.option } : {}),
            ...(a.answers ? { answers: a.answers } : {}),
          }),
      )
    )
      return 'changed';
    s.ask = null;
    s.changedAt = this.now();
    ask.resolve(ask.finish(a));
    this.changed();
    return null;
  }

  // ------------------------------------------------------------------------------------------ cards

  cardServer(s) {
    const tool = this.d.tool(
      CARD_TOOL,
      'Show a card on the user\'s smart glasses: a big number (kind "stat", optional delta and spark trend), a list ("list", rows), or a table ("table", head + table, at most 4 columns). It replaces the card with the same id. Use it when speech is a poor fit.',
      this.d.cardShape,
      async (a) => {
        try {
          this.showCard(s.key, a);
          return { content: [{ type: 'text', text: 'Shown on the glasses.' }] };
        } catch (e) {
          return { content: [{ type: 'text', text: String(e.message ?? e) }], isError: true };
        }
      },
    );
    return this.d.mcp({ name: 'glasses', version: '1.0.0', tools: [tool], alwaysLoad: true });
  }

  /** Validate and broadcast a card; returns it. `key` = the session that pushed it, or null. */
  showCard(key, a) {
    const body = cardBody(a);
    const ttl = Number.isFinite(a.ttl_seconds) && a.ttl_seconds >= 0 ? a.ttl_seconds : 20;
    const card = {
      id: isStr(a.id) && a.id ? a.id : `card-${++this.cardSeq}`,
      key,
      title: (isStr(a.title) ? a.title : '').slice(0, 80) || 'Card',
      ttlMs: ttl === 0 ? null : Math.round(ttl * 1000),
      body,
    };
    this.broadcast({ t: 'card', card });
    return card;
  }

  // ------------------------------------------------------------------------------------------ client frames

  /** Handle one lens frame. `reply` sends to that client only. `stt(pcm: Buffer)` transcribes. */
  async handle(c, f, reply, stt) {
    const ok = (extra = {}) => reply({ t: 'ok', reqId: f.reqId, ...extra });
    const refuse = (reason, message) => reply({ t: 'refused', reqId: f.reqId, reason, message });
    switch (f.t) {
      case 'ping':
        return reply({ t: 'pong' });
      case 'open': {
        const open = { ...f };
        delete open.t;
        c.open = open;
        const fr = this.frameFor(open, c);
        return fr ? reply(fr) : reply(this.homeFrame());
      }
      case 'create': {
        const s = this.create(f.text);
        return ok({ key: s.key });
      }
      case 'draft':
        return ok({
          draft: { project: null, projectWhy: '', model: 'default', modelWhy: '', projects: [], models: [] },
        });
      case 'say': {
        const s = this.sessions.get(f.key);
        if (!s) return refuse('gone', 'No such session.');
        this.say(s, f.text);
        this.changed();
        return ok();
      }
      case 'answer': {
        const why = this.answer(f.key, 'text' in f ? { promptId: f.promptId, text: f.text } : f.answer, c);
        return why ? refuse(why, why === 'gone' ? 'Already answered.' : 'Not an option of this prompt.') : ok();
      }
      case 'interrupt': {
        const s = this.sessions.get(f.key);
        if (!s || s.status !== 'working') return refuse('gone', 'Not working.');
        await s.q?.interrupt?.();
        return ok();
      }
      case 'patch': {
        const s = this.sessions.get(f.key);
        if (!s) return refuse('gone', 'No such session.');
        if (f.done || f.closed) {
          s.box.close();
          this.sessions.delete(f.key);
          this.changed();
        }
        return ok();
      }
      case 'listen':
        c.listen = { reqId: f.reqId, pcm: [] };
        return;
      case 'audio':
        if (c.listen?.reqId === f.reqId) c.listen.pcm.push(Buffer.from(f.pcm, 'base64'));
        return;
      case 'listen.cancel':
        if (c.listen?.reqId === f.reqId) c.listen = null;
        return ok();
      case 'listen.end':
      case 'stt': {
        const pcm =
          f.t === 'stt'
            ? Buffer.from(f.pcm, 'base64')
            : c.listen?.reqId === f.reqId
              ? Buffer.concat(c.listen.pcm)
              : null;
        if (f.t === 'listen.end') c.listen = null;
        if (!pcm) return refuse('gone', 'No open listen.');
        try {
          return ok({ text: pcm.length ? await stt(pcm) : '' });
        } catch (e) {
          return refuse('error', `Speech to text failed: ${e?.message ?? e}`);
        }
      }
      default:
        return refuse('bad', `Unknown frame ${f.t}.`);
    }
  }
}
