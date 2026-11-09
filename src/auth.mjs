// Ghép đôi thiết bị và kiểm thẻ truy cập.
//
// Trạm điều khiển được phiên Claude ở chế độ bỏ qua quyền, tức là ai vào được trạm thì
// chạy được lệnh trên máy. Vì vậy MỌI yêu cầu đều phải mang thẻ, kể cả yêu cầu tới từ
// 127.0.0.1: một bộ chuyển tiếp (reverse proxy) đặt trên chính máy này sẽ đưa yêu cầu từ ngoài
// tới dưới dạng 127.0.0.1, nên tin địa chỉ nội bộ là mở cửa cho cả mạng ngoài.
//
// Thẻ chỉ được lưu dưới dạng băm. Lộ file trạng thái thì cũng không dùng lại được thẻ.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { STATE_DIR, readStateJson, writeJsonAtomic } from './paths.mjs';

const AUTH_FILE = join(STATE_DIR, 'auth.json');
const PAIR_TTL_MS = 10 * 60 * 1000;
const PAIR_MAX_FAILS = 5; // đoán sai bấy nhiêu lần thì nơi gửi bị chặn PAIR_LOCK_MS (redeem)
const PAIR_LOCK_MS = 10 * 60 * 1000;
const PAIR_MAX_ACTIVE = 3;
const ENROLL_TTL_MS = 30 * 60 * 1000; // yêu cầu nối chưa ai duyệt thì tự hết hạn
const ENROLL_PICKUP_MS = 10 * 60 * 1000; // đã duyệt mà máy không tới lấy thẻ thì huỷ
const ENROLL_MAX_PENDING = 10;
const ENROLL_RATE_PER_MIN = 30; // chặn ai đó dội yêu cầu nối vào trạm

const hash = (token) => createHash('sha256').update(token).digest('hex');

export class Auth {
  constructor(file = AUTH_FILE) {
    this.file = file;
    // auth.json hỏng mà coi như trống thì mọi thiết bị và máy đã ghép thành "chưa ghép" (máy khác còn tự dừng 24 giờ):
    // cất bản hỏng, nạp bản dự phòng (paths.mjs readStateJson).
    const { value, from, corrupt } = readStateJson(file, { devices: [] });
    if (corrupt) console.error(`[trạm] ${file} hỏng, đã cất sang ${corrupt}; ${from === 'bak' ? 'nạp bản dự phòng .bak' : 'không có bản dự phòng: mọi thiết bị phải ghép lại'}.`);
    this.data = value && Array.isArray(value.devices) ? value : { devices: [] };
    this.byHash = new Map(this.data.devices.map((d) => [d.tokenHash, d]));
    this.pairCodes = new Map(); // mã -> thời điểm hết hạn
    this.pairFailsByIp = new Map(); // nơi gửi -> { count, until }: đoán sai mã ghép đôi
    this.lastSeenDirty = false;
    // Yêu cầu nối của máy mới: chỉ trong bộ nhớ, trạm khởi động lại thì máy tự gửi lại.
    this.enrollments = new Map();
    this.enrollTimes = [];
  }

