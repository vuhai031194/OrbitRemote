// Danh tính của trạm: một cặp khoá Ed25519 nằm trong thư mục trạng thái của máy giữ trạm.
//
// Máy chạy phiên ghim khoá công khai của trạm lúc được duyệt nối (hay lần đầu nối tới trạm bản có danh tính), rồi
// trước khi gửi thẻ của nó tới bất kỳ địa chỉ nào thì bắt bên kia ký một số ngẫu nhiên (checkHub). Nhờ vậy một máy
// lạ trên cùng mạng trả lời việc dò trạm (UDP, hay /api/ping, đều không cần thẻ) không lấy được thẻ, nên không đóng
// vai trạm để sai máy chạy lệnh được.
//
// Giới hạn: đường nối là HTTP trần. Kẻ đứng giữa đường và chuyển tiếp nguyên văn tới trạm thật thì vẫn qua được bước
// ký; chống được việc đó cần TLS (tailscale serve), là việc riêng.

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { readStateJson, writeJsonAtomic } from './paths.mjs';

const challenge = (hubId, nonce) => Buffer.from(`orbit-remote-hub:${hubId}:${nonce}`);
export const NONCE = /^[0-9a-f]{32,64}$/;

function keyFrom(data) {
  const priv = createPrivateKey(data.privateKey);
  // Khoá công khai tính lại từ khoá riêng, khỏi tin phần công khai ghi trong file.
  const publicKey = createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('base64');
  return { publicKey, sign: (hubId, nonce) => sign(null, challenge(hubId, nonce), priv).toString('base64') };
}

// Đọc khoá của trạm, chưa có (hay hỏng) thì tạo mới. Tạo mới là đổi danh tính: máy đã ghim khoá cũ sẽ không nối
// được nữa cho tới khi xin nối lại, nên chỉ tạo khi thật sự chưa có khoá dùng được.
export function loadHubKey(file) {
  const { value: saved } = readStateJson(file, null); // file hỏng thì nạp bản dự phòng .bak, không đổi danh tính
  if (saved?.privateKey) {
    try {
      return keyFrom(saved);
    } catch {
      // khoá hỏng: tạo mới bên dưới
    }
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  const data = { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), createdAt: new Date().toISOString() };
  // Khoá chỉ ghi một lần nên tự ghi luôn bản dự phòng (writeJsonAtomic chỉ giữ .bak khi có bản cũ để giữ).
  writeJsonAtomic(file, data);
  writeJsonAtomic(`${file}.bak`, data);
  return keyFrom(data);
}

export function verifyHub(publicKey, hubId, nonce, sig) {
  try {
    const key = createPublicKey({ key: Buffer.from(String(publicKey), 'base64'), format: 'der', type: 'spki' });
    return verify(null, challenge(hubId, nonce), key, Buffer.from(String(sig), 'base64'));
  } catch {
    return false;
  }
}

// Máy chạy phiên hỏi địa chỉ `url` có đúng là trạm `hubId` (khoá đã ghim `hubKey`) không, trước khi gửi thẻ.
// Trả { ok: true, key } khi bên kia ký đúng; { ok: true, legacy: true } khi chưa ghim khoá mà bên kia là trạm bản cũ
// (chưa có danh tính: chỉ chấp nhận khi chưa ghim, để nâng cấp từ từ); không thì { ok: false, reason }.
export async function checkHub(url, { hubId, hubKey }, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const nonce = randomBytes(16).toString('hex');
  let res;
  try {
    res = await fetchImpl(new URL(`/api/identity?nonce=${nonce}`, url), { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (res.status === 404 || res.status === 401) return hubKey ? { ok: false, reason: 'mismatch' } : { ok: true, legacy: true };
  const id = await res.json().catch(() => null);
  if (!id || typeof id.key !== 'string' || id.hubId !== hubId) return { ok: false, reason: 'mismatch' };
  if (hubKey && id.key !== hubKey) return { ok: false, reason: 'mismatch' };
  if (!verifyHub(id.key, hubId, nonce, id.sig)) return { ok: false, reason: 'mismatch' };
  return { ok: true, key: id.key };
}

export const newNonce = () => randomBytes(16).toString('hex');
