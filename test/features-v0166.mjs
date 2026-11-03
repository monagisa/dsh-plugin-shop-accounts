#!/usr/bin/env node
/**
 * features-v0166.mjs —— v0.16.6：账号身份按平台真实能力下发（而不是照抄别人的矩阵）
 *
 * 用户反馈：「拼多多只有卖家？」——不合理。实测 + 取证结论：
 *   · 拼多多 **C 端入口是真实存在的**（`mobile.yangkeduo.com/login.html`），
 *     但页面里只有「手机号 + 验证码」和「扫码登录」，**没有任何密码输入框**；
 *   · 抖音 C 端 `www.douyin.com` 直接落到风控验证码中间页，网页端拿不到登录表单 → 买家身份不开放；
 *   · 淘宝/天猫/京东/1688 的 C 端入口都是常规账号密码表单 → 买家也能存密码、代填。
 *
 * 所以把「哪个身份能用、用什么方式登录」做成能力位，服务端下发、界面跟随：
 *   `loginMethods` / `passwordLogin` / `accountTypes`，建号与代填路由都按它分派。
 *
 * 本套覆盖：
 *   A. 平台能力（纯函数）：登录方式、密码能力、可选身份、平台表下发字段
 *   B. 建号：拼多多买家不填密码也能建；卖家缺密码仍拦；抖音买家直接拒
 *   C. 路由：没有账号密码的身份不能代填；/state 能力位；PUT 不能改成不支持的身份
 *   D. 界面：密码框按能力显示/隐藏，账号类型选项由服务端下发驱动
 *
 * 零依赖、不起浏览器。跑法：node test/features-v0166.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-v0166-'));
process.env.DSH_SHOP_ACCOUNTS_DIR = path.join(TMP, 'data');
process.env.SHOP_ACCOUNTS_DSL_DIR = '';

const url = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  \u2713 ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  \u2717 ' + name + '\n      ' + (err && err.message ? err.message : String(err)));
  }
}
const section = (t) => console.log('\n' + t);

const P = await import(url('lib/platforms.mjs'));
const storeMod = await import(url('lib/store.mjs'));
const vaultMod = await import(url('lib/vault.mjs'));
const host = await import(url('lib/index.js'));

// ── A. 平台能力 ────────────────────────────────────────────────────────────
section('A. 平台能力：登录方式与「能不能存密码」');

await test('拼多多买家：不开放（只有商家后台入口）', () => {
  const caps = P.capabilitiesOf(P.platformOf('pdd'), 'buyer');
  assert.deepEqual(caps.loginMethods, []);
  assert.equal(caps.passwordLogin, false);
  assert.equal(caps.autoLogin, false);
  assert.equal(caps.manualLogin, false, '没有入口就不算「可以人工登录」');
  assert.equal(caps.upload, false);
});

await test('淘宝/天猫/京东/1688 买家：C 端有账号密码表单，买家也能存密码', () => {
  for (const id of ['taobao', 'tmall', 'jd', 'ali1688']) {
    const caps = P.capabilitiesOf(P.platformOf(id), 'buyer');
    assert.deepEqual(caps.loginMethods, ['password'], id + ' 买家应有账密登录');
    assert.equal(caps.passwordLogin, true, id + ' 买家应能存密码');
  }
});

await test('卖家一律账号密码（含拼多多卖家 mms）', () => {
  for (const id of ['pdd', 'taobao', 'tmall', 'jd', 'douyin', 'ali1688']) {
    const caps = P.capabilitiesOf(P.platformOf(id), 'seller');
    assert.equal(caps.passwordLogin, true, id + ' 卖家应有账密登录');
    assert.equal(caps.upload, true);
  }
});

await test('抖音买家可用：扫码 / 手机验证码，没有账号密码', () => {
  const caps = P.capabilitiesOf(P.platformOf('douyin'), 'buyer');
  assert.deepEqual(caps.loginMethods, ['sms', 'qrcode']);
  assert.equal(caps.passwordLogin, false, '抖音 C 端登录没有密码框');
  assert.equal(caps.manualLogin, true);
  assert.match(P.variantOf(P.platformOf('douyin'), 'buyer').loginUrl, /douyin\.com/);
});

await test('拼多多买家不可选：建号会被拒并说明原因', () => {
  assert.deepEqual(P.accountTypesFor('pdd'), ['seller']);
  const support = P.accountTypeSupport('pdd', 'buyer');
  assert.equal(support.ok, false);
  assert.equal(support.code, 'ACCOUNT_TYPE_UNSUPPORTED');
  assert.match(support.reason, /买家/, '原因要说明拼多多没有买家入口');
  // 抖音买家可选，其它平台也可以
  assert.deepEqual(P.accountTypesFor('douyin'), ['seller', 'buyer']);
  for (const id of ['taobao', 'tmall', 'jd', 'ali1688']) {
    assert.deepEqual(P.accountTypesFor(id), ['seller', 'buyer'], id + ' 应可选买家');
    assert.equal(P.accountTypeSupport(id, 'buyer').ok, true);
  }
});

await test('平台表下发：accountTypes / buyerLoginMethods / buyerUnsupported 都在', () => {
  const list = P.platformList();
  const pdd = list.find((p) => p.id === 'pdd');
  const dy = list.find((p) => p.id === 'douyin');
  assert.deepEqual(pdd.accountTypes, ['seller']);
  assert.equal(pdd.buyerUnsupported, true);
  assert.match(pdd.buyerUnsupportedReason, /买家/);
  assert.equal(pdd.capabilities.seller.passwordLogin, true);
  assert.deepEqual(dy.accountTypes, ['seller', 'buyer']);
  assert.equal(dy.buyerUnsupported, false);
  assert.deepEqual(dy.buyerLoginMethods, ['sms', 'qrcode']);
  assert.equal(dy.capabilities.buyer.passwordLogin, false);

  assert.deepEqual(dy.accountTypes, ['seller', 'buyer']);
  assert.equal(dy.buyerUnsupported, false);
  assert.deepEqual(dy.buyerLoginMethods, ['sms', 'qrcode']);
});

// ── 宿主 ───────────────────────────────────────────────────────────────────
const registered = [];
host.apply({ webServer: { register: (r) => { registered.push(r); return () => {}; } }, logger: { info() {}, warn() {}, error() {}, debug() {} } });
const handler = registered[0].handler;
function fakeRes() {
  let settle;
  const done = new Promise((r) => { settle = r; });
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; settle(); } };
  return { res, done };
}
function fakeReq(method, reqUrl, body) {
  const req = new EventEmitter();
  req.method = method; req.url = reqUrl; req.destroy = () => {};
  req.headers = { 'x-dsh-shop-accounts': '1', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', host: '127.0.0.1:43120' };
  if (body !== undefined) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    process.nextTick(() => { req.emit('data', Buffer.from(raw, 'utf8')); req.emit('end'); });
  } else process.nextTick(() => req.emit('end'));
  return req;
}
async function call(method, p, body) {
  const { res, done } = fakeRes();
  handler(fakeReq(method, p, body), res);
  await done;
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* ignore */ }
  return { status: res.statusCode, json };
}

