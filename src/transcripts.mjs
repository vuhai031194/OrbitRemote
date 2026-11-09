// Đọc nhật ký phiên mà Claude Code tự ghi ra ~/.claude/projects/<thư mục>/<mã phiên>.jsonl.
//
// Nhờ đó app thấy được cả những phiên mở bằng tay trong VS Code hay terminal, và mở lại
// lịch sử của một phiên sau khi trạm khởi động lại. Không bao giờ sửa nội dung nhật ký. Chỉ có hai việc
// người dùng tự bấm từ app là chạm tới file (transcriptAction): "Ẩn" chỉ ghi mã phiên vào sổ riêng của
// Orbit Remote; "Chuyển vào thùng rác" dời nguyên file sang thư mục trạng thái, khôi phục được.
//
// File nhật ký có thể nặng hàng chục, thậm chí hàng trăm MB (đo trên máy thật: 140 MB), và
// đầu máy quét định kỳ để thấy phiên đang mở ngoài app. Vì vậy:
//   - siêu dữ liệu của mỗi file được nhớ theo thời điểm sửa; file không đổi thì không đọc lại;
//   - phần đầu file (thư mục, câu hỏi đầu) chỉ đọc một lần, vì nó không bao giờ đổi;
//   - lịch sử chỉ đọc phần ĐUÔI file, đủ cho vài trăm sự kiện cuối.

import { closeSync, cpSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { summarizeTool } from './claude-session.mjs';
import { STATE_DIR, readJson, writeJsonAtomic } from './paths.mjs';

export const PROJECTS_DIR = process.env.ORBIT_REMOTE_PROJECTS || join(homedir(), '.claude', 'projects');
// Sổ phiên đang chạy của Claude Code nằm cạnh thư mục nhật ký: ~/.claude/sessions/<pid>.json.
const SESSIONS_DIR = process.env.ORBIT_REMOTE_CLAUDE_SESSIONS || join(dirname(PROJECTS_DIR), 'sessions');
// Phiên người dùng ẩn khỏi danh sách phiên cũ: { ids: [mã phiên] }. Nhật ký vẫn nằm nguyên chỗ cũ.
const HIDDEN_FILE = join(STATE_DIR, 'hidden-transcripts.json');
// Thùng rác: <TRASH_DIR>/<thư mục dự án trong ~/.claude/projects>/<mã phiên>.jsonl, kèm thư mục cùng tên nếu
// Claude Code có tạo (nhật ký phiên con, kết quả công cụ lớn). index.json nhớ lúc chuyển vào.
export const TRASH_DIR = join(STATE_DIR, 'transcript-trash');
const TRASH_INDEX = join(TRASH_DIR, 'index.json');
const SESSION_ID = /^[0-9a-f-]{36}$/i;
const HEAD_BYTES = 96 * 1024;
const TAIL_BYTES = 64 * 1024;
const HISTORY_TAIL_BYTES = 3 * 1024 * 1024;
export const ACTIVE_WINDOW_MS = 90 * 1000;
// Danh sách phiên cũ phải đọc qua mọi nhật ký rỗng (xem listTranscripts), mà máy có thể có cả nghìn
// file (plugin claude-mem đẻ ra hàng trăm phiên nền). Sổ nhớ nhỏ hơn số file thì mỗi lần mở danh sách
// lại đọc lại từ đầu; mỗi mục nhỏ (câu hỏi đầu cắt còn PROMPT_MAX ký tự) nên giữ nhiều cũng rẻ.
const CACHE_MAX = 5000;
const PROMPT_MAX = 200;

const cache = new Map(); // đường dẫn -> { mtime, size, head: { cwd, prompt }, title }

function readSlice(file, start, length) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue; // mẩu cắt ngang giữa dòng thì bỏ
    try {
      out.push(JSON.parse(line));
    } catch {
      // dòng cụt ở biên mẩu đọc
    }
  }
  return out;
}

