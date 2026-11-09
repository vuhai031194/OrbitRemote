// File trạng thái (src/paths.mjs readStateJson, writeJsonAtomic) và sức chịu lỗi của trạm khi đọc, ghi chúng:
// file hỏng không bị coi như trống rồi ghi đè; lưu lỗi không làm sập trạm; sập liên tục thì thôi tự chạy lại.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'orbit-state-'));
process.env.ORBIT_REMOTE_STATE = join(ROOT, 'default-state');
const { readStateJson, writeJsonAtomic } = await import('../src/paths.mjs');
const { Hub } = await import('../src/hub.mjs');
const { Auth } = await import('../src/auth.mjs');
const { crashDecision, CRASH_MAX, CRASH_WINDOW_MS } = await import('../src/launch.mjs');

test.after(() => rmSync(ROOT, { recursive: true, force: true }));
const dirOf = (name) => {
  const d = join(ROOT, name);
  mkdirSync(d, { recursive: true });
  return d;
};
const corruptCopies = (dir, base) => readdirSync(dir).filter((n) => n.startsWith(`${base}.corrupt-`));

test('ghi giữ bản dự phòng .bak là bản tốt trước đó; file hỏng không bao giờ được chép làm bản dự phòng', () => {
  const dir = dirOf('write');
  const file = join(dir, 's.json');
  writeJsonAtomic(file, { v: 1 }, { backup: true });
  assert.ok(!existsSync(`${file}.bak`), 'lần đầu chưa có gì để giữ');
  writeJsonAtomic(file, { v: 2 }, { backup: true });
  assert.deepEqual(JSON.parse(readFileSync(`${file}.bak`, 'utf8')), { v: 1 });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 2 });
  writeFileSync(file, '{"v": 3, "cụt');
  writeJsonAtomic(file, { v: 4 }, { backup: true });
  assert.deepEqual(JSON.parse(readFileSync(`${file}.bak`, 'utf8')), { v: 1 }, 'bản hỏng không đè bản dự phòng tốt');
  assert.ok(!readdirSync(dir).some((n) => n.endsWith('.tmp')), 'không để lại file tạm');
});

test('đọc: file tốt thì dùng; hỏng thì cất sang .corrupt-<giờ> và nạp .bak; không có .bak thì trống mà bản hỏng vẫn còn; mất file thì nạp .bak', () => {
  const dir = dirOf('read');
  const file = join(dir, 's.json');
  writeJsonAtomic(file, { v: 1 }, { backup: true });
  writeJsonAtomic(file, { v: 2 }, { backup: true });
  assert.deepEqual(readStateJson(file, null), { value: { v: 2 }, from: 'file' });

  writeFileSync(file, '{"v": 2, "cụt');
  const r = readStateJson(file, null);
  assert.equal(r.from, 'bak');
  assert.deepEqual(r.value, { v: 1 });
  assert.ok(r.corrupt && existsSync(r.corrupt), 'bản hỏng được cất lại để cứu tay');
  assert.equal(readFileSync(r.corrupt, 'utf8'), '{"v": 2, "cụt');
  assert.ok(!existsSync(file));

  assert.deepEqual(readStateJson(file, null), { value: { v: 1 }, from: 'bak', corrupt: '' }, 'mất file chính thì nạp .bak');

  const lone = join(dir, 'lone.json');
  writeFileSync(lone, 'không phải JSON');
  const l = readStateJson(lone, { devices: [] });
  assert.equal(l.from, 'none');
  assert.deepEqual(l.value, { devices: [] });
  assert.equal(corruptCopies(dir, 'lone.json').length, 1);
  assert.deepEqual(readStateJson(join(dir, 'chua-co.json'), 7), { value: 7, from: 'none', corrupt: '' });
});

test('trạm: hub.json hỏng thì nạp lại phiên từ bản dự phòng, bản hỏng còn nguyên; lưu lỗi (đĩa, file bị giữ) không làm sập trạm', () => {
  const dir = dirOf('hub');
  const first = new Hub({ stateDir: dir });
  first.sessions.set('s1', { snap: { id: 's1', name: 'Giữ lại', status: 'stopped', machineId: 'm1', cwd: 'C:\\x' }, buffer: [], seq: 0, history: null });
  assert.equal(first.saveNow(), true);
  assert.equal(first.saveNow(), true); // lần hai: hub.json.bak là bản có phiên
  writeFileSync(join(dir, 'hub.json'), '{"sessions": [');

  const second = new Hub({ stateDir: dir });
  assert.ok(second.sessions.has('s1'), 'phiên về từ bản dự phòng');
  assert.equal(second.sessions.get('s1').snap.name, 'Giữ lại');
  assert.equal(corruptCopies(dir, 'hub.json').length, 1);

  writeFileSync(join(dir, 'chan'), 'là file, không phải thư mục');
  second.file = join(dir, 'chan', 'hub.json');
  assert.equal(second.saveNow(), false, 'báo không lưu được, không ném lỗi');
  clearTimeout(second.saveRetry);
});

test('auth.json hỏng: thiết bị đã ghép về từ bản dự phòng, không phải ghép lại', () => {
  const dir = dirOf('auth');
  const file = join(dir, 'auth.json');
  const a = new Auth(file);
  const { token } = a.issue('Điện thoại', 'device');
  a.issue('Máy tính', 'device'); // lần lưu thứ hai: auth.json.bak có điện thoại
  writeFileSync(file, '{"devices": [{"id"');
  const b = new Auth(file);
  assert.ok(b.check(token, 'device'), 'thẻ của điện thoại vẫn dùng được');
});

test('tự chạy lại sau khi sập, trừ khi sập liên tục trong 10 phút', () => {
  const now = 1_000_000_000;
  let times = [];
  for (let i = 1; i <= CRASH_MAX; i += 1) {
    const d = crashDecision(times, now + i * 1000);
    assert.equal(d.respawn, true, `lần ${i}`);
    times = d.times;
  }
  assert.equal(crashDecision(times, now + 5000).respawn, false, 'lần thứ tư trong 10 phút: thôi');
  assert.equal(crashDecision(times, now + CRASH_WINDOW_MS + 5000).respawn, true, 'các lần cũ quá 10 phút thì không tính');
  assert.deepEqual(crashDecision('hỏng', now), { times: [now], respawn: true });
});

test('hẹn chạy lại: tiến trình tách riêng chờ đủ giờ rồi mới dựng lệnh, ghi vào log trạng thái', async () => {
  const { spawnMainLater } = await import('../src/launch.mjs');
  const logFile = spawnMainLater(['khong-co-lenh-nay'], 'later-test.log', 300);
  const said = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!said().includes('khong-co-lenh-nay'), 'chưa tới giờ');
  const until = Date.now() + 10000;
  while (!said().includes('Không có lệnh "khong-co-lenh-nay"') && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  assert.match(said(), /Không có lệnh "khong-co-lenh-nay"/);
});
