// Phiên cũ trên máy (nhật ký Claude Code, src/transcripts.mjs): sổ nhớ dùng chung giữa màn máy và màn xem
// chỉ-đọc, gom theo dự án, và các thao tác dọn danh sách (ẩn, thùng rác, bỏ ẩn, khôi phục).

import { api } from './api.js';
import { h, add, baseName, timeAgo, toast } from './dom.js';
import { icon } from './icons.js';

// Phiên cũ đã đọc gần nhất của mỗi máy, để màn xem chỉ-đọc biết tên và thao tác được với phiên vừa chọn.
export const pastCache = new Map(); // mã máy -> [{ claudeSessionId, title, cwd, modified, sizeKb, maybeActive }]

const listeners = new Set();
// Báo khi danh sách phiên cũ của một máy đổi (vừa ẩn, bỏ ẩn, chuyển vào hay lấy ra khỏi thùng rác).
export function onTranscriptsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const ACTION_DONE = {
  hide: 'Đã ẩn phiên. Bỏ ẩn ở mục "Đã ẩn" cuối danh sách phiên cũ.',
  unhide: 'Đã bỏ ẩn, phiên hiện lại trong danh sách.',
  trash: 'Đã chuyển vào thùng rác. Khôi phục ở mục "Thùng rác" cuối danh sách phiên cũ.',
  restore: 'Đã khôi phục phiên về chỗ cũ.',
};

// Lời báo sau một thao tác dọn danh sách; ẩn hay chuyển vào thùng rác thì kèm nút "Hoàn tác" (bỏ ẩn, khôi phục),
// khỏi phải tìm tới mục "Đã ẩn", "Thùng rác" khi lỡ tay.
const UNDO = { hide: 'unhide', trash: 'restore' };
export function toastDone(machineId, claudeSessionId, action) {
  const back = UNDO[action];
  toast(ACTION_DONE[action] || 'Xong.', 'info', back ? {
    label: 'Hoàn tác',
    run: () => transcriptAction(machineId, claudeSessionId, back).then(() => toast(ACTION_DONE[back]), (err) => toast(err.message, 'error')),
  } : null);
}

// action: 'hide' | 'unhide' | 'trash' | 'restore'.
export async function transcriptAction(machineId, claudeSessionId, action) {
  const r = await api.post(`/api/machines/${machineId}/transcripts/${claudeSessionId}/${action}`);
  if (action === 'hide' || action === 'trash') {
    const list = pastCache.get(machineId);
    if (list) pastCache.set(machineId, list.filter((t) => t.claudeSessionId !== claudeSessionId));
  }
  for (const fn of listeners) fn(machineId, claudeSessionId, action);
  return r;
}

// Gom theo thư mục làm việc. Trên Windows nhật ký ghi lẫn "d:\X" và "D:\X", nên so không phân biệt hoa thường.
// Giữ thứ tự của danh sách vào (mới trước): dự án có phiên gần nhất đứng đầu.
// Hai thư mục khác nhau mà trùng tên (D:\A\app và E:\B\app) thì kèm thư mục cha (`where`) để phân biệt.
export function groupByProject(list) {
  const groups = new Map();
  for (const t of list) {
    const key = String(t.cwd || '').replace(/[\\/]+$/, '').toLowerCase();
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, cwd: t.cwd || '', name: baseName(t.cwd) || 'Không rõ thư mục', where: '', items: [] }));
    g.items.push(t);
  }
  const all = [...groups.values()];
  const named = new Map();
  for (const g of all) named.set(g.name.toLowerCase(), (named.get(g.name.toLowerCase()) || 0) + 1);
  for (const g of all) {
    if (named.get(g.name.toLowerCase()) > 1) g.where = g.cwd.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
  }
  return all;
}

// Một khối dự án: dòng đầu (tên thư mục, số phiên, lần ghi gần nhất) chạm để mở hay gập, bên dưới là các
// phiên. Danh sách chỉ có một dự án, hay alwaysOpen, thì luôn mở. Gập chỉ ẩn bằng CSS, các dòng vẫn nằm sẵn.
export function projectBlock(g, rowOf, { alwaysOpen = false } = {}) {
  const open = alwaysOpen || projectOpen(g.key);
  const block = h('div', { class: `proj${open ? ' open' : ''}${alwaysOpen ? ' fixed' : ''}` });
  const head = h(alwaysOpen ? 'div' : 'button', {
    class: 'proj-head',
    title: g.cwd,
    ...(alwaysOpen ? {} : {
      type: 'button',
      'aria-expanded': String(open),
      onclick: () => {
        const on = !block.classList.contains('open');
        block.classList.toggle('open', on);
        head.setAttribute('aria-expanded', String(on));
        setProjectOpen(g.key, on);
      },
    }),
  },
  alwaysOpen ? null : icon('chevron', 14, 'proj-chev'),
  icon('folder', 15),
  h('span', { class: 'proj-name' }, g.name, g.where ? h('span', { class: 'proj-where' }, ` · ${g.where}`) : null),
  h('span', { class: 'group-count' }, String(g.items.length)),
  h('span', { class: 'proj-time' }, timeAgo(g.items[0]?.modified)));
  add(block, head, h('div', { class: 'proj-body' }, g.items.map(rowOf)));
  return block;
}

// Dự án đang mở rộng trong danh sách phiên cũ, nhớ qua lần mở sau trên trình duyệt này.
const OPEN_KEY = 'orbit.pastProjects.open';
let openProjects = null;
function loadOpen() {
  if (openProjects) return openProjects;
  try {
    openProjects = new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]'));
  } catch {
    openProjects = new Set();
  }
  return openProjects;
}
export const projectOpen = (key) => loadOpen().has(key);
export function setProjectOpen(key, on) {
  const set = loadOpen();
  if (on) set.add(key); else set.delete(key);
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...set].slice(-200)));
  } catch {
    // trình duyệt chặn lưu: chỉ nhớ trong lần mở này
  }
}
