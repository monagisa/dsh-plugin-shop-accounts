/**
 * v0.20.24 自检：Microsoft Edge 支持。
 *
 * 需求（用户）：「兼容edge先」—— Edge 与 Chrome 同为 Chromium 内核，插件走 CDP 驱动，
 * 启动参数与调试协议一致，所以把它纳入「用户浏览器」扫描列表与可选后端。
 *
 * 实现：
 *   · 平台层 `browserScanTargets()` 增加 `id: 'edge'`（Windows 扫 `Microsoft\Edge\Application`，macOS 扫 app bundle）；
 *   · `launchBrowser` 的参数拆成可单测的 `browserArgs()`，Edge 额外加抑制「推荐设置 / 登录微软账号 / 侧边栏」的参数；
 *   · 扫描结果顺序固定 Chrome → Edge → ego lite；
 *   · 界面按 `id === 'edge'` 给 Edge 图标，行为与 Chrome 行一致（写 browserPath）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readServerSource } from './_src.mjs';

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
const chrome = await import('../lib/chrome.mjs');
const osPlatform = await import('../lib/platform/index.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-edge-'));
function plant(root, rel, content = 'stub') {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
const fakeRoot = path.join(TMP, 'roots');
const EDGE_DIR = plant(fakeRoot, 'Microsoft/Edge/Application/157.0.4341.46/msedge.exe');
const CHROME_DIR = plant(fakeRoot, 'Google/Chrome/Application/157.0.8103.50/chrome.exe');
const EGO_FILE = plant(fakeRoot, 'Citro Labs/ego lite/Application/ego.exe');
plant(fakeRoot, 'Citro Labs/ego lite/Application/0.6.2.8/ego.ver');

console.log('1. 启动参数');
await test('A1 Edge 追加抑制弹窗与同步的参数', () => {
  const args = chrome.browserArgs({ exe: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', profileDir: 'C:/p', port: 9222 });
  assert.ok(args.includes('--disable-sync'), 'Edge 要关掉同步：' + args.join(' '));
  assert.ok(args.some((a) => a.startsWith('--disable-features=') && a.includes('msEdgeSidebarV2')), 'Edge 要关掉侧边栏等界面特性');
  assert.ok(args.includes('--user-data-dir=C:/p') && args.includes('--remote-debugging-port=9222'), '基础参数不能少');
});

await test('A2 Chrome 不带 Edge 专用参数，公共参数两者一致', () => {
  const args = chrome.browserArgs({ exe: 'C:/Program Files/Google/Chrome/Application/chrome.exe', profileDir: 'C:/p', port: 9222 });
  assert.ok(!args.includes('--disable-sync'), 'Chrome 不该带 Edge 的同步开关');
  assert.ok(!args.some((a) => a.includes('msEdgeSidebarV2')), 'Chrome 不该带 Edge 的特性名单');
  for (const must of ['--no-first-run', '--no-default-browser-check', '--restore-last-session']) {
    assert.ok(args.includes(must), '公共参数缺 ' + must);
  }
});

await test('A3 macOS 上按二进制名「Microsoft Edge」也能认出是 Edge', () => {
  const args = chrome.browserArgs({ exe: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', profileDir: '/p', port: 9222 });
  assert.ok(args.includes('--disable-sync'), 'macOS 的 Edge 也要带抑制参数');
});

console.log('\n2. 扫描列表');
await test('B1 平台层扫描目标含 Microsoft Edge', () => {
  const targets = osPlatform.browserScanTargets();
  const edge = targets.find((t) => t.id === 'edge');
  assert.ok(edge, '扫描目标里没有 edge：' + targets.map((t) => t.id).join(','));
  assert.equal(edge.name, 'Microsoft Edge');
  assert.match(String(edge.exe), /msedge\.exe|Microsoft Edge/i);
});

await test('B2 扫描结果顺序是 Chrome → Edge → ego lite，Edge 版本取自版本目录', () => {
  const targets = [
    { id: 'chrome', name: 'Google Chrome', exe: 'chrome.exe', product: 'Chromium', bases: [path.join(fakeRoot, 'Google', 'Chrome', 'Application')] },
    { id: 'edge', name: 'Microsoft Edge', exe: 'msedge.exe', product: 'Chromium', bases: [path.join(fakeRoot, 'Microsoft', 'Edge', 'Application')] },
    { id: 'egolite', name: 'ego lite', exe: 'ego.exe', product: 'ego 浏览器', files: [EGO_FILE] },
  ];
  const s = scan.scanBrowsers({ browserPath: '' }, { targets, resolved: CHROME_DIR });
  assert.deepEqual(s.browsers.map((b) => b.id), ['chrome', 'edge', 'egolite'], '顺序应按 Chrome → Edge → ego lite');
  const edge = s.browsers.find((b) => b.id === 'edge');
  assert.equal(edge.version, '157.0.4341.46', 'Edge 版本应取同级最大版本目录：' + edge.version);
  assert.equal(edge.chosen, false, 'Chrome 后端下 Edge 不该标使用中');
});

await test('B3 配置指向 Edge 时 Edge 标为使用中', () => {
  const targets = [
    { id: 'chrome', name: 'Google Chrome', exe: 'chrome.exe', product: 'Chromium', bases: [path.join(fakeRoot, 'Google', 'Chrome', 'Application')] },
    { id: 'edge', name: 'Microsoft Edge', exe: 'msedge.exe', product: 'Chromium', bases: [path.join(fakeRoot, 'Microsoft', 'Edge', 'Application')] },
  ];
  const s = scan.scanBrowsers({ browserPath: EDGE_DIR }, { targets });
  assert.equal(s.browsers.find((b) => b.id === 'edge').chosen, true, '用 Edge 时该标使用中');
  assert.equal(s.browsers.find((b) => b.id === 'chrome').chosen, false);
  assert.equal(s.selectedFound, true);
  assert.equal(s.selectedPath, EDGE_DIR);
});

console.log('\n3. 接线与文档');
await test('C1 界面给 Edge 图标，行为与 Chrome 行一致（写 browserPath）', () => {
  assert.ok(clientSrc.includes("id === 'edge'"), '界面缺 Edge 图标分支');
  assert.ok(clientSrc.includes('browserPath: b.path, browser: \'chrome\''), '选中非 ego 行都写 browserPath');
  assert.ok(!clientSrc.includes("browser: 'edge'"), '不该新增一个后端取值（Edge 走 Chrome 后端）');
});

await test('C2 路由只读扫描，不改配置（扫描不会自己切后端）', () => {
  assert.match(readServerSource(ROOT), /scanBrowsers\(cfg\)/, '路由应调用 scanBrowsers');
});

await test('C3 README 与 CHANGELOG 写明了 Edge 支持', () => {
  assert.ok(/Edge/.test(readme), 'README 没提 Edge');
  assert.ok(changelog.includes('v0.20.24'), 'CHANGELOG 缺 v0.20.24 段');
  assert.ok(/Edge/.test(changelog.split('## v0.20.20')[0]), 'v0.20.24 段没提 Edge');
});

await test('C4 版本号已到 0.20.24', () => {
  const parts = pkg.version.split('.').map((n) => parseInt(n, 10));
  assert.ok(parts[0] === 0 && parts[1] === 20 && parts[2] >= 24, '版本号应 ≥ 0.20.24，实际 ' + pkg.version);
});

console.log('');
if (failures.length) {
  console.log('✗ ' + failures.length + ' 项失败（共 ' + (passed + failures.length) + ' 项）');
  for (const f of failures) console.log(' - ' + f.name + '：' + (f.err && f.err.message));
  process.exit(1);
}
console.log('✓ 全部通过（' + passed + ' 项）');
