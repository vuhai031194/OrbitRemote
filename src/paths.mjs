// Chỗ duy nhất biết các file của Orbit Remote nằm ở đâu.
//
// Hai loại chỗ, cố ý tách:
//   - Thư mục trạng thái riêng từng máy (~/.orbit/state/remote): mã ghép đôi, danh sách
//     phiên, cấu hình MCP tạm. Không bao giờ vào git, vì nó chứa bí mật của máy đó.
//   - Thư mục custom/ trong tool: nút bấm, theme, phần mở rộng do người dùng viết. Nằm
//     trong repo, đồng bộ qua mọi máy bằng git (bản fork riêng của bạn).

import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';

export const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_DIR = join(TOOL_DIR, 'web');
export const MCP_SERVER = join(TOOL_DIR, 'src', 'mcp-server.mjs');

// Cho phép đổi gốc trạng thái và thư mục custom/ để phép kiểm chạy trong thư mục tạm, không đụng
// máy thật cũng không đụng trạm thật khai trong kho.
export const CUSTOM_DIR = process.env.ORBIT_REMOTE_CUSTOM || join(TOOL_DIR, 'custom');
export const STATE_DIR = process.env.ORBIT_REMOTE_STATE || join(homedir(), '.orbit', 'state', 'remote');

export const MACHINE_NAME = process.env.ORBIT_REMOTE_MACHINE || hostname();

// Kết quả lần setup gần nhất của máy này (setup.mjs ghi, đầu máy gửi lên trạm để hiện trên app).
export const SETUP_RESULT_FILE = join(STATE_DIR, 'setup-last.json');
// Lịch tắt máy đang chờ (đặt từ app), để đầu máy khởi động lại giữa chừng vẫn báo đúng cho app.
export const POWER_FILE = join(STATE_DIR, 'power.json');

export const PIPE_PATH = process.platform === 'win32'
  ? `\\\\.\\pipe\\orbit-remote-${process.env.ORBIT_REMOTE_PIPE_TAG || 'main'}`
  : join(STATE_DIR, `node-${process.env.ORBIT_REMOTE_PIPE_TAG || 'main'}.sock`);

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function tryParse(file) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, missing: err.code === 'ENOENT' };
  }
}

// Đọc một file trạng thái quan trọng (hub.json, auth.json). readJson coi file hỏng như file trống, rồi lần lưu sau
// ghi đè mất hết phiên, nhóm, thiết bị đã ghép. Ở đây:
//   - file hỏng (JSON cụt, đĩa lỗi) thì cất sang <file>.corrupt-<giờ>, không bao giờ ghi đè lên nó;
//   - file hỏng hay mất thì nạp bản dự phòng <file>.bak (writeJsonAtomic với backup giữ bản tốt trước đó).
// Trả { value, from: 'file' | 'bak' | 'none', corrupt: đường dẫn bản hỏng đã cất (nếu có) }.
export function readStateJson(file, fallback) {
  const main = tryParse(file);
  if (main.ok) return { value: main.value, from: 'file' };
  let corrupt = '';
  if (!main.missing) {
    corrupt = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      renameSync(file, corrupt);
    } catch {
      corrupt = '';
    }
  }
  const bak = tryParse(`${file}.bak`);
  if (bak.ok) return { value: bak.value, from: 'bak', corrupt };
  return { value: fallback, from: 'none', corrupt };
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Đổi tên, thử lại khi Windows báo file đang bị giữ (trình diệt virus, bộ lập chỉ mục mở file vừa ghi).
function renameRetry(from, to, tries = 8) {
  for (let i = 1; ; i += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      sleepSync(15 * i);
    }
  }
}

// Ghi qua file tạm rồi đổi tên: mất điện giữa chừng thì còn bản cũ nguyên vẹn,
// không bao giờ còn một file JSON cụt nửa chừng. Đẩy hẳn xuống đĩa (fsync) trước khi đổi tên, kẻo mất điện ngay
// sau đó còn lại file đúng tên mà rỗng. backup: giữ bản tốt trước đó ở <file>.bak (readStateJson dùng khi hỏng).
export function writeJsonAtomic(file, value, { backup = false } = {}) {
  ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (backup && existsSync(file) && tryParse(file).ok) {
    try {
      copyFileSync(file, `${file}.bak`);
    } catch {
      // không giữ được bản dự phòng lần này: vẫn ghi bản chính
    }
  }
  renameRetry(tmp, file);
}
