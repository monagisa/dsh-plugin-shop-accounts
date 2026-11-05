#!/usr/bin/env node
/**
 * features-v0172.mjs —— v0.17.2：各平台「登录账号要填什么」的提示 + 新建时能填店铺 URL
 *
 * 场景：同一个「登录账号」输入框，淘宝要填旺旺名、拼多多填手机号、抖店必须填邮箱
 * （抖店登录页默认手机登录，代填会先切「邮箱登录」再填），买家账号又不一样。
 * 原来全平台一句「手机号 / 旺旺名 / 邮箱」，等于什么都没说。
 *
 * 这一版把提示按「平台 + 身份」下发给界面，并且补上新建时就能填的店铺 URL
 * （只有支持店铺主页的平台才显示，拼多多不支持）。
 *
 * 跑法：node test/features-v0172.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-v0172-'));
process.env.DSH_SHOP_ACCOUNTS_DIR = path.join(TMP, 'data');
process.env.SHOP_ACCOUNTS_DSL_DIR = '';

const url = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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

const host = await import(url('lib/index.js'));
const store = await import(url('lib/store.mjs'));
const P = await import(url('lib/platforms.mjs'));

function fakeRes() {
  let settle = () => {};
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
const registered = [];
host.apply({ webServer: { register: (r) => { registered.push(r); return () => {}; } }, logger: { info() {}, warn() {}, error() {}, debug() {} } });
const handler = registered[0].handler;
async function call(method, p, body) {
  const { res, done } = fakeRes();
  handler(fakeReq(method, p, body), res);
  await done;
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* ignore */ }
  return { status: res.statusCode, json };
}

const CLIENT = readText('lib/client.js');
const PKG = JSON.parse(readText('package.json'));
const CHANGELOG = readText('CHANGELOG.md');
const README = readText('README.md');

// ── A. 平台提示 ────────────────────────────────────────────────────────────
section('A. 各平台「登录账号」该填什么');

await test('六个卖家身份都有提示', () => {
  for (const id of ['pdd', 'taobao', 'tmall', 'douyin', 'jd', 'ali1688']) {
    const hint = P.loginNameHintOf(id, 'seller');
    assert.ok(hint && hint.length >= 8, id + ' 卖家提示为空');
  }
});

await test('抖店 = 登录邮箱（默认手机登录，填手机号登不上）', () => {
  const hint = P.loginNameHintOf('douyin', 'seller');
  assert.ok(hint.includes('邮箱'), '抖店提示里没有「邮箱」：' + hint);
  assert.ok(hint.includes('登不上'), '要说明填手机号登不上：' + hint);
});

await test('淘宝 / 天猫 / 1688 提到旺旺名、子账号、会员名', () => {
  assert.ok(P.loginNameHintOf('taobao', 'seller').includes('子账号'));
  assert.ok(P.loginNameHintOf('tmall', 'seller').includes('旺旺名'));
  assert.ok(P.loginNameHintOf('ali1688', 'seller').includes('会员名'));
});

await test('买家提示与卖家不同', () => {
  assert.notEqual(P.loginNameHintOf('douyin', 'buyer'), P.loginNameHintOf('douyin', 'seller'));
  assert.ok(P.loginNameHintOf('douyin', 'buyer').includes('手机号'));
  for (const id of ['taobao', 'tmall', 'jd', 'ali1688']) {
    assert.ok(P.loginNameHintOf(id, 'buyer').includes('买家'), id + '：' + P.loginNameHintOf(id, 'buyer'));
  }
});

await test('能力位带上 loginNameHint，/state.platforms 能读到', () => {
  assert.equal(P.capabilitiesOf('douyin', 'seller').loginNameHint, P.loginNameHintOf('douyin', 'seller'));
  for (const p of P.platformList()) {
    assert.ok(p.capabilities.seller.loginNameHint, p.id + ' 卖家能力位缺 loginNameHint');
    assert.equal(typeof p.capabilities.buyer.loginNameHint, 'string');
  }
});

// ── B. 新建时填店铺 URL ────────────────────────────────────────────────────
section('B. 新建店铺时填店铺 URL');

