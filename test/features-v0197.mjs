/**
 * v0.19.7 自检：浏览器设置面板的 hook 顺序不能乱。
 *
 * 现场（2026-11-07，用户反馈「浏览器设置又打不开了」）：点开设置页的「浏览器设置」整块空白。
 * `client-errors.log` 里抓到：
 *   - renderShopAccountsSection 里 React.useState 报 #321（Invalid hook call）
 *   - 紧接着 useRef 报 #310（Rendered more hooks than during the previous render）
 *
 * 根因（v0.10.1 引入「导出 / 导入店铺配置」卡片时埋下）：
 * `ConfigPanel` 里 `useState(form)` 后面紧跟 `if (!form) return null;`，而「导出 / 导入」用的
 * `useRef(fileRef)` 与 `useState(migBusy)` 写在了这个提前返回**之后**。首帧只跑到 4 个 hook 就 return，
 * effect 把 form 填好之后的重渲染要跑 6 个 hook —— hook 数量对不上，React 直接抛错，
 * 整块由错误边界兜住，界面上就是「打不开」。
 *
 * 修法（v0.19.7）：把这两个 hook 上移到 `if (!form) return null;` 之前，并加这条自检守住：
 * 任何组件的顶层 `if (...) return` 都不允许出现在 hook 之前。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const clientSrc = read('lib/client.js');
const pkg = JSON.parse(read('package.json'));

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n    ' + (err && err.message));
  }
}

function versionAtLeast(actual, floor) {
  const a = String(actual).split('.').map(Number);
  const b = String(floor).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

function slice(src, startMark, endMark) {
  const i = src.indexOf(startMark);
  assert.ok(i >= 0, '源码里找不到 ' + startMark);
  const j = src.indexOf(endMark, i);
  assert.ok(j > i, '源码里找不到 ' + endMark);
  return src.slice(i, j);
}

/** 组件函数体里顶层的 `if (...) return ...`（6 空格缩进即函数体一层）。 */
const TOP_EARLY_RETURN = /^      if \(.*\) return /m;

const configBody = slice(clientSrc, 'function ConfigPanel(props) {', 'function doExport() {');
const configHooks = configBody.match(/React\.use[a-zA-Z]+\(/g) || [];

// ── A. ConfigPanel：hook 都要在提前返回之前 ──────────────────────────────────

test('A1 ConfigPanel 里没有「先 return 再调 hook」', () => {
  const early = configBody.search(/^      if \(!form\) return null;/m);
  assert.ok(early >= 0, 'ConfigPanel 里找不到 if (!form) return null;');
  const positions = [...configBody.matchAll(/React\.use[a-zA-Z]+\(/g)].map((m) => m.index);
  assert.ok(positions.length >= 4, 'ConfigPanel 的 hook 数量不对：' + positions.length);
  const late = positions.filter((p) => p > early);
  assert.equal(late.length, 0, 'ConfigPanel 有 ' + late.length + ' 个 hook 排在提前返回之后');
});

test('A2 「导出 / 导入」用的 useRef / useState 已上移', () => {
  const early = configBody.search(/^      if \(!form\) return null;/m);
  assert.ok(early > 0, 'ConfigPanel 里找不到 if (!form) return null;');
  const refAt = configBody.indexOf("var fileRef = React.useRef(null);");
  const migAt = configBody.indexOf("var [migBusy, setMigBusy] = React.useState('');");
  assert.ok(refAt >= 0, '找不到 fileRef 声明');
  assert.ok(migAt >= 0, '找不到 migBusy 声明');
  assert.ok(refAt < early, 'fileRef 又跑到提前返回后面去了');
  assert.ok(migAt < early, 'migBusy 又跑到提前返回后面去了');
  assert.ok(configHooks.length >= 6, 'ConfigPanel 的 hook 数量不对：' + configHooks.length);
});

// ── B. 其它带 hook 的组件也不许在 hook 之前提前返回 ──────────────────────────

test('B1 AccountDialog / AccountDetail / ScheduleDialog 没有顶层提前返回', () => {
  const bodies = [
    slice(clientSrc, 'function AccountDialog(props) {', 'function AccountDetail(props) {'),
    slice(clientSrc, 'function AccountDetail(props) {', 'function ScheduleDialog(props) {'),
    slice(clientSrc, 'function ScheduleDialog(props) {', 'function ConfigPanel(props) {'),
  ];
  for (const body of bodies) {
    const m = body.match(TOP_EARLY_RETURN);
    assert.ok(!m, '组件里出现顶层提前返回：' + (m && m[0]));
    assert.ok(body.match(/React\.use[a-zA-Z]+\(/), '这段里没有 hook，切片标记可能失效');
  }
});

test('B2 账号管理主面板也没有顶层提前返回', () => {
  const body = slice(clientSrc, 'function renderShopAccountsSection() {', 'function toggleSched(account) {');
  const m = body.match(TOP_EARLY_RETURN);
  assert.ok(!m, '主面板里出现顶层提前返回：' + (m && m[0]));
});

test('B3 注释里写清了这条规则（别再把 hook 放到 return 后面）', () => {
  assert.ok(clientSrc.includes('v0.19.7：这两个 hook 必须在下面'), '找不到 v0.19.7 的注释');
  assert.ok(clientSrc.includes('Rendered more hooks than during the previous render'), '注释里没写 React 的报错原文');
});

// ── C. 文档 ───────────────────────────────────────────────────────────────────

test('C1 版本号已到 0.19.7', () => {
  assert.ok(versionAtLeast(pkg.version, '0.19.7'), '版本还停在 ' + pkg.version);
});

test('C2 CHANGELOG / README 写了这次修正', () => {
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.includes('v0.19.7'), 'CHANGELOG 没写 v0.19.7');
  assert.ok(changelog.includes('浏览器设置'), 'CHANGELOG 没提「浏览器设置」');
  const readme = read('README.md');
  assert.ok(readme.includes(pkg.version), 'README 没跟上 ' + pkg.version);
});

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败`);
  for (const f of failures) console.log('  - ' + f.name + ': ' + (f.err && f.err.message));
  process.exit(1);
}
console.log(`✓ 全部通过（${passed} 项）`);
