// Xem và bấm màn khoá (màn đăng nhập) và hộp thoại UAC từ app, qua chương trình win-secure.cs chạy bằng
// quyền SYSTEM trong phiên đang ngồi trước máy. Đầu máy (quyền người dùng) không làm được việc này: Windows
// không cho chương trình thường quay hay bấm vào màn bảo mật.
//
// Cài một lần bằng setup.cmd tại máy (một hộp thoại UAC, bước "secure-desk"):
//   - chương trình được dịch rồi chép vào C:\ProgramData\OrbitRemote, thư mục chỉ SYSTEM và Administrators
//     ghi được (phần mềm chạy bằng quyền thường không tráo được tệp sẽ chạy bằng quyền SYSTEM);
//   - khoá bí mật ngẫu nhiên ở secure.key cạnh chương trình, chỉ SYSTEM, Administrators và đúng người cài
//     đọc được: chương trình chỉ phục vụ ai đưa đúng khoá, và chỉ nghe 127.0.0.1;
//   - tác vụ "Orbit Remote Secure Desktop" của Task Scheduler chạy "orbit-secure.exe serve" bằng quyền
//     SYSTEM mỗi lần bật máy.
// Chương trình chỉ nhận số và một tập lệnh cố định (chụp, bấm), không chạy chương trình nào khác.

import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { isGrantKey } from './hub-identity.mjs';
import { join } from 'node:path';
import { STATE_DIR, TOOL_DIR, ensureDir } from './paths.mjs';

// Cổng của riêng chương trình này: 8795 trạm, 8796 màn hình, 8797 app PC, 8798 chương trình đo nhiệt độ
// (sensors.mjs), 8799 chương trình màn khoá. Hai chương trình trùng cổng thì cái chạy sau không nghe được.
export const SECURE_PORT = Number(process.env.ORBIT_REMOTE_SECURE_PORT) || 8799;
export const SECURE_DIR = join(process.env.ProgramData || 'C:\\ProgramData', 'OrbitRemote');
export const SECURE_EXE = join(SECURE_DIR, 'orbit-secure.exe');
export const SECURE_KEY = process.env.ORBIT_REMOTE_SECURE_KEY || join(SECURE_DIR, 'secure.key');
export const SECURE_TASK = 'Orbit Remote Secure Desktop';
// Một chuỗi của PowerShell: nháy đơn, nháy đơn bên trong nhân đôi.
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const SOURCE = join(TOOL_DIR, 'src', 'win-secure.cs');
const CSC = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

// Khoá công khai cấp quyền bấm của trạm, đầu máy nhận qua đường nối đã xác thực (node-agent.mjs "hub_keys"); setup
// chép nó vào thư mục của chương trình SYSTEM (grant.pub), kèm mã máy (machine.id).
export const GRANT_PUB_STATE = join(STATE_DIR, 'secure-grant.pub');
const SECURE_GRANT_PUB = join(SECURE_DIR, 'grant.pub');
const SECURE_MACHINE_ID = join(SECURE_DIR, 'machine.id');

// Dịch win-secure.cs vào thư mục trạng thái (tên theo dấu mã nguồn); trả về đường dẫn tệp .exe.
// fresh: xoá bản đã dịch rồi dịch lại (lúc cài): thư mục trạng thái người dùng ghi được, tệp trùng tên có sẵn ở đó
// có thể là tệp ai đó đặt vào để được chép đi chạy bằng quyền SYSTEM. Kiểm tra trạng thái thì dùng bản có sẵn.
export function buildSecureExe({ fresh = false } = {}) {
  const tag = createHash('sha256').update(readFileSync(SOURCE)).digest('hex').slice(0, 12);
  const out = join(ensureDir(join(STATE_DIR, 'bin')), `orbit-secure-${tag}.exe`);
  if (fresh) rmSync(out, { force: true });
  if (existsSync(out)) return out;
  if (!existsSync(CSC)) throw new Error('Máy này thiếu csc.exe của .NET Framework 4.');
  const r = spawnSync(CSC, ['-nologo', '-optimize+', '-platform:x64', '-target:exe', '-r:System.Drawing.dll', `-out:${out}`, SOURCE], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(out)) throw new Error(`Dịch win-secure.cs không được: ${(r.stdout || r.stderr || '').trim().slice(0, 400)}`);
  return out;
}

export const fileHash = (file) => {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
};

function readKey() {
  try {
    return readFileSync(SECURE_KEY, 'utf8').trim();
  } catch {
    return '';
  }
}

// Một kết nối đã xác thực, gửi một lệnh. Trả về socket (dữ liệu trả lời đọc tiếp ở nơi gọi).
function open(command, { timeoutMs = 3000 } = {}) {
  const key = readKey();
  if (!key) return Promise.reject(new Error('Chưa cài phần xem màn khoá (secure.key không đọc được).'));
  return new Promise((resolve, reject) => {
    const s = net.connect(SECURE_PORT, '127.0.0.1');
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error('Phần xem màn khoá không trả lời.'));
    }, timeoutMs);
    s.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    s.once('connect', () => {
      clearTimeout(timer);
      s.setNoDelay(true);
      s.write(`auth ${key}\n${command}\n`);
      resolve(s);
    });
  });
}

