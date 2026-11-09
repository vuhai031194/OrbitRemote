// Phiên đang chờ duyệt ở bất kỳ máy nào (app.js trackWaiting dựng nút nổi "Cần duyệt" từ đây).
// hash: địa chỉ màn đang mở. Phiên đang mở đúng trên màn này thì không cần nhắc nữa.
// Trả { total: số phiên chờ duyệt, target: phiên chờ lâu nhất mà không phải phiên đang mở, text: chữ trên nút }.
export function waitingSummary(sessions, hash) {
  const here = /^#\/s\/([\w-]+)/.exec(hash || '')?.[1];
  const waiting = [...sessions].filter((s) => s.status === 'waiting')
    .sort((a, b) => String(a.lastActivity || '').localeCompare(String(b.lastActivity || '')));
  const others = waiting.filter((s) => s.id !== here);
  return {
    total: waiting.length,
    target: others[0] || null,
    text: !others.length ? '' : others.length === 1 ? `${others[0].name} cần duyệt` : `${others.length} phiên cần duyệt`,
  };
}
