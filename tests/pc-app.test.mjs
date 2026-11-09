// Kiểm bản PC: cổng mở app trên máy không giữ trạm (src/app-proxy.mjs) chạy thật trước một trạm thật
// (máy chủ HTTP của Orbit Remote, thư mục trạng thái tạm), và các phần không cần Windows của pc-app.mjs
// (tham số cửa sổ app, tệp .ico, tệp mở app). Không mở cửa sổ trình duyệt, không tạo lối tắt thật.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ORBIT_REMOTE_STATE = mkdtempSync(join(tmpdir(), 'orbit-pc-app-test-'));
const { createServer } = await import('../src/server.mjs');
const { Hub } = await import('../src/hub.mjs');
const { Auth } = await import('../src/auth.mjs');
const { startAppProxy } = await import('../src/app-proxy.mjs');
const { appWindowArgs, findAppBrowser, hasSavedPlacement, icoFromPng, launcherScript } = await import('../src/pc-app.mjs');
const { mkdirSync, writeFileSync } = await import('node:fs');

let server;
let hubPort;
let proxy;
let proxyPort;
let target = '';
before(async () => {
  const hub = new Hub({ stateDir: process.env.ORBIT_REMOTE_STATE });
  const auth = new Auth(join(process.env.ORBIT_REMOTE_STATE, 'auth.json'));
  server = createServer({ hub, auth, localSecret: 'test-secret', version: 'test', hubInfo: () => ({ id: 'hubPC', name: 'TramPC', urls: [] }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  hubPort = server.address().port;
  proxy = startAppProxy({ target: () => target, port: 0 });
  await new Promise((r) => (proxy.listening ? r() : proxy.once('listening', r)));
  proxyPort = proxy.address().port;
});
after(() => {
  proxy?.close();
  server?.close();
});

const viaProxy = (path, init) => fetch(`http://127.0.0.1:${proxyPort}${path}`, init);

test('cổng app: chưa nối trạm thì báo rõ; nối rồi thì app, ghép đôi, API và luồng sự kiện đi qua được như mở thẳng trạm', async () => {
  target = '';
  const down = await viaProxy('/api/ping');
  assert.equal(down.status, 503);
  assert.match(await down.text(), /chưa nối được tới trạm/);

  target = `http://127.0.0.1:${hubPort}`;
  const page = await viaProxy('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Orbit Remote/);
  assert.match(page.headers.get('content-security-policy') || '', /connect-src/, 'chính sách bảo mật của trạm đi kèm trang');
  assert.equal((await (await viaProxy('/api/ping')).json()).service, 'orbit-remote');

  const locked = await viaProxy('/api/state');
  assert.equal(locked.status, 401, 'chưa ghép thì trạm vẫn chặn: cổng không mang thẻ nào của riêng nó');

  // Ghép đôi qua cổng bằng một mã thật của trạm: cookie trạm trả về đi tới trình duyệt.
  const codeRes = await fetch(`http://127.0.0.1:${hubPort}/api/local/pair-code`, { method: 'POST', headers: { 'X-Orbit-Local': 'test-secret', 'Content-Type': 'application/json' }, body: '{}' });
  const { code } = await codeRes.json();
  const paired = await viaProxy('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'Máy tính Windows' }) });
  assert.equal(paired.status, 200);
  const cookie = (paired.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie.includes('='), 'trạm đặt cookie ghép đôi qua cổng');
  const state = await viaProxy('/api/state', { headers: { cookie } });
  assert.equal(state.status, 200);
  assert.ok(Array.isArray((await state.json()).machines));

  // Luồng sự kiện: mẩu đầu tới ngay, không bị gom chờ hết.
  const ctrl = new AbortController();
  const stream = await viaProxy('/api/stream', { headers: { cookie, Accept: 'text/event-stream' }, signal: ctrl.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const first = await Promise.race([reader.read(), new Promise((_, rej) => setTimeout(() => rej(new Error('luồng sự kiện không tới')), 3000))]);
  assert.ok(first.value?.length > 0, 'luồng sự kiện tới qua cổng');
  ctrl.abort();
});

test('cổng app: không cho trang giả tiêu đề của trạm hay đổi máy đích; trạm tắt thì báo không với tới', async () => {
  target = `http://127.0.0.1:${hubPort}`;
  // Tiêu đề bí mật nội bộ bị bỏ ở cổng: lệnh nội bộ của trạm không gọi được qua cổng.
  const local = await viaProxy('/api/local/pair-code', { method: 'POST', headers: { 'X-Orbit-Local': 'test-secret', 'Content-Type': 'application/json' }, body: '{}' });
  assert.notEqual(local.status, 200, 'X-Orbit-Local không đi qua cổng');
  // "//máy-khác/..." vẫn tới trạm (đường dẫn lạ, trạm trả lời), không bị đổi sang máy khác.
  const odd = await viaProxy('//example.com/api/ping');
  assert.notEqual(odd.status, 502, 'đường dẫn lạ không làm cổng gọi ra máy khác');

  target = 'http://127.0.0.1:1'; // không ai nghe
  const dead = await viaProxy('/api/ping');
  assert.equal(dead.status, 502);
  assert.match(await dead.text(), /Không với tới trạm/);
});

test('cổng app: cổng còn bị tiến trình đầu máy cũ giữ (khởi động lại sau setup) thì tự nghe lại khi cổng trống, không bỏ trống mãi; đã đóng thì thôi thử', async () => {
  const net = await import('node:net');
  const until = async (ok, ms) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (ok()) return true; return ok(); };
  // Tiến trình cũ còn giữ cổng.
  const old = net.createServer();
  await new Promise((r) => old.listen(0, '127.0.0.1', r));
  const busy = old.address().port;
  const logs = [];
  target = `http://127.0.0.1:${hubPort}`;
  const fresh = startAppProxy({ target: () => target, port: busy, log: (l) => logs.push(l) });
  try {
    await until(() => logs.length > 0, 2000);
    assert.equal(fresh.listening, false);
    assert.match(logs[0], /không mở được: .*EADDRINUSE.*Đang thử lại/);

    await new Promise((r) => old.close(r)); // tiến trình cũ thoát hẳn
    assert.ok(await until(() => fresh.listening, 4000), 'cổng trống thì cổng app mới tự nghe được');
    assert.equal((await (await fetch(`http://127.0.0.1:${busy}/api/ping`)).json()).service, 'orbit-remote');
    assert.match(logs.at(-1), /đã mở sau \d+ lần thử lại/);
  } finally {
    fresh.close();
    if (old.listening) old.close();
  }

  // Đóng cổng app (đầu máy tắt) giữa lúc đang chờ thử lại: không được tự nghe lại sau đó.
  const holder = net.createServer();
  await new Promise((r) => holder.listen(0, '127.0.0.1', r));
  const port2 = holder.address().port;
  const stopped = startAppProxy({ target: () => target, port: port2, log: () => {} });
  await new Promise((r) => setTimeout(r, 300));
  stopped.close();
  await new Promise((r) => holder.close(r));
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(stopped.listening, false, 'đã đóng thì không nghe lại');
});

test('cửa sổ app: đúng tham số chế độ app và hồ sơ riêng, cỡ cửa sổ chỉ đặt lần đầu; tìm Edge trước Chrome', () => {
  const first = appWindowArgs('http://127.0.0.1:8797/', { profileDir: 'C:\\s\\app-profile', firstRun: true });
  assert.deepEqual(first, ['--app=http://127.0.0.1:8797/', '--user-data-dir=C:\\s\\app-profile', '--no-first-run', '--no-default-browser-check', '--window-size=1440,900']);
  assert.ok(!appWindowArgs('http://x/', { profileDir: 'p' }).some((a) => a.startsWith('--window-size')), 'lần sau trình duyệt tự nhớ cỡ');
  const env = { 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\L' };
  const have = (list) => (p) => list.includes(p);
  assert.equal(findAppBrowser(env, have(['C:\\PF\\Google\\Chrome\\Application\\chrome.exe', 'C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe'])), 'C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.equal(findAppBrowser(env, have(['C:\\L\\Google\\Chrome\\Application\\chrome.exe'])), 'C:\\L\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(findAppBrowser(env, have([])), null);

  // Cỡ cửa sổ lần đầu: đặt khi trình duyệt chưa ghi chỗ cửa sổ app (kể cả hồ sơ đã có mà lần trước bị tắt ngang).
  const profile = mkdtempSync(join(tmpdir(), 'orbit-app-profile-'));
  assert.equal(hasSavedPlacement(profile), false, 'hồ sơ trống');
  mkdirSync(join(profile, 'Default'));
  writeFileSync(join(profile, 'Default', 'Preferences'), '{"browser":{}}');
  assert.equal(hasSavedPlacement(profile), false, 'hồ sơ có mà chưa ghi chỗ cửa sổ (Edge bị tắt ngang)');
  writeFileSync(join(profile, 'Default', 'Preferences'), '{"browser":{"app_window_placement":{"_crx_x":{"bottom":900}}}}');
  assert.equal(hasSavedPlacement(profile), true);
});

test('biểu tượng và tệp mở app: .ico đúng cấu trúc chứa nguyên ảnh PNG của app; tệp VBScript chỉ ASCII, chạy ẩn đúng lệnh "app"', () => {
  const png = readFileSync(new URL('../web/icons/icon-192.png', import.meta.url));
  const ico = icoFromPng(png);
  assert.equal(ico.readUInt16LE(2), 1, 'loại biểu tượng');
  assert.equal(ico.readUInt16LE(4), 1, 'một ảnh');
  assert.equal(ico[6], 192);
  assert.equal(ico[7], 192);
  assert.equal(ico.readUInt32LE(14), png.length);
  assert.equal(ico.readUInt32LE(18), 22);
  assert.ok(ico.subarray(22).equals(png));
  assert.throws(() => icoFromPng(Buffer.from('không phải ảnh')), /PNG/);

  const vbs = launcherScript('C:\\Program Files\\nodejs\\node.exe', 'C:\\Orbit\\Tools\\Orbit Remote\\src\\main.mjs');
  assert.match(vbs, /^[\x20-\x7e\r\n]*$/);
  assert.ok(vbs.includes('Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\Orbit\\Tools\\Orbit Remote\\src\\main.mjs"" app", 0, False'));
});

// Gửi một yêu cầu với Host tự chọn (fetch không cho đặt Host).
function rawGet(port, path, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('chống DNS rebinding: trạm chỉ nhận Host là IP, localhost hay tên của chính trạm; cổng app chỉ nhận loopback và không mở đường xin nối', async () => {
  target = `http://127.0.0.1:${hubPort}`;
  assert.equal(await rawGet(hubPort, '/api/ping', `127.0.0.1:${hubPort}`), 200);
  assert.equal(await rawGet(hubPort, '/api/ping', `localhost:${hubPort}`), 200);
  assert.equal(await rawGet(hubPort, '/api/ping', `192.168.1.20:${hubPort}`), 200, 'IP trần (mạng nhà, Tailscale) thì được');
  assert.equal(await rawGet(hubPort, '/api/ping', `[::1]:${hubPort}`), 200);
  assert.equal(await rawGet(hubPort, '/api/ping', `${hostname()}:${hubPort}`), 200, 'tên máy của trạm');
  assert.equal(await rawGet(hubPort, '/api/ping', `evil.example:${hubPort}`), 421, 'tên miền lạ trỏ về trạm');
  assert.equal(await rawGet(hubPort, '/', 'attacker.test'), 421);

  assert.equal(await rawGet(proxyPort, '/api/ping', `127.0.0.1:${proxyPort}`), 200);
  assert.equal(await rawGet(proxyPort, '/api/ping', `localhost:${proxyPort}`), 200);
  assert.equal(await rawGet(proxyPort, '/api/ping', `evil.example:${proxyPort}`), 421);
  assert.equal(await rawGet(proxyPort, '/api/ping', `192.168.1.20:${proxyPort}`), 421, 'cổng app chỉ nghe loopback: Host khác loopback là lạ');
  for (const p of ['/api/enroll', '/api/enroll/0123456789abcdef', '/node/link']) {
    assert.equal(await rawGet(proxyPort, p, `127.0.0.1:${proxyPort}`), 403, p);
  }
});

test('hostAllowed: tên có trong danh sách của trạm thì được, kể cả có dấu chấm cuối; chỉ-loopback thì từ chối IP khác', async () => {
  const { hostAllowed, hostNamesOf } = await import('../src/netaddr.mjs');
  const names = hostNamesOf(['http://cty.tail5051dc.ts.net:8795', 'http://100.102.248.85:8795', 'rác']);
  assert.ok(hostAllowed('cty.tail5051dc.ts.net:8795', names));
  assert.ok(hostAllowed('CTY.tail5051dc.ts.net.:8795', names));
  assert.ok(!hostAllowed('other.tail5051dc.ts.net:8795', names));
  assert.ok(hostAllowed('', names), 'không có Host: không phải trình duyệt');
  assert.ok(!hostAllowed('10.0.0.5:8797', names, { loopbackOnly: true }));
});
