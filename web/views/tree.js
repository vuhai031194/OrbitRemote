// Danh sách máy và phiên ở màn chính, dạng cây: hai mục lớn "Đang bật" và "Đang tắt" theo trạng thái MÁY, nên mỗi
// máy hiện đúng một lần (trước đây chia theo trạng thái phiên: máy đang bật mà có phiên đã dừng hiện ở cả hai mục,
// trông như hai máy). Dưới mỗi máy: nhóm và phiên đang chạy, phiên đang mở ngoài app (VS Code, terminal), mục
// "Đã dừng" thu gọn sẵn, và lối sang phiên cũ trên máy (màn của máy). Mục, máy, nhóm thu gọn hay xổ ra được bằng nút
// mũi tên, nhớ cho lần mở sau (localStorage).
//
// Nhóm đang chạy: đang chạy hay tạm dừng, có phiên đang chạy, hoặc là nhóm mới chưa có phiên nào (để còn kéo phiên
// vào). Nhóm nằm dưới máy của trưởng nhóm và chứa mọi phiên của nó (phiên ở máy khác ghi thêm tên máy), nên không
// phiên nào hiện hai lần.

import { h, timeAgo } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { store } from '../lib/store.js';
import { sessionCard, isOpenMachine } from './home.js';
import { GROUP_STATUS, STATUS_ORDER, isOpenGroup, openNewGroup } from './group.js';
import { openNewSession } from './sheets.js';

const RUNNING = new Set(['starting', 'idle', 'busy', 'waiting']);

// ---- Thu gọn và xổ ra ------------------------------------------------------------------------------
// Khoá: "label:online", "label:offline", "m:<mục>:<máy>" (một máy có thể ở cả hai mục), "g:<nhóm>".
const STORE_KEY = 'orbit-tree-collapsed';
const DEFAULT_SHUT = { 'label:offline': true }; // phiên đã dừng có thể rất nhiều: mục Offline mặc định thu gọn
const KEYS_MAX = 300;
let shutMap = null;

function shutState() {
  if (!shutMap) {
    try {
      shutMap = { ...DEFAULT_SHUT, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
    } catch {
      shutMap = { ...DEFAULT_SHUT };
    }
  }
  return shutMap;
}

function setShut(key, shut) {
  const state = shutState();
  delete state[key]; // ghi lại ở cuối để phần cắt bỏ dưới đây luôn bỏ khoá lâu không đụng tới
  state[key] = shut;
  const keys = Object.keys(state);
  for (const k of keys.slice(0, Math.max(0, keys.length - KEYS_MAX))) delete state[k];
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // trình duyệt chặn lưu: chỉ mất phần nhớ cho lần mở sau
  }
}

// Một nút gập được: đầu luôn hiện, thân ẩn khi thu gọn. Bấm mũi tên là đổi tại chỗ, không vẽ lại cả cây;
// thân co giãn bằng grid-template-rows nên cao bao nhiêu cũng mượt mà không phải đo.
function fold(key, cls, headParts, body, { attrs = {}, wholeHead = false, shutByDefault = false } = {}) {
  const saved = shutState();
  let shut = key in saved ? Boolean(saved[key]) : shutByDefault;
  const btn = h('button', { class: 'fold-btn', type: 'button', 'aria-expanded': String(!shut), 'aria-label': shut ? 'Xổ ra' : 'Thu gọn' }, icon('down', 16));
  const head = h('div', { class: 'fold-head' }, headParts, btn);
  // fold-inner co giãn (không có padding nên co được về đúng 0), fold-pad mang khoảng đệm của nội dung.
  const bodyEl = h('div', { class: 'fold-body' }, h('div', { class: 'fold-inner' }, h('div', { class: 'fold-pad' }, body)));
  const node = h('div', { class: `fold ${cls}${shut ? ' shut' : ''}`, ...attrs }, head, bodyEl);
  let settle = 0;
  const still = () => {
    clearTimeout(settle);
    node.classList.remove('moving');
  };
  const flip = () => {
    shut = !shut;
    node.classList.add('moving'); // đang co giãn: cắt phần tràn, hết co giãn thì bỏ để bóng của thẻ không bị cắt
    node.classList.toggle('shut', shut);
    btn.setAttribute('aria-expanded', String(!shut));
    btn.setAttribute('aria-label', shut ? 'Xổ ra' : 'Thu gọn');
    setShut(key, shut);
    // Người dùng tắt hiệu ứng chuyển động thì không có transitionend: tự thôi sau đúng thời gian co giãn.
    clearTimeout(settle);
    settle = setTimeout(still, 400);
  };
  bodyEl.addEventListener('transitionend', (e) => {
    if (e.target === bodyEl) still();
  });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    flip();
  });
  // Đầu của mục lớn: bấm vào đâu trên dòng cũng gập (trừ nút khác nằm trên dòng đó).
  if (wholeHead) head.addEventListener('click', (e) => { if (!e.target.closest('a, button')) flip(); });
  return node;
}

