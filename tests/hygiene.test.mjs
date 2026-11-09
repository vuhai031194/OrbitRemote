// Trạm và máy chạy lâu không phình mãi: máy dọn cấu hình MCP sót lại và tệp đính kèm cũ của phiên không còn chạy
// (src/node-agent.mjs sweepStale); trạm bỏ bộ đệm sự kiện của phiên dừng lâu, mở lại thì nạp lại từ nhật ký
// (src/hub.mjs pruneIdleBuffers); app không đọc kịp luồng sự kiện thì bị cắt để nối lại (src/server.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'orbit-hygiene-'));
process.env.ORBIT_REMOTE_STATE = join(ROOT, 'state');
process.env.ORBIT_REMOTE_PROJECTS = join(ROOT, 'projects');
mkdirSync(process.env.ORBIT_REMOTE_PROJECTS, { recursive: true });
const { NodeAgent } = await import('../src/node-agent.mjs');
const { Hub } = await import('../src/hub.mjs');
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test('máy dọn cấu hình MCP sót lại và tệp đính kèm cũ của phiên không còn chạy; phiên đang chạy và tệp mới thì giữ', () => {
  const stateDir = join(ROOT, 'agent');
  const agent = new NodeAgent({ machineId: 'mH0001', machineName: 'H', claudeCommand: ['node', 'x'], pipePath: join(ROOT, 'pipe'), stateDir });
  agent.sessions.set('dang-chay', { claudeSessionId: 'x' });
  const mcp = join(stateDir, 'mcp');
  mkdirSync(mcp, { recursive: true });
  for (const id of ['dang-chay', 'cu1', 'cu2']) writeFileSync(join(mcp, `${id}.json`), '{}');
  const up = (id, daysAgo) => {
    const dir = join(stateDir, 'uploads', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'anh.png'), 'x');
    const t = new Date(Date.now() - daysAgo * 86400000);
    utimesSync(join(dir, 'anh.png'), t, t);
    utimesSync(dir, t, t);
  };
  up('dang-chay', 30);
  up('cu-lau', 30);
  up('cu-moi', 2);
  assert.deepEqual(agent.sweepStale(), { mcp: 2, uploads: 1 });
  assert.ok(existsSync(join(mcp, 'dang-chay.json')), 'phiên đang chạy giữ cấu hình MCP');
  assert.ok(!existsSync(join(mcp, 'cu1.json')));
  assert.ok(existsSync(join(stateDir, 'uploads', 'dang-chay')), 'tệp của phiên đang chạy giữ dù cũ');
  assert.ok(!existsSync(join(stateDir, 'uploads', 'cu-lau')), 'phiên không chạy, 30 ngày không đụng: dọn');
  assert.ok(existsSync(join(stateDir, 'uploads', 'cu-moi')), 'mới 2 ngày: giữ');
  assert.deepEqual(agent.sweepStale(), { mcp: 0, uploads: 0 });
});

test('trạm bỏ bộ đệm của phiên dừng quá một giờ (mở lại thì nạp lại từ nhật ký); phiên đang chạy hay mới dừng thì giữ', () => {
  const hub = new Hub({ stateDir: join(ROOT, 'hub') });
  clearInterval(hub.pruneTimer);
  const now = Date.parse('2026-11-09T12:00:00Z');
  const rec = (id, status, minutesAgo) => {
    const r = { snap: { id, status, lastActivity: new Date(now - minutesAgo * 60000).toISOString() }, buffer: [{ seq: 1 }], seq: 1, history: [{ t: 'user' }] };
    hub.sessions.set(id, r);
    return r;
  };
  const old = rec('cu', 'stopped', 120);
  const fresh = rec('moi', 'stopped', 10);
  const live = rec('chay', 'idle', 600);
  assert.equal(hub.pruneIdleBuffers(now), 1);
  assert.deepEqual([old.buffer, old.history, old.seq], [[], null, 1], 'số thứ tự giữ nguyên, sự kiện mới vẫn tiếp số');
  assert.equal(fresh.buffer.length, 1);
  assert.equal(live.buffer.length, 1, 'phiên đang chạy không bao giờ bị bỏ bộ đệm');
});

// Trên loopback, hệ điều hành nhận hộ hàng chục MB dù bên kia không đọc, nên không dựng được kết nối chậm thật:
// kiểm hàm gửi với kết nối giả có writableLength (lượng tin Node đang giữ chờ gửi) tuỳ ý.
test('app không đọc kịp luồng sự kiện (tin dồn quá 2 MB) thì trạm cắt kết nối đó, các app khác vẫn nhận', async () => {
  const { pushFrame, SSE_BACKLOG_MAX } = await import('../src/server.mjs');
  const fake = (backlog) => ({ writableLength: backlog, got: [], destroyed: false, write(f) { this.got.push(f); }, destroy() { this.destroyed = true; } });
  const slow = fake(SSE_BACKLOG_MAX + 1);
  const ok = fake(SSE_BACKLOG_MAX);
  const clients = new Set([slow, ok]);
  pushFrame(clients, 'event: x\n\n');
  assert.equal(slow.destroyed, true, 'kết nối dồn quá ngưỡng bị cắt');
  assert.deepEqual(slow.got, []);
  assert.ok(!clients.has(slow), 'không gửi tiếp cho kết nối đã cắt');
  assert.deepEqual(ok.got, ['event: x\n\n'], 'kết nối còn đọc vẫn nhận');
  assert.equal(SSE_BACKLOG_MAX, 2 * 1024 * 1024);
});
