// Xem tệp trong thư mục làm việc của một phiên (nút "Tệp" ở màn phiên): liệt kê từng tầng một và đọc tệp theo khúc.
// Gốc là thư mục làm việc của phiên (trạm đưa xuống, app không chọn được); đường dẫn app xin là đường tương đối tính
// từ gốc và không bao giờ được ra ngoài gốc: không "..", không đường tuyệt đối, không lối tắt (junction, symlink)
// trỏ ra ngoài, không đường mạng.

import { open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

// Thư mục hệ thống ở gốc ổ đĩa (thư mục làm việc là cả một ổ): không ai cần xem, mở ra thì bị từ chối.
const HIDDEN_SYSTEM = /^(\$Recycle\.Bin|System Volume Information)$/i;
export const FILES_MAX = 1000; // một thư mục đông hơn thì cắt, báo còn nữa
const CHUNK = 512 * 1024; // bằng khúc tệp đính kèm (node-agent.mjs ATTACH_CHUNK): vừa lô tin 1 MB sau base64

// Thư mục nặng hiếm khi cần xem (thư viện tải về, bản dựng, bộ đệm): app ẩn đi, bật "Hiện thư mục ẩn" thì hiện lại.
// So không phân biệt hoa thường (Unity viết Library, Temp).
export const HEAVY_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'library', 'temp', 'obj', 'dist', 'build', 'builds', 'target',
  '__pycache__', '.venv', 'venv', '.next', '.nuxt', '.gradle', '.vs', '.idea', '.pytest_cache', '.mypy_cache',
  '.tox', 'coverage', '.turbo', '.parcel-cache', '.cache',
]);

const WHY = { ENOENT: 'không còn trên máy', EISDIR: 'là thư mục, không phải tệp', EACCES: 'không được phép đọc', EPERM: 'không được phép đọc', ENOTDIR: 'không phải thư mục' };
const why = (err) => WHY[err.code] || err.code || err.message;

// Đường dẫn trong thư mục của phiên viết theo kiểu app dùng: tương đối, ngăn bằng "/", gốc là ''.
const toRel = (root, full) => relative(root, full).split(sep).join('/');

// Nằm trong gốc (hay chính là gốc)? So bằng path.relative: trên Windows nó không phân biệt hoa thường. Chỉ chặn
// đúng bước "..", không chặn tên tệp bắt đầu bằng hai dấu chấm ("..ghi-chu.txt" vẫn nằm trong gốc).
function within(root, full) {
  const rel = relative(root, full);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// Gốc thật (đã giải lối tắt) và đường thật của `rel` trong gốc. Ném lỗi tiếng Việt khi đường không hợp lệ, ra ngoài
// gốc hay không có trên máy.
export async function locate(root, rel = '') {
  const r = String(root || '');
  if (!r || r.length > 1000 || r.includes('\0') || /^[\\/]{2}/.test(r) || !isAbsolute(r)) {
    throw new Error('Phiên này không có thư mục làm việc hợp lệ trên máy.');
  }
  const p = String(rel || '').replace(/\\/g, '/');
  // Đường tuyệt đối ("/etc", "C:/...", "//máy/chia-sẻ") không bao giờ là đường tương đối hợp lệ.
  if (p.length > 1000 || p.includes('\0') || p.startsWith('/') || /^[a-z]:/i.test(p)) throw new Error('Đường dẫn không hợp lệ.');
  let rootReal;
  try {
    rootReal = await realpath(r);
  } catch (err) {
    throw new Error(`Không mở được thư mục làm việc ${r}: ${why(err)}.`);
  }
  const full = resolve(rootReal, p);
  if (!within(rootReal, full)) throw new Error('Chỉ xem được tệp trong thư mục làm việc của phiên.');
  let real;
  try {
    real = await realpath(full);
  } catch (err) {
    throw new Error(`Không mở được ${p || 'thư mục làm việc'}: ${why(err)}.`);
  }
  if (!within(rootReal, real)) throw new Error('Lối tắt này trỏ ra ngoài thư mục làm việc của phiên.');
  return { rootReal, full, real, rel: toRel(rootReal, full) };
}

// Thư mục `rel` trong gốc, một tầng: { root, path, entries: [{ name, kind: 'dir'|'file', size, mtime, heavy, link }],
// more }. Thư mục trước tệp; trong mỗi nhóm, tên bắt đầu bằng "." xuống cuối, còn lại xếp như File Explorer (số theo
// giá trị: 2 trước 10). Lối tắt thì theo đích của nó để biết là thư mục hay tệp; đích hỏng thì bỏ.
export async function listFiles(root, rel = '') {
  const { rootReal, real, rel: at } = await locate(root, rel);
  let items;
  try {
    items = await readdir(real, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Không mở được ${at || 'thư mục làm việc'}: ${why(err)}.`);
  }
  const rows = await Promise.all(items.filter((d) => !HIDDEN_SYSTEM.test(d.name)).map(async (d) => {
    const link = d.isSymbolicLink();
    let dir = d.isDirectory();
    let st = null;
    try {
      st = await stat(join(real, d.name));
      dir = st.isDirectory();
    } catch {
      if (link) return null; // lối tắt hỏng
    }
    if (!dir && !(st ? st.isFile() : d.isFile())) return null; // ống, thiết bị...
    return {
      name: d.name,
      kind: dir ? 'dir' : 'file',
      ...(dir ? {} : { size: st?.size ?? 0 }),
      ...(st ? { mtime: Math.round(st.mtimeMs) } : {}),
      ...(dir && HEAVY_DIRS.has(d.name.toLowerCase()) ? { heavy: true } : {}),
      ...(link ? { link: true } : {}),
    };
  }));
  const entries = rows.filter(Boolean).sort((a, b) => (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1)
    || a.name.startsWith('.') - b.name.startsWith('.')
    || a.name.localeCompare(b.name, 'vi', { sensitivity: 'base', numeric: true }));
  return { root: rootReal, path: at, entries: entries.slice(0, FILES_MAX), more: entries.length > FILES_MAX };
}

// Một khúc của tệp `rel` trong gốc: { size, mtime, offset, data (base64) }; head: chỉ cỡ và giờ sửa (để trạm trả 304
// khi app đã có bản đó). Cùng dạng với node-agent.mjs readSessionFile để trạm phát bằng một đường.
export async function readFileChunk(root, rel, offset = 0, head = false, chunk = CHUNK) {
  const { real, rel: at } = await locate(root, rel);
  if (!at) throw new Error('Đây là thư mục làm việc, không phải một tệp.');
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  let fh;
  try {
    fh = await open(real, 'r');
  } catch (err) {
    throw new Error(`Không mở được ${at}: ${why(err)}.`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('Đường dẫn này không phải một tệp.');
    const mtime = Math.round(st.mtimeMs);
    if (head) return { size: st.size, mtime };
    const length = Math.max(0, Math.min(chunk, st.size - start));
    const buf = Buffer.alloc(length);
    const { bytesRead } = length ? await fh.read(buf, 0, length, start) : { bytesRead: 0 };
    return { size: st.size, mtime, offset: start, data: buf.subarray(0, bytesRead).toString('base64') };
  } finally {
    await fh.close();
  }
}