function firstUserText(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return '';
  const c = entry.message?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b) => b?.type === 'text')?.text || '' : '';
  // Lệnh nội bộ và nội dung do hook chèn vào không phải câu người dùng hỏi.
  if (!text || text.startsWith('<')) return '';
  return text;
}

function allFiles() {
  if (!existsSync(PROJECTS_DIR)) return [];
  const files = [];
  for (const dir of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const full = join(PROJECTS_DIR, dir.name);
    let names;
    try {
      names = readdirSync(full);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const st = statSync(join(full, name));
        files.push({ file: join(full, name), mtime: st.mtimeMs, size: st.size });
      } catch {
        // file vừa bị xoá giữa lúc quét
      }
    }
  }
  return files;
}

// Tên thư mục Claude Code đặt cho một dự án trong ~/.claude/projects: mọi ký tự không phải chữ hay số thành
// "-" (D:\Zitga\pigloop-ai-data -> D--Zitga-pigloop-ai-data). So không phân biệt hoa thường: trên Windows
// thư mục mang tên theo lần tạo đầu, "d--Zitga-x" hay "D--Zitga-x".
const projectKey = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();

// Tìm trên đĩa thư mục thật có tên dự án khớp `dirKey` (dạng projectKey). Tên đã mất dấu phân cách nên không
// giải ngược được; thay vào đó đi từ gốc ổ xuống, mỗi tầng chỉ vào thư mục con có tên khớp phần đầu còn lại
// ("d--zitga-vh-library": ổ D:, rồi "Zitga", rồi "vh-library"). Ít khi cần (xem describe), và mỗi dự án chỉ
// tìm một lần mỗi lần chạy, kể cả khi không thấy.
const resolvedDirs = new Map(); // dirKey -> đường dẫn thật, '' nếu không thấy
function findProjectDir(dirKey) {
  if (resolvedDirs.has(dirKey)) return resolvedDirs.get(dirKey);
  let found = '';
  const drive = /^([a-z])--(.+)$/.exec(dirKey); // Windows: "d--zitga-x"
  if (process.platform === 'win32' && drive) found = walkProjectDir(`${drive[1].toUpperCase()}:\\`, drive[2], 0);
  else if (process.platform !== 'win32' && dirKey.startsWith('-')) found = walkProjectDir('/', dirKey.slice(1), 0); // "/Users/x" -> "-users-x"
  resolvedDirs.set(dirKey, found);
  return found;
}
function walkProjectDir(dir, rest, depth) {
  if (depth > 12) return '';
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const k = projectKey(d.name);
    if (k === rest) return join(dir, d.name);
    if (k && rest.startsWith(`${k}-`)) {
      const r = walkProjectDir(join(dir, d.name), rest.slice(k.length + 1), depth + 1);
      if (r) return r;
    }
  }
  return '';
}