// Đọc đúng một dòng trả lời, rồi phần còn lại để nơi gọi đọc tiếp.
function readLine(s, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error('Phần xem màn khoá không trả lời.')), timeoutMs);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const at = buf.indexOf(10);
      if (at >= 0) done(null, buf.subarray(0, at).toString('ascii').trim(), buf.subarray(at + 1));
    };
    const onClose = () => done(new Error('Phần xem màn khoá đóng kết nối (khoá sai hay chưa cài).'));
    function done(err, line, rest) {
      clearTimeout(timer);
      s.off('data', onData);
      s.off('close', onClose);
      if (err) reject(err);
      else resolve({ line, rest });
    }
    s.on('data', onData);
    s.on('close', onClose);
  });
}

// Phần xem màn khoá đã cài và đang chạy trên máy này.
export async function secureAvailable() {
  if (process.platform !== 'win32' || !existsSync(SECURE_KEY)) return false;
  try {
    const s = await open('ping', { timeoutMs: 1500 });
    const { line } = await readLine(s, 1500);
    s.destroy();
    return line === 'pong';
  } catch {
    return false;
  }
}

// Chụp vùng (x, y, w, h) của màn đang nhận phím chuột (kể cả màn khoá), ảnh JPEG ow x oh. onJpeg nhận
// từng ảnh; onEnd khi luồng dừng (máy dừng chương trình, kết nối đứt). Trả về { stop }.
export async function startSecureCapture({ x, y, w, h, ow, oh, fps = 8, quality = 70 }, onJpeg, onEnd = () => {}) {
  const n = (v) => Math.round(Number(v) || 0);
  const s = await open(`cap ${n(x)} ${n(y)} ${n(w)} ${n(h)} ${n(ow)} ${n(oh)} ${n(fps)} ${n(quality)}`);
  const { line, rest } = await readLine(s);
  if (line !== 'ok') {
    s.destroy();
    throw new Error(`Phần xem màn khoá từ chối chụp: ${line}`);
  }
  let buf = rest;
  let stopped = false;
  const drain = () => {
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len > 16 * 1024 * 1024) {
        s.destroy();
        return;
      }
      if (buf.length < 4 + len) return;
      onJpeg(Buffer.from(buf.subarray(4, 4 + len)));
      buf = buf.subarray(4 + len);
    }
  };
  s.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    drain();
  });
  s.on('close', () => { if (!stopped) onEnd(); });
  s.on('error', () => {});
  drain();
  return {
    stop() {
      stopped = true;
      s.destroy();
    },
  };
}

// Kênh bấm vào màn đang nhận phím chuột: send(lệnh như win-input.cs). Trả về { send, close }.
export async function openSecureInput() {
  const s = await open('in');
  const { line } = await readLine(s);
  if (line !== 'ok') {
    s.destroy();
    throw new Error(`Phần xem màn khoá từ chối kênh bấm: ${line}`);
  }
  s.on('error', () => {});
  return {
    send(command) {
      if (!s.destroyed) s.write(`${command}\n`);
    },
    close() {
      s.destroy();
    },
  };
}