await test('POST /accounts 带 url 会落库', async () => {
  const r = await call('POST', '/shop-accounts/accounts', {
    platform: 'taobao', name: 'URL 测试店', loginName: 'url-test', password: 'pw-url-test',
    url: 'https://myseller.taobao.com/home.htm',
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const acc = store.readAccounts().accounts.find((a) => a.id === r.json.account.id);
  assert.equal(acc.url, 'https://myseller.taobao.com/home.htm');
  await call('DELETE', '/shop-accounts/accounts/' + r.json.account.id, { deleteProfile: false });
});

await test('店铺 URL 只认 http/https', async () => {
  const r = await call('POST', '/shop-accounts/accounts', {
    platform: 'taobao', name: 'XSS 测试店', loginName: 'xss-test', password: 'pw-xss-test',
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const bad = await call('PUT', '/shop-accounts/accounts/' + r.json.account.id, { url: 'javascript:alert(1)' });
  assert.equal(bad.status, 400, '坏 URL 应当被拒：' + JSON.stringify(bad.json));
  await call('DELETE', '/shop-accounts/accounts/' + r.json.account.id, { deleteProfile: false });
});

await test('店铺 URL 只有支持的平台才有（拼多多不支持）', () => {
  assert.equal(P.capabilitiesOf('pdd', 'seller').storeUrl, false);
  assert.equal(P.capabilitiesOf('taobao', 'seller').storeUrl, true);
  assert.equal(P.capabilitiesOf('jd', 'seller').storeUrl, true);
  assert.equal(P.capabilitiesOf('taobao', 'buyer').storeUrl, false);
});

// ── C. 界面接线 ────────────────────────────────────────────────────────────
section('C. 界面接线');

await test('登录账号输入框用平台提示当占位文字', () => {
  assert.ok(CLIENT.includes('caps.loginNameHint'), 'client 没读能力位里的提示');
  // v0.18.5：占位优先用「平台+身份」的短标签（例如：登录邮箱），没有短标签时仍退回平台提示
  assert.ok(CLIENT.includes("placeholder: loginTag ? ('例如：' + loginTag)"), '占位文字没接平台短标签');
  assert.ok(CLIENT.includes("(loginHint || '填登录用的账号名')"), '占位文字没接平台提示');
  assert.ok(CLIENT.includes('var loginHint = String(caps.loginNameHint'), '没取 loginHint');
});

await test('输入框下面不再挂长说明（v0.18.7 起精简）', () => {
  assert.ok(!CLIENT.includes('账号只用来区分是哪个登录身份，不要填密码'), '登录账号下面还挂着说明');
});

await test('新建弹窗有「店铺 URL」且按平台能力显示', () => {
  assert.ok(CLIENT.includes("label: '店铺 URL'"), '新建弹窗没有店铺 URL 栏');
  assert.ok(CLIENT.includes('!editing && urlSupported'), '没有按平台能力控制显示');
  assert.ok(CLIENT.includes("placeholder: '店铺主页链接（选填）'"), '占位文字不对');
  assert.ok(CLIENT.includes('url: urlSupported ? (url || undefined) : undefined'), 'POST body 没带 url');
});

// ── D. 版本与文档 ──────────────────────────────────────────────────────────
section('D. 版本与文档');

await test('版本号 ≥0.17.2', () => {
  const [maj, min, pat] = PKG.version.split('.').map(Number);
  assert.ok(maj === 0 && (min > 17 || (min === 17 && pat >= 2)), '实际版本 ' + PKG.version);
});

await test('CHANGELOG / README 已写 0.17.2 与「登录账号填什么」', () => {
  assert.ok(CHANGELOG.includes('0.17.2'), 'CHANGELOG 没有 0.17.2');
  assert.ok(README.includes('0.17.2'), 'README 没有 0.17.2');
  assert.ok(README.includes('抖店'), 'README 没提抖店');
});

fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n' + (failures.length === 0 ? '\u2713' : '\u2717') + ' v0.17.2：' + passed + ' 项通过' + (failures.length ? '，' + failures.length + ' 项失败' : '') + '\n');
if (failures.length) {
  for (const f of failures) console.error('- ' + f.name + ': ' + (f.err && f.err.stack ? f.err.stack.split('\n')[0] : f.err));
  process.exit(1);
}
