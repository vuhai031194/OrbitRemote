// Đường nối của một đầu máy đứng riêng (máy không giữ trạm) về trạm qua mạng.
//
// Đầu máy luôn là bên chủ động gọi ra: một luồng SSE dài để nhận lệnh, cộng các POST gộp
// lô để báo sự kiện. Nhờ vậy máy này không phải mở cổng nào, chỉ cần với tới được trạm
// (cùng mạng nhà, hoặc qua địa chỉ HTTPS công khai của trạm).
//
// `connectOnce` chạy đúng một lần nối và trả về lý do kết thúc. Việc thử lại, dò lại trạm
// khi trạm đổi địa chỉ, hay xin nối lại khi bị thu hồi thẻ là của vòng ngoài (node-runner.mjs).

const FLUSH_MS = 40;
const BATCH_MAX = 200;
// Một lô POST không vượt chừng này (đo bằng độ dài chuỗi JSON): khúc tệp đính kèm ~700 KB mỗi tin, vài
// lượt xem song song dồn vào một lô thì vượt giới hạn 1 MB mà trạm bản cũ nhận, làm đứt đường nối.
const BATCH_CHARS = 768 * 1024;
// Trạm gửi ping mỗi 20 giây trên luồng này. Quá chừng này không nhận được gì thì đường nối đã chết lặng (mạng
// đổi, máy ngủ dậy): dựng lại ngay, đừng chờ fetch tự hết giờ sau vài phút.
export const LINK_SILENCE_MS = 60000;

// Trả về { reason: 'closed' | 'unauthorized' | 'unreachable', linked: boolean }.
// Tin chưa chắc tới trạm khi đường nối đứt (lô đang gửi dở, hàng đợi) được trả lại cho agent.requeue theo đúng
// thứ tự, để lần nối sau gửi bù; trạm bỏ tin trùng theo mã eid (hub.mjs).
export async function connectOnce(agent, { hubUrl, token, log = () => {}, signal, silenceMs = LINK_SILENCE_MS }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });

  let res;
  try {
    res = await fetch(new URL('/node/link', hubUrl), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
  } catch {
    signal?.removeEventListener('abort', abort);
    return { reason: 'unreachable', linked: false };
  }
  if (res.status === 401) return { reason: 'unauthorized', linked: false };
  if (!res.ok || !res.body) return { reason: 'unreachable', linked: false };

  let linkId = null;
  const queue = [];
  let timer = null;
  let inFlight = false; // mỗi lúc chỉ một lô đang gửi: giữ đúng thứ tự, và biết chắc tin nào đã tới
  let dead = false;

  // Tin chỉ rời hàng đợi khi trạm đã nhận lô chứa nó. Gửi hỏng thì để nguyên và dựng lại đường nối; tin còn lại
  // được trả cho agent ở `finally`.
  const flush = () => {
    timer = null;
    if (inFlight || dead || !queue.length || !linkId) return;
    // Luôn lấy ít nhất một tin, kể cả khi riêng nó đã quá BATCH_CHARS.
    const parts = [];
    let chars = 0;
    for (let i = 0; i < queue.length && parts.length < BATCH_MAX; i += 1) {
      const text = JSON.stringify(queue[i]);
      if (parts.length && chars + text.length > BATCH_CHARS) break;
      parts.push(text);
      chars += text.length;
    }
    inFlight = true;
    fetch(new URL('/node/push', hubUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Orbit-Link': linkId },
      body: `[${parts.join(',')}]`,
      signal: controller.signal,
    }).then((r) => {
      if (!r.ok) throw new Error(`trạm trả ${r.status}`);
      queue.splice(0, parts.length);
      inFlight = false;
      if (queue.length && !timer) timer = setTimeout(flush, 0);
    }).catch(() => {
      dead = true; // đường nối đã đứt phía trạm: dựng lại từ đầu
      controller.abort();
    });
  };
  const send = (message) => {
    queue.push(message);
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  };
  let heard = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - heard > silenceMs) controller.abort();
  }, Math.min(15000, Math.max(50, silenceMs / 4)));
  watchdog.unref?.();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      heard = Date.now();
      buffer += decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        let message;
        try {
          message = JSON.parse(data);
        } catch {
          continue;
        }
        if (message.op === 'linked') {
          linkId = message.linkId;
          agent.hubUrl = hubUrl; // địa chỉ trạm đang nối được, cho cổng mở app trên máy này (app-proxy.mjs)
          agent.attach(send);
          log(`Đã nối tới trạm ${hubUrl}`);
        } else {
          agent.handle(message);
        }
      }
    }
  } catch {
    // bị huỷ hoặc rớt mạng giữa chừng
  } finally {
    clearInterval(watchdog);
    if (timer) clearTimeout(timer);
    dead = true;
    controller.abort(); // luồng tự hết (trạm đóng): huỷ luôn lô đang gửi dở, coi như chưa tới
    if (linkId) agent.detach();
    // Lô đang gửi dở có thể đã tới trạm mà mất câu trả lời: vẫn trả lại, trạm bỏ bản trùng theo eid.
    if (queue.length) agent.requeue?.(queue.splice(0));
    signal?.removeEventListener('abort', abort);
  }
  return { reason: 'closed', linked: Boolean(linkId) };
}
