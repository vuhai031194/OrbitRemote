// Kiểm nút "Tệp" ở màn phiên, phần đầu máy (src/files.mjs): liệt kê một tầng thư mục làm việc của phiên, đọc tệp
// theo khúc, và không bao giờ ra ngoài thư mục đó (.., đường tuyệt đối, lối tắt trỏ ra ngoài, đường mạng).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILES_MAX, listFiles, locate, readFileChunk } from '../src/files.mjs';

function project() {
  const base = mkdtempSync(join(tmpdir(), 'orbit-files-'));
  const root = join(base, 'du-an');
  mkdirSync(join(root, 'docs', 'reference'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(root, 'Library'));
  mkdirSync(join(root, '.claude'));
  mkdirSync(join(root, 'a10'));
  mkdirSync(join(root, 'a2'));
  writeFileSync(join(root, 'README.md'), '# Dự án\n');
  writeFileSync(join(root, '.env'), 'KEY=1\n');
  writeFileSync(join(root, 'b.txt'), 'xin chào');
  writeFileSync(join(root, 'docs', 'spec.md'), 'nội dung spec');
  writeFileSync(join(base, 'ngoai.txt'), 'không được đọc');
  mkdirSync(join(base, 'ngoai'));
  writeFileSync(join(base, 'ngoai', 'bi-mat.txt'), 'không được đọc');
  return { base, root };
}

test('liệt kê một tầng: thư mục trước tệp, tên chấm xuống cuối, số theo giá trị, thư mục nặng có dấu, tệp có cỡ', async () => {
  const { base, root } = project();
  try {
    const r = await listFiles(root, '');
    assert.equal(r.path, '');
    assert.deepEqual(r.entries.map((e) => `${e.kind}:${e.name}`), [
      'dir:a2', 'dir:a10', 'dir:docs', 'dir:Library', 'dir:node_modules', 'dir:.claude',
      'file:b.txt', 'file:README.md', 'file:.env',
    ]);
    const by = Object.fromEntries(r.entries.map((e) => [e.name, e]));
    assert.equal(by.node_modules.heavy, true);
    assert.equal(by.Library.heavy, true, 'không phân biệt hoa thường (Unity)');
    assert.equal(by.docs.heavy, undefined);
    assert.equal(by['b.txt'].size, Buffer.byteLength('xin chào'));
    assert.equal(by.docs.size, undefined, 'thư mục không có cỡ');
    assert.ok(by['b.txt'].mtime > 0);
    assert.equal(r.more, false);

    const sub = await listFiles(root, 'docs');
    assert.equal(sub.path, 'docs');
    assert.deepEqual(sub.entries.map((e) => e.name), ['reference', 'spec.md']);
    assert.equal((await listFiles(root, 'docs\\reference')).path, 'docs/reference', 'nhận cả \\ và trả về dạng /');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('không ra ngoài thư mục làm việc: .., đường tuyệt đối, đường mạng, gốc không hợp lệ đều bị chặn', async () => {
  const { base, root } = project();
  try {
    await assert.rejects(listFiles(root, '..'), /Chỉ xem được tệp trong thư mục làm việc/);
    await assert.rejects(listFiles(root, 'docs/../../ngoai'), /Chỉ xem được tệp trong thư mục làm việc/);
    await assert.rejects(readFileChunk(root, '../ngoai.txt'), /Chỉ xem được tệp trong thư mục làm việc/);
    await assert.rejects(readFileChunk(root, join(base, 'ngoai.txt')), /Đường dẫn không hợp lệ/, 'đường tuyệt đối');
    await assert.rejects(readFileChunk(root, '/etc/passwd'), /Đường dẫn không hợp lệ/);
    await assert.rejects(readFileChunk(root, '//may-khac/chia-se/a.txt'), /Đường dẫn không hợp lệ/);
    await assert.rejects(readFileChunk(root, '\\\\may-khac\\chia-se\\a.txt'), /Đường dẫn không hợp lệ/);
    await assert.rejects(readFileChunk(root, 'C:x.txt'), /Đường dẫn không hợp lệ/, 'đường theo ổ đĩa');
    await assert.rejects(readFileChunk(root, 'b.txt\0'), /Đường dẫn không hợp lệ/);
    await assert.rejects(listFiles('\\\\may-khac\\chia-se', ''), /không có thư mục làm việc hợp lệ/, 'gốc là đường mạng');
    await assert.rejects(listFiles('tuong-doi', ''), /không có thư mục làm việc hợp lệ/);
    await assert.rejects(listFiles('', ''), /không có thư mục làm việc hợp lệ/);
    await assert.rejects(listFiles(join(base, 'khong-co'), ''), /không còn trên máy/);
    // Tên có hai dấu chấm nhưng vẫn ở trong gốc thì được.
    writeFileSync(join(root, '..ghi-chu.txt'), 'ok');
    assert.equal(Buffer.from((await readFileChunk(root, '..ghi-chu.txt')).data, 'base64').toString(), 'ok');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lối tắt trỏ ra ngoài thư mục làm việc không mở được; lối tắt trỏ vào trong thì được', async (t) => {
  const { base, root } = project();
  try {
    try {
      // Windows: junction tạo được mà không cần quyền quản trị; máy khác: symlink thường.
      symlinkSync(join(base, 'ngoai'), join(root, 'loi-tat-ra-ngoai'), 'junction');
      symlinkSync(join(root, 'docs'), join(root, 'loi-tat-vao-trong'), 'junction');
    } catch (err) {
      t.skip(`máy này không tạo được lối tắt: ${err.code}`);
      return;
    }
    const top = await listFiles(root, '');
    const out = top.entries.find((e) => e.name === 'loi-tat-ra-ngoai');
    assert.equal(out?.kind, 'dir');
    assert.equal(out?.link, true);
    await assert.rejects(listFiles(root, 'loi-tat-ra-ngoai'), /trỏ ra ngoài thư mục làm việc/);
    await assert.rejects(readFileChunk(root, 'loi-tat-ra-ngoai/bi-mat.txt'), /trỏ ra ngoài thư mục làm việc/);
    const inside = await listFiles(root, 'loi-tat-vao-trong');
    assert.deepEqual(inside.entries.map((e) => e.name), ['reference', 'spec.md']);
    assert.equal(Buffer.from((await readFileChunk(root, 'loi-tat-vao-trong/spec.md')).data, 'base64').toString(), 'nội dung spec');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('đọc tệp theo khúc, head chỉ có cỡ và giờ sửa; thư mục và gốc không đọc như tệp; tệp nhạy cảm đọc bình thường', async () => {
  const { base, root } = project();
  try {
    const big = Buffer.alloc(25, 7);
    writeFileSync(join(root, 'lon.bin'), big);
    const first = await readFileChunk(root, 'lon.bin', 0, false, 10);
    assert.equal(first.size, 25);
    assert.equal(first.offset, 0);
    assert.equal(Buffer.from(first.data, 'base64').length, 10);
    const last = await readFileChunk(root, 'lon.bin', 20, false, 10);
    assert.equal(Buffer.from(last.data, 'base64').length, 5);
    const head = await readFileChunk(root, 'lon.bin', 0, true);
    assert.deepEqual(Object.keys(head).sort(), ['mtime', 'size']);
    assert.equal(Buffer.from((await readFileChunk(root, '.env')).data, 'base64').toString(), 'KEY=1\n', 'người dùng chọn mở .env như mọi tệp');
    await assert.rejects(readFileChunk(root, 'docs'), /không phải một tệp|là thư mục/);
    await assert.rejects(readFileChunk(root, ''), /không phải một tệp/);
    await assert.rejects(readFileChunk(root, 'khong-co.txt'), /không còn trên máy/);
    const { rel } = await locate(root, 'docs/./reference/../spec.md');
    assert.equal(rel, 'docs/spec.md');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('thư mục quá đông thì cắt và báo còn nữa', async () => {
  const base = mkdtempSync(join(tmpdir(), 'orbit-files-'));
  try {
    for (let i = 0; i <= FILES_MAX; i += 1) writeFileSync(join(base, `t${i}.txt`), '');
    const r = await listFiles(base, '');
    assert.equal(r.entries.length, FILES_MAX);
    assert.equal(r.more, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