// ---- Phân loại ----------------------------------------------------------------------------------------
const sessionOnline = (s) => RUNNING.has(s.status) && store.machines.get(s.machineId)?.online !== false;

function groupOnline(g) {
  if (g.status === 'running' || g.status === 'paused') return true;
  const sessions = g.members.map((m) => store.sessions.get(m.id)).filter(Boolean);
  return sessions.some(sessionOnline) || (g.status === 'draft' && !sessions.length);
}

// Máy của nhóm: máy chạy phiên trưởng nhóm, không có thì máy của phiên đầu tiên còn trong danh sách.
function homeMachine(g) {
  const s = store.sessions.get(g.leaderId) || g.members.map((m) => store.sessions.get(m.id)).find(Boolean);
  return s?.machineId || '';
}

const byActivity = (a, b) => Number(b.status === 'waiting') - Number(a.status === 'waiting')
  || String(b.lastActivity || '').localeCompare(String(a.lastActivity || ''));
const byGroup = (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
  || String(b.createdAt).localeCompare(String(a.createdAt));

// Mỗi máy (kể cả máy chưa có phiên): nhóm đang chạy và đã dừng, phiên đang chạy và đã dừng (ngoài nhóm). loose: nhóm
// chưa có phiên nào trên máy nào.
export function collect() {
  const machines = new Map();
  const loose = [];
  const bucket = (id) => {
    if (!machines.has(id)) machines.set(id, { groupsOn: [], groupsOff: [], running: [], stopped: [] });
    return machines.get(id);
  };
  const grouped = new Set();
  for (const g of store.groups.values()) {
    for (const m of g.members) grouped.add(m.id);
    const mid = homeMachine(g);
    if (!mid) loose.push(g);
    else (groupOnline(g) ? bucket(mid).groupsOn : bucket(mid).groupsOff).push(g);
  }
  for (const s of store.sessions.values()) {
    if (!grouped.has(s.id)) (RUNNING.has(s.status) ? bucket(s.machineId).running : bucket(s.machineId).stopped).push(s);
  }
  for (const m of store.machines.values()) bucket(m.id);
  return { machines, loose };
}

// Máy trạm chưa biết (phiên của máy đã bị quên): dựng tạm từ tên máy ghi trong phiên.
function machineOf(id, items) {
  const m = store.machines.get(id);
  if (m) return m;
  const s = items.running[0] || items.stopped[0] || [...items.groupsOn, ...items.groupsOff].map((g) => store.sessions.get(g.leaderId)).find(Boolean);
  return { id, name: s?.machine || 'Máy không rõ', online: false, lastSeen: '', external: [], unknown: true };
}

// ---- Vẽ ---------------------------------------------------------------------------------------------
function groupMembers(g) {
  const list = g.members.map((m) => store.sessions.get(m.id)).filter(Boolean);
  return list.sort((a, b) => Number(b.id === g.leaderId) - Number(a.id === g.leaderId));
}

function groupBlock(g, homeId) {
  const done = g.tasks.filter((t) => t.status === 'done').length;
  const members = groupMembers(g);
  const head = h('a', { class: `team-head${isOpenGroup(g.id) ? ' current' : ''}`, href: `#/g/${g.id}` },
    icon('group', 16, 'team-icon'),
    h('span', { class: 'team-head-name' }, g.name),
    g.tasks.length || g.costTotal ? h('span', { class: 'team-head-count' }, [g.tasks.length ? `${done}/${g.tasks.length} việc` : '', g.costTotal ? `$${g.costTotal.toFixed(2)}` : ''].filter(Boolean).join(' · ')) : null,
    h('span', { class: 'pill' }, GROUP_STATUS[g.status] || g.status));
  const cards = members.length
    ? h('div', { class: 'cards' }, members.map((s) => sessionCard(s, { showMachine: s.machineId !== homeId })))
    : h('div', { class: 'team-drop-hint' }, icon('drag', 14), 'Kéo thẻ phiên thả vào đây');
  return fold(`g:${g.id}`, `tree-group team-${g.status}`, head,
    [h('div', { class: `tree-goal${g.goal ? '' : ' unset'}` }, g.goal || 'Chưa đặt mục tiêu'), cards],
    { attrs: { 'data-drop-group': g.id } });
}

// Lúc thấy máy lần cuối: timeAgo trả "vừa xong", "5 phút" hay một ngày tháng (quá một tuần).
function lastSeenText(iso) {
  const ago = timeAgo(iso);
  if (!ago) return '';
  if (ago === 'vừa xong') return 'vừa tắt';
  return /\d+\/\d+/.test(ago) ? `thấy lần cuối ${ago}` : `thấy ${ago} trước`;
}

// Phiên đang mở ngoài app (VS Code, terminal) trên máy: một dòng bấm được, mở màn xem phiên đó (chỉ đọc, từ đó tiếp
// tục hay tách nhánh ở app). Trước đây màn chính chỉ hiện con số "n ngoài app".
export function externalLine(machineId, t) {
  return h('a', { class: 'tree-ext', href: `#/x/${machineId}/${t.claudeSessionId}` },
    h('span', { class: 'status-dot' }),
    h('span', { class: 'tree-ext-name' }, t.title || '(chưa có câu hỏi)'),
    h('span', { class: 'tree-ext-meta' }, 'ngoài app'));
}

function machineBlock(m, items) {
  const running = [...items.running].sort(byActivity);
  const live = [...running, ...items.groupsOn.flatMap(groupMembers)];
  const stoppedCount = items.stopped.length + items.groupsOff.reduce((n, g) => n + groupMembers(g).length, 0);
  const waiting = live.filter((s) => s.status === 'waiting').length;
  const outside = m.online ? m.external || [] : [];
  const info = m.online
    ? [live.length ? `${live.length} đang chạy` : 'chưa có phiên chạy', outside.length ? `${outside.length} ngoài app` : '', stoppedCount ? `${stoppedCount} đã dừng` : ''].filter(Boolean).join(' · ')
    : ['đang tắt', lastSeenText(m.lastSeen), stoppedCount + live.length ? `${stoppedCount + live.length} phiên` : ''].filter(Boolean).join(' · ');
  const head = h(m.unknown ? 'span' : 'a', { class: `machine-label tree-machine${!m.unknown && isOpenMachine(m.id) ? ' current' : ''}`, ...(m.unknown ? {} : { href: `#/m/${m.id}` }) },
    h('span', { class: `mini-dot ${m.online ? 'on' : 'off'}` }),
    icon('machine', 15),
    h('span', { class: 'machine-label-name' }, m.name),
    waiting ? h('span', { class: 'machine-label-alert' }, icon('shield', 12), `${waiting} cần duyệt`) : null,
    h('span', { class: 'machine-label-count' }, info));
  const body = [];
  for (const g of [...items.groupsOn].sort(byGroup)) body.push(groupBlock(g, m.id));
  if (running.length) body.push(h('div', { class: 'cards' }, running.map((s) => sessionCard(s, { showMachine: false }))));
  if (outside.length) body.push(h('div', { class: 'tree-ext-list' }, outside.map((t) => externalLine(m.id, t))));
  if (m.online && !live.length) {
    body.push(h('div', { class: 'tree-empty' }, 'Chưa có phiên đang chạy.',
      h('button', { class: 'tree-empty-action', type: 'button', onclick: () => openNewSession({ machineId: m.id }) }, icon('plus', 13), 'Mở phiên')));
  }
  if (stoppedCount) {
    const stoppedBody = [
      ...[...items.groupsOff].sort(byGroup).map((g) => groupBlock(g, m.id)),
      items.stopped.length ? h('div', { class: 'cards' }, [...items.stopped].sort(byActivity).map((s) => sessionCard(s, { showMachine: false }))) : null,
    ];
    body.push(fold(`stopped:${m.id}`, 'tree-stopped', [h('span', { class: 'tree-stopped-title' }, 'Đã dừng'), h('span', { class: 'group-count' }, String(stoppedCount))],
      stoppedBody, { wholeHead: true, shutByDefault: true }));
  }
  if (m.online && !m.unknown) body.push(h('a', { class: 'tree-more', href: `#/m/${m.id}` }, 'Xem phiên cũ trên máy', icon('chevron', 13)));
  if (!body.length) body.push(h('div', { class: 'tree-empty' }, 'Không có phiên nào.'));
  return fold(`m:${m.id}`, `tree-machine-block${m.online ? '' : ' offline'}${waiting ? ' attention' : ''}`, head, body);
}

// Một mục lớn: các máy đang bật (online) hay đang tắt.
function labelBlock(online, entries, loose) {
  entries.sort(online
    ? (a, b) => Number(Boolean(b.m.local)) - Number(Boolean(a.m.local)) || a.m.name.localeCompare(b.m.name)
    : (a, b) => String(b.m.lastSeen || '').localeCompare(String(a.m.lastSeen || '')));
  const liveOf = (items) => items.running.length + items.groupsOn.reduce((k, g) => k + groupMembers(g).length, 0);
  const sessions = entries.reduce((n, e) => n + liveOf(e.items), 0);
  const waiting = online && entries.some((e) => e.items.running.some((s) => s.status === 'waiting') || e.items.groupsOn.some((g) => groupMembers(g).some((s) => s.status === 'waiting')));
  const head = [
    h('span', { class: `tree-label-dot ${online ? 'on' : 'off'}` }),
    h('span', { class: 'tree-label-title' }, online ? 'Đang bật' : 'Đang tắt'),
    h('span', { class: 'group-count' }, online ? `${entries.length} máy · ${sessions} phiên chạy` : `${entries.length} máy`),
    waiting ? h('span', { class: 'machine-label-alert' }, icon('shield', 12), 'cần duyệt') : null,
    h('span', { class: 'fold-spacer' }),
    online ? h('button', { class: 'title-action', type: 'button', onclick: () => openNewGroup() }, icon('plus', 14), 'Tạo nhóm') : null,
  ];
  const body = [];
  if (online && !store.groups.size && sessions) {
    body.push(h('button', { class: 'team-empty', type: 'button', onclick: () => openNewGroup() }, icon('group', 20),
      h('span', null, 'Gom nhiều phiên vào một nhóm, gán vai trò cho từng phiên, đặt mục tiêu chung rồi bấm Bắt đầu.')));
  }
  for (const g of [...loose].sort(byGroup)) body.push(groupBlock(g, ''));
  for (const { m, items } of entries) body.push(machineBlock(m, items));
  if (!entries.length && !loose.length) body.push(h('div', { class: 'tree-empty' }, 'Chưa có máy nào đang nối.'));
  return fold(`label:${online ? 'online' : 'offline'}`, `tree-label tree-${online ? 'online' : 'offline'}${waiting ? ' attention' : ''}`, head, body, { wholeHead: true });
}

export function homeTree() {
  const { machines, loose } = collect();
  const entries = [...machines.entries()].map(([id, items]) => ({ m: machineOf(id, items), items }));
  const on = entries.filter((e) => e.m.online);
  const off = entries.filter((e) => !e.m.online);
  // Không có máy nào đang tắt thì khỏi hiện mục đó.
  return h('div', { class: 'tree' }, labelBlock(true, on, loose), off.length ? labelBlock(false, off, []) : null);
}
