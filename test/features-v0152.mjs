#!/usr/bin/env node
/**
 * features-v0152.mjs —— v0.15.2：账号/密码错误要「说清楚 + 停下来」
 *
 * 用户报的问题：「密码或者账号是错误时，他会停掉，不返回任何信息」。
 * 根因两条：
 *   1. 站点把"账号或密码不正确"渲染成一行红字（HTTP 仍 200），我们没读它 → 误报成「要验证码/未建立登录态」；
 *   2. 定时任务卡在代填里没有超时 → 整轮被钉死，后面的店铺全不动，界面也看不到原因。
 *
 * 这一版：
 *   · classifyLoginFailure()：读页面提示，分清「账号密码错」/「验证码」；
 *   · 错误密码 → AUTOLOGIN_BAD_CREDENTIALS，明确文案 + 停掉自动代填（credentialErrorAt）；
 *   · 定时任务每个店铺套超时，卡住只算这一店失败，不拖死整轮；
 *   · /state 暴露 credentialErrorAt / autoLoginBlocked，详情页显示橙色警示卡。
 *
 * 零依赖、不起浏览器。跑法：node test/features-v0152.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-v0152-'));
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

const A = await import(url('lib/autologin.mjs'));

// ── A. 页面提示分类 ─────────────────────────────────────────────────────────
section('A. 登录失败提示 → 错误码');

await test('中文「账号或密码不正确」→ AUTOLOGIN_BAD_CREDENTIALS', () => {
  for (const t of [
    '账号或密码不正确',
    '用户名或密码错误，请重新输入',
    '密码输入错误，还可以再试 4 次',
    '登录名或密码不正确',
    '手机号或密码错误',
  ]) {
    const r = A.classifyLoginFailure(t);
    assert.equal(r.code, 'AUTOLOGIN_BAD_CREDENTIALS', '没认出：' + t);
    assert.match(r.message, /不正确/);
  }
});

await test('英文提示也认', () => {
  for (const t of ['Incorrect username or password', 'Your password is incorrect', 'invalid credentials']) {
    assert.equal(A.classifyLoginFailure(t).code, 'AUTOLOGIN_BAD_CREDENTIALS', '没认出：' + t);
  }
});

await test('验证码/滑块 → AUTOLOGIN_NEEDS_USER（和密码错分开）', () => {
  for (const t of ['请输入验证码', '请拖动滑块完成验证', 'Please verify you are human']) {
    assert.equal(A.classifyLoginFailure(t).code, 'AUTOLOGIN_NEEDS_USER', '没认对：' + t);
  }
});

await test('没有失败提示的普通页面 → 不误判', () => {
  assert.equal(A.classifyLoginFailure('欢迎登录千牛工作台').code, '');
  assert.equal(A.classifyLoginFailure('').code, '');
  assert.equal(A.classifyLoginFailure(null).code, '');
});

await test('扫描表达式存在且会收集 hint 元素 + 整页兜底文本', () => {
  const expr = A.buildErrorScanExpression();
  assert.ok(expr.includes('hints'), '没有 hints');
  assert.ok(expr.includes('innerText'), '没有整页兜底');
  assert.ok(expr.includes('display'), '没有可见性判断');
});

// ── B. 定时采集遇到错误密码 ─────────────────────────────────────────────────
section('B. 定时采集：错误密码 → 说清楚 + 停掉代填');

const host = await import(url('lib/index.js'));

// 宿主 HTTP 面（B/C 段都要用，所以先建）
const registered = [];
function fakeRes() { let r; const done = new Promise((res) => { r = res; }); const res = { statusCode: 0, headers: {}, setHeader() {}, end(b) { this.body = b; r(); } }; return { res, done }; }
function fakeReq(method, u, body) {
  const req = new EventEmitter(); req.method = method; req.url = u; req.destroy = () => {};
  req.headers = { 'x-dsh-shop-accounts': '1', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', host: '127.0.0.1:43120' };
  if (body !== undefined) { const raw = JSON.stringify(body); process.nextTick(() => { req.emit('data', Buffer.from(raw)); req.emit('end'); }); } else process.nextTick(() => req.emit('end'));
  return req;
}
host.apply({ webServer: { register: (r) => { registered.push(r); return () => {}; } }, logger: { info() {}, warn() {}, error() {}, debug() {} } });
const handler = registered[0].handler;
async function call(m, p, b) {
  const { res, done } = fakeRes();
  handler(fakeReq(m, p, b), res);
  await done;
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* ignore */ }
  return { status: res.statusCode, json };
}

