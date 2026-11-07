/**
 * v0.19.8 自检：窗口里已经登录时不要再代填。
 *
 * 现场（用户反馈：「有时候打开了，其实是登录了的，但是他还会自动退回登录自己登录一遍」）：
 * v0.9.2 起「打开」就等于「打开 + 代填一次」，代码里没有任何「窗口里是不是已经登录」的判断。
 * 代填链路（Chrome / ego 两条）第一步都是把页面导到登录地址，然后填账号密码提交 ——
 * 已登录的人看到的就是「明明登录着，又退回登录页自己登了一遍」。
 *
 * 修法：
 *   · ego 的 `open` op 顺手把 cookie 罐读出来（跟 probe / autofill 一样），`egoOpenAccount` 透传；
 *   · 「打开」处理块先判一次登录态（ego 用 judgeLogin，Chrome 用 readLoginFrom），已登录就跳过代填；
 *   · 「自动登录」路由与工具入口先走 `quickLoginState`，已登录直接返回「不用代填」。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readServerSource } from './_src.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const indexSrc = readServerSource(ROOT);
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

function slice(src, startMark, endMark) {
  const i = src.indexOf(startMark);
  assert.ok(i >= 0, '源码里找不到 ' + startMark);
  const j = src.indexOf(endMark, i);
  assert.ok(j > i, '源码里找不到 ' + endMark);
  return src.slice(i, j);
}

console.log('1. ego 打开窗口时把 cookie 罐读出来');
test('open op 在 handOff 之前读 Network.getAllCookies', () => {
  const seg = slice(egoSrc, "if (op === 'open') {", "if (op === 'autofill') {");
  const cookieAt = seg.indexOf("page.cdp('Network.getAllCookies', {})");
  assert.ok(cookieAt >= 0, 'open op 里没有读 cookie');
  const handOffAt = seg.indexOf('await handOff();');
  assert.ok(handOffAt > cookieAt, 'cookie 要在 handOff 之前读（交出去之后 ego 会硬停 agent 命令）');
  assert.ok(seg.includes('domainHit'), 'cookie 要按站点域过滤');
  assert.ok(seg.includes('pickCookie'), 'cookie 要只留判断登录需要的字段');
});

test('open op 的 emit 带上 cookies 与 cookieError', () => {
  const seg = slice(egoSrc, "if (op === 'open') {", "if (op === 'autofill') {");
  const emitLine = seg.slice(seg.lastIndexOf('emit('));
  assert.ok(emitLine.includes('cookies'), 'emit 里没有 cookies');
  assert.ok(emitLine.includes('cookieError'), 'emit 里没有 cookieError');
  assert.ok(emitLine.includes('navErrors'), 'emit 里丢了 navErrors');
});

test('egoOpenAccount 把 cookies 透传给调用方', () => {
  assert.ok(indexSrc.includes("cookies: Array.isArray(r.cookies) ? r.cookies : null, cookieError: r.cookieError || ''"), 'egoOpenAccount 没有透传 cookies');
});

console.log('2. 「打开」处理块：已登录就跳过代填');
test('打开前先判登录态（ego 走 judgeLogin、Chrome 走 readLoginFrom）', () => {
  const seg = slice(indexSrc, "if (action === 'open') {", "if (action === 'reset') {");
  assert.ok(seg.includes('judgeLogin(r.cookies'), '没有用窗口的 cookie 判登录态');
  assert.ok(seg.includes('readLoginFrom(Number(r.port)'), 'Chrome 后端没有读端口上的登录态');
  assert.ok(seg.includes('const alreadyLoggedIn = Boolean(liveLogin && liveLogin.loggedIn);'), '没有算出 alreadyLoggedIn');
  assert.ok(seg.includes('login: liveLogin'), '响应里要带上登录态，界面才知道为什么没代填');
});

test('已登录时代填被跳过并给出 AUTOLOGIN_ALREADY_LOGGED_IN', () => {
  const seg = slice(indexSrc, "if (action === 'open') {", "if (action === 'reset') {");
  assert.ok(seg.includes('if (alreadyLoggedIn) {'), '代填分支里没有 alreadyLoggedIn 判断');
  assert.ok(seg.includes("code: 'AUTOLOGIN_ALREADY_LOGGED_IN'"), '缺 AUTOLOGIN_ALREADY_LOGGED_IN');
  assert.ok(seg.includes('窗口里已经是登录状态，这次没有代填'), '缺给人看的说明');
});

console.log('3. 「自动登录」两个入口同样先查登录态');
test('路由 /accounts/:id/autologin 先走 quickLoginState', () => {
  const seg = slice(indexSrc, "if (kind === 'autologin' && method === 'POST') {", 'return sendJson(res, 405,');
  assert.ok(seg.includes('const already = await quickLoginState(account);'), '路由没有先查登录态');
  assert.ok(seg.includes('AUTOLOGIN_ALREADY_LOGGED_IN'), '路由缺 AUTOLOGIN_ALREADY_LOGGED_IN');
  const checkAt = seg.indexOf('quickLoginState(account)');
  const fillAt = seg.indexOf('autoLogin(account');
  assert.ok(checkAt >= 0 && fillAt > checkAt, '要先查登录态再代填');
});

test('工具 action=autologin 先走 quickLoginState', () => {
  const seg = slice(indexSrc, "if (action === 'autologin') {", "return { ok: false, error: '不认识的 action：' + action };");
  assert.ok(seg.includes('const already = await quickLoginState(account);'), '工具入口没有先查登录态');
  const checkAt = seg.indexOf('quickLoginState(account)');
  const fillAt = seg.indexOf('autoLogin(account');
  assert.ok(checkAt >= 0 && fillAt > checkAt, '要先查登录态再代填');
});

test('quickLoginState 只读不写：ego 用临时空间、Chrome 读端口', () => {
  const seg = slice(indexSrc, 'async function quickLoginState(account) {', 'async function navigatePageTo(port, url) {');
  assert.ok(seg.includes('await egoCheckAccount(account, { launch: false })'), 'ego 分支不是「不启动浏览器」的检测');
  assert.ok(seg.includes('readLoginFrom(port, platform, siteUrl)'), 'Chrome 分支没有读端口 cookie');
  assert.ok(seg.includes('return out && out.loggedIn ? out : null;'), '读不到时应该返回 null 让调用方照旧代填');
});

console.log('4. 版本文档');
test('版本号已到 0.19.8', () => {
  assert.ok(versionAtLeast(pkg.version, '0.19.8'), 'package.json 版本还是 ' + pkg.version);
});

test('CHANGELOG 与 README 跟上 v0.19.8', () => {
  const changelog = read('CHANGELOG.md');
  const readme = read('README.md');
  assert.ok(changelog.includes('v0.19.8'), 'CHANGELOG 没有 v0.19.8');
  assert.ok(changelog.includes('已经登录'), 'CHANGELOG 没写清「已登录不代填」');
  assert.ok(readme.includes(pkg.version), 'README 没跟上 ' + pkg.version);
});

if (failures.length) {
  console.log('\n✗ 失败 ' + failures.length + ' / 通过 ' + passed);
  for (const f of failures) {
    console.log('\n[' + f.name + ']');
    console.log(f.err && f.err.stack ? f.err.stack : String(f.err));
  }
  process.exit(1);
}
console.log('\n✓ 全部通过（' + passed + ' 项）');
