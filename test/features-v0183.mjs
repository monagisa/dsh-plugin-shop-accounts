/**
 * v0.18.1 自检：账号的平台参数要按「平台 × 身份」取（买家/卖家入口不同）。
 *
 * 现场（2026-11-05，用户反馈）：点抖音买家账号的「登录」，跳到的却是抖店（fxg.jinritemai.com）登录页。
 * 原因：打开/检测只按 `account.platform` 取平台定义 → 拿到的是卖家那套（抖店后台），
 * 而买家那套（抖音精选）根本没被用到。版本 0.16.6 只把「能不能填密码 / 有哪些身份」做对了，
 * 「打开哪个页面 / 读哪些 cookie 域」没跟着身份走。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const mod = await import(pathToFileURL(path.join(ROOT, 'lib/index.js')).href);
const host = (mod.default && typeof mod.default.apply === 'function') ? mod.default : mod;
const pkg = JSON.parse(read('package.json'));
const indexSrc = read('lib/index.js');

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

// ── A. 平台 × 身份 解析 ─────────────────────────────────────────────────────

test('A1 抖音买家 → 抖音精选（不再落到抖店后台）', () => {
  const v = host.accountPlatformOf({ platform: 'douyin', accountType: 'buyer' });
  assert.equal(v.loginUrl, 'https://www.douyin.com/jingxuan');
  assert.equal(v.workUrl, 'https://www.douyin.com/jingxuan');
  assert.deepEqual(v.cookieDomains, ['douyin.com']);
});

test('A2 抖音卖家仍是抖店后台（没被买家改动波及）', () => {
  const v = host.accountPlatformOf({ platform: 'douyin', accountType: 'seller' });
  assert.ok(v.loginUrl.includes('fxg.jinritemai.com'), '卖家登录页不对：' + v.loginUrl);
  assert.ok(v.cookieDomains.includes('jinritemai.com'));
});

test('A3 淘宝买家是 havanaone 登录页 + 已买到的宝贝；卖家是千牛', () => {
  const buyer = host.accountPlatformOf({ platform: 'taobao', accountType: 'buyer' });
  const seller = host.accountPlatformOf({ platform: 'taobao', accountType: 'seller' });
  assert.ok(buyer.loginUrl.includes('login.taobao.com'), '买家登录页不对：' + buyer.loginUrl);
  assert.ok(buyer.workUrl.includes('buyertrade.taobao.com'), '买家工作页不对：' + buyer.workUrl);
  assert.ok(seller.loginUrl.includes('loginmyseller.taobao.com'), '卖家登录页不对：' + seller.loginUrl);
  assert.notEqual(buyer.loginUrl, seller.loginUrl);
});

test('A3b 天猫买家仍走淘宝登录页（跨站 iframe 那条结论没被改动）', () => {
  const v = host.accountPlatformOf({ platform: 'tmall', accountType: 'buyer' });
  assert.ok(v.loginUrl.includes('login.taobao.com'), '天猫买家登录页不对：' + v.loginUrl);
  assert.ok(!v.loginUrl.includes('login.tmall.com'), '又回到跨站 iframe 那套了：' + v.loginUrl);
});

test('A4 历史上没有身份的店铺按卖家取（与 normalizeAccountType 的默认值一致）', () => {
  const v = host.accountPlatformOf({ platform: 'douyin' });
  assert.ok(v.loginUrl.includes('fxg.jinritemai.com'), '缺省身份应当回落到卖家：' + v.loginUrl);
});

test('A5 买家/卖家的登录态 cookie 域不同（抖音买家只读 douyin.com）', () => {
  const buyer = host.accountPlatformOf({ platform: 'douyin', accountType: 'buyer' });
  const seller = host.accountPlatformOf({ platform: 'douyin', accountType: 'seller' });
  assert.deepEqual(buyer.cookieDomains, ['douyin.com']);
  assert.ok(seller.cookieDomains.join(',').includes('jinritemai.com'), '卖家应当读抖店域：' + seller.cookieDomains);
});

test('A6 拼多多买家没有入口（回落到卖家定义但带着 unsupported 标记）', () => {
  const v = host.accountPlatformOf({ platform: 'pdd', accountType: 'buyer' });
  assert.equal(v.unsupported, true);
  assert.equal(v.loginMethods.length, 0);
});

// ── B. 打开 / 检测 / 快照都走账号变体 ───────────────────────────────────────

test('B1 ego 打开用账号变体的登录页/工作台', () => {
  assert.ok(indexSrc.includes('const pv = accountPlatformOf(account) || platform;'), 'egoOpenAccount 没取变体');
  assert.ok(indexSrc.includes('? [pv.loginUrl]'), 'egoOpenAccount 没用变体的登录页');
  assert.ok(indexSrc.includes('const workUrl = shopUrl || pv.workUrl || pv.homeUrl;'), 'egoOpenAccount 没用变体的工作台');
});

test('B2 Chrome 打开、登录态检测、profile 分配都按身份取平台', () => {
  const hits = (indexSrc.match(/accountPlatformOf\(account\) \|\| platformOf\(account\.platform\)/g) || []).length;
  assert.ok(hits >= 3, 'openAccount / checkAccount / egoCheckAccount 未全部改用变体：命中 ' + hits);
  assert.ok(indexSrc.includes('accountPlatformOf(a) || {}).cookieDomains'), 'profile 分配/共用判定没按身份域');
});

test('B3 会话快照按身份的 cookie 名（抖音买家读 sessionid 那套）', () => {
  const hits = (indexSrc.match(/snapshotAccount\(account, accountPlatformOf\(account\)\)/g) || []).length;
  assert.ok(hits >= 2, '快照仍按平台基础定义取 cookie：命中 ' + hits);
});

// ── C. 版本与文档 ───────────────────────────────────────────────────────────

test('C1 版本号已到 0.18.1', () => {
  const [maj, min, patchNum] = String(pkg.version).split('.').map(Number);
  assert.ok(maj === 0 && (min > 18 || (min === 18 && patchNum >= 1)), 'package.json 版本还是 ' + pkg.version);
});

test('C2 CHANGELOG / README 写了这次修正', () => {
  const changelog = read('CHANGELOG.md');
  const readme = read('CHANGELOG.md');
  assert.match(changelog, /v0\.18\.1/, 'CHANGELOG 没有 v0.18.1');
  assert.match(changelog, /jingxuan/, 'CHANGELOG 没写抖音精选');
  assert.match(readme, new RegExp(String(pkg.version).replace(/\./g, '\\.')), 'README 没更新到当前版本');
});

console.log('\n' + passed + ' 项通过' + (failures.length ? '，' + failures.length + ' 项失败' : ''));
if (failures.length) process.exit(1);
