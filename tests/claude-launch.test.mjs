// Chạy Claude Code mà không để vỏ lệnh cắt tham số (src/claude-session.mjs claudeSpawn): npm cài Claude Code trên
// Windows thành claude.cmd; chạy nó bằng `shell: true` thì "--name Phiên mới" thành hai tham số, lời dặn hệ thống
// chỉ còn chữ đầu, và "&" trong tên phiên thành lệnh của cmd.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSession, claudeSpawn, unwrapCmdShim } from '../src/claude-session.mjs';

const NEW_SHIM = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n'
  + '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
const OLD_SHIM = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\n'
  + 'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n'
  + 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';

test('đọc vỏ claude.cmd của npm ra chương trình thật: bản mới gọi claude.exe, bản cũ gọi node cli.js (không nhầm node.exe ở dòng IF EXIST)', () => {
  const dir = 'C:\\npm';
  const exists = () => true;
  assert.deepEqual(unwrapCmdShim(`${dir}\\claude.cmd`, { read: () => NEW_SHIM, exists }),
    [join(dir, 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe')]);
  assert.deepEqual(unwrapCmdShim(`${dir}\\claude.cmd`, { read: () => OLD_SHIM, exists, node: 'NODE' }),
    ['NODE', join(dir, 'node_modules\\@anthropic-ai\\claude-code\\cli.js')]);
  assert.equal(unwrapCmdShim(`${dir}\\claude.cmd`, { read: () => NEW_SHIM, exists: () => false }), null, 'chương trình không còn thì thôi');
  assert.equal(unwrapCmdShim(`${dir}\\claude.cmd`, { read: () => '@echo off\r\nset X=%~dp0a.js\r\nnode "%X%" %*\r\n', exists }), null);
  assert.equal(unwrapCmdShim(`${dir}\\claude.cmd`, { read: () => { throw new Error('ENOENT'); } }), null);
});

test('claudeSpawn: chương trình thường thì chạy thẳng; .cmd đọc được thì chạy thẳng chương trình thật; không bao giờ dùng shell: true', () => {
  assert.deepEqual(claudeSpawn(['node', 'fake.mjs'], ['--name', 'a b']), ['node', ['fake.mjs', '--name', 'a b'], {}]);
  assert.deepEqual(claudeSpawn('C:\\x\\claude.exe', ['-p'], { platform: 'win32' }), ['C:\\x\\claude.exe', ['-p'], {}]);
  assert.deepEqual(claudeSpawn('/usr/bin/claude.cmd', ['-p'], { platform: 'linux' }), ['/usr/bin/claude.cmd', ['-p'], {}]);
  const [file, argv, extra] = claudeSpawn('C:\\npm\\claude.cmd', ['--name', 'Phiên mới'], { platform: 'win32', read: () => NEW_SHIM, exists: () => true });
  assert.equal(file, join('C:\\npm', 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'));
  assert.deepEqual(argv, ['--name', 'Phiên mới']);
  assert.deepEqual(extra, {});
  const fallback = claudeSpawn('C:\\npm\\claude.cmd', ['a & b'], { platform: 'win32', read: () => '', exists: () => true });
  assert.equal(fallback[2].windowsVerbatimArguments, true, 'không đọc được vỏ: tự bọc tham số, không để Node nối trần');
  assert.ok(!('shell' in fallback[2]));
});

test('mã phiên Claude và effort đi vào dòng lệnh chỉ nhận đúng dạng', () => {
  assert.throws(() => new ClaudeSession({ cwd: '.', claudeSessionId: 'x & calc' }), /Mã phiên Claude không hợp lệ/);
  assert.equal(new ClaudeSession({ cwd: '.', effort: 'high & calc' }).effort, '');
  assert.equal(new ClaudeSession({ cwd: '.', effort: 'xhigh' }).effort, 'xhigh');
});

// Tham số khó: dấu cách, ký tự đặc biệt của cmd, phần trăm, ngoặc kép, gạch chéo ngược ở cuối, nhiều dòng.
const NASTY = ['--name', 'Phiên mới & echo PWNED>pwned.txt', 'a|b', '100% (x)', 'say "hi"', 'C:\\dir\\', 'dòng 1\ndòng 2', '^!x!'];

test('Windows thật: chạy qua vỏ .cmd (đọc được vỏ, và cả khi phải tự bọc tham số) thì chương trình nhận đúng từng tham số, không lệnh nào bị chèn', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-launch-'));
  try {
    const pkg = join(root, 'node_modules', '@anthropic-ai', 'claude-code');
    mkdirSync(pkg, { recursive: true });
    const out = join(root, 'argv.json');
    writeFileSync(join(pkg, 'cli.js'), `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`);
    const run = (shim) => {
      const cmd = join(root, 'claude.cmd');
      writeFileSync(cmd, shim);
      rmSync(out, { force: true });
      const [file, argv, extra] = claudeSpawn(cmd, NASTY);
      const r = spawnSync(file, argv, { cwd: root, windowsHide: true, encoding: 'utf8', ...extra });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(readFileSync(out, 'utf8'));
    };
    // Vỏ npm bản cũ (node cli.js): đọc ra chương trình thật, chạy thẳng: nhận nguyên văn kể cả xuống dòng.
    assert.deepEqual(run(OLD_SHIM), NASTY);
    // Vỏ lạ không đọc được: chạy qua cmd.exe với tham số tự bọc; xuống dòng thành dấu cách (cmd không chuyển được).
    const odd = '@echo off\r\nset "T=%~dp0node_modules\\@anthropic-ai\\claude-code\\cli.js"\r\nnode "%T%" %*\r\n';
    assert.deepEqual(run(odd), NASTY.map((a) => a.replace(/\n/g, ' ')));
    assert.ok(!existsSync(join(root, 'pwned.txt')), 'không lệnh nào bị chèn chạy');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
