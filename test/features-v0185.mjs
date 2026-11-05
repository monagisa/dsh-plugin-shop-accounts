/**
 * v0.18.3 自检：ego 空间里没有活着的页面时，别再递回一个已经关闭的 `p1`。
 *
 * 现场（2026-11-05，用户反馈）：每点一次「打开」都会冒出一个停在 `https://x/` 的窗口。
 * 根因：`pickPage` 在 `task.pages()` 为空时退回 `task.page('p1')` —— 那个 p1 早被关掉了，
 * 之后任何 `goto` 都报 `page p1 was closed`，ego 窗口就只剩一张空页（ego 把它显示成 `https://x/`）。
 * 现在：没有活着的页面就 `task.newPage()` 新建一页；导航失败也换新页再试一次。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const egoSrc = read('lib/ego.mjs');
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

/** 取一段源码：从 start 标记开始，return 到出现 end 标记为止（不含 end）。 */
function slice(startMark, endMark) {
  const i = egoSrc.indexOf(startMark);
  assert.ok(i >= 0, '源码里找不到 ' + startMark);
  const j = egoSrc.indexOf(endMark, i);
  assert.ok(j > i, '源码里找不到 ' + endMark);
  return egoSrc.slice(i, j);
}

const pickBody = slice('async function pickPage(task) {', '\n}\n\n// 导航失败时');
const retryBody = slice('async function gotoMaybeNewPage(', '\n}\n');
const openBody = slice("if (op === 'open') {", "\n  if (op === 'autofill') {");
const autofillHead = slice("if (op === 'autofill') {", '\n    if (P.preExpr) {');
const probeBody = slice("if (op === 'probe') {", "\n  const { entry } = await findEntry");

// ── A. 不再把已关闭的 p1 当成可用页面 ────────────────────────────────────────

test('A1 pickPage 不再无条件退回 task.page(\'p1\')', () => {
  assert.ok(!/if \(!cands\.length\) cands\.push\(task\.page\('p1'\)\)/.test(pickBody),
    'pickPage 里还留着「没页面就退回 p1」的老写法');
  // p1 只作为最后兜底，且必须先试 newPage
  const newPageAt = pickBody.indexOf('task.newPage');
  const p1At = pickBody.lastIndexOf("task.page('p1')");
  assert.ok(newPageAt > 0, 'pickPage 没用 task.newPage');
  assert.ok(p1At > newPageAt, 'task.page(\'p1\') 不该排在 newPage 之前');
});

test('A2 pickPage 会跳过已关闭的页（逐个 url() 试探）', () => {
  assert.ok(gunpickOk(pickBody), 'pickPage 没有逐个试探页面是否还活着');
});

test('A3 没有活着的页面时新建一页（带注释说明为什么）', () => {
  assert.ok(pickBody.includes('没有活着的页面就新建一页'), '缺「新建一页」的说明注释');
  assert.ok(/typeof task\.newPage === 'function'/.test(pickBody), '没做 newPage 能力判断');
});

test('A4 导航失败会换新页重试一次，并把两次错误都记进 navErrors', () => {
  assert.ok(retryBody.length > 0, '找不到 gotoMaybeNewPage');
  assert.ok(retryBody.includes('await page.goto(url'), '没先试原页面导航');
  assert.ok(retryBody.includes('task.newPage'), '失败后没换新页重试');
  const pushes = (retryBody.match(/navErrors\.push/g) || []).length;
  assert.ok(pushes >= 2, '两次失败都该记进 navErrors，实际只有 ' + pushes + ' 处');
  assert.ok(retryBody.includes('await np.goto(url'), '新页没有重新导航');
});

// ── B. 三处调用都走同一套兜底 ─────────────────────────────────────────────────

test('B1 打开走 gotoMaybeNewPage（不再自己裸调 goto）', () => {
  assert.ok(openBody.includes('let page = await pickPage(task)'), 'open 里没用 let page');
  assert.ok(openBody.includes('gotoMaybeNewPage(task, page, urls[0], navErrors)'), 'open 没接兜底导航');
  assert.ok(!/try \{ await page\.goto\(urls\[0\]/.test(openBody), 'open 里还留着裸 goto');
});

test('B2 账密代填（autofill）同样接兜底导航', () => {
  assert.ok(autofillHead.includes('gotoMaybeNewPage(task, page, P.url, navErrors)'), 'autofill 没接兜底导航');
  assert.ok(autofillHead.includes('let page = await pickPage(task)'), 'autofill 里没用 let page');
});

test('B3 登录态检测的临时空间也用 pickPage（不再写 pickPage 的形状判断）', () => {
  assert.ok(probeBody.includes('const page = await pickPage(temp)'), 'probe 没用 pickPage(temp)');
  assert.ok(!/pickPage \? await pickPage\(temp\) : temp\.page\('p1'\)/.test(probeBody), 'probe 里还留着三元写法');
});

// ── C. 文档 ───────────────────────────────────────────────────────────────────

test('C1 版本号已到 0.18.3', () => {
  assert.ok(versionAtLeast(pkg.version, '0.18.3'), '版本还停在 ' + pkg.version);
});

test('C2 CHANGELOG / README 写了这次修正', () => {
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.includes('v0.18.3'), 'CHANGELOG 没写 v0.18.3');
  assert.ok(changelog.includes('x/'), 'CHANGELOG 没提空白页');
  const readme = read('README.md');
  assert.ok(readme.includes('0.18.3'), 'README 没写 0.18.3');
  assert.ok(readme.includes('newPage') || readme.includes('新的一页'), 'README 没说明修复方式');
});

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败`);
  for (const f of failures) console.log('  - ' + f.name + ': ' + (f.err && f.err.message));
  process.exit(1);
}
console.log(`✓ 全部通过（${passed} 项）`);

/** pickPage 里是否逐个试探每个候选页（有 for 循环 + try url()）。 */
function gunpickOk(body) {
  return /for \(const pg of cands\)/.test(body) && /await pg\.url\(\)/.test(body) && /catch/.test(body);
}