// Kịch bản PowerShell chạy bằng quyền quản trị (setup.mjs, một hộp thoại UAC): chép chương trình vào thư
// mục chỉ quản trị viên ghi được, tạo khoá bí mật chỉ SYSTEM, Administrators và người cài (sid) đọc được,
// đăng ký tác vụ SYSTEM chạy lúc bật máy rồi chạy ngay. Chạy lại là cập nhật (dừng tác vụ, chép bản mới).
// exeHash: SHA256 của bản vừa dịch; kiểm lại trên tệp đã chép vào thư mục chỉ quản trị viên ghi được, nên không ai
// tráo được giữa lúc kiểm và lúc chạy. grantKey, machineId: khoá công khai cấp quyền của trạm và mã máy này
// (win-secure.cs chỉ nhận lệnh bấm khi có quyền trạm ký cho đúng máy này).
export function installScript({ exePath, userSid, exeHash, grantKey, machineId }) {
  if (!/^S-1-[\d-]+$/.test(userSid)) throw new Error(`Mã tài khoản lạ: ${userSid}`);
  if (!/^[0-9a-f]{64}$/i.test(String(exeHash))) throw new Error('Thiếu mã băm của chương trình vừa dịch.');
  if (!isGrantKey(grantKey)) throw new Error('Thiếu khoá cấp quyền của trạm.');
  if (!/^[\w-]{4,40}$/.test(String(machineId))) throw new Error('Mã máy không hợp lệ.');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$dir = ${q(SECURE_DIR)}`,
    `$task = ${q(SECURE_TASK)}`,
    'Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue',
    "Get-Process orbit-secure -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
    'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
    // Thư mục: bỏ quyền thừa kế, chỉ SYSTEM và Administrators toàn quyền, Users chỉ đọc và chạy.
    'icacls $dir /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-32-545:(OI)(CI)RX" | Out-Null',
    "if ($LASTEXITCODE) { throw 'Không đặt được quyền cho thư mục.' }",
    "$dst = Join-Path $dir 'orbit-secure.exe'",
    `Copy-Item -Force -LiteralPath ${q(exePath)} -Destination $dst`,
    `if ((Get-FileHash -Algorithm SHA256 -LiteralPath $dst).Hash -ne ${q(String(exeHash).toUpperCase())}) { Remove-Item -Force -LiteralPath $dst; throw 'Chương trình vừa chép không khớp bản vừa dịch (có thể đã bị tráo): dừng cài.' }`,
    `[IO.File]::WriteAllText((Join-Path $dir 'grant.pub'), ${q(grantKey)})`,
    `[IO.File]::WriteAllText((Join-Path $dir 'machine.id'), ${q(machineId)})`,
    "$key = Join-Path $dir 'secure.key'",
    'if (-not (Test-Path $key)) { $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [IO.File]::WriteAllText($key, (($b | ForEach-Object { $_.ToString(\'x2\') }) -join \'\')) }',
    // Khoá: chỉ SYSTEM, Administrators (toàn quyền) và người cài (đọc); Users không đọc được.
    `icacls $key /inheritance:r /grant:r "*S-1-5-18:F" "*S-1-5-32-544:F" "*${userSid}:R" | Out-Null`,
    "if ($LASTEXITCODE) { throw 'Không đặt được quyền cho khoá.' }",
    `$action = New-ScheduledTaskAction -Execute (Join-Path $dir 'orbit-secure.exe') -Argument 'serve ${SECURE_PORT}'`,
    '$trigger = New-ScheduledTaskTrigger -AtStartup',
    "$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
    '$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew',
    'Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null',
    'Start-ScheduledTask -TaskName $task',
  ].join('\n');
}

// Tác vụ tên `name` có trên máy này hay không. Tác vụ SYSTEM do setup tạo thì người dùng thường không được
// đọc, nên `schtasks /Query` và `Get-ScheduledTask` đều báo như là không có: đầu máy chạy bằng quyền người
// dùng sẽ tưởng tác vụ bị thiếu và xin quyền quản trị cài lại mãi. Hỏi thẳng Task Scheduler qua COM thì mã
// HRESULT phân biệt được "không có" (0x80070002) với "có mà không đọc được" (0x80070005), và không phụ
// thuộc ngôn ngữ của Windows như chuỗi lỗi của schtasks.
export function scheduledTaskExists(name) {
  if (process.platform !== 'win32') return false;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  $svc = New-Object -ComObject Schedule.Service',
    '  $svc.Connect()',
    `  $null = $svc.GetFolder('\\').GetTask(${q(name)})`,
    "  'yes'",
    '} catch {',
    '  $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }',
    "  if ($e.HResult -eq 0x80070005) { 'yes' } else { 'no' }",
    '}',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return (r.stdout || '').trim() === 'yes';
}

// Tình trạng cài trên máy này, cho bước setup: { installed, current, running, detail }.
export async function secureStatus() {
  if (!existsSync(SECURE_EXE)) return { installed: false, detail: 'chưa cài' };
  let built = '';
  try {
    built = buildSecureExe();
  } catch (err) {
    return { installed: true, current: false, detail: err.message };
  }
  const current = fileHash(SECURE_EXE) === fileHash(built);
  const running = await secureAvailable();
  const task = scheduledTaskExists(SECURE_TASK);
  const grant = existsSync(SECURE_GRANT_PUB) && existsSync(SECURE_MACHINE_ID);
  const parts = [];
  if (!current) parts.push('bản đã cài cũ hơn mã nguồn');
  if (!task) parts.push('thiếu tác vụ chạy lúc bật máy');
  if (!running) parts.push('chưa chạy hay không đọc được khoá');
  if (!grant) parts.push('chưa có khoá cấp quyền của trạm (chưa bấm được màn khoá, UAC)');
  return { installed: true, current, running, task, grant, detail: parts.join('; ') || 'đang chạy, đúng bản mới nhất' };
}

// Đưa một quyền bấm do trạm ký (hub-identity.mjs grant) cho chương trình SYSTEM. Trả hạn (giây Unix).
export async function sendSecureGrant(payload, sig) {
  const b64 = /^[A-Za-z0-9+/=]{1,700}$/;
  if (!b64.test(String(payload)) || !b64.test(String(sig))) throw new Error('Quyền không hợp lệ.');
  const s = await open(`grant ${payload} ${sig}`);
  let line;
  try {
    ({ line } = await readLine(s));
  } catch {
    throw new Error('Phần xem màn khoá trên máy này là bản cũ, chưa nhận quyền bấm: chạy setup.cmd trên máy đó.');
  } finally {
    s.destroy();
  }
  const m = /^ok (\d+)$/.exec(String(line || ''));
  if (!m) throw new Error('Phần xem màn khoá từ chối quyền (khoá cấp quyền chưa cài, hay của trạm khác): chạy setup.cmd trên máy đó.');
  return { until: Number(m[1]) };
}
