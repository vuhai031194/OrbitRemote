// Bảng "Tệp" của một phiên: cây thư mục làm việc của phiên trên máy, mở từng thư mục khi chạm, chạm tệp thì mở khung
// xem (views/viewer.js). Chỉ xem, không sửa; trạm và đầu máy giữ cho mọi đường dẫn nằm trong thư mục của phiên
// (src/files.mjs). Thư mục nặng (node_modules, .git...) ẩn đi, bật lại bằng nút "Hiện thư mục ẩn".

import { h, add, clear, baseName } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { heavyCount, sizeText, treeRows } from '../lib/file-tree.js';
import { openSheet } from './sheets.js';
import { attachmentIcon, attachmentKind, openAttachment } from './viewer.js';

const REFRESH_DELAY_MS = 400; // gộp mấy lượt xong liền nhau thành một lần làm mới

// Bảng tệp của phiên app giữ (màn phiên): tự làm mới mỗi khi phiên xong một lượt.
export function openSessionFiles(session) {
  const id = session.id;
  const enc = encodeURIComponent;
  return openFiles({
    root: session.remote?.cwd || session.cwd || '',
    listUrl: (p) => `/api/sessions/${enc(id)}/tree${p ? `?p=${enc(p)}` : ''}`,
    fileUrl: (p) => `/api/sessions/${enc(id)}/tree-file?p=${enc(p)}`,
    sessionId: id,
  });
}

// Bảng tệp của phiên ngoài app (màn chỉ xem): đầu máy tìm thư mục làm việc trong nhật ký của phiên.
export function openTranscriptFiles(machineId, claudeSessionId, cwd = '') {
  const enc = encodeURIComponent;
  return openFiles({
    root: cwd,
    listUrl: (p) => `/api/machines/${enc(machineId)}/tree/${enc(claudeSessionId)}${p ? `?p=${enc(p)}` : ''}`,
    fileUrl: (p) => `/api/machines/${enc(machineId)}/tree-file/${enc(claudeSessionId)}?p=${enc(p)}`,
  });
}

function openFiles({ root, listUrl, fileUrl, sessionId = null }) {
  const nodes = new Map(); // đường tương đối -> { entries, more } | { error }
  const open = new Set(); // thư mục đang mở
  const loading = new Set();
  let showHeavy = false;
  let rootPath = root;
  let closed = false;
  let timer = null;
  const offs = [];

  const { body } = openSheet(`Tệp · ${baseName(root) || 'thư mục làm việc'}`, {
    tall: true,
    cls: 'files',
    onClose: () => {
      closed = true;
      clearTimeout(timer);
      offs.forEach((off) => off());
    },
  });
  const pathEl = h('div', { class: 'files-root' }); // paint() điền đường dẫn
  const refreshBtn = h('button', { class: 'icon-btn', 'aria-label': 'Làm mới', title: 'Làm mới', onclick: () => refresh() }, icon('rotate', 18));
  const filter = h('input', { class: 'input files-filter', type: 'search', placeholder: 'Lọc theo tên', 'aria-label': 'Lọc theo tên', enterkeyhint: 'search' });
  filter.addEventListener('input', () => paint());
  const heavyBtn = h('button', { class: 'chip files-heavy hidden', onclick: () => { showHeavy = !showHeavy; paint(); } });
  const list = h('div', { class: 'files-list', role: 'tree', 'aria-label': 'Tệp trong thư mục làm việc' });
  add(body,
    h('div', { class: 'files-bar' }, icon('folder', 17), pathEl, refreshBtn),
    h('div', { class: 'files-tools' }, filter, heavyBtn),
    list);

  async function load(rel) {
    loading.add(rel);
    paint();
    try {
      const data = await api.get(listUrl(rel));
      nodes.set(rel, data);
      if (!rel && data.root) rootPath = data.root;
    } catch (err) {
      nodes.set(rel, { error: err.message });
    } finally {
      loading.delete(rel);
      if (!closed) paint();
    }
  }

  // Tải lại thư mục làm việc và mọi thư mục đang mở; thư mục đang đóng thì bỏ bản cũ, mở lại sẽ tải mới.
  function refresh() {
    if (closed) return;
    for (const rel of [...nodes.keys()]) if (rel && !open.has(rel)) nodes.delete(rel);
    for (const rel of ['', ...open]) load(rel);
  }

  function toggle(row) {
    if (row.open && open.has(row.rel)) {
      open.delete(row.rel);
      paint();
      return;
    }
    open.add(row.rel);
    if (!nodes.has(row.rel) || nodes.get(row.rel).error) load(row.rel);
    else paint();
  }

  function rowEl(row) {
    const pad = { paddingLeft: `${8 + row.depth * 16}px` };
    if (row.note) return h('div', { class: `files-note${row.error ? ' err' : ''}`, style: pad }, row.note);
    const dir = row.kind === 'dir';
    return h('button', {
      class: `file-row ${dir ? 'dir' : 'file'}${row.heavy ? ' heavy' : ''}`,
      style: pad,
      role: 'treeitem',
      ...(dir ? { 'aria-expanded': row.open ? 'true' : 'false' } : {}),
      title: row.rel,
      onclick: () => (dir ? toggle(row) : openAttachment({ name: row.name, src: fileUrl(row.rel) })),
    },
    dir ? icon(row.open ? 'down' : 'chevron', 14, 'file-caret') : h('span', { class: 'file-caret' }),
    icon(dir ? 'folder' : attachmentIcon(attachmentKind(row.name)), 17, 'file-icon'),
    h('span', { class: 'file-name' }, row.name),
    row.link ? icon('link', 13, 'file-link-mark') : null,
    row.loading ? h('span', { class: 'file-spin' }) : null,
    dir ? null : h('span', { class: 'file-size' }, sizeText(row.size)));
  }

  function paint() {
    if (closed) return;
    pathEl.textContent = rootPath;
    pathEl.setAttribute('title', rootPath);
    refreshBtn.classList.toggle('spinning', loading.size > 0);
    const hidden = heavyCount(nodes);
    heavyBtn.classList.toggle('hidden', !hidden && !showHeavy);
    heavyBtn.classList.toggle('active', showHeavy);
    heavyBtn.textContent = showHeavy ? 'Ẩn thư mục nặng' : `Hiện thư mục ẩn (${hidden})`;
    const rows = treeRows(nodes, open, { filter: filter.value, showHeavy, loading });
    clear(list).append(...rows.map(rowEl));
  }

  // Phiên app giữ: Claude vừa xong một lượt thì có thể đã thêm, sửa, xoá tệp.
  if (sessionId) {
    offs.push(store.on('event', ({ id, ev }) => {
      if (id !== sessionId || ev.t !== 'result') return;
      clearTimeout(timer);
      timer = setTimeout(refresh, REFRESH_DELAY_MS);
    }));
  }
  load('');
}
