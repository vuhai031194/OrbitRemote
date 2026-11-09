// macOS: tự chạy bằng launchd (src/launch.mjs launchdPlist, main.mjs autostart) và nhận ra trạm, đầu máy đang chạy
// từ `ps` (src/setup.mjs parsePs) để "Setup máy" không báo "chưa chạy" mãi. Chạy được trên mọi hệ điều hành: chỉ kiểm
// nội dung sinh ra, không gọi launchctl.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAUNCHD_LABEL, launchdPlist } from '../src/launch.mjs';
import { parsePs } from '../src/setup.mjs';

test('launchd: chạy "ensure" lúc đăng nhập và mỗi 5 phút, không giết tiến trình nó dựng, ghi nhật ký; đường dẫn lạ được thoát đúng XML', () => {
  const p = launchdPlist({ node: '/opt/homebrew/bin/node', main: '/Users/me/Orbit & Co/src/main.mjs', log: '/Users/me/.orbit/state/remote/ensure.log', workdir: '/Users/me/Orbit & Co' });
  assert.match(p, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
  assert.ok(p.includes(`<key>Label</key><string>${LAUNCHD_LABEL}</string>`));
  assert.ok(p.includes('<array><string>/opt/homebrew/bin/node</string><string>/Users/me/Orbit &amp; Co/src/main.mjs</string><string>ensure</string></array>'));
  assert.ok(p.includes('<key>RunAtLoad</key><true/>'));
  assert.ok(p.includes('<key>StartInterval</key><integer>300</integer>'));
  assert.ok(p.includes('<key>AbandonProcessGroup</key><true/>'), 'tiến trình tách riêng "ensure" dựng không bị launchd giết theo');
  assert.ok(!/&(?!amp;|lt;|gt;)/.test(p), 'không còn & trần');
  assert.equal((p.match(/<dict>/g) || []).length, (p.match(/<\/dict>/g) || []).length);
  assert.ok(launchdPlist({ node: 'n', main: 'm', log: 'l', workdir: 'w', intervalSec: 5 }).includes('<integer>60</integer>'), 'không chạy dày hơn mỗi phút');
});

test('ps (macOS, Linux): nhận ra trạm và đầu máy của Orbit, giờ mở, số phiên claude con; bỏ tiến trình khác', () => {
  const out = [
    '  101     1 Mon Nov  9 22:48:16 2026 /opt/homebrew/bin/node /Users/me/OrbitRemote/src/main.mjs node',
    '  202   101 Mon Nov  9 22:50:01 2026 /Users/me/.local/bin/claude --output-format stream-json',
    '  203   101 Mon Nov  9 22:51:01 2026 /opt/homebrew/bin/node /Users/me/.npm/claude-code/cli.js',
    '  204   101 Mon Nov  9 22:52:01 2026 /bin/zsh -c ls',
    '  300     1 Tue Nov 10 08:00:00 2026 node /srv/orbit/src/main.mjs hub',
    '  400     1 Tue Nov 10 08:00:00 2026 node /srv/other/src/main.mjs ensure',
    'rác không phải dòng ps',
  ].join('\n');
  const procs = parsePs(out);
  assert.deepEqual(procs.map((p) => [p.pid, p.mode, p.children]), [[101, 'node', 2], [300, 'hub', 0]]);
  assert.equal(new Date(procs[0].started).getFullYear(), 2026);
  assert.deepEqual(parsePs(''), []);
});
