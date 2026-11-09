// Danh sách "Phiên cũ trên máy" (src/transcripts.mjs, listTranscripts): nhật ký không có câu hỏi nào của
// người dùng (phiên nền của plugin như claude-mem) không được chiếm chỗ của phiên thật trong `limit`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'orbit-transcripts-'));
process.env.ORBIT_REMOTE_PROJECTS = join(ROOT, 'projects');
process.env.ORBIT_REMOTE_CLAUDE_SESSIONS = join(ROOT, 'sessions');
process.env.ORBIT_REMOTE_STATE = join(ROOT, 'state');
mkdirSync(process.env.ORBIT_REMOTE_CLAUDE_SESSIONS, { recursive: true });
const { listTranscripts, listTrash, transcriptAction, transcriptBin, TRASH_DIR } = await import('../src/transcripts.mjs');

const line = (o) => `${JSON.stringify(o)}\n`;
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
let clock = Date.now() - 3600 * 1000;
// Mỗi file viết sau thì "mới hơn" file trước một phút.
function write(dir, n, lines) {
  mkdirSync(join(process.env.ORBIT_REMOTE_PROJECTS, dir), { recursive: true });
  const file = join(process.env.ORBIT_REMOTE_PROJECTS, dir, `${id(n)}.jsonl`);
  writeFileSync(file, lines.map(line).join(''));
  clock += 60 * 1000;
  utimesSync(file, new Date(clock), new Date(clock));
}

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test('phiên cũ: bỏ nhật ký không có câu hỏi trước khi đếm limit, giữ phiên có tiêu đề hay đang mở', () => {
  const long = 'x'.repeat(500);
  write('D--Work', 1, [{ type: 'user', cwd: 'D:\\Work', message: { role: 'user', content: long } }]);
  write('D--Work', 2, [{ type: 'user', cwd: 'D:\\Work', message: { role: 'user', content: 'sửa lỗi đăng nhập' } }]);
  // Chỉ có tiêu đề AI đặt, câu hỏi đầu nằm ngoài phần đọc: vẫn là phiên thật.
  write('D--Work', 3, [{ type: 'ai-title', cwd: 'D:\\Work', aiTitle: 'Dọn thư mục build' }]);
  // Phiên đang mở (có trong sổ phiên) mà chưa hỏi gì: vẫn hiện.
  write('D--Work', 4, [{ type: 'user', cwd: 'D:\\Work', isMeta: true, message: { role: 'user', content: 'meta' } }]);
  writeFileSync(join(process.env.ORBIT_REMOTE_CLAUDE_SESSIONS, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: id(4), cwd: 'D:\\Work' }));
  // Phiên nền mới hơn tất cả: chỉ có nội dung hook chèn vào, không câu nào của người dùng.
  for (let n = 10; n < 20; n++) {
    write('C--Users-me--claude-mem-observer-sessions', n,
      [{ type: 'user', cwd: 'C:\\Users\\me\\.claude-mem\\observer-sessions', message: { role: 'user', content: '<observed>…</observed>' } }]);
  }

  const all = listTranscripts(100);
  assert.deepEqual(all.map((t) => t.claudeSessionId), [id(4), id(3), id(2), id(1)], 'mới trước, không còn phiên nền');
  assert.equal(all[0].title, '(chưa có câu hỏi)');
  assert.equal(all[0].maybeActive, true);
  assert.equal(all[1].title, 'Dọn thư mục build');
  assert.equal(all[2].title, 'sửa lỗi đăng nhập');
  assert.equal(all[3].prompt.length, 200, 'câu hỏi đầu cắt còn 200 ký tự');

  assert.deepEqual(listTranscripts(2).map((t) => t.claudeSessionId), [id(4), id(3)],
    '10 phiên nền mới hơn không chiếm mất 2 chỗ');
});

