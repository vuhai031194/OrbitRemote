// Thông báo của trình duyệt khi một phiên cần duyệt hay vừa xong lượt, lúc cửa sổ app không được xem (để làm việc
// khác mà vẫn biết). Trình duyệt chỉ cho thông báo ở trang an toàn: bản PC (127.0.0.1) được; điện thoại mở trạm qua
// http://<IP> thì không (cần HTTPS). Người dùng bật trong Cài đặt; tắt được, nhớ trên trình duyệt này.

const KEY = 'orbit-notify';

export function notifySupported() {
  return typeof Notification === 'function' && Boolean(globalThis.isSecureContext);
}

export function notifyEnabled() {
  if (!notifySupported() || Notification.permission !== 'granted') return false;
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setNotifyOff(off) {
  try {
    if (off) localStorage.setItem(KEY, 'off');
    else localStorage.removeItem(KEY);
  } catch {
    // trình duyệt chặn lưu
  }
}

// Có nên báo không, theo trạng thái trước và bây giờ của một phiên (null: không báo).
export function notifyReason(prev, s) {
  if (!prev || prev === s.status) return null;
  if (s.status === 'waiting') return { title: `${s.name} cần duyệt`, body: 'Mở để cho phép hay từ chối.' };
  if (prev === 'busy' && s.status === 'idle') return { title: `${s.name} đã xong lượt`, body: String(s.lastText || '').slice(0, 140) };
  return null;
}

// Theo dõi trạng thái các phiên trong store, báo khi cần. show: thay được trong phép kiểm.
export function trackNotifications(store, { show = showNotification, visible = () => document.visibilityState === 'visible' && document.hasFocus?.() !== false } = {}) {
  const last = new Map();
  const seed = () => {
    for (const s of store.sessions.values()) last.set(s.id, s.status);
  };
  seed();
  store.on('state', seed); // nạp lại cả danh sách (nối lại): chỉ ghi nhận, không báo dồn
  store.on('session', (s) => {
    const prev = last.get(s.id);
    last.set(s.id, s.status);
    const why = notifyReason(prev, s);
    if (why && notifyEnabled() && !visible()) show(why, s.id);
  });
}

function showNotification({ title, body }, id) {
  try {
    const n = new Notification(title, { body, tag: `orbit-${id}`, icon: '/icons/icon-192.png' });
    n.onclick = () => {
      window.focus();
      location.hash = `#/s/${id}`;
      n.close();
    };
  } catch {
    // trình duyệt từ chối: thôi
  }
}