// Thư mục làm việc của phiên. Mỗi dòng nhật ký ghi thư mục lúc đó, và nó đổi trong đời phiên theo hai cách:
//   - lệnh `cd` vào thư mục con (D:\Zitga\PigLoop rồi ...\PigLoop\CartSort): phiên vẫn thuộc dự án gốc;
//   - dự án bị dời rồi phiên chạy tiếp ở chỗ mới (D:\Projects\x rồi D:\Zitga\x): phiên thuộc chỗ mới, chỗ cũ
//     có khi không còn.
// Thư mục chứa file nhật ký cho biết phiên đang thuộc dự án nào, nên lấy bản ghi sau cùng khớp tên thư mục đó.
// Không bản nào khớp thì lấy bản đầu như trước; riêng khi bản đó không còn trên đĩa (thư mục nhật ký bị đổi tên
// tay theo chỗ mới của dự án, mà các dòng bên trong vẫn ghi chỗ cũ) thì tìm thư mục thật theo tên thư mục nhật ký.
function describe({ file, mtime, size }) {
  let c = cache.get(file);
  if (c && c.mtime === mtime) return c;
  const dirKey = basename(dirname(file)).toLowerCase();
  const matches = (cwd) => projectKey(cwd) === dirKey;
  // File nhỏ thì đọc lại trọn (rẻ) để bắt tiêu đề mới; file lớn chỉ đọc đầu một lần.
  if (!c?.head || size <= HEAD_BYTES) {
    const head = parseLines(readSlice(file, 0, Math.min(size, HEAD_BYTES)));
    let firstCwd = '';
    let matchCwd = '';
    let prompt = '';
    let title = '';
    for (const e of head) {
      if (e.cwd) {
        if (!firstCwd) firstCwd = e.cwd;
        if (matches(e.cwd)) matchCwd = e.cwd;
      }
      if (!prompt) prompt = firstUserText(e);
      if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
    }
    c = { head: { firstCwd, matchCwd, prompt: prompt.slice(0, PROMPT_MAX) }, title };
  }
  // Tiêu đề do AI đặt và thư mục làm việc đổi được trong đời phiên: lấy bản mới nhất ở đuôi file.
  let tailMatch = '';
  let tailFirst = '';
  if (size > HEAD_BYTES) {
    for (const e of parseLines(readSlice(file, Math.max(0, size - TAIL_BYTES), TAIL_BYTES))) {
      if (e.type === 'ai-title' && e.aiTitle) c.title = e.aiTitle;
      if (e.cwd && !tailFirst) tailFirst = e.cwd;
      if (e.cwd && matches(e.cwd)) tailMatch = e.cwd;
    }
  }
  let cwd = tailMatch || c.head.matchCwd || c.head.firstCwd || tailFirst;
  if (!tailMatch && !c.head.matchCwd && !(cwd && existsSync(cwd))) cwd = findProjectDir(dirKey) || cwd;
  c = { ...c, head: { ...c.head, cwd }, mtime, size };
  cache.set(file, c);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return c;
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // tiến trình có đó, chỉ là không thuộc quyền mình
  }
};

// Phiên Claude đang chạy trên máy, theo sổ Claude Code tự ghi: mỗi phiên (VS Code, terminal, hay
// do app mở) có một file <pid>.json lúc mở và file đó bị xoá lúc đóng. File còn mà tiến trình đã
// chết (máy tắt ngang, phiên bị giết) thì bỏ qua. Trả null nếu máy không có sổ này (bản Claude Code
// cũ): khi đó chỉ còn cách đoán theo giờ ghi nhật ký.
export function listOpenSessions() {
  let names;
  try {
    names = readdirSync(SESSIONS_DIR);
  } catch {
    return null;
  }
  const open = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let s;
    try {
      s = JSON.parse(readFileSync(join(SESSIONS_DIR, name), 'utf8'));
    } catch {
      continue; // đang được ghi dở hay vừa bị xoá
    }
    if (typeof s?.sessionId !== 'string' || !Number.isInteger(s.pid) || !pidAlive(s.pid)) continue;
    open.push(s);
  }
  return open;
}

function transcriptOf(claudeSessionId) {
  const file = findTranscript(claudeSessionId);
  if (!file) return null;
  try {
    const st = statSync(file);
    return { mtime: st.mtimeMs, d: describe({ file, mtime: st.mtimeMs, size: st.size }) };
  } catch {
    return null;
  }
}

// Phiên đang mở ngoài app (VS Code, terminal), trừ các mã trong `exclude` (phiên do app giữ).
// Có sổ phiên thì lấy đúng phiên đang chạy, dù đã ngồi yên bao lâu; không có thì lấy nhật ký được
// ghi trong `windowMs` vừa qua.
export function listExternalSessions({ exclude = new Set(), max = 20, windowMs = 15 * 60 * 1000 } = {}) {
  const open = listOpenSessions();
  if (!open) {
    // Phiên đang mở thì vẫn báo dù người dùng đã ẩn nó khỏi danh sách phiên cũ.
    return listTranscripts(max, { sinceMs: windowMs, hidden: 'all' })
      .filter((t) => !exclude.has(t.claudeSessionId))
      .map(({ claudeSessionId, title, cwd, modified, maybeActive }) => ({ claudeSessionId, title, cwd, modified, active: maybeActive, open: false }));
  }
  return open
    .filter((s) => !exclude.has(s.sessionId))
    .sort((a, b) => (b.updatedAt || b.startedAt || 0) - (a.updatedAt || a.startedAt || 0))
    .slice(0, max)
    .map((s) => {
      const t = transcriptOf(s.sessionId);
      const named = s.nameSource === 'user' && s.name;
      return {
        claudeSessionId: s.sessionId,
        title: String(named || t?.d.title || t?.d.head.prompt.slice(0, 80) || s.name || '(chưa có câu hỏi)').slice(0, 120),
        cwd: s.cwd || t?.d.head.cwd || '',
        modified: new Date(t?.mtime || s.updatedAt || s.startedAt || Date.now()).toISOString(),
        active: true, // đang mở thật: "tiếp tục" ở app lúc này sẽ ghi chồng một nhật ký
        open: true,
      };
    });
}