/** 造一次「首轮因登录失效失败」的 prepareFn。 */
function makePrepareFn() {
  return async () => ({
    success: true,
    data: {
      job_id: 'job_bad', revision: 1, next_action: 'done',
      counts: { total: 1, ok: 0, empty: 0, failed: 1, pending: 0 },
      delivery: {
        artifacts: [],
        incomplete: [{ dslId: 'tb_shop_overview', state: 'failed', code: 'LOGIN_REQUIRED', attempts: 2 }],
      },
    },
  });
}

const { setPassword } = await import(url('lib/vault.mjs'));
const { readAccounts } = await import(url('lib/store.mjs'));

/** 造一个真实落盘的店铺（runScheduledCollection 会 patchAccount 写回）。 */
async function makeAccount(id, patch = {}) {
  const store = await import(url('lib/store.mjs'));
  store.ensureDir(store.dataDir());
  const list = store.readAccounts().accounts;
  list.push({
    id, platform: 'taobao', accountType: 'seller', name: '密码错的店',
    loginName: 'wrong@example.com', createdAt: new Date().toISOString(),
    collection: { enabled: true, domains: ['经营总览'], time: '09:00' },
    ...patch,
  });
  store.writeAccounts(list);
  return list.find((a) => a.id === id);
}

await test('站点说账号密码错 → AUTOLOGIN_BAD_CREDENTIALS + 明确文案 + 标待登录', async () => {
  const acc = await makeAccount('acc_taobao_v152bad');
  setPassword(acc.id, 'Wrong@Pass1');
  const out = await host.runScheduledCollection(acc, { info: () => {}, warn: () => {} }, {
    prepareFn: makePrepareFn(),
    autoLoginFn: async () => ({ ok: false, code: 'AUTOLOGIN_BAD_CREDENTIALS', loggedIn: false, error: '登录账号或密码不正确（站点提示）' }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'AUTOLOGIN_BAD_CREDENTIALS');
  assert.match(out.error, /账号或密码不正确/);
  assert.match(out.error, /停止自动代填|锁号/);
  const row = readAccounts().accounts.find((a) => a.id === acc.id);
  assert.equal(row.pendingLogin, true, '应该标待登录');
  assert.ok(row.credentialErrorAt, '应该记下 credentialErrorAt（用于停止重试）');
  assert.match(row.lastSchedError, /账号或密码不正确/);
});

await test('/state 暴露 credentialErrorAt + autoLoginBlocked（界面能显示警示）', async () => {
  const st = await call('GET', '/shop-accounts/state');
  assert.equal(st.status, 200, 'GET /state 失败');
  const row = st.json.accounts.find((a) => a.id === 'acc_taobao_v152bad');
  assert.ok(row, '账号不在 /state 里');
  assert.equal(row.autoLoginBlocked, true);
  assert.ok(row.credentialErrorAt);
});

await test('密码改对后（清了 pendingLogin）就不再 blocked', async () => {
  const store = await import(url('lib/store.mjs'));
  const list = store.readAccounts().accounts;
  const row = list.find((a) => a.id === 'acc_taobao_v152bad');
  row.pendingLogin = false;
  store.writeAccounts(list);
  const st = await call('GET', '/shop-accounts/state');
  const got = st.json.accounts.find((a) => a.id === 'acc_taobao_v152bad');
  assert.equal(got.autoLoginBlocked, false, '不 pendingLogin 就不该再 blocked');
});

await test('验证码仍走 NEEDS_USER（不跟密码错混）', async () => {
  const acc = await makeAccount('acc_taobao_v152cap');
  setPassword(acc.id, 'Some@Pass1');
  const out = await host.runScheduledCollection(acc, { info: () => {}, warn: () => {} }, {
    prepareFn: makePrepareFn(),
    autoLoginFn: async () => ({ ok: false, code: 'AUTOLOGIN_NEEDS_USER', loggedIn: false }),
  });
  assert.equal(out.code, 'AUTOLOGIN_NEEDS_USER');
  const row = readAccounts().accounts.find((a) => a.id === acc.id);
  assert.equal(row.pendingLogin, true);
  assert.equal(row.credentialErrorAt, undefined, '验证码不该记成密码错');
});

// ── C. 超时保护 ─────────────────────────────────────────────────────────────
section('C. 定时任务超时保护（一店卡住不拖死整轮）');

await test('某个店的采集卡住 → 超时后记为失败，后面的店照跑', async () => {
  await call('POST', '/shop-accounts/accounts', {
    platform: 'taobao', loginName: 'hang@example.com', password: 'Hang@Pass1', name: '会卡住的店',
    collection: { enabled: true, domains: ['经营总览'], time: '09:00' },
  });
  await call('POST', '/shop-accounts/accounts', {
    platform: 'taobao', loginName: 'ok@example.com', password: 'Ok@Pass1', name: '正常的店',
    collection: { enabled: true, domains: ['经营总览'], time: '09:10' },
  });
  // 新建店铺默认 pendingLogin=true（等首次登录），定时任务会跳过 → 先清掉
  const storeMod = await import(url('lib/store.mjs'));
  const list = storeMod.readAccounts().accounts;
  for (const a of list) a.pendingLogin = false;
  storeMod.writeAccounts(list);

  const st = await call('GET', '/shop-accounts/state');
  const hangs = st.json.accounts.filter((a) => a.name === '会卡住的店' || a.name === '正常的店');
  assert.equal(hangs.length, 2);

  const order = [];
  const r = await host.tickSchedule({
    now: new Date(),
    // 顺序固定：先卡住的那个，再正常的那个（验证后者不受前者影响）
    due: ['会卡住的店', '正常的店'].map((name) => {
      const a = hangs.find((x) => x.name === name);
      return { id: a.id, name: a.name, time: '09:00' };
    }),
    collectTimeoutMs: 120, // 120ms 就超时
    log: { info() {}, warn() {} },
    checkFn: async () => ({ loggedIn: true }),
    collectFn: (acc) => {
      order.push(acc.name);
      if (acc.name === '会卡住的店') return new Promise(() => {}); // 永不返回
      return Promise.resolve({ ok: true, counts: { total: 1, ok: 1, failed: 0, empty: 0, pending: 0 } });
    },
  });
  assert.deepEqual(order, ['会卡住的店', '正常的店'], '卡住的那个不该挡住后面的店');
  assert.ok(r.skipped.some((x) => x.name === '会卡住的店' && /超时/.test(x.reason)), '超时要记成失败原因：' + JSON.stringify(r.skipped));
  assert.ok(r.ran.some((x) => x.name === '正常的店' && x.ok === true), '后面的店应该正常跑完');
});

// ── D. 文档/文案接线 ─────────────────────────────────────────────────────────
section('D. 界面与文案');

await test('详情页有橙色「账号或密码不正确」警示卡', () => {
  const c = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');
  assert.ok(c.includes('autoLoginBlocked'), '详情页没读 autoLoginBlocked');
  assert.ok(c.includes('账号或密码不正确'), '没有警示文案');
  assert.ok(c.includes('credentialErrorAt'), '没显示时间点');
});

await test('代填提示里不再把"密码错"混进"可能账号密码不对"的模糊说法', () => {
  const s = fs.readFileSync(path.join(ROOT, 'lib', 'autologin.mjs'), 'utf8');
  assert.ok(s.includes('AUTOLOGIN_BAD_CREDENTIALS'), '没有明确的错误码');
  assert.ok(s.includes('去店铺详情里把账号/密码改对'), '没有可执行的下一步提示');
});

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log('');
if (failures.length) {
  console.log(`\u2717 失败 ${failures.length} / 通过 ${passed}`);
  for (const f of failures) console.log(`  · ${f.name}: ${f.err && f.err.message}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}
console.log(`\u2713 全部通过（${passed} 项）`);
fs.rmSync(TMP, { recursive: true, force: true });
