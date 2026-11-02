#!/usr/bin/env node
/**
 * features-v0101.mjs —— v0.10.1 两项收尾能力：
 *   1. 登录账号查重：同平台 + 同登录账号（大小写折叠、NFC 归一）= 同一个人，不许建两条；
 *      新建和编辑两条路都要挡，且只挡同平台（跨平台同名是正常的）。
 *   2. 店铺配置导出 / 导入：换机器（Windows → mac）不用一条条重填。
 *      **只搬配置不搬秘密** —— 密码、登录态、档案路径、端口都不进包；导入时逐条校验、
 *      坏数据跳过并说明原因，重复条目跳过（导两次不会翻倍）。
 *
 * 零依赖、不动真实数据（DSH_SHOP_ACCOUNTS_DIR 指到临时目录）、不启动浏览器。
 * 跑法：node test/features-v0101.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-v0101-'));
process.env.DSH_SHOP_ACCOUNTS_DIR = path.join(TMP, 'data');

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

// ── HTTP 面（假 webServer，跟 features-v090 一样直接打 handler）───────────────
const host = await import(url('lib/index.js'));
const S = await import(url('lib/store.mjs'));

function fakeRes() {
  let settle;
  const done = new Promise((r) => { settle = r; });
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(body) { this.body = body; settle(); },
  };
  return { res, done };
}
function fakeReq(method, reqUrl, body, headers) {
  const req = new EventEmitter();
  req.method = method;
  req.url = reqUrl;
  req.destroy = () => {};
  req.headers = Object.assign({
    'x-dsh-shop-accounts': '1',
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
    host: '127.0.0.1:43120',
  }, headers || {});
  if (body !== undefined) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    process.nextTick(() => { req.emit('data', Buffer.from(raw, 'utf8')); req.emit('end'); });
  } else {
    process.nextTick(() => req.emit('end'));
  }
  return req;
}

const registered = [];
host.apply({
  webServer: { register: (r) => { registered.push(r); return () => {}; } },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
});
const handler = registered[0].handler;
async function call(method, p, body, headers) {
  const { res, done } = fakeRes();
  handler(fakeReq(method, p, body, headers), res);
  await done;
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* 非 JSON 忽略 */ }
  return { status: res.statusCode, json, body: res.body };
}

const PW = 'V0101-P@ss1';

// ── 1. 登录账号查重 ─────────────────────────────────────────────────────────
section('1. 登录账号查重（同平台 + 同账号只许一条）');

let firstId = '';
await test('POST /accounts：建第一条成功', async () => {
  const r = await call('POST', '/shop-accounts/accounts', {
    platform: 'taobao', loginName: 'Alice@Example.com', password: PW, name: 'A 店',
  });
  assert.equal(r.status, 200);
  firstId = r.json.account.id;
  assert.equal(r.json.account.loginName, 'Alice@Example.com');
});

