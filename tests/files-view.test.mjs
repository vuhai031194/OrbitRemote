// Kiểm nút "Tệp" ở màn phiên, phần app: dựng hàng của cây (web/lib/file-tree.js), và bảng Tệp (web/views/files.js)
// trên một DOM giả tối thiểu: mở thư mục, ẩn và hiện thư mục nặng, lọc theo tên, chạm tệp Markdown thì khung xem
// dựng thành trang và chuyển được sang mã gốc, phiên xong một lượt thì cây tự làm mới.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heavyCount, joinRel, sizeText, treeRows } from '../web/lib/file-tree.js';

const dir = (name, more = {}) => ({ name, kind: 'dir', ...more });
const file = (name, size = 1) => ({ name, kind: 'file', size });
const label = (r) => (r.note ? `!${r.note}` : `${'  '.repeat(r.depth)}${r.kind === 'dir' ? (r.open ? 'v ' : '> ') : ''}${r.name}`);

test('cây: thư mục mở thì hiện bên trong, thư mục nặng ẩn trừ khi bật, thư mục trống và lỗi có ghi chú', () => {
  const nodes = new Map([
    ['', { entries: [dir('docs'), dir('empty'), dir('node_modules', { heavy: true }), file('README.md')], more: false }],
    ['docs', { entries: [dir('reference'), file('spec.md')], more: false }],
    ['empty', { entries: [], more: false }],
    ['docs/reference', { error: 'Không mở được docs/reference: không được phép đọc.' }],
  ]);
  const open = new Set(['docs', 'empty', 'docs/reference']);
  assert.deepEqual(treeRows(nodes, open).map(label), [
    'v docs', '  v reference', '!Không mở được docs/reference: không được phép đọc.', '  spec.md',
    'v empty', '!Thư mục trống.',
    'README.md',
  ]);
  assert.deepEqual(treeRows(nodes, new Set(), { showHeavy: true }).map(label), ['> docs', '> empty', '> node_modules', 'README.md']);
  assert.equal(heavyCount(nodes), 1);
  const row = treeRows(nodes, open, { loading: new Set(['docs']) })[0];
  assert.equal(row.rel, 'docs');
  assert.equal(row.loading, true);
  assert.equal(treeRows(nodes, open)[3].rel, 'docs/spec.md');
  // Thư mục mở mà chưa tải xong.
  assert.deepEqual(treeRows(new Map([['', { entries: [dir('a')] }]]), new Set(['a'])).map(label), ['v a', '!Đang tải…']);
  assert.deepEqual(treeRows(new Map([['', { entries: [], more: true }]]), new Set()).map(label),
    ['!Thư mục trống.', '!Thư mục quá đông, chỉ hiện 0 mục đầu.']);
});

test('cây: lọc theo tên chỉ trong phần đã tải, thư mục chứa tên khớp tự mở, thư mục có tên khớp thì hiện cả bên trong', () => {
  const nodes = new Map([
    ['', { entries: [dir('docs'), dir('scripts'), dir('reports'), file('Báo cáo.md')] }],
    ['docs', { entries: [dir('reference'), file('spec.md')] }],
    ['docs/reference', { entries: [file('BAO-CAO-cu.md'), file('khac.txt')] }],
    ['reports', { entries: [file('a.html')] }],
  ]);
  assert.deepEqual(treeRows(nodes, new Set(), { filter: 'báo' }).map(label), ['Báo cáo.md'], 'không phân biệt hoa thường, giữ dấu');
  assert.deepEqual(treeRows(nodes, new Set(), { filter: 'bao' }).map(label), ['v docs', '  v reference', '    BAO-CAO-cu.md'],
    'thư mục đóng nhưng bên trong (đã tải) có tên khớp thì tự mở');
  assert.deepEqual(treeRows(nodes, new Set(['reports']), { filter: 'report' }).map(label), ['v reports', '  a.html'],
    'thư mục có tên khớp và đang mở thì hiện cả bên trong');
  assert.deepEqual(treeRows(nodes, new Set(), { filter: 'zzz' }).map(label), ['!Không có tên nào khớp trong các thư mục đã mở.']);
});

