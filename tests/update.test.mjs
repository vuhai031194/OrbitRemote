// "Setup máy" an toàn (src/setup.mjs safeUpdate, keepUserActions; src/main.mjs update, selftest): code mới không nạp
// được thì quay về bản trước; nút tuỳ biến người dùng sửa không chặn git pull; app ghi nút tuỳ biến ra tệp riêng.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'orbit-update-'));
process.env.ORBIT_REMOTE_STATE = join(ROOT, 'state');
process.env.ORBIT_REMOTE_CUSTOM = join(ROOT, 'custom');
mkdirSync(process.env.ORBIT_REMOTE_CUSTOM, { recursive: true });
writeFileSync(join(process.env.ORBIT_REMOTE_CUSTOM, 'actions.json'), JSON.stringify({ actions: [{ label: 'Mặc định' }] }));
const { keepUserActions, safeUpdate } = await import('../src/setup.mjs');
test.after(() => rmSync(ROOT, { recursive: true, force: true }));
const MAIN = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'main.mjs');

function fakeRepo({ before = 'aaaaaaa1', after = 'bbbbbbb2', failed = false, selftestOk = true, resetOk = true } = {}) {
  let head = before;
  const calls = [];
  return {
    calls,
    deps: {
      head: () => head,
      pull: async () => { calls.push('pull'); if (!failed) head = after; return { failed, pulled: failed ? 'không kéo được: mạng' : 'đã kéo bản mới' }; },
      selftest: () => { calls.push('selftest'); return { ok: selftestOk, why: 'SyntaxError: Unexpected token' }; },
      reset: (repo, rev) => { calls.push(`reset ${rev}`); if (resetOk) head = rev; return { ok: resetOk, why: 'local changes' }; },
    },
    head: () => head,
  };
}

test('Setup máy: không có bản mới thì không kiểm; bản mới nạp được thì giữ; bản mới hỏng thì quay về đúng bản trước và báo rõ', async () => {
  const same = fakeRepo({ after: 'aaaaaaa1' });
  assert.deepEqual(await safeUpdate('repo', same.deps), { failed: false, pulled: 'đã kéo bản mới', rolledBack: '' });
  assert.deepEqual(same.calls, ['pull']);

  const good = fakeRepo();
  assert.equal((await safeUpdate('repo', good.deps)).failed, false);
  assert.deepEqual(good.calls, ['pull', 'selftest']);
  assert.equal(good.head(), 'bbbbbbb2');

  const bad = fakeRepo({ selftestOk: false });
  const r = await safeUpdate('repo', bad.deps);
  assert.deepEqual(bad.calls, ['pull', 'selftest', 'reset aaaaaaa1']);
  assert.equal(bad.head(), 'aaaaaaa1', 'máy chạy lại bản cũ');
  assert.equal(r.failed, true, 'app thấy "còn thiếu", không phải "đủ cả"');
  assert.match(r.pulled, /^không kéo được: code mới \(bbbbbbb\) không chạy được: SyntaxError.*Đã quay về bản trước \(aaaaaaa\)/);

  const stuck = fakeRepo({ selftestOk: false, resetOk: false });
  assert.match((await safeUpdate('repo', stuck.deps)).pulled, /Không quay về bản trước được: local changes/);

  const offline = fakeRepo({ failed: true });
  assert.equal((await safeUpdate('repo', offline.deps)).failed, true);
  assert.deepEqual(offline.calls, ['pull'], 'kéo hỏng: máy vẫn ở bản cũ, khỏi kiểm');
});

test('nút tuỳ biến bị sửa thẳng trong kho (bản app cũ) được chuyển sang actions.local.json, tệp của kho trả về như cũ để git pull không bị chặn', { skip: spawnSync('git', ['--version']).status !== 0 }, () => {
  const repo = join(ROOT, 'repo');
  mkdirSync(join(repo, 'custom'), { recursive: true });
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'core.autocrlf', 'false'); // so nội dung từng byte, khỏi để git đổi xuống dòng
  writeFileSync(join(repo, 'custom', 'actions.json'), '{"actions":[]}\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  assert.equal(keepUserActions(repo), false, 'chưa sửa gì thì thôi');

  writeFileSync(join(repo, 'custom', 'actions.json'), '{"actions":[{"label":"Của tôi"}]}\n');
  assert.equal(keepUserActions(repo), true);
  assert.equal(readFileSync(join(repo, 'custom', 'actions.local.json'), 'utf8'), '{"actions":[{"label":"Của tôi"}]}\n', 'giữ phần người dùng sửa');
  assert.equal(readFileSync(join(repo, 'custom', 'actions.json'), 'utf8'), '{"actions":[]}\n', 'tệp của kho như cũ');
  assert.equal(git('status', '--porcelain', '--', 'custom/actions.json').stdout.trim(), '');
});