// Một dòng trong danh sách phiên cũ (dạng app nhận).
function entryOf(f, d, claudeSessionId, maybeActive) {
  return {
    claudeSessionId,
    title: d.title || d.head.prompt.slice(0, 80) || '(chưa có câu hỏi)',
    prompt: d.head.prompt,
    cwd: d.head.cwd,
    modified: new Date(f.mtime).toISOString(),
    sizeKb: Math.round(f.size / 1024),
    maybeActive,
  };
}

const hiddenIds = () => {
  const ids = readJson(HIDDEN_FILE, {})?.ids;
  return new Set(Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : []);
};

// limit: số phiên mới nhất; sinceMs: chỉ lấy file được ghi trong khoảng này.
// hidden: 'skip' bỏ phiên người dùng đã ẩn (mặc định), 'only' chỉ lấy phiên đã ẩn, 'all' không xét.
// Nhật ký không có câu hỏi nào của người dùng (không tiêu đề, không câu hỏi) bị bỏ trước khi đếm `limit`:
// đó là phiên nền do plugin hay hook đẻ ra (claude-mem ghi hàng trăm phiên như vậy), không có gì để xem,
// mà để lại thì chúng chiếm hết chỗ của phiên thật. Riêng phiên đang mở thì vẫn giữ dù chưa hỏi gì.
export function listTranscripts(limit = 40, { sinceMs = 0, hidden = 'skip' } = {}) {
  const now = Date.now();
  let files = allFiles().sort((a, b) => b.mtime - a.mtime);
  if (sinceMs) files = files.filter((f) => now - f.mtime < sinceMs);
  const open = listOpenSessions();
  const openIds = open ? new Set(open.map((s) => s.sessionId)) : null;
  const hiddenSet = hidden === 'all' ? null : hiddenIds();
  const out = [];
  for (const f of files) {
    if (out.length >= limit) break;
    const claudeSessionId = basename(f.file, '.jsonl');
    if (hiddenSet && hiddenSet.has(claudeSessionId) !== (hidden === 'only')) continue;
    const d = describe(f);
    // Có sổ phiên thì biết chắc phiên nào đang mở; không có thì đoán: file vừa được ghi rất gần
    // đây thì nhiều khả năng phiên đó vẫn đang mở ở đâu đó.
    const maybeActive = openIds ? openIds.has(claudeSessionId) : now - f.mtime < ACTIVE_WINDOW_MS;
    if (!d.title && !d.head.prompt && !maybeActive) continue;
    out.push(entryOf(f, d, claudeSessionId, maybeActive));
  }
  return out;
}

// ---- Ẩn và thùng rác --------------------------------------------------------------------------

// Các nhật ký đang nằm trong thùng rác: [{ file, mtime, size, dir }], dir là tên thư mục dự án cũ.
function trashFiles() {
  let dirs;
  try {
    dirs = readdirSync(TRASH_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let names;
    try {
      names = readdirSync(join(TRASH_DIR, dir.name));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const st = statSync(join(TRASH_DIR, dir.name, name));
        out.push({ file: join(TRASH_DIR, dir.name, name), mtime: st.mtimeMs, size: st.size, dir: dir.name });
      } catch {
        // vừa bị dời đi
      }
    }
  }
  return out;
}

