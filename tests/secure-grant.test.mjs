// Quyền bấm màn bảo mật (màn khoá, UAC): trạm ký bằng ECDSA P-256 (src/hub-identity.mjs loadGrantKey), chương trình
// SYSTEM của máy (src/win-secure.cs) kiểm bằng CNG của Windows. Phép kiểm dịch đúng tệp C# đó rồi chạy lệnh check-grant
// của nó với quyền do Node ký: hai bên phải khớp nhau từng byte (dạng khoá, dạng chữ ký, nội dung).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRANT_MAX_SECONDS, isGrantKey, loadGrantKey } from '../src/hub-identity.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'orbit-grant-'));
test.after(() => rmSync(ROOT, { recursive: true, force: true }));
const SOURCE = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'win-secure.cs');
const CSC = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

test('khoá cấp quyền: tạo một lần, nạp lại đúng khoá; quyền gắn với mã máy, hạn bị giới hạn', () => {
  const file = join(ROOT, 'grant.json');
  const k = loadGrantKey(file);
  assert.ok(isGrantKey(k.publicKey));
  assert.equal(loadGrantKey(file).publicKey, k.publicKey);
  const now = Date.UTC(2026, 10, 9, 12, 0, 0);
  const g = k.grant('0a430871dc', 3600, now);
  assert.equal(g.until, now / 1000 + GRANT_MAX_SECONDS, 'xin một giờ cũng chỉ được 15 phút');
  assert.match(Buffer.from(g.payload, 'base64').toString(), /^orbit-secure-grant\|0a430871dc\|\d+\|[0-9a-f]{16}$/);
  assert.throws(() => k.grant('a|b'), /Mã máy không hợp lệ/);
  assert.ok(!isGrantKey('rác'));
});

