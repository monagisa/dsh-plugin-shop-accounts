#!/usr/bin/env node
/**
 * features-v0170.mjs —— v0.17.0：登录方式可选（账号密码代填 / 扫码或手动登录）
 *
 * 场景：不是所有人都记得住卖家后台的账号密码。原来建店必须填密码，
 * 记不住的人就卡在建店这一步。这一版把「登录方式」独立出来：
 *
 *   · password（默认）：本机加密保存密码，打开店铺时自动代填；
 *   · qrcode：不存密码，打开窗口扫码或用账号密码登录一次，
 *     登录态留在该店铺独立的本地档案里（与之前那套账号工具的做法一致）。
 *
 * 选了 qrcode 之后：建店不再要求密码、打开店铺不代填、定时采集遇到登录过期
 * 只标「需要扫码登录」而不去瞎尝试代填。
 *
 * 全离线（临时数据目录 + 进程内 HTTP 调用 + 源码断言），不起浏览器。
 * 跑法：node test/features-v0170.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readServerSource } from './_src.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-v0170-'));
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
const vault = await import(url('lib/vault.mjs'));
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
const rowOf = (state, id) => (state.accounts || []).find((a) => a.id === id);

// ── A. 登录方式的归一化 ─────────────────────────────────────────────────────
section('A. 登录方式归一化');

await test('normalizeLoginMode：认得出扫码写法，其余一律当账号密码代填', () => {
  assert.equal(host.normalizeLoginMode('qrcode'), 'qrcode');
  assert.equal(host.normalizeLoginMode('QR'), 'qrcode');
  assert.equal(host.normalizeLoginMode('scan'), 'qrcode');
  assert.equal(host.normalizeLoginMode('manual'), 'qrcode');
  assert.equal(host.normalizeLoginMode('password'), 'password');
  assert.equal(host.normalizeLoginMode(''), 'password');
  assert.equal(host.normalizeLoginMode(undefined), 'password');
  assert.equal(host.normalizeLoginMode(null), 'password');
  assert.equal(host.normalizeLoginMode('whatever'), 'password');
});

await test('loginModeOf：历史数据没有这个字段时的默认值是账号密码代填', () => {
  assert.equal(host.loginModeOf({}), 'password');
  assert.equal(host.loginModeOf({ loginMode: 'qrcode' }), 'qrcode');
  assert.equal(host.loginModeOf({ loginMode: 'password' }), 'password');
  assert.equal(host.loginModeOf(null), 'password');
});

await test('LOGIN_MODES 只有两种，文案固定', () => {
  assert.equal(host.LOGIN_MODES.length, 2);
  assert.deepEqual(host.LOGIN_MODES.map((m) => m.id), ['password', 'qrcode']);
  assert.deepEqual(host.LOGIN_MODES.map((m) => m.label), ['账号密码代填', '扫码或手动登录']);
});

await test('/state 把登录方式选项下发给界面', async () => {
  const s = await call('GET', '/shop-accounts/state');
  assert.ok(Array.isArray(s.json.loginModes) && s.json.loginModes.length === 2);
  assert.deepEqual(s.json.loginModes.map((m) => m.id), ['password', 'qrcode']);
});

// ── B. 建店：选了扫码登录就不再要求密码 ────────────────────────────────────
section('B. 建店：qrcode 模式不必填密码');

let qrId = '';

await test('淘宝店铺选「扫码或手动登录」：不传密码也能建号', async () => {
  const r = await call('POST', '/shop-accounts/accounts', {
    platform: 'taobao', loginName: 'v170-qr@example.com', name: 'v170 扫码店', loginMode: 'qrcode',
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  qrId = r.json.account.id;
  assert.equal(r.json.account.loginMode, 'qrcode');
  assert.equal(r.json.passwordSaved, false);
  assert.ok(r.json.passwordSkipped && r.json.passwordSkipped.includes('扫码'), '应提示不保存密码');
});

await test('扫码模式的店铺没有把密码写进本机密码库', () => {
  assert.equal(vault.hasPassword(qrId), false);
});

await test('不选登录方式时的默认行为不变：仍然要求填密码', async () => {
  const r = await call('POST', '/shop-accounts/accounts', {
    platform: 'taobao', loginName: 'v170-default@example.com', name: 'v170 默认店',
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'ACCOUNT_PASSWORD_REQUIRED');
  assert.ok(r.json.error.includes('扫码或手动登录'), '错误文案要给出口（改成扫码登录也行）');
});

await test('本来就没有账密登录的身份（抖音买家）自动是扫码登录', async () => {
  const r = await call('POST', '/shop-accounts/accounts', {
    platform: 'douyin', accountType: 'buyer', loginName: 'v170-dy-buyer', name: 'v170 抖音买家',
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.account.loginMode, 'qrcode');
});

// ── C. 切换登录方式与后续行为 ───────────────────────────────────────────────
section('C. 切换登录方式 / 状态位 / 代填');

let pwId = '';

await test('账号密码模式的店铺可以切成扫码模式', async () => {
  const a = await call('POST', '/shop-accounts/accounts', {
    platform: 'taobao', loginName: 'v170-pw@example.com', password: 'V170-P@ss1', name: 'v170 账密店',
  });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  pwId = a.json.account.id;
  assert.equal(a.json.account.loginMode, 'password');
  const put = await call('PUT', `/shop-accounts/accounts/${pwId}`, { loginMode: 'qrcode' });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.equal(put.json.account.loginMode, 'qrcode');
});

await test('/state：切成扫码后不再需要密码、也不再显示可代填', async () => {
  const s = await call('GET', '/shop-accounts/state');
  const row = rowOf(s.json, pwId);
  assert.ok(row, '账号应出现在 state 里');
  assert.equal(row.loginMode, 'qrcode');
  assert.equal(row.loginModeLabel, '扫码或手动登录');
  assert.equal(row.capabilities.passwordRequired, false);
  assert.equal(row.capabilities.autoLoginSupported, false);
});

await test('切回账号密码代填：密码需求恢复（本机那份密码还在，可直接用）', async () => {
  const put = await call('PUT', `/shop-accounts/accounts/${pwId}`, { loginMode: 'password' });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  const s = await call('GET', '/shop-accounts/state');
  const row = rowOf(s.json, pwId);
  assert.equal(row.loginMode, 'password');
  assert.equal(row.capabilities.passwordRequired, true);
  assert.equal(row.capabilities.autoLoginSupported, true);
});

await test('扫码模式的店铺：代填接口明确拒绝（不假装尝试）', async () => {
  const r = await call('POST', `/shop-accounts/accounts/${qrId}/autologin`, {});
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'AUTOLOGIN_LOGIN_MODE_MANUAL');
  assert.ok(r.json.error.includes('扫码'));
});

await test('没有账密登录的身份不能被切成账号密码代填', async () => {
  const s = await call('GET', '/shop-accounts/state');
  const dyBuyer = (s.json.accounts || []).find((a) => a.platform === 'douyin' && a.accountType === 'buyer');
  assert.ok(dyBuyer, '抖音买家账号应存在');
  const put = await call('PUT', `/shop-accounts/accounts/${dyBuyer.id}`, { loginMode: 'password' });
  assert.equal(put.status, 400);
  assert.equal(put.json.code, 'LOGIN_MODE_UNSUPPORTED');
});

// ── D. 代码接线（打开店铺 / 定时采集 / 界面） ───────────────────────────────
section('D. 接线：打开店铺、定时采集、界面');

await test('打开店铺时代填受登录方式门控', () => {
  const src = readServerSource(ROOT);
  assert.match(src, /loginModeOf\(account\) !== 'qrcode'/, 'open 分支要跳过扫码模式的代填');
  assert.match(src, /body\.autofill !== false/);
});

await test('定时采集遇到登录过期：扫码模式只标待登录，不去代填', () => {
  const src = readServerSource(ROOT);
  assert.match(src, /AUTOLOGIN_LOGIN_MODE_MANUAL/, '定时任务也要有这个码');
  assert.match(src, /扫码或手动登录/);
});

await test('界面：登录方式两个选项 + 扫码卡的打开按钮', () => {
  const src = readText('lib/client.js');
  assert.match(src, /LOGIN_MODE_OPTIONS/);
  assert.match(src, /账号密码代填/);
  assert.match(src, /扫码或手动登录/);
  assert.match(src, /打开店铺（扫码登录）/);
  assert.match(src, /function loginModeLabel/);
  // 建店与详情页都要把登录方式发给后端（出现两次以上）
  assert.ok((src.match(/loginMode: mode/g) || []).length >= 2, '建店与编辑的请求体都要带 loginMode');
});

await test('平台能力位：密码登录能力仍由平台决定', () => {
  assert.equal(P.supportsPasswordLogin('taobao', 'seller'), true);
  assert.equal(P.supportsPasswordLogin('douyin', 'buyer'), false);
  assert.equal(P.supportsPasswordLogin('pdd', 'seller'), true);
});

// ── E. 版本与文档 ───────────────────────────────────────────────────────────
section('E. 版本与文档');

await test('版本号与文档已覆盖 0.17.0', () => {
  const pkg = JSON.parse(readText('package.json'));
  const [maj, min, patchNo] = String(pkg.version).split('.').map(Number);
  assert.ok(maj === 0 && (min > 17 || (min === 17 && patchNo >= 0)), '版本号应 ≥0.17.0，实际 ' + pkg.version);
  assert.ok(readText('CHANGELOG.md').includes('0.17.0'));
  assert.ok(readText('CHANGELOG.md').includes('0.17.0'));
});

console.log('\n' + (failures.length ? '\u2717 ' + failures.length + ' failed' : '\u2713 all passed') + ' (' + passed + ' checks)');
if (failures.length) {
  console.error(failures.map((f) => f.name + ': ' + (f.err && f.err.stack ? f.err.stack : f.err)).join('\n\n'));
  process.exit(1);
}