// Phiên trong thùng rác, mới chuyển vào trước. Mỗi dòng có thêm `trashedAt`.
export function listTrash(limit = 200) {
  const index = readJson(TRASH_INDEX, {}) || {};
  return trashFiles()
    .map((f) => {
      const claudeSessionId = basename(f.file, '.jsonl');
      return { ...entryOf(f, describe(f), claudeSessionId, false), trashedAt: index[claudeSessionId]?.at || null };
    })
    .sort((a, b) => (b.trashedAt || b.modified).localeCompare(a.trashedAt || a.modified))
    .slice(0, limit);
}

// Số phiên đã ẩn (còn nhật ký trên máy) và số phiên trong thùng rác, cho hai nút ở cuối danh sách.
export function transcriptBin() {
  const hidden = hiddenIds();
  let hiddenCount = 0;
  if (hidden.size) for (const f of allFiles()) if (hidden.has(basename(f.file, '.jsonl'))) hiddenCount += 1;
  return { hiddenCount, trashCount: trashFiles().length, trashDir: TRASH_DIR };
}

// Dời một file hay thư mục. Khác ổ đĩa (trạng thái để ở ổ khác) thì không đổi tên thẳng được: chép rồi xoá.
function move(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// Dời nhật ký <dir>/<id>.jsonl (kèm thư mục <dir>/<id> nếu có) từ gốc `from` sang gốc `to`. Dời thư mục kèm
// hỏng thì trả file nhật ký về chỗ cũ, để không bao giờ còn một nửa ở mỗi bên.
function moveTranscript(fromRoot, toRoot, dir, id) {
  const fromFile = join(fromRoot, dir, `${id}.jsonl`);
  const toFile = join(toRoot, dir, `${id}.jsonl`);
  if (existsSync(toFile)) throw new Error('Chỗ đến đã có một nhật ký cùng mã phiên.');
  move(fromFile, toFile);
  const extra = join(fromRoot, dir, id);
  if (!isDir(extra)) return;
  try {
    move(extra, join(toRoot, dir, id));
  } catch (err) {
    move(toFile, fromFile);
    throw err;
  }
}

function busyText(err) {
  return ['EBUSY', 'EPERM', 'EACCES'].includes(err.code)
    ? 'Không dời được nhật ký: file đang bị một chương trình khác mở (phiên còn chạy ở đâu đó?).'
    : `Không dời được nhật ký: ${err.message}`;
}

// Việc người dùng bấm từ app với một phiên cũ: 'hide' | 'unhide' | 'trash' | 'restore'.
// Phiên đang mở (theo sổ phiên của Claude Code) thì không cho chuyển vào thùng rác.
export function transcriptAction(claudeSessionId, action) {
  const id = String(claudeSessionId || '');
  if (!SESSION_ID.test(id)) throw new Error('Mã phiên không hợp lệ.');
  if (action === 'hide' || action === 'unhide') {
    if (action === 'hide' && !findTranscript(id)) throw new Error('Không thấy nhật ký của phiên này trên máy.');
    // Nhân tiện bỏ mã của nhật ký không còn (Claude Code tự xoá sau 30 ngày) để sổ không phình mãi.
    const present = new Set(allFiles().map((f) => basename(f.file, '.jsonl')));
    const ids = [...hiddenIds()].filter((x) => x !== id && present.has(x));
    if (action === 'hide') ids.push(id);
    writeJsonAtomic(HIDDEN_FILE, { ids });
    return { ok: true };
  }
  if (action === 'trash') {
    if (listOpenSessions()?.some((s) => s.sessionId === id)) {
      throw new Error('Phiên này đang mở ở VS Code hay terminal. Đóng nó trước rồi hãy chuyển vào thùng rác.');
    }
    const file = findTranscript(id);
    if (!file) throw new Error('Không thấy nhật ký của phiên này trên máy.');
    const dir = basename(dirname(file));
    try {
      moveTranscript(PROJECTS_DIR, TRASH_DIR, dir, id);
    } catch (err) {
      throw new Error(err.message.startsWith('Chỗ đến') ? err.message : busyText(err));
    }
    cache.delete(file);
    const index = readJson(TRASH_INDEX, {}) || {};
    index[id] = { dir, at: new Date().toISOString() };
    writeJsonAtomic(TRASH_INDEX, index);
    const hidden = hiddenIds();
    if (hidden.delete(id)) writeJsonAtomic(HIDDEN_FILE, { ids: [...hidden] });
    return { ok: true };
  }
  if (action === 'restore') {
    const found = trashFiles().find((f) => basename(f.file, '.jsonl') === id);
    if (!found) throw new Error('Phiên này không còn trong thùng rác.');
    try {
      moveTranscript(TRASH_DIR, PROJECTS_DIR, found.dir, id);
    } catch (err) {
      throw new Error(err.message.startsWith('Chỗ đến') ? err.message : busyText(err));
    }
    cache.delete(found.file);
    const index = readJson(TRASH_INDEX, {}) || {};
    delete index[id];
    writeJsonAtomic(TRASH_INDEX, index);
    return { ok: true };
  }
  throw new Error(`Không có thao tác "${action}".`);
}

export function findTranscript(claudeSessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(claudeSessionId) || !existsSync(PROJECTS_DIR)) return null;
  for (const dir of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const candidate = join(PROJECTS_DIR, dir.name, `${claudeSessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function toEvents(e, push) {
  if (e.isSidechain || e.isMeta) return;
  const at = e.timestamp;
  const content = e.message?.content;
  if (e.type === 'user') {
    if (typeof content === 'string') {
      if (!content.startsWith('<')) push({ t: 'user', text: content, at });
      return;
    }
    for (const b of content || []) {
      if (b?.type === 'text' && b.text && !b.text.startsWith('<')) push({ t: 'user', text: b.text, at });
      else if (b?.type === 'tool_result') {
        const text = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map((x) => x?.text || '').join('\n') : '';
        push({ t: 'tool_result', id: b.tool_use_id, ok: !b.is_error, preview: text.slice(0, 1500), at });
      }
    }
  } else if (e.type === 'assistant') {
    for (const b of content || []) {
      if (b?.type === 'text' && b.text) push({ t: 'text', text: b.text, at });
      else if (b?.type === 'tool_use') push({ t: 'tool', id: b.id, name: b.name, summary: summarizeTool(b.name, b.input), at });
    }
  }
}

// Dựng lại dòng sự kiện của app từ phần đuôi nhật ký, giữ đúng `max` sự kiện cuối.
// `sinceMtime`: file chưa đổi kể từ lần đọc trước thì trả `unchanged` cho khỏi gửi lại.
export function loadHistory(claudeSessionId, max = 400, { sinceMtime = 0 } = {}) {
  const file = findTranscript(claudeSessionId);
  if (!file) return { events: [], mtime: 0 };
  const fd = openSync(file, 'r');
  let text;
  let mtime;
  try {
    const st = fstatSync(fd);
    mtime = st.mtimeMs;
    if (sinceMtime && mtime === sinceMtime) return { unchanged: true, mtime };
    const start = Math.max(0, st.size - HISTORY_TAIL_BYTES);
    const buf = Buffer.alloc(st.size - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    text = buf.subarray(0, n).toString('utf8');
    // Bắt đầu giữa chừng file thì dòng đầu là mẩu cụt: bỏ tới hết dòng.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } finally {
    closeSync(fd);
  }
  const events = [];
  const push = (ev) => {
    events.push(ev);
    if (events.length > max) events.shift();
  };
  for (const line of text.split('\n')) {
    if (!line.startsWith('{"') || (!line.includes('"type":"user"') && !line.includes('"type":"assistant"'))) continue;
    try {
      toEvents(JSON.parse(line), push);
    } catch {
      // dòng hỏng
    }
  }
  return { events, mtime, truncated: text.length >= HISTORY_TAIL_BYTES - 1 };
}