test('ẩn và bỏ ẩn: nhật ký giữ nguyên chỗ cũ, chỉ thôi hiện trong danh sách; danh sách "đã ẩn" chỉ có phiên đã ẩn', () => {
  const file = join(process.env.ORBIT_REMOTE_PROJECTS, 'D--Work', `${id(2)}.jsonl`);
  assert.deepEqual(transcriptAction(id(2), 'hide'), { ok: true });
  assert.ok(existsSync(file), 'ẩn không đụng tới file');
  assert.ok(!listTranscripts(100).some((t) => t.claudeSessionId === id(2)));
  assert.deepEqual(listTranscripts(100, { hidden: 'only' }).map((t) => t.claudeSessionId), [id(2)]);
  assert.equal(listTranscripts(100, { hidden: 'all' }).length, 4);
  assert.equal(transcriptBin().hiddenCount, 1);

  transcriptAction(id(2), 'unhide');
  assert.ok(listTranscripts(100).some((t) => t.claudeSessionId === id(2)));
  assert.equal(transcriptBin().hiddenCount, 0);
  assert.throws(() => transcriptAction(id(99), 'hide'), /Không thấy nhật ký/);
  assert.throws(() => transcriptAction('../../x', 'hide'), /Mã phiên không hợp lệ/);
  assert.throws(() => transcriptAction(id(2), 'nuke'), /Không có thao tác/);
});

test('thùng rác: dời nhật ký và thư mục đi kèm sang thư mục trạng thái, khôi phục về đúng chỗ cũ; phiên đang mở thì từ chối', () => {
  const dir = join(process.env.ORBIT_REMOTE_PROJECTS, 'D--Work');
  const file = join(dir, `${id(1)}.jsonl`);
  // Claude Code để nhật ký phiên con và kết quả công cụ lớn trong thư mục cùng tên với phiên.
  mkdirSync(join(dir, id(1), 'subagents'), { recursive: true });
  writeFileSync(join(dir, id(1), 'subagents', 'agent-1.jsonl'), '{}\n');
  const before = readFileSync(file, 'utf8');
  transcriptAction(id(1), 'hide'); // vào thùng rác thì thôi tính là "đã ẩn"

  assert.deepEqual(transcriptAction(id(1), 'trash'), { ok: true });
  assert.ok(!existsSync(file) && !existsSync(join(dir, id(1))), 'nhật ký và thư mục kèm rời khỏi thư mục của Claude Code');
  assert.equal(readFileSync(join(TRASH_DIR, 'D--Work', `${id(1)}.jsonl`), 'utf8'), before, 'nội dung nguyên vẹn');
  assert.ok(existsSync(join(TRASH_DIR, 'D--Work', id(1), 'subagents', 'agent-1.jsonl')));
  assert.ok(!listTranscripts(100, { hidden: 'all' }).some((t) => t.claudeSessionId === id(1)));
  const trash = listTrash();
  assert.deepEqual(trash.map((t) => t.claudeSessionId), [id(1)]);
  assert.equal(trash[0].cwd, 'D:\\Work');
  assert.match(trash[0].trashedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual({ ...transcriptBin(), trashDir: undefined }, { hiddenCount: 0, trashCount: 1, trashDir: undefined });
  assert.throws(() => transcriptAction(id(1), 'trash'), /Không thấy nhật ký/, 'đã ở thùng rác thì không chuyển lần nữa');

  assert.deepEqual(transcriptAction(id(1), 'restore'), { ok: true });
  assert.equal(readFileSync(file, 'utf8'), before, 'về đúng chỗ cũ, nội dung nguyên vẹn');
  assert.ok(existsSync(join(dir, id(1), 'subagents', 'agent-1.jsonl')), 'thư mục kèm cũng về');
  assert.equal(listTrash().length, 0);
  assert.ok(listTranscripts(100).some((t) => t.claudeSessionId === id(1)), 'hiện lại trong danh sách, không còn bị ẩn');
  assert.throws(() => transcriptAction(id(1), 'restore'), /không còn trong thùng rác/);

  // id(4) đang mở theo sổ phiên của Claude Code (ghi ở phép kiểm đầu).
  assert.throws(() => transcriptAction(id(4), 'trash'), /đang mở ở VS Code hay terminal/);
  assert.ok(existsSync(join(dir, `${id(4)}.jsonl`)));
});
