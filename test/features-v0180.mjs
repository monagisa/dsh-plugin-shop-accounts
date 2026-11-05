/**
 * v0.17.10 自检：抖音买家的入口页（不许再用会落风控的站根）。
 *
 * 背景（用户反馈）：抖音买家账号打开后跳去的是抖音的登录/验证码页，而其它买家都是落到自己平台的页面。
 * 实测（2026-11-05 headless Chrome）：
 *   · `https://www.douyin.com/`、`https://sso.douyin.com/` → 直接被风控「验证码中间页」接走（正文空白）；
 *   · `https://www.douyin.com/user/self` → 正常打开，页面内自带「扫码登录 / 验证码登录」面板，连开 3 次稳定；
 *   · `/shop`、`/order` → 「页面不见啦」404，`haohuo.jinritemai.com` → 被拉到 /follow。
 * 所以抖音买家的登录页 / 主页 / 工作页统一改成 `/user/self`。
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

// ── A. 抖音买家的三个入口 ────────────────────────────────────────────────────

test('A1 抖音买家的登录页走 /user/self（不再用会落风控验证码的站根）', () => {
  const b = P.variantOf(P.platformOf('douyin'), 'buyer');
  assert.equal(b.loginUrl, 'https://www.douyin.com/user/self');
  assert.ok(!/^https:\/\/www\.douyin\.com\/?$/.test(b.loginUrl), '登录页又退回站根了');
  assert.ok(!b.loginUrl.includes('sso.douyin.com'), '登录页不该是 sso（会落验证码中间页）');
});

test('A2 抖音买家的主页/工作页也在 /user/self（打开后看到的是平台页面而不是登录墙）', () => {
  const b = P.variantOf(P.platformOf('douyin'), 'buyer');
  assert.equal(b.homeUrl, 'https://www.douyin.com/user/self');
  assert.equal(b.workUrl, 'https://www.douyin.com/user/self');
});

test('A3 判据仍按登录态 cookie（改成页面入口不影响登录态识别）', () => {
  const b = P.variantOf(P.platformOf('douyin'), 'buyer');
  assert.deepEqual(b.sessionCookies, ['sessionid', 'sessionid_ss', 'sid_tt', 'passport_assist_user']);
  assert.equal(b.minCookieHits, 1);
  assert.deepEqual(b.cookieDomains, ['douyin.com']);
});

test('A4 抖音买家仍然不要密码（扫码 / 验证码）', () => {
  const b = P.variantOf(P.platformOf('douyin'), 'buyer');
  assert.equal(b.passwordLogin, false);
  assert.deepEqual(b.loginMethods, ['sms', 'qrcode']);
  assert.equal(P.supportsPasswordLogin('douyin', 'buyer'), false);
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
  // 1688 的会员登录页只此一个（登录后按会员身份进卖家工作台或买家站），两家共用登录页是对的。
  assert.ok(P.variantOf(P.platformOf('ali1688'), 'buyer').loginUrl.includes('login.1688.com'));
});

test('B3 抖音卖家仍是抖店后台（没被买家改动波及）', () => {
  const s = P.variantOf(P.platformOf('douyin'), 'seller');
  assert.ok(s.loginUrl.includes('fxg.jinritemai.com'), '抖音卖家登录入口被改坏了：' + s.loginUrl);
  assert.ok(s.workUrl.includes('fxg.jinritemai.com'), '抖音卖家工作页被改坏了：' + s.workUrl);
});

// ── C. 把实测证据留在源码里（避免以后又被改回站根）──────────────────────────

test('C1 platforms.mjs 记录了「站根会落验证码中间页」的实测结论', () => {
  assert.match(rawPlatforms, /验证码中间页/, '没写实测证据：站根会落验证码中间页');
  assert.match(rawPlatforms, /\/user\/self/, '没写为什么用 /user\/self');
});

test('C2 platforms.mjs 记下了 /shop 与 /order 是 404（别再有人往这两个地址加）', () => {
  assert.match(rawPlatforms, /页面不见啦/, '没写 /shop、/order 是 404 的事实');
});

// ── D. 版本与文档 ────────────────────────────────────────────────────────────

test('D1 版本号已到 0.17.10', () => {
  const [maj, min, patchNum] = String(pkg.version).split('.').map(Number);
  assert.ok(maj === 0 && (min > 17 || (min === 17 && patchNum >= 10)), 'package.json 版本还是 ' + pkg.version);
});

test('D2 CHANGELOG / README 写了这次修正', () => {
  const changelog = read('CHANGELOG.md');
  const readme = read('README.md');
  assert.match(changelog, /v0\.17\.10/, 'CHANGELOG 没有 v0.17.10');
  assert.match(changelog, /抖音买家/, 'CHANGELOG 没写抖音买家');
  assert.match(readme, /0\.17\.10/, 'README 没更新版本');
});

console.log('\n' + passed + ' 项通过' + (failures.length ? '，' + failures.length + ' 项失败' : ''));
if (failures.length) process.exit(1);
