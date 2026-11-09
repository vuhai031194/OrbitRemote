// Danh tính trạm (src/hub-identity.mjs): máy chạy phiên chỉ gửi thẻ tới địa chỉ ký đúng bằng khoá của trạm đã ghim.
// Một máy lạ trên cùng mạng trả lời việc dò trạm với đúng mã trạm (mã này công khai qua /api/ping) không qua được.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHub, loadHubKey, verifyHub } from '../src/hub-identity.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'orbit-identity-'));
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test('khoá trạm: tạo một lần, nạp lại đúng khoá đó; file hỏng thì nạp bản dự phòng, không đổi danh tính', () => {
  const file = join(ROOT, 'hub-key.json');
  const a = loadHubKey(file);
  assert.ok(existsSync(`${file}.bak`), 'có bản dự phòng ngay từ đầu');
  const b = loadHubKey(file);
  assert.equal(a.publicKey, b.publicKey);
  writeFileSync(file, '{"privateKey": "cụt');
  assert.equal(loadHubKey(file).publicKey, a.publicKey, 'file hỏng: vẫn đúng danh tính cũ');

  const sig = a.sign('hub1', 'ab'.repeat(16));
  assert.equal(verifyHub(a.publicKey, 'hub1', 'ab'.repeat(16), sig), true);
  assert.equal(verifyHub(a.publicKey, 'hub2', 'ab'.repeat(16), sig), false, 'chữ ký gắn với mã trạm');
  assert.equal(verifyHub(a.publicKey, 'hub1', 'cd'.repeat(16), sig), false, 'chữ ký gắn với số ngẫu nhiên');
  assert.equal(verifyHub(loadHubKey(join(ROOT, 'khac.json')).publicKey, 'hub1', 'ab'.repeat(16), sig), false);
  assert.equal(verifyHub('rác', 'hub1', 'ab'.repeat(16), sig), false);
});

// Một "trạm" nhỏ trả lời /api/identity theo `answer(nonce)`.
async function identityServer(answer) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const out = answer(u.searchParams.get('nonce'));
    res.writeHead(out.status || 200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out.body || {}));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('máy chạy phiên: đúng trạm thì qua (và học khoá nếu chưa ghim); trạm giả cùng mã trạm, khoá khác, ký sai, trạm bản cũ sau khi đã ghim thì không', async () => {
  const real = loadHubKey(join(ROOT, 'real.json'));
  const fake = loadHubKey(join(ROOT, 'fake.json'));
  const servers = [];
  const serve = async (answer) => {
    const s = await identityServer(answer);
    servers.push(s);
    return s.url;
  };
  try {
    const good = await serve((n) => ({ body: { hubId: 'hub1', key: real.publicKey, sig: real.sign('hub1', n) } }));
    assert.deepEqual(await checkHub(good, { hubId: 'hub1' }), { ok: true, key: real.publicKey }, 'chưa ghim: học khoá');
    assert.deepEqual(await checkHub(good, { hubId: 'hub1', hubKey: real.publicKey }), { ok: true, key: real.publicKey });

    const impostor = await serve((n) => ({ body: { hubId: 'hub1', key: fake.publicKey, sig: fake.sign('hub1', n) } }));
    assert.deepEqual(await checkHub(impostor, { hubId: 'hub1', hubKey: real.publicKey }), { ok: false, reason: 'mismatch' }, 'khoá khác khoá đã ghim');

    const forged = await serve(() => ({ body: { hubId: 'hub1', key: real.publicKey, sig: real.sign('hub1', 'ab'.repeat(16)) } }));
    assert.deepEqual(await checkHub(forged, { hubId: 'hub1', hubKey: real.publicKey }), { ok: false, reason: 'mismatch' }, 'chữ ký cũ phát lại không dùng được');

    const other = await serve((n) => ({ body: { hubId: 'hub9', key: real.publicKey, sig: real.sign('hub9', n) } }));
    assert.deepEqual(await checkHub(other, { hubId: 'hub1' }), { ok: false, reason: 'mismatch' }, 'trạm khác mã');

    const legacy = await serve(() => ({ status: 401, body: { error: 'Thiết bị chưa ghép đôi.' } }));
    assert.deepEqual(await checkHub(legacy, { hubId: 'hub1' }), { ok: true, legacy: true }, 'chưa ghim: trạm bản cũ vẫn nối được');
    assert.deepEqual(await checkHub(legacy, { hubId: 'hub1', hubKey: real.publicKey }), { ok: false, reason: 'mismatch' }, 'đã ghim: không lùi về bản cũ');

    assert.deepEqual(await checkHub('http://127.0.0.1:9', { hubId: 'hub1' }, { timeoutMs: 1000 }), { ok: false, reason: 'unreachable' });
  } finally {
    for (const s of servers) await s.close();
  }
});

test('đầu-cuối: "trạm" giả khai đúng mã trạm qua /api/ping, máy đã ghim khoá không bao giờ gửi thẻ cho nó', async () => {
  const { runNodeLoop } = await import('../src/node-runner.mjs');
  const { writeJsonAtomic, readJson } = await import('../src/paths.mjs');
  const real = loadHubKey(join(ROOT, 'real2.json'));
  const fake = loadHubKey(join(ROOT, 'fake2.json'));
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url.split('?')[0], auth: req.headers.authorization || '' });
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/ping') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ service: 'orbit-remote', hubId: 'hubR', hubName: 'Trạm' }));
    if (u.pathname === '/api/identity') {
      const n = u.searchParams.get('nonce');
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ hubId: 'hubR', key: fake.publicKey, sig: fake.sign('hubR', n) }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }).write('data: {"op":"linked","linkId":"x"}\n\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const stateFile = join(ROOT, 'node.json');
  writeJsonAtomic(stateFile, { hubId: 'hubR', hubName: 'Trạm', urls: [url], token: 'the-that', hubKey: real.publicKey });
  const logs = [];
  const ctrl = new AbortController();
  const loop = runNodeLoop({ machine: { id: 'mZ', name: 'MayZ' } }, { stateFile, port: 9, log: (t) => logs.push(t), signal: ctrl.signal });
  try {
    for (let i = 0; i < 100 && !seen.some((s) => s.path === '/api/identity'); i += 1) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    ctrl.abort();
    await loop.catch(() => {});
    await new Promise((r) => server.close(r));
  }
  assert.ok(seen.some((s) => s.path === '/api/identity'), 'máy có hỏi danh tính');
  assert.ok(!seen.some((s) => s.auth.includes('the-that')), 'thẻ không bao giờ tới trạm giả');
  assert.ok(!seen.some((s) => s.path === '/node/link'), 'không mở đường nối');
  assert.ok(logs.some((t) => /Bỏ qua .*khoá không khớp/.test(t)), logs.join('\n'));
  assert.equal(readJson(stateFile, {}).hubKey, real.publicKey, 'khoá đã ghim giữ nguyên');
});
