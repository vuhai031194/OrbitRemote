// Gọi API của trạm. Thẻ truy cập nằm trong cookie HttpOnly nên mã ở đây không bao giờ
// chạm vào nó; chỉ cần gửi kèm cookie cùng nguồn.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Thời hạn chờ một câu trả lời. Dài hơn mọi việc trạm tự chờ máy (lệnh thường 20 giây, bật Remote Control 70 giây),
// để chỉ cắt khi đường tới trạm thật sự treo, không cắt ngang một việc dài đang chạy.
export const TIMEOUT_MS = 95000;
export const OFFLINE_TEXT = 'Không với tới trạm. Kiểm tra mạng (hay Tailscale) rồi thử lại.';
export const TIMEOUT_TEXT = 'Trạm không trả lời kịp. Thử lại sau ít phút.';

async function call(method, path, body) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
  let res;
  let data = null;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl?.signal,
    });
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  } catch {
    // Lỗi của trình duyệt ("Failed to fetch", "Load failed") chẳng nói được gì với người dùng.
    if (!res) throw new ApiError(0, ctrl?.signal.aborted ? TIMEOUT_TEXT : OFFLINE_TEXT);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent('orbit:unpaired'));
    throw new ApiError(res.status, data?.error || `Trạm trả mã ${res.status}.`);
  }
  return data;
}

export const api = {
  get: (path) => call('GET', path),
  post: (path, body = {}) => call('POST', path, body),
  put: (path, body = {}) => call('PUT', path, body),
};