// ── B. 建号 ────────────────────────────────────────────────────────────────
section('B. 建号：密码按身份必填，不再一刀切');

let dyBuyer = null;
await test('抖音买家不填密码也能建（响应说明为什么没存密码）', async () => {
  const r = await call('POST', '/accounts', { platform: 'douyin', accountType: 'buyer', loginName: '13900000000', name: '抖音买家号' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.passwordSaved, false);
  assert.match(r.json.passwordSkipped, /验证码|扫码/, '要说明这个身份只有验证码/扫码');
  dyBuyer = r.json.account;
  assert.equal(dyBuyer.accountType, 'buyer');
  // 密码库里确实没有这条（不是"存了但没回显"）
  assert.equal(vaultMod.hasPassword(dyBuyer.id), false, '抖音买家不该有密码条目');
});

await test('抖音买家即使传了密码也不会落库（也不会报错）', async () => {
  const r = await call('POST', '/accounts', { platform: 'douyin', accountType: 'buyer', loginName: '13900000001', name: '抖音买家号2', password: 'should-not-be-stored' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.passwordSaved, false);
  assert.equal(vaultMod.hasPassword(r.json.account.id), false, '拿到密码也不该存（这个身份用不上）');
});

await test('拼多多买家不可选：建号直接被拒', async () => {
  const r = await call('POST', '/accounts', { platform: 'pdd', accountType: 'buyer', loginName: '13800000000', name: '拼多多买家号' });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.equal(r.json.code, 'ACCOUNT_TYPE_UNSUPPORTED');
  assert.match(r.json.error, /买家/);
});

await test('拼多多卖家缺密码仍然拦（mms 是账密登录）', async () => {
  const r = await call('POST', '/accounts', { platform: 'pdd', accountType: 'seller', loginName: 'seller-pdd-1', name: '拼多多卖家号' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'ACCOUNT_PASSWORD_REQUIRED');
});

await test('淘宝买家缺密码拦、填了密码就能建', async () => {
  const bad = await call('POST', '/accounts', { platform: 'taobao', accountType: 'buyer', loginName: 'tb-buyer-1', name: '淘宝买家号' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'ACCOUNT_PASSWORD_REQUIRED');
  const ok = await call('POST', '/accounts', { platform: 'taobao', accountType: 'buyer', loginName: 'tb-buyer-1', name: '淘宝买家号', password: 'pw-1234' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.passwordSaved, true);
});

// ── C. 路由与状态 ──────────────────────────────────────────────────────────
section('C. 路由：没有账号密码的身份不能代填');

await test('抖音买家点「代填」→ 明确报「只有验证码/扫码」', async () => {
  const r = await call('POST', '/accounts/' + dyBuyer.id + '/autologin', {});
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'AUTOLOGIN_LOGIN_METHOD_UNSUPPORTED');
  assert.match(r.json.error, /验证码|扫码/);
});

await test('/state：每店带能力位；密码必填由身份决定', async () => {
  const r = await call('GET', '/state');
  assert.equal(r.status, 200);
  const mine = (r.json.accounts || []).find((a) => a.id === dyBuyer.id);
  assert.equal(mine.capabilities.passwordLogin, false);
  assert.equal(mine.capabilities.passwordRequired, false);
  assert.equal(mine.capabilities.autoLoginSupported, false);
  assert.deepEqual(mine.capabilities.loginMethods, ['sms', 'qrcode']);
  const platforms = r.json.platforms || [];
  const pdd = platforms.find((p) => p.id === 'pdd');
  assert.deepEqual(pdd.accountTypes, ['seller']);
  assert.equal(pdd.buyerUnsupported, true);
  assert.deepEqual(platforms.find((p) => p.id === 'douyin').accountTypes, ['seller', 'buyer']);
});

await test('PUT 不能把拼多多卖家改成买家', async () => {
  const created = await call('POST', '/accounts', { platform: 'pdd', accountType: 'seller', loginName: 'pdd-seller-1', name: '拼多多卖家号', password: 'pw-pdd' });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const id = created.json.account.id;
  const r = await call('PUT', '/accounts/' + id, { accountType: 'buyer' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'ACCOUNT_TYPE_UNSUPPORTED');
});

await test('打开店铺的代填只在「有账密登录」的身份上尝试', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8');
  assert.match(src, /supportsPasswordLogin\(account\.platform, normalizeAccountType\(account\.accountType\)\)/,
    'open 的自动代填要先看身份有没有密码登录');
});

// ── D. 界面 ────────────────────────────────────────────────────────────────
section('D. 界面：密码框按能力显示，账号类型选项由服务端下发驱动');

const clientSrc = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');

await test('客户端从 /state 取平台能力（不自己猜）', () => {
  assert.match(clientSrc, /platformMeta\(platforms, id\)/);
  assert.match(clientSrc, /accountTypesOf\(platforms, id\)/);
  assert.match(clientSrc, /passwordLoginOf\(platforms, id, type\)/);
  assert.match(clientSrc, /platforms: \(state\.data && state\.data\.platforms\) \|\| null/, '弹窗与详情页都要拿到平台能力表');
});

await test('新建弹窗：没有账号密码的身份不显示密码框，改显示登录方式', () => {
  assert.match(clientSrc, /!editing && needsPassword && h\(Field, \{ label: '登录密码（必填）' \}/, '密码框只在需要时出现');
  assert.match(clientSrc, /!editing && !needsPassword && h\(Field, \{ label: '登录方式' \}/, '不需要密码时换成登录方式说明');
  assert.match(clientSrc, /使用「|没有账号密码可存/);
});

await test('账号类型下拉由 accountTypes 生成（拼多多不会出现买家选项）', () => {
  assert.match(clientSrc, /types\.map\(function \(t\) \{/);
  assert.match(clientSrc, /accountTypeOptionLabel\(props\.platforms, platform, t\)/);
  assert.match(clientSrc, /accountTypeOptionLabel\(props\.platforms, a\.platform, t\)/);
  // 换平台后不支持的身份自动落回卖家
  assert.match(clientSrc, /if \(accountTypesOf\(props\.platforms, p\.id\)\.indexOf\(type\) < 0\) setAccountType\('seller'\)/);
});

await test('详情页：没有账密登录时卡片改成「登录方式」，不显示用不上的密码框', () => {
  assert.match(clientSrc, /pwLogin \? '密码与账密登录' : '登录方式'/);
  assert.match(clientSrc, /没有账号密码可保存/);
});

// ── E. 文档与版本 ──────────────────────────────────────────────────────────
section('E. 版本与文档');

await test('版本 ≥0.16.6 且文档写明身份差异', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const [maj, min, patchNo] = pkg.version.split('.').map(Number);
  assert.ok(maj === 0 && (min > 16 || (min === 16 && patchNo >= 6)), '至少 0.16.6，当前 ' + pkg.version);
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /0\.16\.6/);
  assert.match(changelog, /验证码|扫码/);
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /0\.16\.6/);
});

// ── 汇总 ───────────────────────────────────────────────────────────────────
if (failures.length) {
  console.log('\n✗ 失败 ' + failures.length + ' / 通过 ' + passed);
  for (const f of failures) console.log('\n  ✗ ' + f.name + '\n' + (f.err && f.err.stack ? f.err.stack : String(f.err)));
  process.exit(1);
}
console.log('\n✓ 全部通过：' + passed + ' 项');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
