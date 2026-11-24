// Open gateway (SC-11683): a fake Agent SDK `query` drives the real Gateway and the real WebSocket server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { Gateway, cardBody } from '../core.mjs';
import { serve } from '../server.mjs';
import { wav } from '../stt.mjs';

/** A fake `query`: replies with text, or calls a tool through canUseTool when the prompt names one. */
function fakeQuery({ prompt, options }) {
  const out = (async function* () {
    for await (const m of prompt) {
      const text = m.message.content;
      if (text.startsWith('bash ')) {
        const input = { command: text.slice(5) };
        yield {
          type: 'assistant',
          parent_tool_use_id: null,
          message: { content: [{ type: 'tool_use', name: 'Bash', input }] },
        };
        const r = await options.canUseTool('Bash', input, {
          signal: new AbortController().signal,
          suggestions: [{ type: 'addRules' }],
        });
        yield {
          type: 'assistant',
          parent_tool_use_id: null,
          message: { content: [{ type: 'text', text: r.behavior === 'allow' ? 'ran it' : `denied: ${r.message}` }] },
        };
      } else if (text === 'ask') {
        const input = {
          questions: [
            {
              question: 'Which branch?',
              header: 'Branch',
              options: [{ label: 'main' }, { label: 'dev' }],
              multiSelect: false,
            },
          ],
        };
        const r = await options.canUseTool('AskUserQuestion', input, { signal: new AbortController().signal });
        yield {
          type: 'assistant',
          parent_tool_use_id: null,
          message: { content: [{ type: 'text', text: `picked ${JSON.stringify(r.updatedInput.answers)}` }] },
        };
      } else {
        yield {
          type: 'assistant',
          parent_tool_use_id: null,
          message: { content: [{ type: 'text', text: `echo: ${text}` }] },
        };
      }
      yield { type: 'result', is_error: false };
    }
  })();
  out.interrupt = async () => {};
  return out;
}

const tick = () => new Promise((r) => setTimeout(r, 10));
/** A client that declared `ask-whole` (the current lens). */
const W = { whole: true };

function rig() {
  const g = new Gateway({ query: fakeQuery, cwd: '/tmp/demo', now: () => 1_700_000_000_000 });
  const sent = [];
  const c = g.attach((f) => sent.push(f), ['ask-whole']);
  const call = (f) =>
    g.handle(
      c,
      f,
      (x) => sent.push(x),
      async () => 'hello from stt',
    );
  return { g, c, sent, call, last: (t) => [...sent].reverse().find((f) => f.t === t) };
}

test('hello then home with one Sessions view', () => {
  const { sent } = rig();
  assert.equal(sent[0].t, 'hello');
  assert.deepEqual(sent[1], {
    t: 'home',
    views: [{ id: 'sessions', name: 'Sessions', needs: 0, working: 0, total: 0 }],
    needs: 0,
  });
});

