// Cây tệp của nút "Tệp" (views/files.js): từ các tầng thư mục đã tải và các thư mục đang mở, dựng danh sách hàng để
// vẽ. Không đụng DOM, để kiểm được thẳng bằng node --test.
//
// nodes: Map<đường tương đối, { entries, more } | { error }>, '' là thư mục làm việc. Mỗi mục như đầu máy trả
// (src/files.mjs listFiles): { name, kind: 'dir'|'file', size, mtime, heavy, link }.

export const joinRel = (dir, name) => (dir ? `${dir}/${name}` : name);

const lower = (s) => String(s).toLocaleLowerCase('vi');

// Hàng để vẽ, theo thứ tự từ trên xuống: mục { ...entry, rel, depth, open, loading }, hay ghi chú { note, depth, error }.
// filter: chữ lọc theo tên, chỉ trong các tầng đã tải (thư mục chứa tên khớp tự mở ra; thư mục có tên khớp thì hiện cả
// bên trong). showHeavy: hiện thư mục nặng (node_modules, .git...). loading: các thư mục đang tải lại.
export function treeRows(nodes, open, { filter = '', showHeavy = false, loading = new Set() } = {}) {
  const q = lower(filter.trim());
  const visible = (e) => showHeavy || !e.heavy;
  const hit = (e) => lower(e.name).includes(q);
  // Bên trong thư mục `rel` (chỉ phần đã tải) có tên khớp không.
  const memo = new Map();
  const hasHit = (rel) => {
    if (memo.has(rel)) return memo.get(rel);
    memo.set(rel, false); // chặn vòng (lối tắt trỏ ngược lên)
    const found = Boolean(nodes.get(rel)?.entries?.some((e) => visible(e) && (hit(e) || (e.kind === 'dir' && hasHit(joinRel(rel, e.name))))));
    memo.set(rel, found);
    return found;
  };
  const rows = [];
  const walk = (dir, depth, all) => {
    const node = nodes.get(dir);
    if (!node) {
      rows.push({ note: 'Đang tải…', depth });
      return;
    }
    if (node.error) {
      rows.push({ note: node.error, depth, error: true });
      return;
    }
    let shown = 0;
    for (const e of node.entries) {
      if (!visible(e)) continue;
      const rel = joinRel(dir, e.name);
      const self = all || hit(e);
      const deep = !all && e.kind === 'dir' && hasHit(rel);
      if (!self && !deep) continue;
      const isOpen = e.kind === 'dir' && (open.has(rel) || deep);
      rows.push({ ...e, rel, depth, open: isOpen, loading: loading.has(rel) });
      shown += 1;
      if (isOpen) walk(rel, depth + 1, all || hit(e));
    }
    if (!shown && all) rows.push({ note: node.entries.length ? 'Chỉ có thư mục ẩn.' : 'Thư mục trống.', depth });
    if (node.more) rows.push({ note: `Thư mục quá đông, chỉ hiện ${node.entries.length} mục đầu.`, depth });
  };
  walk('', 0, !q);
  if (q && !rows.some((r) => !r.note)) rows.push({ note: 'Không có tên nào khớp trong các thư mục đã mở.', depth: 0 });
  return rows;
}

// Số thư mục nặng đang bị ẩn trong các tầng đã tải (nút "Hiện thư mục ẩn").
export function heavyCount(nodes) {
  let n = 0;
  for (const node of nodes.values()) for (const e of node.entries || []) if (e.heavy) n += 1;
  return n;
}

export function sizeText(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)} ${units[i]}`;
}
