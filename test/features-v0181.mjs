/**
 * v0.17.11 自检：抖音买家的入口就是抖音首页（和其它买家一样落在自己平台首页）。
 *
 * 用户确认（2026-11-05）：抖音买家应该跳 `https://www.douyin.com/`。
 * 实测补充（2026-11-05 headless Chrome）：未登录的新档案/无头环境直接开站根会被风控接到「验证码中间页」，
 * 这是抖音对新环境的正常风控，人工登录一次后回首页即正常；`/shop`、`/order` 是 404「页面不见啦」。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const P = await import(pathToFileURL(path.join(ROOT, 'lib/platforms.mjs')).href);
const pkg = JSON.parse(read('package.json'));
const rawPlatforms = read('lib/platforms.mjs');

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

// ── A. 抖音买家的入口 = 抖音首页 ─────────────────────────────────────────────

test('A1 抖音买家的登录页就是 https://www.douyin.com/', () => {
  const b = P.variantOf(P.platformOf('douyin'), 'buyer');
  assert.equal(b.loginUrl, 'https://www.douyin.com/');
});

test('A2 抖音买家的主页/工作页也是抖音首页（打开即落平台首页）', () => {
  const b = P.variantOf(P.platformOf('douyin'), 'buyer');
  assert.equal(b.homeUrl, 'https://www.douyin.com/');
  assert.equal(b.workUrl, 'https://www.douyin.com/');
});

test('A3 不再用 /user/self、也不再用 sso 当入口', () => {
  const b = P.variantOf(P.platformOf('douyin'), 'buyer');
  assert.ok(!b.loginUrl.includes('/user/self'), '登录入口又回到 /user/self 了');
  assert.ok(!b.loginUrl.includes('sso.douyin.com'), '登录入口不该是 sso');
});

test('A4 判据仍按登录态 cookie，且买家仍然不要密码', () => {
  const b = P.variantOf(P.platformOf('douyin'), 'buyer');
  assert.deepEqual(b.sessionCookies, ['sessionid', 'sessionid_ss', 'sid_tt', 'passport_assist_user']);
  assert.equal(b.minCookieHits, 1);
  assert.deepEqual(b.cookieDomains, ['douyin.com']);
  assert.equal(b.passwordLogin, false);
  assert.deepEqual(b.loginMethods, ['sms', 'qrcode']);
  assert.equal(P.supportsPasswordLogin('douyin', 'buyer'), false);
});

test('A5 登录页判据里也不再残留 /user/self', () => {
  const b = P.variantOf(P.platformOf('douyin'), 'buyer');
  assert.ok(!b.loginUrlHints.some((h) => String(h).includes('/user/self')), 'loginUrlHints 还留着 /user/self');
});

// ── B. 其它买家各自落在自己平台 ──────────────────────────────────────────────

test('B1 淘宝 / 天猫 / 京东 / 1688 的买家入口各自是自己平台的域名', () => {
  const cases = [
    ['taobao', 'login.taobao.com', 'buyertrade.taobao.com'],
    ['tmall', 'login.taobao.com', 'buyertrade.taobao.com'],
    ['jd', 'passport.jd.com', 'order.jd.com'],
    ['ali1688', 'login.1688.com', 'www.1688.com'],
  ];
  for (const [id, loginHost, workHost] of cases) {
    const b = P.variantOf(P.platformOf(id), 'buyer');
    assert.ok(b.loginUrl.includes(loginHost), id + ' 买家登录页不对：' + b.loginUrl);
    assert.ok(b.workUrl.includes(workHost), id + ' 买家工作页不对：' + b.workUrl);
  }
});

test('B2 买家入口不会串到卖家后台（工作页必须不同；1688 同一登录页是平台本身的设计）', () => {
  for (const id of ['taobao', 'tmall', 'jd', 'ali1688', 'douyin']) {
    const seller = P.variantOf(P.platformOf(id), 'seller');
    const buyer = P.variantOf(P.platformOf(id), 'buyer');
    assert.notEqual(seller.workUrl, buyer.workUrl, id + ' 的卖家/买家工作页一样了');
    if (id !== 'ali1688') {
      assert.notEqual(seller.loginUrl, buyer.loginUrl, id + ' 的卖家/买家登录页一样了');
    }
  }
  assert.ok(P.variantOf(P.platformOf('ali1688'), 'buyer').loginUrl.includes('login.1688.com'));
});

test('B3 抖音卖家仍是抖店后台（没被买家改动波及）', () => {
  const s = P.variantOf(P.platformOf('douyin'), 'seller');
  assert.ok(s.loginUrl.includes('fxg.jinritemai.com'), '抖音卖家登录入口被改坏了：' + s.loginUrl);
  assert.ok(s.workUrl.includes('fxg.jinritemai.com'), '抖音卖家工作页被改坏了：' + s.workUrl);
});

// ── C. 实测结论留在源码里（避免又被改成 sso / /shop / /order）───────────────

test('C1 platforms.mjs 记下了「新档案可能被风控接到验证码中间页」这一事实', () => {
  assert.match(rawPlatforms, /验证码中间页/, '没写风控事实：验证码中间页');
});

test('C2 platforms.mjs 记下了 /shop 与 /order 是 404（别再往这两个地址加）', () => {
  assert.match(rawPlatforms, /页面不见啦/, '没写 /shop、/order 是 404 的事实');
});

// ── D. 版本与文档 ────────────────────────────────────────────────────────────

test('D1 版本号已到 0.17.11', () => {
  const [maj, min, patchNum] = String(pkg.version).split('.').map(Number);
  assert.ok(maj === 0 && (min > 17 || (min === 17 && patchNum >= 11)), 'package.json 版本还是 ' + pkg.version);
});

test('D2 CHANGELOG / README 写了这次修正', () => {
  const changelog = read('CHANGELOG.md');
  const readme = read('README.md');
  assert.match(changelog, /v0\.17\.11/, 'CHANGELOG 没有 v0.17.11');
  assert.match(changelog, /www\.douyin\.com/, 'CHANGELOG 没写入口 URL');
  assert.match(readme, /0\.17\.11/, 'README 没更新版本');
});

console.log('\n' + passed + ' 项通过' + (failures.length ? '，' + failures.length + ' 项失败' : ''));
if (failures.length) process.exit(1);
