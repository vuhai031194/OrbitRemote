// Xem nhật ký của máy từ app (src/logs.mjs readLogTail): chỉ một danh sách tên cố định, đúng số dòng cuối, bỏ dòng
// mã QR khối đặc, tệp lớn chỉ đọc phần đuôi.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOGS, readLogTail } from '../src/logs.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'orbit-logs-'));
test.after(() => rmSync(DIR, { recursive: true, force: true }));

test('nhật ký: đúng số dòng cuối, bỏ dòng mã QR; chưa có tệp thì báo missing; tên lạ (kể cả ../) bị từ chối', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `[giờ] dòng ${i + 1}`);
  writeFileSync(join(DIR, 'hub.log'), [...lines.slice(0, 48), '███ █▀▀▀█ █▀▄█▄▀█▀▄██', ...lines.slice(48), ''].join('\r\n'));
  const r = readLogTail('hub', 3, DIR);
  assert.equal(r.text, '[giờ] dòng 48\n[giờ] dòng 49\n[giờ] dòng 50', 'ba dòng cuối, không có dòng QR');
  assert.equal(r.missing, false);
  assert.deepEqual(readLogTail('node', 10, DIR), { name: 'node', text: '', size: 0, mtime: null, missing: true });
  for (const bad of ['../auth', 'auth', 'hub.log', '', 'constructor']) assert.throws(() => readLogTail(bad, 10, DIR), /Không có nhật ký này/, bad);
  assert.deepEqual(Object.keys(LOGS), ['hub', 'node', 'setup', 'restart', 'ensure']);
});

test('nhật ký lớn: chỉ đọc phần đuôi, bỏ dòng cụt ở đầu phần đọc', () => {
  const big = `${'x'.repeat(200 * 1024)}\n[giờ] dòng cuối cùng\n`;
  writeFileSync(join(DIR, 'setup.log'), big);
  const r = readLogTail('setup', 5, DIR);
  assert.equal(r.text, '[giờ] dòng cuối cùng');
  assert.ok(r.size > 200 * 1024);
});
