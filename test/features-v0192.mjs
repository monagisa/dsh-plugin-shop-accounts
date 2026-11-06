/**
 * v0.19.2 自检：窗口是用户在外面关掉的，界面不能一直显示「关闭浏览器」。
 *
 * 现场（2026-11-06，用户反馈）：没在插件里点「关闭浏览器」，而是直接在 ego 里关掉空间 /
 * 结束浏览器进程，回到 DSH 详情页仍然显示「关闭浏览器」（顶部还写着「浏览器运行中」）。
 *
 * 两个原因：
 * 1. 后端 `refreshEgoInfo` 先看 30 秒的「空间列表」缓存 —— ego 主程序都被关掉了，
 *    缓存里的空间还在，`egoSpaceExists()` 一直为真，`running` 就一直为真。
 * 2. 前端只有在「有人在等登录」或「定时任务开着」时才轮询 `/state`，其余时候安静待着，
 *    所以状态压根不会重新拉。
 *
 * 修法（v0.19.2）：后端先问一次 ego 主程序在不在（tasklist，自带 5 秒缓存），没了就立刻 `running:false`；
 * 前端在从别的窗口切回来（窗口 focus / 标签页重新可见）时立刻对一次状态。
 * 修法（v0.19.3）：面板可见时每 2 秒对一次、带 `?fresh=1` 绕过 30 秒的空间列表缓存，
 * 只关空间窗口（ego 进程还在）也能在 2 秒内跟上。定时器只在 `document.visibilityState === 'visible'`
 * 时挂 —— 自检是在无头环境里渲染这个组件的，常驻 interval 会把进程留住不退出。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const indexSrc = read('lib/index.js');
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

const egoInfoBody = slice(indexSrc, 'async function refreshEgoInfo(force) {', '\n/** 同步拿一份');
const pendingBody = slice(egoInfoBody, 'egoInfoCache.pending = (async () => {', '})().finally(');
const panelBody = slice(clientSrc, 'function ShopAccountsSection(', 'function toggleSched(account) {');

// ── A. 后端：先问 ego 主程序在不在，再决定要不要信缓存 ────────────────────────

test('A1 进程探测排在「30 秒缓存命中」之前', () => {
  const probeAt = egoInfoBody.indexOf('const appRunning = await egoAppRunning()');
  const cacheAt = egoInfoBody.indexOf('if (!force && !egoInfoStale() && egoInfoCache.data) return egoInfoCache.data;');
  assert.ok(probeAt >= 0, 'refreshEgoInfo 里没有先问 egoAppRunning()');
  assert.ok(cacheAt >= 0, 'refreshEgoInfo 里找不到缓存命中那行');
  assert.ok(probeAt < cacheAt, '进程探测排在了缓存命中之后 —— 关掉 ego 之后还会报运行中');
});

test('A2 主程序不在时如实报 running:false 且清空空间列表', () => {
  const branch = slice(egoInfoBody, 'if (!appRunning) {', '\n  }');
  assert.match(branch, /running: false/, '未运行分支没有 running:false');
  assert.match(branch, /spaces: \[\]/, '未运行分支没有清空 spaces');
  assert.match(branch, /ego lite 没在运行/, '未运行分支没有说明原因');
});

test('A3 不再在 ego CLI 那一段里重复问进程（只问一次）', () => {
  assert.ok(!pendingBody.includes('await egoAppRunning()'), '列空间的那段里还在问 egoAppRunning()');
  assert.match(pendingBody, /const r = await egoList\(/, '列空间那段没走 egoList');
});

test('A4 /state 支持 ?fresh=1 强制重列空间（界面 2 秒轮询用）', () => {
  assert.match(indexSrc, /async function buildState\(freshEgo\)/, 'buildState 没有接 freshEgo 参数');
  assert.match(indexSrc, /refreshEgoInfo\(freshEgo \? true : false\)/, 'buildState 没把 freshEgo 传给 refreshEgoInfo');
  const route = slice(indexSrc, "if (method === 'GET' && p === '/state') {", '\n    }');
  assert.match(route, /url\.searchParams\.get\('fresh'\) === '1'/, '/state 路由没读 ?fresh=1');
  assert.match(route, /await buildState\(/, '/state 路由没把 fresh 传下去');
});

// ── B. 前端：面板可见时自己对状态 ────────────────────────────────────────────

test('B1 可见时每 2 秒对一次，且只在可见时挂定时器（无头自检要能退出）', () => {
  assert.match(panelBody, /setInterval\(refresh, 2000\)/, '找不到 2 秒的状态轮询');
  assert.match(panelBody, /document\.visibilityState === 'visible'/, '2 秒轮询没有「可见才挂」的守卫 —— 自检会被留住不退出');
  assert.ok(!panelBody.includes('}, 15000'), '又出现了一个 15 秒的常驻轮询');
});

test('B2 切回窗口时立刻对一次，并且绕过 30 秒空间缓存', () => {
  assert.match(panelBody, /function refresh\(\) \{ load\(true, true\); \}/, 'refresh 没带 fresh 参数（还会读到 30 秒的旧空间列表）');
  assert.match(panelBody, /window\.addEventListener\('focus', refresh\)/, '没有监听窗口 focus');
  assert.match(panelBody, /document\.addEventListener\('visibilitychange', refresh\)/, '没有监听 visibilitychange');
  assert.match(panelBody, /window\.removeEventListener\('focus', refresh\)/, 'focus 监听没有移除');
  assert.match(panelBody, /document\.removeEventListener\('visibilitychange', refresh\)/, 'visibilitychange 监听没有移除');
  assert.match(panelBody, /if \(timer\) clearInterval\(timer\)/, '定时器没有随卸载清掉');
});

test('B3 原来的两种轮询还在（登录中 2.5 秒、定时开着 20 秒）', () => {
  assert.match(panelBody, /setInterval\(function \(\) \{ load\(true\); \}, 2500\)/, '登录轮询丢了');
  assert.match(panelBody, /setInterval\(function \(\) \{ load\(true\); \}, 20000\)/, '排期轮询丢了');
});

// ── C. 文档 ───────────────────────────────────────────────────────────────────

test('C1 版本号已到 0.19.3', () => {
  assert.ok(versionAtLeast(pkg.version, '0.19.3'), '版本还停在 ' + pkg.version);
});

test('C2 CHANGELOG / README 写了这次修正', () => {
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.includes('v0.19.3'), 'CHANGELOG 没写 v0.19.3');
  assert.ok(changelog.includes('关闭浏览器'), 'CHANGELOG 没提「关闭浏览器」按钮');
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