await test('POST /accounts：同平台同账号（大小写/空格不同）→ 400 ACCOUNT_LOGIN_NAME_DUPLICATE', async () => {
  const r = await call('POST', '/shop-accounts/accounts', {
    platform: 'taobao', loginName: '  alice@example.COM  ', password: PW, name: 'A 店重复',
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'ACCOUNT_LOGIN_NAME_DUPLICATE');
  assert.match(r.json.error, /A 店/, '错误里要指出撞的是哪家店');
  // 没有真的建出第二条
  const s = await call('GET', '/shop-accounts/state');
  assert.equal(s.json.accounts.filter((a) => a.platform === 'taobao').length, 1);
});

await test('POST /accounts：别的平台用同一个登录账号是允许的（跨平台不算重复）', async () => {
  const r = await call('POST', '/shop-accounts/accounts', {
    platform: 'jd', loginName: 'alice@example.com', password: PW, name: 'JD 店',
  });
  assert.equal(r.status, 200);
});

await test('POST /accounts：同平台不同账号可以共存（第二个淘宝店）', async () => {
  const r = await call('POST', '/shop-accounts/accounts', {
    platform: 'taobao', loginName: 'bob@example.com', password: PW, name: 'B 店',
  });
  assert.equal(r.status, 200);
});

await test('PUT /accounts/:id：改成同平台别人的登录账号 → 400；自己改自己（只变大小写）→ 200', async () => {
  const s = await call('GET', '/shop-accounts/state');
  const bob = s.json.accounts.find((a) => a.name === 'B 店');
  const dup = await call('PUT', `/shop-accounts/accounts/${bob.id}`, { loginName: 'ALICE@example.com' });
  assert.equal(dup.status, 400);
  assert.equal(dup.json.code, 'ACCOUNT_LOGIN_NAME_DUPLICATE');
  // 自己改自己没有误伤（大小写变了但 key 相同）
  const self = await call('PUT', `/shop-accounts/accounts/${bob.id}`, { loginName: 'Bob@Example.COM' });
  assert.equal(self.status, 200);
  assert.equal(self.json.account.loginName, 'Bob@Example.COM');
});

// ── 2. 导出 ─────────────────────────────────────────────────────────────────
section('2. GET /export：只搬配置，不搬秘密');

let exported = null;
await test('导出结构：format/version/count/accounts，字段齐全', async () => {
  // 给第一家店补上 URL 与采集设置，验证这些字段真的会被带出去
  await call('PUT', `/shop-accounts/accounts/${firstId}`, {
    url: 'https://myseller.taobao.com/home.htm', note: '主店', accountType: 'buyer',
    collection: { enabled: true, domains: ['商品供给'], time: '08:30' },
  });
  const r = await call('GET', '/shop-accounts/export');
  assert.equal(r.status, 200);
  assert.equal(r.json.format, 'dsh-shop-accounts/stores');
  assert.equal(r.json.version, 1);
  assert.equal(r.json.count, 3);
  assert.equal(r.json.accounts.length, 3);
  const a = r.json.accounts.find((x) => x.name === 'A 店');
  assert.equal(a.name, 'A 店');
  assert.equal(a.loginName, 'Alice@Example.com');
  assert.equal(a.accountType, 'buyer');
  assert.equal(a.url, 'https://myseller.taobao.com/home.htm');
  assert.equal(a.note, '主店');
  assert.deepEqual(a.collection.domains, ['商品供给']);
  assert.equal(a.collection.time, '08:30');
  exported = r.json;
});

await test('导出里绝不含密码、登录态、档案路径、端口、内部 id', async () => {
  const text = JSON.stringify(exported);
  assert.ok(!text.includes(PW), '导出文件里不能出现明文密码');
  for (const key of ['password', 'hasPassword', 'profileDir', 'cookieJar', 'port', 'pendingLogin']) {
    assert.ok(!text.includes('"' + key + '"'), '导出里不该有 ' + key);
  }
  for (const a of exported.accounts) {
    assert.ok(!('id' in a), '导出不带内部 id');
  }
  // 文件里写清「不含密码」，否则以后有人当成 bug
  assert.match(exported.note, /不含密码/);
});

// ── 3. 导入 ─────────────────────────────────────────────────────────────────
section('3. POST /import：逐条校验、坏数据跳过、重复不翻倍');

await test('把导出的文件原样导回来：全部跳过（同平台同账号已存在），不会翻倍', async () => {
  const r = await call('POST', '/shop-accounts/import', exported);
  assert.equal(r.status, 200);
  assert.equal(r.json.imported, 0);
  assert.equal(r.json.skipped.length, 3);
  for (const s of r.json.skipped) assert.match(s.reason, /已有同一登录账号/);
  const s = await call('GET', '/shop-accounts/state');
  assert.equal(s.json.accounts.length, 3);
});

await test('导入到"新机器"（先清空账号表）：配置回来了，密码没有（hasPassword=false）', async () => {
  // 模拟换机器：账号表清空，但密码库不清（真实换机器时密钥本来也解不开，这里只验证导入行为）
  S.writeAccounts([]);
  const r = await call('POST', '/shop-accounts/import', exported);
  assert.equal(r.status, 200);
  assert.equal(r.json.imported, 3);
  assert.equal(r.json.skipped.length, 0);
  const s = await call('GET', '/shop-accounts/state');
  assert.equal(s.json.accounts.length, 3);
  const tb = s.json.accounts.find((a) => a.name === 'A 店');
  assert.equal(tb.name, 'A 店');
  assert.equal(tb.loginName, 'Alice@Example.com');
  assert.equal(tb.accountType, 'buyer');
  assert.equal(tb.url, 'https://myseller.taobao.com/home.htm');
  assert.equal(tb.hasPassword, false, '导入不搬密码');
  assert.equal(tb.pendingLogin, true, '导入的店铺需要重新登录');
  assert.equal(tb.collection.enabled, true);
  assert.deepEqual(tb.collection.domains, ['商品供给']);
  // 档案目录是本机重新派生的，不能是导出文件里的东西
  assert.ok(tb.profileDir && tb.profileDir.includes(path.basename(tb.id)), '档案目录按新 id 派生');
});

await test('导入坏数据：平台不认识 / 缺登录账号 → 跳过并说明；非法 URL 被丢弃；profileDir 与 port 被忽略', async () => {
  S.writeAccounts([]);
  const r = await call('POST', '/shop-accounts/import', {
    accounts: [
      { platform: 'nope', loginName: 'x', name: '坏平台' },
      { platform: 'pdd', loginName: '', name: '缺账号' },
      {
        platform: 'pdd', loginName: '13800000111', name: 'P 店',
        url: 'javascript:alert(1)', profileDir: 'C:\\Windows\\System32', port: 1,
      },
      // 同一次导入里两条相同登录账号：第一条建、第二条跳
      { platform: 'pdd', loginName: '13800000111', name: 'P 店重复' },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.imported, 1);
  assert.equal(r.json.skipped.length, 3);
  const reasons = r.json.skipped.map((s) => s.reason).join(' | ');
  assert.match(reasons, /平台「nope」不认识/);
  assert.match(reasons, /缺登录账号/);
  assert.match(reasons, /已有同一登录账号/);
  const s = await call('GET', '/shop-accounts/state');
  const p = s.json.accounts.find((a) => a.platform === 'pdd');
  assert.equal(p.url, '', 'javascript: 这种 URL 必须被丢掉');
  assert.ok(!String(p.profileDir).includes('System32'), '不能接受外部文件里的档案路径');
  assert.notEqual(p.port, 1, '不能接受外部文件里的端口');
});

await test('导入后仍然是"同平台同账号只一条"：再手动建同账号会 400', async () => {
  const r = await call('POST', '/shop-accounts/accounts', {
    platform: 'pdd', loginName: '13800000111', password: PW, name: '重复建',
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'ACCOUNT_LOGIN_NAME_DUPLICATE');
});

await test('导入文件不是 JSON 结构（没有 accounts 数组）→ 400 且不落盘', async () => {
  const before = (await call('GET', '/shop-accounts/state')).json.accounts.length;
  const bad = await call('POST', '/shop-accounts/import', { foo: 1 });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /accounts/);
  const text = await call('POST', '/shop-accounts/import', 'null');
  assert.equal(text.status, 400);
  const after = (await call('GET', '/shop-accounts/state')).json.accounts.length;
  assert.equal(after, before);
});

await test('一次导入超过上限 → 400（防止一个巨型文件把界面卡死）', async () => {
  const many = { accounts: Array.from({ length: 501 }, (_, i) => ({ platform: 'pdd', loginName: 'u' + i })) };
  const r = await call('POST', '/shop-accounts/import', many);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /最多导入 500/);
});

// ── 4. 界面接上 ─────────────────────────────────────────────────────────────
section('4. 界面与文档');

await test('client.js：设置页有「店铺配置迁移」两个按钮，走 /export 与 /import，并提示不含密码', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');
  assert.match(src, /店铺配置迁移/);
  assert.match(src, /导出店铺配置/);
  assert.match(src, /导入店铺配置/);
  assert.match(src, /api\('\/export'\)/);
  assert.match(src, /api\('\/import'/);
  assert.match(src, /a\.download = /, '导出要真的下载文件');
  assert.match(src, /不含密码/);
});

await test('文档点名了 v0.10.1（CHANGELOG 有该段，package.json 版本不低于它）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const log = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  // 版本会一路往前走，这里只要求"不低于 v0.10.1"且该版本段还在（别把断言写死成某一个版本）
  const [maj, min, patch] = String(pkg.version).split('.').map(Number);
  assert.ok(maj === 0 && (min > 10 || (min === 10 && patch >= 1)), 'package.json 版本应 ≥ 0.10.1，实际 ' + pkg.version);
  assert.match(log, /## v0\.10\.1/, 'CHANGELOG 缺 v0.10.1 段');
  assert.match(log, /登录账号查重|ACCOUNT_LOGIN_NAME_DUPLICATE/);
  assert.match(log, /导出/);
});

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log('');
if (failures.length) {
  console.log('✗ 失败 ' + failures.length + ' / 通过 ' + passed);
  for (const f of failures) {
    console.log('\n[' + f.name + ']');
    console.log(f.err && f.err.stack ? f.err.stack : String(f.err));
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exitCode = 1;
} else {
  console.log('✓ 全部通过（' + passed + ' 项）');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}