test('Windows: chương trình SYSTEM (win-secure.cs, dịch thật) nhận đúng quyền trạm ký; từ chối quyền bị sửa, sai máy, hết hạn, quá dài, khoá khác', { skip: process.platform !== 'win32' || !existsSync(CSC) }, () => {
  const exe = join(ROOT, 'orbit-secure-test.exe');
  const built = spawnSync(CSC, ['-nologo', '-optimize+', '-platform:x64', '-target:exe', '-r:System.Drawing.dll', `-out:${exe}`, SOURCE], { windowsHide: true, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stdout || built.stderr);
  const key = loadGrantKey(join(ROOT, 'hub-grant.json'));
  const pubFile = join(ROOT, 'grant.pub');
  writeFileSync(pubFile, key.publicKey);
  const check = (machine, g) => spawnSync(exe, ['check-grant', pubFile, machine, g.payload, g.sig], { windowsHide: true, encoding: 'utf8' }).stdout.trim();

  const g = key.grant('0a430871dc');
  assert.equal(check('0a430871dc', g), `ok ${g.until}`, 'quyền đúng');
  assert.equal(check('ffffffffff', g), 'bad', 'quyền của máy khác');

  const forged = Buffer.from(Buffer.from(g.payload, 'base64').toString().replace(/\|(\d+)\|/, (_, t) => `|${Number(t) + 600}|`)).toString('base64');
  assert.equal(check('0a430871dc', { payload: forged, sig: g.sig }), 'bad', 'sửa hạn thì chữ ký không khớp');

  assert.equal(check('0a430871dc', key.grant('0a430871dc', 300, Date.now() - 3600 * 1000)), 'bad', 'quyền đã hết hạn');

  // Ký thẳng bằng khoá của trạm một quyền một giờ (hàm grant tự giới hạn 15 phút): chương trình SYSTEM vẫn từ chối.
  const priv = createPrivateKey(JSON.parse(readFileSync(join(ROOT, 'hub-grant.json'), 'utf8')).privateKey);
  const long = Buffer.from(`orbit-secure-grant|0a430871dc|${Math.floor(Date.now() / 1000) + 3600}|00`);
  assert.equal(check('0a430871dc', { payload: long.toString('base64'), sig: sign('sha256', long, { key: priv, dsaEncoding: 'ieee-p1363' }).toString('base64') }), 'bad', 'hạn quá 15 phút');

  const other = loadGrantKey(join(ROOT, 'khac.json'));
  assert.equal(check('0a430871dc', other.grant('0a430871dc')), 'bad', 'quyền ký bằng khoá khác');
  assert.equal(check('0a430871dc', { payload: g.payload, sig: Buffer.alloc(64).toString('base64') }), 'bad', 'chữ ký rác');
  assert.equal(check('0a430871dc', { payload: g.payload, sig: 'không phải base64' }), 'bad');
});

test('đầu máy đưa quyền cho chương trình SYSTEM đúng giao thức; bản cũ (không trả lời "grant") và quyền bị từ chối đều báo rõ', async () => {
  const net = await import('node:net');
  const seen = [];
  let answer = (line) => `ok 1794238705`;
  const server = net.createServer((s) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      if (lines.length < 3) return;
      seen.push(lines.slice(0, 2));
      const out = answer(lines[1]);
      if (out === null) s.destroy();
      else s.end(`${out}\n`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const keyFile = join(ROOT, 'secure.key');
  writeFileSync(keyFile, 'k'.repeat(64));
  process.env.ORBIT_REMOTE_SECURE_PORT = String(server.address().port);
  process.env.ORBIT_REMOTE_SECURE_KEY = keyFile;
  try {
    const { sendSecureGrant } = await import(`../src/secure-desk.mjs?t=${Date.now()}`);
    assert.deepEqual(await sendSecureGrant('cGF5', 'c2ln'), { until: 1794238705 });
    assert.deepEqual(seen[0], [`auth ${'k'.repeat(64)}`, 'grant cGF5 c2ln']);
    answer = () => 'bad';
    await assert.rejects(sendSecureGrant('cGF5', 'c2ln'), /từ chối quyền/);
    answer = () => null; // bản cũ: không hiểu "grant", đóng kết nối
    await assert.rejects(sendSecureGrant('cGF5', 'c2ln'), /bản cũ/);
    await assert.rejects(sendSecureGrant('a b', 'c2ln'), /không hợp lệ/, 'không cho chèn thêm từ vào dòng lệnh');
  } finally {
    delete process.env.ORBIT_REMOTE_SECURE_PORT;
    delete process.env.ORBIT_REMOTE_SECURE_KEY;
    await new Promise((r) => server.close(r));
  }
});

test('kịch bản cài: kiểm mã băm trên tệp đã chép vào thư mục quản trị, ghi khoá cấp quyền và mã máy; từ chối đầu vào lạ', async () => {
  const { installScript } = await import('../src/secure-desk.mjs');
  const grantKey = loadGrantKey(join(ROOT, 'script-grant.json')).publicKey;
  const ok = { exePath: 'C:\\x\\orbit-secure.exe', userSid: 'S-1-5-21-1-2-3-1001', exeHash: 'ab'.repeat(32), grantKey, machineId: '0a430871dc' };
  const script = installScript(ok);
  const copy = script.indexOf('Copy-Item');
  const verify = script.indexOf('Get-FileHash -Algorithm SHA256 -LiteralPath $dst');
  assert.ok(copy > 0 && verify > copy, 'kiểm mã băm trên tệp ĐÃ chép (thư mục người dùng không ghi được), không phải tệp nguồn');
  assert.ok(script.includes(`'${'AB'.repeat(32)}'`));
  assert.ok(script.includes(`'grant.pub'), '${grantKey}'`));
  assert.ok(script.includes(`'machine.id'), '0a430871dc'`));
  assert.ok(script.indexOf('grant.pub') < script.indexOf('Start-ScheduledTask'), 'khoá có trước khi chương trình chạy');
  assert.throws(() => installScript({ ...ok, exeHash: '' }), /mã băm/);
  assert.throws(() => installScript({ ...ok, grantKey: "x'; calc; '" }), /khoá cấp quyền/);
  assert.throws(() => installScript({ ...ok, machineId: "a'; calc" }), /Mã máy/);
});
