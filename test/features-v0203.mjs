/**
 * v0.20.3 自检：设置页「本机浏览器」扫描。
 *
 * 需求（用户）：像系统设置里「用户浏览器」那块一样，扫当前电脑能用的浏览器，
 * 列出名字 / 版本 / 路径，并标出正在使用的那个。
 *
 * 实现：
 *   · `lib/browser-scan.mjs` 扫 Chromium 内核桌面浏览器（Chrome / Edge / Brave / Chromium / Vivaldi），
 *     版本从安装路径的 `Application/<版本>/` 目录名推断（不起进程、不读 PE 头）；
 *   · `GET /browser-scan` 只读扫描；点「使用这个」走原 `PUT /config` 写 `browserPath`；
 *   · 「使用中」按实际会用的路径判断（配置为空时用 `resolveBrowserPath` 的回退结果）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readServerSource } from './_src.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const indexSrc = readServerSource(ROOT);
const clientSrc = read('lib/client.js');
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

const mod = await import('../lib/browser-scan.mjs');
const osPlatform = await import('../lib/platform/index.mjs');
const modTargets = osPlatform.browserScanTargets();

// 临时目录里造一份「装了 Chrome 与 Edge 的假机器」：目录结构与真实安装一致。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bscan-'));
function plant(root, rel, content = 'stub') {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
const fakeRoot = path.join(TMP, 'roots');
const CHROME_DIR = plant(fakeRoot, 'Google/Chrome/Application/157.0.8103.38/chrome.exe');
const CHROME_STUB = plant(fakeRoot, 'Google/Chrome/Application/chrome.exe'); // 启动器那份，没版本目录名
const EDGE_DIR = plant(fakeRoot, 'Microsoft/Edge/Application/157.0.4341.42/msedge.exe');

console.log('\n1. 扫描与版本推断');

await test('A1 平台层给出五家 Chromium 系浏览器的扫描目标', () => {
  const osPlatform = modTargets;
  const ids = osPlatform.map((t) => t.id);
  assert.deepEqual(ids, ['chrome', 'edge', 'brave', 'chromium', 'vivaldi']);
  const exes = osPlatform.map((t) => t.exe);
  assert.ok(exes.includes('chrome.exe') || exes.includes('Google Chrome'), '主程序名不对：' + exes.join(','));
});

await test('A2 版本从 Application/<版本>/ 路径段推断', () => {
  assert.equal(mod.versionFromPath('C:/PF/Google/Chrome/Application/157.0.8103.38/chrome.exe'), '157.0.8103.38');
  assert.equal(mod.versionFromPath('C:\\PF\\Microsoft\\Edge\\Application\\157.0.4341.42\\msedge.exe'), '157.0.4341.42');
  assert.equal(mod.versionFromPath('C:/PF/Google/Chrome/Application/chrome.exe'), '', '根目录启动器没有版本段');
});

await test('A3 系统环境展示名', () => {
  assert.equal(mod.osLabel('win32'), 'Windows');
  assert.equal(mod.osLabel('darwin'), 'macOS');
  assert.equal(mod.osLabel('linux'), 'Linux');
  assert.equal(mod.osLabel('freebsd'), 'freebsd');
});

await test('A4 路径比较不区分大小写与斜杠', () => {
  assert.equal(mod.samePath('C:/PF/chrome.exe', 'c:\\pf\\CHROME.EXE'), true);
  assert.equal(mod.samePath('C:/PF/chrome.exe', 'C:/PF/edge.exe'), false);
  assert.equal(mod.samePath('', 'C:/PF/chrome.exe'), false);
});

await test('A5 扫临时目录：每家只留一条、带版本、能标出使用中', () => {
  const targets = [
    { id: 'chrome', name: 'Google Chrome', exe: 'chrome.exe', bases: [path.join(fakeRoot, 'Google', 'Chrome', 'Application')] },
    { id: 'edge', name: 'Microsoft Edge', exe: 'msedge.exe', bases: [path.join(fakeRoot, 'Microsoft', 'Edge', 'Application')] },
  ];
  const s = mod.scanBrowsers({ browserPath: '' }, { targets, resolved: CHROME_STUB });
  const ids = s.browsers.map((b) => b.id);
  assert.deepEqual(ids, ['chrome', 'edge'], '只该有 chrome 与 edge：' + ids.join(','));
  const chrome = s.browsers.find((b) => b.id === 'chrome');
  assert.equal(chrome.version, '157.0.8103.38', 'Chrome 版本应取同级最大版本目录：' + chrome.version);
  assert.equal(chrome.chosen, true, 'resolveBrowserPath 回退到的那份应标使用中');
  const edge = s.browsers.find((b) => b.id === 'edge');
  assert.equal(edge.chosen, false);
  assert.ok(s.os.label === 'Windows' || s.os.label === 'macOS' || s.os.label === 'Linux', '系统名不对：' + s.os.label);
  assert.ok(s.scannedAt, '扫描结果要带时间');
});

await test('A6 指定了 browserPath 时用它标使用中', () => {
  const targets = [
    { id: 'chrome', name: 'Google Chrome', exe: 'chrome.exe', bases: [path.join(fakeRoot, 'Google', 'Chrome', 'Application')] },
  ];
  const s = mod.scanBrowsers({ browserPath: CHROME_DIR }, { targets });
  assert.equal(s.selectedFound, true);
  assert.equal(s.browsers.find((b) => b.id === 'chrome').chosen, true);
  assert.equal(s.selected, CHROME_DIR);
});

await test('A7 entries 注入模式：同 id 多份只留版本最高的', () => {
  const s = mod.scanBrowsers({ browserPath: 'C:/PF/Google/Chrome/Application/100.0/chrome.exe' }, {
    entries: [
      { id: 'chrome', name: 'Google Chrome', path: 'C:/PF/Google/Chrome/Application/chrome.exe', version: '157.0.8103.38' },
      { id: 'chrome', name: 'Google Chrome', path: 'C:/PF/Google/Chrome/Application/100.0/chrome.exe', version: '100.0.1.1' },
      { id: 'edge', name: 'Microsoft Edge', path: 'C:/PF/Microsoft/Edge/Application/157.0.4341.42/msedge.exe', version: '157.0.4341.42' },
    ],
  });
  assert.equal(s.browsers.length, 2);
  assert.equal(s.browsers.find((b) => b.id === 'chrome').version, '157.0.8103.38');
  assert.equal(s.browsers.find((b) => b.id === 'chrome').path, 'C:/PF/Google/Chrome/Application/chrome.exe');
  assert.equal(s.browsers.find((b) => b.id === 'chrome').chosen, false, '配置指向 100.0，不是留下的那份');
  assert.equal(s.browsers.find((b) => b.id === 'edge').chosen, false);
});

console.log('\n2. 接线：路由与界面');

await test('B1 路由里有只读扫描接口', () => {
  assert.match(indexSrc, /if \(method === 'GET' && p === '\/browser-scan'\)/, '路由缺 GET /browser-scan');
  assert.match(indexSrc, /scanBrowsers\(cfg\)/, '路由应调用 scanBrowsers');
  assert.match(indexSrc, /import \{ scanBrowsers \} from '\.\.\/browser-scan\.mjs'/, '路由要导入扫描模块');
  const seg = indexSrc.slice(indexSrc.indexOf("p === '/browser-scan'"), indexSrc.indexOf("p === '/browser-scan'") + 400);
  assert.ok(!/writeConfig|launchBrowser/.test(seg), '扫描接口必须只读（不能写配置、不能起进程）');
});

await test('B2 界面有「本机浏览器」块、重新扫描与切换按钮', () => {
  assert.ok(clientSrc.includes("'/browser-scan'"), '客户端要调 /browser-scan');
  assert.match(clientSrc, /function loadScan\(\)/, '要有 loadScan');
  assert.ok(clientSrc.includes('重新扫描'), '要有「重新扫描」按钮');
  assert.ok(clientSrc.includes('本机浏览器'), '要有「本机浏览器」小标题');
  assert.ok(clientSrc.includes('使用中'), '要标出使用中的浏览器');
  assert.ok(clientSrc.includes('使用这个'), '要能一键切换');
  assert.match(clientSrc, /browserPath: b\.path/, '切换时写 browserPath');
  assert.match(clientSrc, /scan\.os\.label/, '要显示系统环境');
});

console.log('\n3. 版本与文档');

await test('C1 版本号已到 0.20.3', () => {
  const parts = String(pkg.version).split('.').map((x) => Number(x));
  assert.ok(parts[0] > 0 || (parts[0] === 0 && (parts[1] > 20 || (parts[1] === 20 && parts[2] >= 3))), '版本应 ≥ 0.20.3：' + pkg.version);
});

await test('C2 CHANGELOG 与 README 同步', () => {
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.includes('v0.20.3'), 'CHANGELOG 要有 v0.20.3');
  assert.ok(/浏览器|扫描/.test(changelog), 'CHANGELOG 要说明本机浏览器扫描');
  const readme = read('README.md');
  assert.ok(readme.includes(pkg.version), 'README 版本行没跟上 ' + pkg.version);
});

fs.rmSync(TMP, { recursive: true, force: true });

if (failures.length) {
  console.log('\n✗ 失败 ' + failures.length + ' / 通过 ' + passed);
  for (const f of failures) console.log('  [' + f.name + ']');
  for (const f of failures) console.log(f.err && f.err.stack ? f.err.stack : String(f.err));
  process.exit(1);
}
console.log('\n✓ 全部通过（' + passed + ' 项）');
