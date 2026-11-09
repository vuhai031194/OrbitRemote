// Phân loại địa chỉ IPv4: mạng nhà (địa chỉ nội bộ chuẩn) hay dải 100.64.0.0/10 mà Tailscale dùng.

function inRange(ip, base, bits) {
  const toInt = (s) => s.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}

export const isCgnat = (ip) => inRange(ip, '100.64.0.0', 10);
export const isPrivate = (ip) => inRange(ip, '10.0.0.0', 8) || inRange(ip, '172.16.0.0', 12) || inRange(ip, '192.168.0.0', 16);

// Chống DNS rebinding: một trang web lạ (đang mở trong trình duyệt của người dùng) trỏ tên miền của nó về
// 127.0.0.1 hay IP của trạm rồi gọi API như thể cùng nguồn. Trình duyệt vẫn gửi Host là tên miền lạ đó, nên chỉ
// nhận Host là IP trần, localhost, hay một tên trong `names` (tên của chính trạm: địa chỉ đã khai, tên Tailscale,
// tên máy). Thiếu Host (HTTP/1.0, công cụ dòng lệnh) thì không phải trình duyệt: cho qua.
export function hostAllowed(host, names = new Set(), { loopbackOnly = false } = {}) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return true;
  const name = h.startsWith('[') ? h.slice(1, h.indexOf(']')) : h.replace(/:\d*$/, '');
  if (loopbackOnly) return name === 'localhost' || name === '127.0.0.1' || name === '::1';
  if (name === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || (h.startsWith('[') && name.includes(':'))) return true;
  return names.has(name.replace(/\.$/, ''));
}

// Tên (không kèm cổng) lấy từ danh sách địa chỉ dạng URL.
export function hostNamesOf(urls) {
  const out = new Set();
  for (const u of urls || []) {
    try {
      out.add(new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, ''));
    } catch {
      // không phải URL
    }
  }
  return out;
}
