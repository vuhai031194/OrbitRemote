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