test('cỡ tệp và đường tương đối', () => {
  assert.equal(sizeText(0), '0 B');
  assert.equal(sizeText(1023), '1023 B');
  assert.equal(sizeText(1024), '1 KB');
  assert.equal(sizeText(1536), '1.5 KB');
  assert.equal(sizeText(25 * 1024), '25 KB');
  assert.equal(sizeText(3.2 * 1024 * 1024), '3.2 MB');
  assert.equal(sizeText(5 * 1024 ** 4), '5120 GB');
  assert.equal(joinRel('', 'a'), 'a');
  assert.equal(joinRel('a/b', 'c'), 'a/b/c');
});

// ---- Bảng Tệp trên DOM giả ---------------------------------------------------------------

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...c) { for (const x of c) this.set.add(x); }
  remove(...c) { for (const x of c) this.set.delete(x); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : Boolean(force);
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
}
class FakeNode {}
class FakeEl extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag;
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.style = { setProperty() {} };
    this.dataset = {};
    this.attrs = {};
    this.classList = new FakeClassList();
    this.textContent = '';
  }
  set className(v) {
    this.classList = new FakeClassList();
    for (const c of String(v).split(/\s+/)) if (c) this.classList.add(c);
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener() {}
  dispatch(type, e = {}) { for (const fn of this.listeners[type] || []) fn(e); }
  append(...children) { for (const c of children) { c.parent?.children && (c.parent.children = c.parent.children.filter((x) => x !== c)); c.parent = this; this.children.push(c); } }
  get firstChild() { return this.children[0] || null; }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  all(cls, out = []) { if (this.classList.contains(cls)) out.push(this); for (const c of this.children) c.all?.(cls, out); return out; }
  find(cls) { return this.all(cls)[0] || null; }
  text() { return this.tagName === '#text' ? this.textContent : this.textContent + this.children.map((c) => c.text?.() || '').join(''); }
}
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
const sheetRoot = new FakeEl('div');
define('Node', FakeNode);
define('window', globalThis);
define('document', {
  createElement: (t) => new FakeEl(t),
  createElementNS: (_ns, t) => new FakeEl(t),
  createTextNode: (s) => Object.assign(new FakeEl('#text'), { textContent: String(s) }),
  addEventListener() {},
  removeEventListener() {},
  getElementById: () => sheetRoot,
  body: new FakeEl('body'),
  visibilityState: 'visible',
});
define('requestAnimationFrame', (fn) => setTimeout(fn, 0));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
define('localStorage', { getItem: () => null, setItem() {} });
define('location', { hash: '#/', protocol: 'http:', hostname: '192.168.1.10' });

// Thư mục làm việc giả của phiên s1, trả theo đúng dạng listFiles.
const TREE = {
  '': { root: 'D:\\Du an', path: '', entries: [dir('docs'), dir('node_modules', { heavy: true }), file('README.md', 2048)], more: false },
  docs: { root: 'D:\\Du an', path: 'docs', entries: [file('spec.md', 30)], more: false },
};
const FILES = { 'docs/spec.md': '# Đặc tả\n\n| A | B |\n|---|---|\n| 1 | 2 |\n<script>alert(1)</script>\n' };
const asked = [];
define('fetch', async (url) => {
  const u = new URL(url, 'http://hub');
  asked.push(`${u.pathname}?${u.searchParams.get('p') || ''}`);
  const p = u.searchParams.get('p') || '';
  if (u.pathname === '/api/sessions/s1/tree' && p in TREE) return { ok: true, status: 200, json: async () => TREE[p] };
  if (u.pathname === '/api/sessions/s1/tree-file' && p in FILES) return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(FILES[p]).buffer };
  return { ok: false, status: 404, json: async () => ({ error: 'Chỉ xem được tệp trong thư mục làm việc của phiên.' }) };
});

const { store } = await import('../web/lib/store.js');
const { openSessionFiles } = await import('../web/views/files.js');
const tick = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0)); };
const names = (box) => box.all('file-row').map((r) => r.find('file-name').text());