  issue(name, kind, extra = {}) {
    const token = randomBytes(32).toString('base64url');
    const device = {
      id: randomBytes(6).toString('hex'),
      name: String(name || 'Thiết bị').slice(0, 60),
      kind,
      ...extra,
      tokenHash: hash(token),
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    this.data.devices.push(device);
    this.byHash.set(device.tokenHash, device);
    this.save();
    return { token, device };
  }

  save() {
    writeJsonAtomic(this.file, this.data, { backup: true });
  }

  prunePairCodes() {
    const now = Date.now();
    for (const [code, expires] of this.pairCodes) if (now > expires) this.pairCodes.delete(code);
  }

  // Vài mã cùng sống một lúc: run.cmd cần một mã cho trình duyệt máy này tự ghép và một mã
  // khác in ra cho điện thoại. Nếu chỉ giữ một mã thì mã in ra chính là mã trình duyệt vừa
  // dùng mất (đã gặp thật). Giữ tối đa PAIR_MAX_ACTIVE mã, mã cũ nhất bị bỏ trước.
  newPairCode() {
    this.prunePairCodes();
    while (this.pairCodes.size >= PAIR_MAX_ACTIVE) this.pairCodes.delete(this.pairCodes.keys().next().value);
    let code;
    do code = String(randomInt(0, 1_000_000)).padStart(6, '0'); while (this.pairCodes.has(code));
    this.pairCodes.set(code, Date.now() + PAIR_TTL_MS);
    return code;
  }

  // Đổi mã ghép đôi lấy một thẻ dài hạn. Mã dùng một lần: ghép xong là mã chết.
  // ip: nơi gửi yêu cầu. Đoán sai PAIR_MAX_FAILS lần thì chỉ nơi đó bị chặn PAIR_LOCK_MS (trước đây là xoá mọi mã
  // đang sống: bất kỳ ai trên cùng mạng gõ sai năm lần là chặn được việc ghép của chủ máy, mãi mãi).
  // extra: trường gắn thêm vào thẻ (thẻ của máy chạy phiên mang machineId của máy đó).
  redeem(code, name, kind = 'device', { ip = '', extra = {} } = {}) {
    this.prunePairCodes();
    const now = Date.now();
    const key = String(ip || '?');
    let fails = this.pairFailsByIp.get(key);
    if (fails?.until && fails.until <= now) fails = null; // hết hạn chặn: đếm lại từ đầu
    if (fails?.until) return { error: 'Sai mã quá nhiều lần. Thử lại sau ít phút.' };
    if (!this.pairCodes.size) return { error: 'Mã ghép đôi đã hết hạn. Lấy mã mới trên máy tính.' };
    const given = String(code || '').replace(/\D/g, '');
    if (!this.pairCodes.has(given)) {
      const count = (fails?.count || 0) + 1;
      this.pairFailsByIp.set(key, { count, until: count >= PAIR_MAX_FAILS ? now + PAIR_LOCK_MS : 0 });
      if (this.pairFailsByIp.size > 1000) this.pairFailsByIp.delete(this.pairFailsByIp.keys().next().value);
      return { error: 'Sai mã ghép đôi.' };
    }
    this.pairCodes.delete(given);
    this.pairFailsByIp.delete(key);
    const { token, device } = this.issue(name, kind, extra);
    return { token, device: publicDevice(device) };
  }

  // ---- Máy mới xin nối, người dùng duyệt trên app --------------------------------
  pruneEnrollments() {
    const now = Date.now();
    for (const [id, e] of this.enrollments) {
      const ttl = e.status === 'pending' ? ENROLL_TTL_MS : ENROLL_PICKUP_MS;
      if (now - e.updatedAt > ttl) this.enrollments.delete(id);
    }
  }

  requestEnroll({ machineId, name, platform, ip }) {
    const now = Date.now();
    this.enrollTimes = this.enrollTimes.filter((t) => now - t < 60000);
    if (this.enrollTimes.length >= ENROLL_RATE_PER_MIN) return { error: 'Quá nhiều yêu cầu nối, thử lại sau.' };
    this.enrollTimes.push(now);
    this.pruneEnrollments();
    const mid = String(machineId || '').slice(0, 40);
    if (!/^[\w-]{4,40}$/.test(mid)) return { error: 'Mã máy không hợp lệ.' };
    // Một máy chỉ giữ một yêu cầu: gửi lại thì thay yêu cầu cũ.
    for (const [id, e] of this.enrollments) if (e.machineId === mid && e.status === 'pending') this.enrollments.delete(id);
    if ([...this.enrollments.values()].filter((e) => e.status === 'pending').length >= ENROLL_MAX_PENDING) {
      return { error: 'Đang có quá nhiều máy chờ duyệt.' };
    }
    const entry = {
      requestId: randomBytes(8).toString('hex'),
      pollSecret: randomBytes(24).toString('base64url'),
      machineId: mid,
      name: String(name || 'Máy tính').slice(0, 60),
      platform: String(platform || '').slice(0, 20),
      ip: String(ip || '').slice(0, 60),
      at: new Date(now).toISOString(),
      updatedAt: now,
      status: 'pending',
      token: null,
      // Mã xác nhận: máy xin nối in ra màn của nó, thẻ trên app hiện cùng mã. Tên và địa chỉ IP trên thẻ do bên xin
      // tự khai nên giả được; mã này thì chỉ đúng máy đã gửi yêu cầu mới biết.
      code: String(randomInt(0, 10000)).padStart(4, '0'),
    };
    this.enrollments.set(entry.requestId, entry);
    return { requestId: entry.requestId, pollSecret: entry.pollSecret, code: entry.code };
  }

  pollEnroll(requestId, secret) {
    this.pruneEnrollments();
    const e = this.enrollments.get(requestId);
    if (!e) return { status: 'expired' };
    const given = Buffer.from(String(secret || ''));
    const want = Buffer.from(e.pollSecret);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return { status: 'expired' };
    if (e.status === 'approved') {
      // Thẻ chỉ trao đúng một lần rồi xoá khỏi bộ nhớ.
      this.enrollments.delete(requestId);
      return { status: 'approved', token: e.token };
    }
    if (e.status === 'rejected') this.enrollments.delete(requestId);
    return { status: e.status };
  }

  decideEnroll(requestId, approve) {
    const e = this.enrollments.get(requestId);
    if (!e || e.status !== 'pending') return null;
    e.updatedAt = Date.now();
    if (!approve) {
      e.status = 'rejected';
      return e;
    }
    // Máy xin nối lại (mất thẻ cũ) thì thu hồi thẻ cũ của chính máy đó.
    this.revokeMachine(e.machineId, false);
    const { token } = this.issue(e.name, 'node', { machineId: e.machineId });
    e.status = 'approved';
    e.token = token;
    return e;
  }

  pendingEnrollments() {
    this.pruneEnrollments();
    return [...this.enrollments.values()]
      .filter((e) => e.status === 'pending')
      .map(({ requestId, machineId, name, platform, ip, at, code }) => ({ requestId, machineId, name, platform, ip, at, code }));
  }

  revokeMachine(machineId, persist = true) {
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter((d) => !(d.kind === 'node' && d.machineId === machineId));
    if (this.data.devices.length === before) return false;
    this.byHash = new Map(this.data.devices.map((d) => [d.tokenHash, d]));
    if (persist) this.save();
    return true;
  }

  check(token, kind) {
    if (!token) return null;
    const device = this.byHash.get(hash(token));
    if (!device || (kind && device.kind !== kind)) return null;
    device.lastSeen = new Date().toISOString();
    this.lastSeenDirty = true;
    return device;
  }

  list() {
    return this.data.devices.map(publicDevice);
  }

  revoke(id) {
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter((d) => d.id !== id);
    if (this.data.devices.length === before) return false;
    this.byHash = new Map(this.data.devices.map((d) => [d.tokenHash, d]));
    this.save();
    return true;
  }

  // Ghi lần thấy cuối theo lô, không ghi đĩa ở mỗi yêu cầu.
  // Chạy từ bộ hẹn giờ mỗi phút: lỗi ghi đĩa ở đây không được làm sập trạm, để lần sau ghi lại.
  flushLastSeen() {
    if (!this.lastSeenDirty) return;
    try {
      this.save();
      this.lastSeenDirty = false;
    } catch (err) {
      console.error(`[trạm] không lưu được ${this.file}: ${err.message}. Thử lại sau.`);
    }
  }
}

function publicDevice(d) {
  return { id: d.id, name: d.name, kind: d.kind, machineId: d.machineId, createdAt: d.createdAt, lastSeen: d.lastSeen };
}
