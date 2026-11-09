// Đọc phần cuối các tệp nhật ký của Orbit Remote trên máy (thư mục trạng thái), để xem từ app khi có chuyện mà không
// phải ngồi tại máy (màn của máy → nút ba chấm → Xem nhật ký). Chỉ một danh sách tên cố định: không đọc tệp nào khác.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './paths.mjs';

// tên -> việc ghi vào đó (main.mjs, launch.mjs)
export const LOGS = {
  hub: 'Trạm',
  node: 'Đầu máy (máy không giữ trạm)',
  setup: 'Setup máy',
  restart: 'Khởi động lại trạm',
  ensure: 'Tự chạy lại sau khi sập, tự chạy lúc đăng nhập',
};
const TAIL_BYTES = 96 * 1024;
const LINES_MAX = 400;

// { name, text, size, mtime, missing }. text: tối đa `lines` dòng cuối (bỏ các dòng mã QR khối đặc, chỉ để quét trên
// cửa sổ dòng lệnh).
export function readLogTail(name, lines = 200, dir = STATE_DIR) {
  if (!Object.hasOwn(LOGS, name)) throw new Error('Không có nhật ký này.');
  const want = Math.min(Math.max(1, Number(lines) || 200), LINES_MAX);
  let fd;
  try {
    fd = openSync(join(dir, `${name}.log`), 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return { name, text: '', size: 0, mtime: null, missing: true };
    throw err;
  }
  try {
    const st = fstatSync(fd);
    const start = Math.max(0, st.size - TAIL_BYTES);
    const buf = Buffer.alloc(st.size - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    let text = buf.subarray(0, n).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // bỏ dòng cụt ở đầu phần đọc
    const kept = text.split(/\r?\n/).filter((l) => !/[█▀▄]{4}/.test(l));
    while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
    return { name, text: kept.slice(-want).join('\n'), size: st.size, mtime: st.mtime.toISOString(), missing: false };
  } finally {
    closeSync(fd);
  }
}