test('bảng Tệp: mở thư mục làm việc, ẩn thư mục nặng, mở thư mục con, lọc, chạm tệp Markdown thì xem có định dạng và mã gốc', async () => {
  asked.length = 0;
  openSessionFiles({ id: 's1', cwd: 'D:\\Du an', machineId: 'm1' });
  await tick();
  const sheet = sheetRoot.find('files');
  assert.ok(sheet, 'mở bảng Tệp');
  assert.deepEqual(asked, ['/api/sessions/s1/tree?']);
  assert.equal(sheet.find('files-root').text(), 'D:\\Du an');
  assert.deepEqual(names(sheet), ['docs', 'README.md'], 'node_modules ẩn');
  assert.equal(sheet.find('file-size').text(), '2 KB');
  const heavy = sheet.find('files-heavy');
  assert.equal(heavy.text(), 'Hiện thư mục ẩn (1)');
  heavy.dispatch('click');
  assert.deepEqual(names(sheet), ['docs', 'node_modules', 'README.md']);
  assert.equal(sheet.find('heavy')?.find('file-name').text(), 'node_modules', 'thư mục nặng hiện mờ');
  heavy.dispatch('click');

  sheet.all('file-row')[0].dispatch('click');
  await tick();
  assert.deepEqual(asked.at(-1), '/api/sessions/s1/tree?docs');
  assert.deepEqual(names(sheet), ['docs', 'spec.md', 'README.md']);
  assert.equal(sheet.all('file-row')[0].attrs['aria-expanded'], 'true');

  const filter = sheet.find('files-filter');
  filter.value = 'SPEC';
  filter.dispatch('input');
  assert.deepEqual(names(sheet), ['docs', 'spec.md']);
  filter.value = '';
  filter.dispatch('input');

  sheet.all('file-row')[1].dispatch('click');
  await tick();
  const viewer = sheetRoot.find('viewer');
  assert.ok(viewer, 'chạm tệp thì mở khung xem');
  assert.equal(asked.at(-1), '/api/sessions/s1/tree-file?docs/spec.md');
  const md = viewer.find('viewer-md');
  assert.ok(md, 'Markdown dựng thành trang');
  assert.match(md.innerHTML, /<h3>Đặc tả<\/h3>/);
  assert.match(md.innerHTML, /<table>/);
  assert.doesNotMatch(md.innerHTML, /<script>/, 'chữ trong tệp không thành HTML chạy được');
  const toggle = viewer.find('viewer-actions').children[0];
  assert.match(toggle.text(), /Mã gốc/);
  toggle.dispatch('click');
  assert.equal(viewer.find('viewer-md'), null);
  assert.match(viewer.find('viewer-text').textContent, /<script>alert\(1\)<\/script>/, 'mã gốc hiện nguyên văn');
  assert.match(toggle.text(), /Định dạng/);
  toggle.dispatch('click');
  assert.ok(viewer.find('viewer-md'));
});

test('bảng Tệp: phiên xong một lượt thì cây tự tải lại thư mục làm việc và các thư mục đang mở', async () => {
  const before = asked.length;
  store.emit('event', { id: 'khac', ev: { t: 'result' } });
  store.emit('event', { id: 's1', ev: { t: 'text', text: 'x' } });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(asked.length, before, 'lượt của phiên khác, hay chữ giữa lượt, không làm mới');
  store.emit('event', { id: 's1', ev: { t: 'result' } });
  store.emit('event', { id: 's1', ev: { t: 'result' } });
  await new Promise((r) => setTimeout(r, 500));
  await tick();
  assert.deepEqual(asked.slice(before).sort(), ['/api/sessions/s1/tree?', '/api/sessions/s1/tree?docs'], 'hai lượt liền nhau gộp thành một lần');
});

test('khung xem: HTML dựng trong khung hộp cát không chạy mã; tệp chữ quen không đuôi xem được như chữ', async () => {
  const { attachmentKind, formatOf, openAttachment } = await import('../web/views/viewer.js');
  assert.equal(formatOf('a.md'), 'md');
  assert.equal(formatOf('B.HTML'), 'html');
  assert.equal(formatOf('a.txt'), '');
  assert.equal(attachmentKind('Dockerfile'), 'text');
  assert.equal(attachmentKind('.gitignore'), 'text');
  assert.equal(attachmentKind('a.xlsx'), 'other');
  openAttachment({ name: 'bao-cao.html', bytes: new TextEncoder().encode('<h1>Hi</h1><script>alert(1)</script>') });
  await tick();
  const frame = sheetRoot.all('viewer-html').at(-1);
  assert.ok(frame, 'HTML hiện trong khung');
  assert.equal(frame.attrs.sandbox, '', 'hộp cát rỗng: không chạy mã, không cùng nguồn');
  assert.match(frame.attrs.srcdoc, /<h1>Hi<\/h1>/);
});
