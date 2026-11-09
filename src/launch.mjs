// Chạy một lệnh của main.mjs ở tiến trình tách riêng, không cửa sổ, ghi nhật ký vào thư mục trạng
// thái. Dùng để dựng trạm và đầu máy chạy nền, và cho các lệnh bấm từ app (khởi động lại trạm, setup
// một máy): tiến trình tách riêng sống tiếp khi trạm hay đầu máy đã gọi nó tắt đi.

import { spawn } from 'node:child_process';
import { openSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv } from './claude-session.mjs';
import { STATE_DIR, TOOL_DIR, ensureDir } from './paths.mjs';

export const MAIN_SCRIPT = join(TOOL_DIR, 'src', 'main.mjs');
const LOG_MAX_BYTES = 2 * 1024 * 1024;

// Nhật ký chạy nền không được phình mãi: quá ngưỡng thì cất thành .1 (đè bản cũ) và mở file mới.
export function rotateLog(file) {
  try {
    if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // chưa có file
  }
}

// Trả về đường dẫn tệp nhật ký.
export function spawnMain(args, logName) {
  ensureDir(STATE_DIR);
  const logFile = join(STATE_DIR, logName);
  rotateLog(logFile);
  const out = openSync(logFile, 'a');
  // Phiên Claude do trạm mở phải là phiên bình thường: bỏ công tắc tắt đồng bộ đầu phiên nếu lệnh
  // này được gọi từ một tiến trình đã bật nó.
  const env = childEnv();
  delete env.ORBIT_SESSION_SYNC_OFF;
  spawn(process.execPath, [MAIN_SCRIPT, ...args], { detached: true, windowsHide: true, stdio: ['ignore', out, out], env }).unref();
  return logFile;
}

// Như spawnMain nhưng chờ `delayMs` rồi mới chạy, để tiến trình gọi (vừa sập) kịp thoát và nhả cổng. Một tiến trình
// node nhỏ tách riêng giữ hẹn giờ, rồi dựng lệnh thật cũng tách riêng.
export function spawnMainLater(args, logName, delayMs) {
  ensureDir(STATE_DIR);
  const logFile = join(STATE_DIR, logName);
  rotateLog(logFile);
  const out = openSync(logFile, 'a');
  const env = childEnv();
  delete env.ORBIT_SESSION_SYNC_OFF;
  const argv = JSON.stringify([MAIN_SCRIPT, ...args]);
  const code = `setTimeout(() => require('node:child_process').spawn(process.execPath, ${argv}, { detached: true, windowsHide: true, stdio: 'inherit' }).unref(), ${Math.max(0, Number(delayMs) || 0)});`;
  spawn(process.execPath, ['-e', code], { detached: true, windowsHide: true, stdio: ['ignore', out, out], env }).unref();
  return logFile;
}

// Tự chạy lại sau khi sập, trừ khi sập liên tục (lỗi nằm ở code hay ở máy: chạy lại chỉ sập tiếp, lấp mất log).
// times: các lần sập trước (mili giây). Trả danh sách mới để lưu và có nên tự chạy lại không.
export const CRASH_WINDOW_MS = 10 * 60 * 1000;
export const CRASH_MAX = 3;
export function crashDecision(times, now = Date.now()) {
  const recent = (Array.isArray(times) ? times : []).filter((t) => Number.isFinite(t) && t <= now && now - t < CRASH_WINDOW_MS);
  recent.push(now);
  return { times: recent, respawn: recent.length <= CRASH_MAX };
}

// ---- Tự chạy trên macOS (launchd) ------------------------------------------------------------------
// main.mjs autostart on (macOS): một LaunchAgent của người dùng chạy "ensure" lúc đăng nhập và mỗi 5 phút. ensure dựng
// trạm hay đầu máy nếu chưa chạy, nên cũng là người canh: tiến trình chết thì vài phút sau tự dựng lại.
// AbandonProcessGroup: "ensure" dựng tiến trình tách riêng rồi thoát; launchd không được giết theo.
export const LAUNCHD_LABEL = 'com.orbitremote.ensure';
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function launchdPlist({ node, main, log, workdir, intervalSec = 300 }) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(main)}</string><string>ensure</string></array>`,
    `  <key>WorkingDirectory</key><string>${xml(workdir)}</string>`,
    '  <key>RunAtLoad</key><true/>',
    `  <key>StartInterval</key><integer>${Math.max(60, Math.floor(intervalSec))}</integer>`,
    '  <key>AbandonProcessGroup</key><true/>',
    `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}
