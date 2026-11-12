/**
 * v0.20.27 自检：「使用中」按解析后的后端标记 / 点 ego lite 行能切回去。
 *
 * 需求（用户）：「为什么选择不到ego」—— 在「用户浏览器」里点 ego lite 那一行，
 * 界面一直把 Edge/Chrome 标成使用中，看起来像选不了。
 *
 * 根因两处：
 *   1. `scanBrowsers` 拿配置里的原始值 `cfg.browser`（默认 `auto`）判断，没走
 *      `backendFor()` 的解析结果 —— 装了 ego lite 时实际后端是 ego，界面却标 Chrome/Edge；
 *   2. 界面点 ego lite 那行写的是 `{ browser: 'auto' }`，`browserPath` 仍留着上一次选的
 *      Chrome/Edge 路径，标记继续错位。
 *
 * 修法：扫描结果按 `backendFor(cfg)` 解析后的后端标「使用中」（也允许 `opts.backend`
 * 显式传入，便于测试不依赖本机是否装了 ego lite）；界面点 ego lite 行改成明确写
 * `{ browser: 'egolite' }`。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const clientSrc = read('lib/client.js');
const changelog = read('CHANGELOG.md');
const readme = read('README.md');
const pkg = JSON.parse(read('package.json'));

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  ✗ ' + name);
    console.log('      ' + (err && err.message ? err.message : String(err)));
  }
}

const scan = await import('../lib/browser-scan.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backend-'));
function plant(root, rel) {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'stub');
  return p;
}
const fakeRoot = path.join(TMP, 'roots');
const CHROME_DIR = plant(fakeRoot, 'Google/Chrome/Application/157.0.8103.50/chrome.exe');
const EDGE_DIR = plant(fakeRoot, 'Microsoft/Edge/Application/157.0.4341.46/msedge.exe');
const EGO_FILE = plant(fakeRoot, 'Citro Labs/ego lite/Application/ego.exe');
plant(fakeRoot, 'Citro Labs/ego lite/Application/0.6.2.8/ego.ver');

const TARGETS = [
  { id: 'chrome', name: 'Google Chrome', exe: 'chrome.exe', product: 'Chromium', bases: [path.join(fakeRoot, 'Google', 'Chrome', 'Application')] },
  { id: 'edge', name: 'Microsoft Edge', exe: 'msedge.exe', product: 'Chromium', bases: [path.join(fakeRoot, 'Microsoft', 'Edge', 'Application')] },
  { id: 'egolite', name: 'ego lite', exe: 'ego.exe', product: 'ego 浏览器', files: [EGO_FILE] },
];
const chosenIds = (s) => s.browsers.filter((b) => b.chosen).map((b) => b.id);

console.log('1. 「使用中」按解析后的后端');
await test('A1 实际后端是 ego lite 时，即使配过 Chrome/Edge 路径也标 ego lite', () => {
  // 用户场景：先点了 Edge，再点 ego lite 那一行 —— 配置里 browserPath 还留着 Edge。
  const s = scan.scanBrowsers({ browser: 'auto', browserPath: EDGE_DIR }, { targets: TARGETS, resolved: EDGE_DIR, backend: 'egolite' });
  assert.deepEqual(chosenIds(s), ['egolite'], '实际后端是 ego lite，就该只有 ego lite 标使用中：' + chosenIds(s).join(','));
  assert.equal(s.backend, 'egolite');
});

await test('A2 实际后端是 Chrome 时，Edge 标使用中、ego lite 不标', () => {
  const s = scan.scanBrowsers({ browser: 'chrome', browserPath: EDGE_DIR }, { targets: TARGETS, resolved: EDGE_DIR, backend: 'chrome' });
  assert.deepEqual(chosenIds(s), ['edge']);
  assert.equal(s.backend, 'chrome');
});

await test('A3 不传 backend 时按配置解析：明确 chrome + 路径存在就是 chrome', () => {
  const s = scan.scanBrowsers({ browser: 'chrome', browserPath: CHROME_DIR }, { targets: TARGETS, resolved: CHROME_DIR });
  assert.equal(s.backend, 'chrome', '解析后的后端应写进结果');
  assert.deepEqual(chosenIds(s), ['chrome']);
});

await test('A4 opts.backend 可显式指定，测试不依赖本机装没装 ego lite', () => {
  const a = scan.scanBrowsers({ browserPath: '' }, { targets: TARGETS, resolved: CHROME_DIR, backend: 'chrome' });
  assert.deepEqual(chosenIds(a), ['chrome']);
  const b = scan.scanBrowsers({ browserPath: '' }, { targets: TARGETS, resolved: CHROME_DIR, backend: 'egolite' });
  assert.deepEqual(chosenIds(b), ['egolite']);
});

await test('A5 选中的浏览器用不了时（后端回退 ego）也不再把 Chrome 标使用中', () => {
  // 画面等：配置写的是 chrome，但那份 Chrome 不存在 → backendFor 回退 ego lite。
  const s = scan.scanBrowsers({ browser: 'chrome', browserPath: 'C:/not-there/chrome.exe' }, { targets: TARGETS, backend: 'egolite' });
  assert.deepEqual(chosenIds(s), ['egolite']);
});

console.log('\n2. 界面接线');
await test('B1 点 ego lite 那一行写的是明确的 egolite 后端', () => {
  const seg = clientSrc.slice(clientSrc.indexOf('function useBrowser(b) {'), clientSrc.indexOf('function useBrowser(b) {') + 900);
  assert.ok(seg.includes("{ browser: 'egolite' }"), 'ego lite 行要明确写 egolite');
  assert.ok(!seg.includes("{ browser: 'auto' }"), '不该再写 auto（会留着 browserPath 让标记错位）');
  assert.ok(seg.includes("browserPath: b.path, browser: 'chrome'"), 'Chrome/Edge 行仍写路径');
});

await test('B2 切换成功后表单里的后端与写入值一致', () => {
  const seg = clientSrc.slice(clientSrc.indexOf('function useBrowser(b) {'), clientSrc.indexOf('function useBrowser(b) {') + 900);
  const forms = seg.split('setForm(Object.assign({}, form, b.id === \'egolite\'').length - 1;
  assert.ok(forms === 1, 'setForm 那段要跟着写 egolite：出现次数 ' + forms);
});

await test('B3 点行即切换仍然生效（ego lite 行也能点）', () => {
  assert.ok(clientSrc.includes('function useBrowser(b)'), 'useBrowser 还在');
  assert.ok(clientSrc.includes('if (!chosen && !scanBusy) useBrowser(b)'), '未选中的行点一下就该切换（含 ego lite）');
});

console.log('\n3. 版本与文档');
await test('C1 版本号已到 0.20.27', () => {
  const cmp = (a, b) => {
    const A = String(a).split('.').map(Number);
    const B = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i += 1) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0);
    return 0;
  };
  assert.ok(cmp(pkg.version, '0.20.27') >= 0, '版本号还没到 0.20.27：' + pkg.version);
});

await test('C2 CHANGELOG 与 README 同步', () => {
  assert.ok(changelog.includes('v0.20.27'), 'CHANGELOG 缺 v0.20.27');
  assert.ok(changelog.includes('使用中'), 'CHANGELOG 要说明「使用中」标记');
  assert.ok(readme.includes('ego lite 那一行'), 'README 要说明点 ego lite 那一行的效果');
  assert.ok(readme.includes(pkg.version), 'README 版本号要与 package.json 一致');
});

if (failures.length) {
  console.log('\n✗ 失败 ' + failures.length + ' / 通过 ' + passed);
  for (const f of failures) console.log('  [' + f.name + '] ' + (f.err && f.err.stack ? f.err.stack.split('\n')[0] : f.err));
  process.exitCode = 1;
} else {
  console.log('\n✓ 全部通过（' + passed + ' 项）');
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
