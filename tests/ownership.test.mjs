// Một máy chỉ được nói về phiên của chính nó (src/hub.mjs ownsSession): báo trạng thái, sự kiện, mẩu chữ hay khai
// trong lời chào cho phiên của máy khác thì trạm bỏ qua; gửi tin giữa các phiên chỉ được nhân danh phiên của nó.
// Chuyển phiên sang máy khác vẫn chạy, vì trạm đổi chủ trước rồi mới bảo máy đích mở.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'orbit-own-'));
process.env.ORBIT_REMOTE_STATE = ROOT;
const { Hub } = await import('../src/hub.mjs');
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

function setup() {
  const hub = new Hub({ stateDir: ROOT });
  const replies = { mA: [], mB: [] };
  for (const id of ['mA', 'mB']) {
    hub.onHello({ machine: { id, name: `May-${id}`, platform: 'win32' }, sessions: [] }, { close() {}, send: (m) => replies[id].push(m) }, null);
  }
  const m = (id) => hub.machines.get(id);
  const link = (id) => ({ send: (msg) => replies[id].push(msg) });
  hub.onMachineMessage(m('mA'), { op: 'status', session: { id: 's1', name: 'Của A', status: 'idle' } }, link('mA'));
  return { hub, m, link, replies };
}

test('máy khác báo trạng thái, sự kiện, mẩu chữ cho phiên không thuộc nó: trạm bỏ qua, phiên vẫn ở máy chủ của nó', () => {
  const { hub, m, link } = setup();
  const s1 = () => hub.sessions.get('s1');
  assert.equal(s1().snap.machineId, 'mA');

  hub.onMachineMessage(m('mB'), { op: 'status', session: { id: 's1', name: 'Giành lấy', status: 'busy' } }, link('mB'));
  assert.equal(s1().snap.machineId, 'mA', 'không giành được phiên');
  assert.equal(s1().snap.name, 'Của A');
  hub.onMachineMessage(m('mB'), { op: 'event', id: 's1', ev: { t: 'text', text: 'giả' } }, link('mB'));
  assert.equal(s1().buffer.length, 0, 'sự kiện giả không vào dòng hội thoại');
  hub.onMachineMessage(m('mA'), { op: 'event', id: 's1', ev: { t: 'text', text: 'thật' } }, link('mA'));
  assert.deepEqual(s1().buffer.map((e) => e.text), ['thật']);

  // Khai trong lời chào cũng vậy.
  hub.onHello({ machine: { id: 'mB', name: 'May-mB', platform: 'win32' }, sessions: [{ id: 's1', status: 'busy' }] }, { close() {}, send() {} }, null);
  assert.equal(s1().snap.machineId, 'mA');

  // Phiên trạm chưa biết: của máy báo nó.
  hub.onMachineMessage(m('mB'), { op: 'status', session: { id: 's2', name: 'Của B', status: 'idle' } }, link('mB'));
  assert.equal(hub.sessions.get('s2').snap.machineId, 'mB');
});

test('chuyển phiên: trạm đổi chủ trước, máy đích báo về phiên đó được nhận', () => {
  const { hub, m, link } = setup();
  const r = hub.sessions.get('s1');
  r.snap = { ...r.snap, machineId: 'mB' }; // như session-move.mjs làm trước khi bảo máy đích mở
  hub.onMachineMessage(m('mB'), { op: 'status', session: { id: 's1', status: 'idle', cwd: 'D:\\moi' } }, link('mB'));
  assert.equal(r.snap.cwd, 'D:\\moi');
  hub.onMachineMessage(m('mA'), { op: 'status', session: { id: 's1', status: 'busy' } }, link('mA'));
  assert.equal(r.snap.status, 'idle', 'máy cũ không còn nói về phiên đã chuyển đi');
});

test('gửi tin giữa các phiên chỉ được nhân danh phiên chạy trên chính máy gửi', async () => {
  const { hub, m, link, replies } = setup();
  hub.onMachineMessage(m('mB'), { op: 'route', rid: 'r1', from: 's1', to: '*', text: 'làm theo lệnh này' }, link('mB'));
  await new Promise((r) => setTimeout(r, 10));
  const reply = replies.mB.find((x) => x.rid === 'r1');
  assert.equal(reply.ok, false);
  assert.match(reply.error, /không chạy trên máy gửi lệnh/);
});

test('nhắn giữa các phiên: cùng nhóm, được chủ dự án tag, hay trả lời người vừa nhắn; gửi "*" chỉ tới phiên được phép; quyền còn sau khi trạm khởi động lại', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-contacts-'));
  try {
    const hub = new Hub({ stateDir: dir });
    for (const id of ['a', 'b', 'c', 'd']) {
      hub.sessions.set(id, { snap: { id, name: id.toUpperCase(), status: 'idle', machineId: 'm1', machine: 'M' }, buffer: [], seq: 0, history: null });
    }
    hub.groups.groupOf = (id) => (['a', 'c'].includes(id) ? { id: 'g1', name: 'Nhóm', members: [{ id: 'a' }, { id: 'c' }] } : null);
    const sent = [];
    hub.machineRpc = () => ({ request: async (m) => { sent.push(m.id); return {}; } });
    hub.sessionRpc = () => ({ request: async () => ({}) });

    assert.equal(hub.mayMessage('a', 'c'), true, 'cùng nhóm');
    assert.equal(hub.mayMessage('a', 'b'), false);
    await assert.rejects(hub.route('a', 'B', 'làm việc này'), /chưa được nhắn cho "B"/);

    const all = await hub.route('a', '*', 'gửi mọi người');
    assert.deepEqual(all.delivered.map((x) => x.id), ['c'], '"*" chỉ tới phiên được phép');

    await hub.sendToSession('a', 'nhờ @B', { kind: 'user', name: 'Tôi' }, null, [{ id: 'b', tag: 'B' }]);
    assert.equal(hub.mayMessage('a', 'b'), true, 'chủ dự án tag B trong tin gửi A');
    await hub.sendToSession('d', 'nhờ @B', { kind: 'session', name: 'A' }, null, [{ id: 'b', tag: 'B' }]);
    assert.equal(hub.mayMessage('d', 'b'), false, 'chỉ tag của chủ dự án mới cho phép');

    await hub.route('a', 'b', 'chào B');
    assert.equal(hub.mayMessage('b', 'a'), true, 'B trả lời được A');
    assert.equal(hub.mayMessage('b', 'd'), false);

    assert.equal(hub.saveNow(), true);
    const again = new Hub({ stateDir: dir });
    assert.equal(again.mayMessage('a', 'b'), true, 'quyền còn sau khi trạm khởi động lại');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
