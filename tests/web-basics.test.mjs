// Những mảnh nhỏ của app dùng trên mọi màn: gọi API (web/lib/api.js) báo lỗi mạng bằng tiếng Việt và không treo mãi;
// nút nổi "Cần duyệt" (web/lib/waiting.js) chọn đúng phiên; danh sách file service worker lưu sẵn có đủ mọi file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'web');
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define('window', globalThis);
if (typeof globalThis.CustomEvent !== 'function') define('CustomEvent', class extends Event { constructor(t, o) { super(t); this.detail = o?.detail; } });
const { api, ApiError, OFFLINE_TEXT, TIMEOUT_TEXT } = await import('../web/lib/api.js');
const { waitingSummary } = await import('../web/lib/waiting.js');

test('mất mạng: báo bằng tiếng Việt thay vì "Failed to fetch"; trạm trả lỗi thì giữ lời của trạm', async () => {
  define('fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(api.get('/api/state'), (err) => err instanceof ApiError && err.status === 0 && err.message === OFFLINE_TEXT);
  define('fetch', async () => ({ ok: false, status: 409, json: async () => ({ error: 'Phiên vẫn đang chạy.' }) }));
  await assert.rejects(api.post('/api/x'), /Phiên vẫn đang chạy\./);
  define('fetch', async () => ({ ok: true, status: 200, json: async () => ({ ok: 1 }) }));
  assert.deepEqual(await api.get('/api/x'), { ok: 1 });
});

test('trạm treo: hết thời hạn thì báo "không trả lời kịp", không chờ mãi', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  define('fetch', (path, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  const pending = api.get('/api/slow');
  t.mock.timers.tick(95000);
  await assert.rejects(pending, (err) => err.message === TIMEOUT_TEXT);
});

test('nút "Cần duyệt": phiên chờ lâu nhất trước, bỏ phiên đang mở trên màn, đếm cả hai cho tiêu đề', () => {
  const s = [
    { id: 'a', name: 'Alpha', status: 'waiting', lastActivity: '2026-11-09T10:05:00Z' },
    { id: 'b', name: 'Beta', status: 'waiting', lastActivity: '2026-11-09T10:01:00Z' },
    { id: 'c', name: 'Gamma', status: 'busy', lastActivity: '2026-11-09T09:00:00Z' },
  ];
  assert.deepEqual(waitingSummary(s, '#/'), { total: 2, target: s[1], text: '2 phiên cần duyệt' });
  assert.deepEqual(waitingSummary(s, '#/s/b/m/m1'), { total: 2, target: s[0], text: 'Alpha cần duyệt' });
  assert.deepEqual(waitingSummary([s[0]], '#/s/a'), { total: 1, target: null, text: '' }, 'đang mở đúng phiên đó: khỏi nhắc');
  assert.deepEqual(waitingSummary([s[2]], '#/'), { total: 0, target: null, text: '' });
});

test('service worker lưu sẵn đủ mọi file thư viện và màn của app (thiếu thì app mở lúc mất mạng bị hỏng)', () => {
  const sw = readFileSync(join(WEB, 'sw.js'), 'utf8');
  const shell = /const SHELL = \[([\s\S]*?)\];/.exec(sw)[1];
  const listed = new Set([...shell.matchAll(/'(\/[^']+)'/g)].map((m) => m[1]));
  for (const p of listed) if (p !== '/') assert.ok(existsSync(join(WEB, p)), `${p} có trong danh sách mà không có file`);
  const app = readFileSync(join(WEB, 'app.js'), 'utf8');
  for (const m of app.matchAll(/from '\.\/((?:lib|views)\/[^']+)'/g)) assert.ok(listed.has(`/${m[1]}`), `/${m[1]} chưa có trong danh sách của sw.js`);
});

test('thông báo: báo khi phiên vừa cần duyệt hay vừa xong lượt lúc không xem app; không báo khi đang xem, khi vừa nối lại (nạp cả danh sách), hay khi đã tắt', async () => {
  class FakeNotification { constructor() {} }
  FakeNotification.permission = 'granted';
  define('Notification', FakeNotification);
  define('isSecureContext', true);
  const mem = new Map();
  define('localStorage', { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) });
  const { trackNotifications, notifyReason, setNotifyOff, notifySupported } = await import('../web/lib/notify.js');
  assert.equal(notifySupported(), true);
  assert.equal(notifyReason('busy', { name: 'A', status: 'waiting' }).title, 'A cần duyệt');
  assert.equal(notifyReason('busy', { name: 'A', status: 'idle', lastText: 'Xong rồi' }).body, 'Xong rồi');
  assert.equal(notifyReason(undefined, { name: 'A', status: 'waiting' }), null, 'phiên mới thấy lần đầu: không báo');
  assert.equal(notifyReason('idle', { name: 'A', status: 'busy' }), null);

  const listeners = {};
  const store = { sessions: new Map([['a', { id: 'a', name: 'A', status: 'busy' }]]), on: (t, fn) => { listeners[t] = fn; } };
  const shown = [];
  let watching = false;
  trackNotifications(store, { show: (why, id) => shown.push([why.title, id]), visible: () => watching });
  listeners.session({ id: 'a', name: 'A', status: 'waiting' });
  assert.deepEqual(shown, [['A cần duyệt', 'a']]);
  listeners.session({ id: 'a', name: 'A', status: 'waiting' });
  assert.equal(shown.length, 1, 'vẫn chờ duyệt: không báo lại');

  watching = true;
  listeners.session({ id: 'a', name: 'A', status: 'busy' });
  listeners.session({ id: 'a', name: 'A', status: 'idle' });
  assert.equal(shown.length, 1, 'đang xem app: không báo');

  watching = false;
  store.sessions.set('a', { id: 'a', name: 'A', status: 'waiting' });
  listeners.state();
  listeners.session({ id: 'a', name: 'A', status: 'waiting' });
  assert.equal(shown.length, 1, 'vừa nối lại: trạng thái nạp lại không thành thông báo');

  setNotifyOff(true);
  listeners.session({ id: 'a', name: 'A', status: 'busy' });
  listeners.session({ id: 'a', name: 'A', status: 'idle' });
  assert.equal(shown.length, 1, 'đã tắt');
});

test('tìm phiên: không phân biệt dấu, hoa thường; mọi từ phải khớp; gồm phiên ngoài app (trừ phiên app đã giữ); đang chạy lên trước', async () => {
  const { searchSessions } = await import('../web/lib/search.js');
  const machines = new Map([
    ['m1', { id: 'm1', name: 'Máy Công Ty', online: true, external: [
      { claudeSessionId: 'c-ext', title: 'Sửa lỗi đăng nhập ở VS Code', cwd: 'D:/Zitga/qa-portal', modified: '2026-11-09T09:00:00Z' },
      { claudeSessionId: 'c-app', title: 'Trùng phiên app', cwd: 'D:/x', modified: '2026-11-09T09:00:00Z' },
    ] }],
    ['m2', { id: 'm2', name: 'Mac', online: false, external: [{ claudeSessionId: 'c-off', title: 'sửa lỗi', cwd: '/x' }] }],
  ]);
  const sessions = new Map([
    ['a', { id: 'a', name: 'Sửa lỗi build', status: 'stopped', machineId: 'm1', cwd: 'D:/Zitga/PigLoop', claudeSessionId: 'c-app', lastActivity: '2026-11-09T10:00:00Z' }],
    ['b', { id: 'b', name: 'Viết test', status: 'busy', machineId: 'm1', cwd: 'D:/Zitga/qa-portal', lastText: 'Đã sửa lỗi xong', lastActivity: '2026-11-09T08:00:00Z' }],
  ]);
  const ids = (q) => searchSessions(q, sessions, machines).map((x) => (x.kind === 'app' ? x.s.id : x.t.claudeSessionId));
  assert.deepEqual(ids('sua loi'), ['c-ext', 'b', 'a'], 'đang chạy trước (mới hoạt động gần nhất trước), phiên đã dừng sau; phiên ngoài app của máy tắt thì bỏ');
  assert.deepEqual(ids('SỬA qa-portal'), ['c-ext', 'b'], 'mọi từ đều phải khớp');
  assert.deepEqual(ids('cong ty pigloop'), ['a'], 'khớp cả tên máy');
  assert.deepEqual(ids('trùng'), [], 'phiên ngoài app mà app đang giữ thì không lặp');
  assert.deepEqual(ids('   '), []);
});

test('thuật ngữ: một bảng chung; không màn nào tự đặt tên trạng thái riêng hay dùng chữ tiếng Anh Active, In-Active', async () => {
  const { STATUS_LABEL, statusLabel, VERB } = await import('../web/lib/labels.js');
  assert.equal(STATUS_LABEL.starting, 'Đang khởi động', 'không trùng chữ "đang mở" của phiên mở ngoài app');
  assert.equal(statusLabel({ status: 'idle', offline: true }), 'Mất kết nối');
  assert.equal(statusLabel({ status: 'stopped', offline: true }), 'Đã dừng');
  assert.deepEqual(VERB, { resume: 'Chạy lại', takeOver: 'Tiếp tục ở app', fork: 'Tách nhánh mới' });
  const { readdirSync } = await import('node:fs');
  for (const f of readdirSync(join(WEB, 'views'))) {
    const src = readFileSync(join(WEB, 'views', f), 'utf8');
    assert.ok(!/'(In-)?Active'/.test(src), `${f}: còn chữ Active/In-Active`);
    assert.ok(!/waiting: 'Chờ duyệt'|starting: 'Đang mở'/.test(src), `${f}: còn bảng trạng thái riêng`);
  }
});