test('selftest: main.mjs nạp được trọn mọi phần thì thoát 0 (Setup máy dùng để kiểm bản vừa kéo)', () => {
  const r = spawnSync(process.execPath, [MAIN, 'selftest'], { encoding: 'utf8', env: { ...process.env, ORBIT_REMOTE_STATE: join(ROOT, 'st2') } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nạp đủ mọi phần/);
});

test('app lưu nút tuỳ biến vào actions.local.json (ngoài git), đọc lại thì được bản người dùng; tệp của kho không đổi', async () => {
  const { Hub } = await import('../src/hub.mjs');
  const { Auth } = await import('../src/auth.mjs');
  const { createServer } = await import('../src/server.mjs');
  const auth = new Auth(join(ROOT, 'auth.json'));
  const server = createServer({ hub: new Hub({ stateDir: join(ROOT, 'hubstate') }), auth, localSecret: 's', version: 't', hubInfo: () => ({ id: 'h', name: 'H', urls: [] }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { token } = auth.issue('Thử', 'device');
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Cookie: `orbit_remote_token=${encodeURIComponent(token)}`, 'Content-Type': 'application/json' };
    const before = await (await fetch(`${base}/custom/actions.json`, { headers })).json();
    assert.deepEqual(before, { actions: [{ label: 'Mặc định' }] });
    const put = await fetch(`${base}/api/custom/actions`, { method: 'PUT', headers, body: JSON.stringify({ actions: [{ label: 'Của tôi' }] }) });
    assert.equal(put.status, 200);
    assert.ok(existsSync(join(process.env.ORBIT_REMOTE_CUSTOM, 'actions.local.json')));
    assert.deepEqual(JSON.parse(readFileSync(join(process.env.ORBIT_REMOTE_CUSTOM, 'actions.json'), 'utf8')), { actions: [{ label: 'Mặc định' }] }, 'tệp của kho không đổi');
    assert.deepEqual(await (await fetch(`${base}/custom/actions.json`, { headers })).json(), { actions: [{ label: 'Của tôi' }] });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('đầu-cuối với git thật: kéo về một bản main.mjs hỏng thì selftest bắt được và máy quay về đúng bản trước', { skip: spawnSync('git', ['--version']).status !== 0 }, async () => {
  const { pullRepo } = await import('../src/setup.mjs');
  const base = join(ROOT, 'e2e');
  mkdirSync(base, { recursive: true });
  const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
  const setUser = (dir) => {
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
  };
  const remote = join(base, 'remote.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const dev = join(base, 'dev');
  // core.autocrlf=false ngay lúc clone: đặt sau thì tệp đã ra đĩa theo CRLF (cấu hình chung của máy) trông như bị sửa,
  // và git pull báo "Aborting".
  spawnSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', remote, dev]);
  setUser(dev);
  git(dev, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(dev, 'main.mjs'), "if (process.argv[2] === 'selftest') console.log('ok');\n");
  git(dev, 'add', '.');
  git(dev, 'commit', '-qm', 'tốt');
  git(dev, 'push', '-q', 'origin', 'main');
  const machine = join(base, 'machine');
  spawnSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', '-b', 'main', remote, machine]);
  setUser(machine);
  const good = git(machine, 'rev-parse', 'HEAD').stdout.trim();

  writeFileSync(join(dev, 'main.mjs'), 'export const = ; // hỏng\n');
  git(dev, 'commit', '-qam', 'hỏng');
  git(dev, 'push', '-q', 'origin', 'main');

  const r = await safeUpdate(machine, {
    pull: (repo) => pullRepo(repo),
    selftest: () => {
      const t = spawnSync(process.execPath, [join(machine, 'main.mjs'), 'selftest'], { encoding: 'utf8' });
      return { ok: t.status === 0, why: String(t.stderr).trim().split('\n').find((l) => /Error/.test(l)) || 'lỗi' };
    },
    reset: (repo, rev) => {
      const g = git(repo, 'reset', '--keep', rev);
      return { ok: g.status === 0, why: g.stderr };
    },
  });
  assert.equal(r.failed, true, JSON.stringify(r));
  assert.match(r.rolledBack, /SyntaxError/, JSON.stringify(r));
  assert.equal(git(machine, 'rev-parse', 'HEAD').stdout.trim(), good, 'HEAD về đúng bản trước');
  assert.equal(readFileSync(join(machine, 'main.mjs'), 'utf8'), "if (process.argv[2] === 'selftest') console.log('ok');\n", 'tệp về đúng bản chạy được');
});
