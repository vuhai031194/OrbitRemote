// Tìm phiên ở màn chính (home.js): theo tên, thư mục làm việc, tên máy và câu trả lời gần nhất; không phân biệt hoa
// thường hay dấu tiếng Việt ("sua loi" khớp "Sửa lỗi"); mỗi từ gõ vào đều phải có mặt. Gồm phiên app giữ và phiên
// đang mở ngoài app (VS Code, terminal). Phiên cũ đã đóng nằm ở màn của máy (đọc từ nhật ký trên máy).

import { fold } from './mention-core.js';

const RUNNING = new Set(['starting', 'idle', 'busy', 'waiting']);

// sessions, machines: Map như store. Trả [{ kind: 'app', s } | { kind: 'external', t, machineId }]: phiên đang chạy
// trước, rồi mới hoạt động gần nhất.
export function searchSessions(query, sessions, machines) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hit = (...parts) => {
    const hay = fold(parts.filter(Boolean).join(' '));
    return words.every((w) => hay.includes(w));
  };
  const out = [];
  for (const s of sessions.values()) {
    const m = machines.get(s.machineId);
    if (hit(s.name, s.cwd, s.remote?.cwd, s.machine, m?.name, s.lastText)) out.push({ kind: 'app', s, at: s.lastActivity || '', live: RUNNING.has(s.status) });
  }
  const held = new Set([...sessions.values()].map((s) => s.claudeSessionId).filter(Boolean));
  for (const m of machines.values()) {
    for (const t of m.online ? m.external || [] : []) {
      if (held.has(t.claudeSessionId)) continue;
      if (hit(t.title, t.cwd, m.name)) out.push({ kind: 'external', t, machineId: m.id, at: t.modified || '', live: true });
    }
  }
  return out.sort((a, b) => Number(b.live) - Number(a.live) || String(b.at).localeCompare(String(a.at)));
}
