// Không mất sự kiện khi đường nối máy -> trạm chập chờn: đường nối chỉ bỏ tin khi trạm đã nhận và trả lại tin chưa
// chắc tới (src/remote-link.mjs); máy giữ sự kiện lúc mất nối rồi gửi bù sau lời chào (src/node-agent.mjs); trạm bỏ
// bản trùng theo mã eid, kể cả qua các lần nối lại (src/hub.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'orbit-link-'));
process.env.ORBIT_REMOTE_STATE = join(ROOT, 'state');
process.env.ORBIT_REMOTE_PROJECTS = join(ROOT, 'projects');
process.env.ORBIT_REMOTE_CLAUDE_SESSIONS = join(ROOT, 'sessions');
mkdirSync(process.env.ORBIT_REMOTE_PROJECTS, { recursive: true });
const { connectOnce } = await import('../src/remote-link.mjs');
const { NodeAgent } = await import('../src/node-agent.mjs');
const { Hub } = await import('../src/hub.mjs');

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

// Trạm giả: /node/link mở luồng và báo "linked"; /node/push trả theo `push(lô)` (số mã trạng thái HTTP).
async function fakeHub({ push = () => 200, afterLinked = () => {} } = {}) {
  const got = [];
  const streams = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/node/link') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ op: 'linked', linkId: 'L1' })}\n\n`);
      streams.add(res);
      afterLinked(res);
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const batch = JSON.parse(body);
      const status = push(batch);
      if (status === 200) got.push(...batch);
      res.writeHead(status).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    got,
    endStreams: () => { for (const s of streams) s.end(); },
    close: () => new Promise((r) => { for (const s of streams) s.destroy(); server.close(r); }),
  };
}

function fakeAgent(onAttach) {
  const agent = {
    requeued: [],
    detached: 0,
    attach(send) { onAttach(send); },
    detach() { agent.detached += 1; },
    handle() {},
    requeue(msgs) { agent.requeued.push(...msgs); },
  };
  return agent;
}
const ev = (n) => ({ op: 'event', id: 's1', ev: { t: 'text', text: `tin ${n}` }, eid: `x-${n}` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('trạm từ chối lô: không tin nào bị bỏ, tất cả trả lại cho máy theo đúng thứ tự', async () => {
  const hub = await fakeHub({ push: () => 503 });
  try {
    const agent = fakeAgent((send) => { send(ev(1)); send(ev(2)); send(ev(3)); });
    const r = await connectOnce(agent, { hubUrl: hub.url, token: 't' });
    assert.equal(r.linked, true);
    assert.deepEqual(agent.requeued, [ev(1), ev(2), ev(3)]);
    assert.equal(agent.detached, 1);
  } finally {
    await hub.close();
  }
});

test('trạm đóng luồng giữa chừng: tin đã tới thì thôi, tin chưa gửi thì trả lại', async () => {
  let sendLater;
  const hub = await fakeHub();
  try {
    const agent = fakeAgent((send) => { send(ev(1)); sendLater = send; });
    const done = connectOnce(agent, { hubUrl: hub.url, token: 't' });
    for (let i = 0; i < 50 && hub.got.length < 1; i += 1) await wait(20);
    assert.deepEqual(hub.got, [ev(1)]);
    sendLater(ev(2)); // vào hàng đợi, chưa kịp gửi (gom 40 ms) thì trạm đóng luồng
    hub.endStreams();
    await done;
    assert.deepEqual(agent.requeued, [ev(2)]);
  } finally {
    await hub.close();
  }
});

test('đường nối chết lặng (không cả ping): tự bỏ để dựng lại, không chờ fetch hết giờ', async () => {
  const hub = await fakeHub();
  try {
    const started = Date.now();
    const r = await connectOnce(fakeAgent(() => {}), { hubUrl: hub.url, token: 't', silenceMs: 300 });
    assert.equal(r.reason, 'closed');
    assert.ok(Date.now() - started < 3000, `bỏ sau ${Date.now() - started} ms`);
  } finally {
    await hub.close();
  }
});

test('máy: sự kiện lúc mất nối được giữ (không giữ mẩu chữ), tin trả lại xếp trước; nối lại thì gửi bù ngay sau lời chào', () => {
  const agent = new NodeAgent({ machineId: 'mL', machineName: 'MayL', claudeCommand: ['node', 'x'], pipePath: join(ROOT, 'pipe') });
  agent.safeOut(ev(2));
  agent.safeOut({ op: 'delta', id: 's1', text: 'mẩu' });
  agent.safeOut({ op: 'status', session: { id: 's1' } });
  agent.requeue([ev(1), { op: 'delta', id: 's1', text: 'x' }]);
  assert.deepEqual(agent.pending, [ev(1), ev(2)]);

  const out = [];
  agent.attach((m) => out.push(m));
  assert.equal(out[0].op, 'hello');
  assert.deepEqual(out.slice(1, 3), [ev(1), ev(2)], 'gửi bù đúng thứ tự, ngay sau lời chào');
  assert.deepEqual(agent.pending, []);
  agent.detach();
});

test('máy: mất nối lâu thì chỉ giữ 2000 sự kiện mới nhất', () => {
  const agent = new NodeAgent({ machineId: 'mM', machineName: 'MayM', claudeCommand: ['node', 'x'], pipePath: join(ROOT, 'pipe2') });
  for (let i = 1; i <= 2100; i += 1) agent.safeOut(ev(i));
  assert.equal(agent.pending.length, 2000);
  assert.deepEqual(agent.pending[0], ev(101));
});

test('trạm bỏ sự kiện trùng theo eid, kể cả khi máy đã nối lại (lời chào mới)', () => {
  const hub = new Hub({ stateDir: join(ROOT, 'hub') });
  hub.sessions.set('s1', { snap: { id: 's1', name: 'A', status: 'idle', machineId: 'mX' }, buffer: [], seq: 0, history: null });
  const hello = (link) => hub.onHello({ machine: { id: 'mX', name: 'X', platform: 'win32' }, sessions: [] }, link, null);
  hello({ close() {} });
  hub.onMachineMessage(hub.machines.get('mX'), ev(1), null);
  hub.onMachineMessage(hub.machines.get('mX'), ev(1), null);
  assert.equal(hub.sessions.get('s1').buffer.length, 1);
  hello({ close() {} });
  hub.onMachineMessage(hub.machines.get('mX'), ev(1), null); // gửi bù sau khi nối lại: đã tới trước đó
  hub.onMachineMessage(hub.machines.get('mX'), ev(2), null);
  assert.deepEqual(hub.sessions.get('s1').buffer.map((e) => e.text), ['tin 1', 'tin 2']);
  hub.onMachineMessage(hub.machines.get('mX'), { op: 'event', id: 's1', ev: { t: 'text', text: 'không mã' } }, null);
  assert.equal(hub.sessions.get('s1').buffer.length, 3, 'máy bản cũ không gửi eid: vẫn nhận');
});