test('create starts a session; its thread shows what was said and the reply', async () => {
  const { call, last } = rig();
  await call({ t: 'create', reqId: 'r1', text: 'hi there' });
  const key = last('ok').key;
  assert.match(key, /^local\//);
  await tick();
  await call({ t: 'open', screen: 'session', key });
  const th = last('thread');
  assert.deepEqual(
    th.lines.map((l) => [l.who, l.text]),
    [
      ['you', 'hi there'],
      ['agent', 'echo: hi there'],
    ],
  );
  assert.equal(th.row.mark, 'your-turn');
});

test('a permission ask shows on the lens; Yes lets it run; a stale answer is refused', async () => {
  const { g, call, last, sent } = rig();
  await call({ t: 'create', reqId: 'r1', text: 'bash rm -rf build' });
  const key = last('ok').key;
  await tick();
  assert.equal(last('banner').key, key, 'a client not looking at the session gets a banner');
  await call({ t: 'open', screen: 'session', key });
  const ask = last('thread').ask;
  assert.equal(ask.kind, 'permission');
  assert.equal(ask.detail, 'rm -rf build');
  assert.deepEqual(
    ask.options.map((o) => o.label),
    ['Yes', 'Always', 'No'],
  );
  await call({ t: 'answer', reqId: 'r2', key, answer: ask.options[0].answer });
  assert.equal(last('ok').reqId, 'r2');
  await tick();
  assert.equal(g.threadFrame(key).lines.at(-1).text, 'ran it');
  sent.length = 0;
  await call({ t: 'answer', reqId: 'r3', key, answer: ask.options[0].answer });
  assert.equal(last('refused').reason, 'gone');
});

test('No with a dictated reason denies with that reason', async () => {
  const { g, call, last } = rig();
  await call({ t: 'create', reqId: 'r1', text: 'bash deploy' });
  const key = last('ok').key;
  await tick();
  const ask = g.threadFrame(key).ask;
  await call({ t: 'answer', reqId: 'r2', key, promptId: ask.promptId, text: 'not on a Friday' });
  await tick();
  assert.equal(g.threadFrame(key).lines.at(-1).text, 'denied: The user said no: not on a Friday');
});

test('an AskUserQuestion becomes a question with its options; picking one answers it', async () => {
  const { g, call, last } = rig();
  await call({ t: 'create', reqId: 'r1', text: 'ask' });
  const key = last('ok').key;
  await tick();
  const ask = g.threadFrame(key).ask;
  assert.equal(ask.kind, 'question');
  assert.equal(ask.detail, 'Which branch?');
  assert.deepEqual(
    ask.options.map((o) => o.label),
    ['main', 'dev'],
  );
  await call({ t: 'answer', reqId: 'r2', key, answer: ask.options[1].answer });
  await tick();
  assert.equal(g.threadFrame(key).lines.at(-1).text, 'picked {"Which branch?":"dev"}');
});

test('an answer that is not one of the options is refused as changed', async () => {
  const { g, call, last } = rig();
  await call({ t: 'create', reqId: 'r1', text: 'ask' });
  const key = last('ok').key;
  await tick();
  const ask = g.threadFrame(key).ask;
  await call({
    t: 'answer',
    reqId: 'r2',
    key,
    answer: { promptId: ask.promptId, answers: { 'Which branch?': 'prod' } },
  });
  assert.equal(last('refused').reason, 'changed');
});

test('show_card broadcasts a card with the agent ttl; bad shapes are rejected', () => {
  const { g, last } = rig();
  g.showCard('local/x', { title: 'Revenue', kind: 'stat', value: '$4,210', spark: [1, 2], ttl_seconds: 0 });
  assert.deepEqual(last('card').card, {
    id: 'card-1',
    key: 'local/x',
    title: 'Revenue',
    ttlMs: null,
    body: { kind: 'stat', value: '$4,210', spark: [1, 2] },
  });
  g.showCard(null, { title: 'T', kind: 'table', head: ['a', 'b', 'c', 'd', 'e'], table: [['1', '2', '3', '4', '5']] });
  assert.equal(last('card').card.ttlMs, 20_000);
  assert.equal(last('card').card.body.head.length, 4);
  assert.throws(() => cardBody({ kind: 'list', rows: [] }), /rows/);
  assert.throws(() => cardBody({ kind: 'pie' }), /unknown/);
});

test('listen + audio + listen.end returns the transcript', async () => {
  const { call, last } = rig();
  await call({ t: 'listen', reqId: 'L1' });
  await call({ t: 'audio', reqId: 'L1', pcm: Buffer.alloc(320).toString('base64') });
  await call({ t: 'listen.end', reqId: 'L1' });
  assert.deepEqual(last('ok'), { t: 'ok', reqId: 'L1', text: 'hello from stt' });
});

test('wav header describes 16 kHz mono 16-bit', () => {
  const w = wav(Buffer.alloc(100));
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(w.length, 144);
});

test('server: wrong token refused, first-frame auth works, POST /api/card reaches the lens', async () => {
  const g = new Gateway({ query: fakeQuery });
  const server = serve({ gateway: g, token: 'sekret', stt: async () => '' });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `ws://127.0.0.1:${port}/api/glasses`;

  const bad = new WebSocket(`${base}?token=nope`);
  const code = await new Promise((r) =>
    bad.on('unexpected-response', (_q, res) => r(res.statusCode)).on('error', () => {}),
  );
  assert.equal(code, 401);

  const ws = new WebSocket(base);
  const frames = [];
  ws.on('message', (m) => frames.push(JSON.parse(String(m))));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'auth', token: 'sekret' }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(frames[0]?.t, 'hello');

  const res = await fetch(`http://127.0.0.1:${port}/api/card`, {
    method: 'POST',
    headers: { authorization: 'Bearer sekret', 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Flights', kind: 'list', rows: ['VN 318'] }),
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(frames.at(-1).t, 'card');
  assert.deepEqual(frames.at(-1).card.body, { kind: 'list', rows: ['VN 318'] });

  const unauth = await fetch(`http://127.0.0.1:${port}/api/card`, { method: 'POST', body: '{}' });
  assert.equal(unauth.status, 401);
  ws.close();
  server.close();
});

test('parallel permission asks wait their turn; both resolve (review F5aef514b4a)', async () => {
  const g = new Gateway({ query: fakeQuery });
  const s = { key: 'local/p', title: 'p', lines: [], status: 'working', changedAt: 0, box: { push() {} } };
  g.sessions.set(s.key, s);
  const sig = new AbortController().signal;
  const a = g.permission(s, 'Bash', { command: 'one' }, { signal: sig });
  const b = g.permission(s, 'Bash', { command: 'two' }, { signal: sig });
  await tick();
  assert.equal(s.ask.detail, 'one');
  assert.equal(g.answer(s.key, s.ask.options[0].answer, W), null);
  assert.equal((await a).behavior, 'allow');
  await tick();
  assert.equal(s.ask.detail, 'two', 'the second ask shows once the first is answered');
  assert.equal(g.answer(s.key, { promptId: s.ask.promptId, option: 3 }), null);
  assert.equal((await b).behavior, 'deny');
});

test('an aborted ask settles as denied and frees the queue', async () => {
  const g = new Gateway({ query: fakeQuery });
  const s = { key: 'local/q', title: 'q', lines: [], status: 'working', changedAt: 0, box: { push() {} } };
  g.sessions.set(s.key, s);
  const ac = new AbortController();
  const a = g.permission(s, 'Bash', { command: 'one' }, { signal: ac.signal });
  const b = g.permission(s, 'Bash', { command: 'two' }, { signal: new AbortController().signal });
  await tick();
  ac.abort();
  assert.equal((await a).behavior, 'deny');
  await tick();
  assert.equal(s.ask.detail, 'two');
  g.answer(s.key, s.ask.options[0].answer, W);
  assert.equal((await b).behavior, 'allow');
});

test('POST /api/card refuses shapes the lens cannot draw (review F676cc10356); an oversize frame does not crash the server (F1f18504843)', async () => {
  assert.throws(() => cardBody({ kind: 'stat', value: 4210 }), /string/);
  assert.throws(() => cardBody({ kind: 'list', rows: 'a' }), /rows/);
  assert.throws(() => cardBody({ kind: 'table', head: ['a'], table: [[1]] }), /table/);
  const g = new Gateway({ query: fakeQuery });
  const server = serve({ gateway: g, token: 't', stt: async () => '' });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const bad = await fetch(`http://127.0.0.1:${port}/api/card`, {
    method: 'POST',
    headers: { authorization: 'Bearer t' },
    body: JSON.stringify({ kind: 'stat', value: 4210 }),
  });
  assert.equal(bad.status, 400);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/glasses?token=t`);
  await new Promise((r) => ws.on('open', r));
  const closed = new Promise((r) => ws.on('close', r));
  ws.send(Buffer.alloc(9 * 1024 * 1024));
  await closed;
  const ok = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(await ok.text(), 'ok', 'the server is still up');
  server.close();
});

test('a pre-auth `null` (or any non-object) frame is refused, not a crash (review F4eee2abd9e)', async () => {
  const g = new Gateway({ query: fakeQuery });
  const server = serve({ gateway: g, token: 't', stt: async () => '' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/glasses`);
  const got = [];
  ws.on('message', (m) => got.push(JSON.parse(String(m))));
  await new Promise((r) => ws.on('open', r));
  for (const raw of ['null', '42', '"x"']) ws.send(raw);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(
    got.map((f) => f.reason),
    ['bad', 'bad', 'bad'],
  );
  ws.send(JSON.stringify({ t: 'auth', token: 't' }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(got.at(-1).t, 'home', 'still alive and serving after the bad frames');
  ws.close();
  server.close();
});

test('only our own show_card skips the lens; a same-named tool from another MCP server asks (review Ff42ee9790e)', async () => {
  const g = new Gateway({ query: fakeQuery });
  const s = { key: 'local/m', title: 'm', lines: [], status: 'working', changedAt: 0, box: { push() {} } };
  g.sessions.set(s.key, s);
  const sig = new AbortController().signal;
  assert.equal((await g.permission(s, 'mcp__glasses__show_card', {}, { signal: sig })).behavior, 'allow');
  const other = g.permission(s, 'mcp__evil__show_card', { x: 1 }, { signal: sig });
  await tick();
  assert.equal(s.ask?.kind, 'permission', 'a look-alike tool needs a yes on the lens');
  g.answer(s.key, { promptId: s.ask.promptId, option: 3 });
  assert.equal((await other).behavior, 'deny');
});

test('hostile requests never take the gateway down (review F6abe23ceec, F18717597d7, F267511a4fa, F31a69dce39)', async () => {
  const net = await import('node:net');
  const g = new Gateway({ query: fakeQuery });
  const server = serve({ gateway: g, token: 't', stt: async () => '', log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const raw = (text) =>
    new Promise((r) => {
      const s = net.connect(port, '127.0.0.1', () => s.end(text));
      s.on('error', () => r());
      s.on('close', () => r());
      s.resume();
    });
  // unparsable request targets, as a plain request and as an upgrade
  await raw('GET //[ HTTP/1.1\r\nHost: x\r\n\r\n');
  await raw('GET http://a:99999999/ HTTP/1.1\r\nHost: x\r\n\r\n');
  await raw(
    'GET //[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n', // gitleaks:allow RFC 6455's sample nonce
  );
  // a card POST whose client drops mid-body
  await new Promise((r) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write('POST /api/card HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer t\r\nContent-Length: 1000\r\n\r\n{"title":');
      setTimeout(() => s.destroy(), 20);
    });
    s.on('close', r);
  });
  // an auth frame whose token is not a string
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/glasses`);
  await new Promise((r) => ws.on('open', r));
  const closed = new Promise((r) => ws.on('close', r));
  ws.send(JSON.stringify({ t: 'auth', token: { toString: 1 } }));
  await closed;
  await new Promise((r) => setTimeout(r, 50));
  const ok = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(await ok.text(), 'ok', 'still serving after every hostile request');
  server.close();
});

test('a permission carries the whole target, padding collapsed, never cut (the lens decides what it can show; review F3c7b6b7c66)', async () => {
  const g = new Gateway({ query: fakeQuery });
  const s = { key: 'local/l', title: 'l', lines: [], status: 'working', changedAt: 0, box: { push() {} } };
  g.sessions.set(s.key, s);
  const sig = new AbortController().signal;
  const tail = '; rm -rf build';
  const padded = g.permission(s, 'Bash', { command: `npm test${' '.repeat(500)}${tail}` }, { signal: sig });
  await tick();
  assert.equal(s.ask.detail, `npm test ${tail}`, 'padding collapses, the tail is in view');
  g.answer(s.key, s.ask.options[0].answer, W);
  assert.equal((await padded).behavior, 'allow');
  const cmd = 'echo ' + 'x'.repeat(600) + ' && rm -rf ~';
  const long = g.permission(s, 'Bash', { command: cmd }, { signal: sig });
  await tick();
  assert.equal(s.ask.detail, cmd, 'the whole command reaches the lens, its end included');
  g.answer(s.key, { promptId: s.ask.promptId, option: 3 });
  assert.equal((await long).behavior, 'deny');
});

test('a client that does not declare ask-whole (an older lens) sees only No and cannot send a Yes (review Fd534f966ae)', async () => {
  const g = new Gateway({ query: fakeQuery });
  const oldSent = [];
  const old = g.attach((f) => oldSent.push(f));
  const cur = g.attach(() => {}, ['ask-whole']);
  await g.handle(
    old,
    { t: 'create', reqId: 'r1', text: 'bash rm -rf build' },
    (f) => oldSent.push(f),
    async () => '',
  );
  const key = oldSent.find((f) => f.t === 'ok').key;
  await tick();
  await g.handle(
    old,
    { t: 'open', screen: 'session', key },
    (f) => oldSent.push(f),
    async () => '',
  );
  const shown = oldSent.filter((f) => f.t === 'thread').at(-1).ask;
  assert.deepEqual(
    shown.options.map((o) => o.label),
    ['No'],
  );
  const yes = { promptId: shown.promptId, option: 1 };
  assert.equal(g.answer(key, yes, old), 'changed', 'a forged Yes from the old client is refused');
  assert.equal(g.threadFrame(key, 12, cur).ask.options[0].label, 'Yes', 'the current lens is offered Yes');
  assert.equal(g.answer(key, yes, cur), null);
  await tick();
  assert.equal(g.threadFrame(key).lines.at(-1).text, 'ran it');
});

test('the server reads caps from the URL and from the auth frame', async () => {
  const g = new Gateway({ query: fakeQuery });
  const seen = [];
  const attach = g.attach.bind(g);
  g.attach = (send, caps) => (seen.push(caps), attach(send, caps));
  const server = serve({ gateway: g, token: 't', stt: async () => '', log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const a = new WebSocket(`ws://127.0.0.1:${port}/api/glasses?token=t&caps=ask-whole`);
  await new Promise((r) => a.on('open', r));
  const b = new WebSocket(`ws://127.0.0.1:${port}/api/glasses`);
  await new Promise((r) => b.on('open', r));
  b.send(JSON.stringify({ t: 'auth', token: 't', caps: ['ask-whole'] }));
  const c = new WebSocket(`ws://127.0.0.1:${port}/api/glasses?token=t`);
  await new Promise((r) => c.on('open', r));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen, [['ask-whole'], ['ask-whole'], []]);
  for (const w of [a, b, c]) w.close();
  server.close();
});

test('an answer with text is only its words: option 1 riding along never approves (review F1c0f76041f)', async () => {
  for (const [client, text] of [
    [null, ''],
    [W, ''],
    [null, 5],
    [null, null],
    [W, null],
  ]) {
    const g = new Gateway({ query: fakeQuery });
    const s = { key: 'local/t', title: 't', lines: [], status: 'working', changedAt: 0, box: { push() {} } };
    g.sessions.set(s.key, s);
    const p = g.permission(s, 'Bash', { command: 'rm -rf build' }, { signal: new AbortController().signal });
    await tick();
    const why = g.answer(s.key, { promptId: s.ask.promptId, option: 1, text }, client);
    if (typeof text === 'string') {
      assert.equal(why, null);
      assert.equal((await p).behavior, 'deny', 'string text + option 1 is a refusal');
    } else if (client) {
      assert.equal(why, null, 'non-string text is dropped; the current lens was offered Yes');
      assert.equal((await p).behavior, 'allow');
    } else {
      assert.equal(why, 'changed', 'non-string text cannot carry option 1 past an old lens');
      g.answer(s.key, { promptId: s.ask.promptId, option: 3 });
      assert.equal((await p).behavior, 'deny');
    }
  }
  const g = new Gateway({ query: fakeQuery });
  assert.equal(g.answer('local/none', null), 'changed', 'a non-object answer is refused, not thrown');
});
