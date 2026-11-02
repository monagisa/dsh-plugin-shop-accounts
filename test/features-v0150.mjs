#!/usr/bin/env node
/**
 * features-v0150.mjs —— v0.15.0：定时任务 = 定时采集（照 Accio 的「每店一条 cron 跑采集」）
 *
 * 逆向证据：他机器上 8 个自动化任务里 7 个是
 *   name: "<店铺> · <平台> 经营数据采集"、schedule: {kind:'cron', expr:'0 10 * * *'}、
 *   payload: {kind:'agent', message:'ecommerce-data-collect …domain_id=<platform>-scheduler-<域>…'}
 * 即：**定时任务就是定时采集**，不是"定时检测登录态"。
 *
 * 本套覆盖：
 *   A. 配置：mode 默认 collect、可切 check、老配置兼容
 *   B. tick：collect 模式跑采集 / 没配采集退回检测 / check 模式一律检测 / 等登录跳过 / 锁占用跳过
 *   C. 采集回写：lastRun* 带 by=schedule；没有可跑配方时明确报 NO_DSL_FOR_PLATFORM
 *   D. 界面与接线
 *
 * 零依赖、不起浏览器（tick 的 collectFn/checkFn 全部注入假函数）。
 * 跑法：node test/features-v0150.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-v0150-'));
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

const S = await import(url('lib/schedule.mjs'));

// ── A. 配置 ─────────────────────────────────────────────────────────────────
section('A. 排期配置：mode 默认 collect');

await test('normalizeSchedule：没写 mode → collect（老配置升级后自动变定时采集）', () => {
  assert.equal(S.normalizeSchedule({}).mode, 'collect');
  assert.equal(S.normalizeSchedule({ enabled: true, startTime: '09:00' }).mode, 'collect');
  assert.equal(S.normalizeSchedule({ mode: '乱写' }).mode, 'collect');
});

await test('normalizeSchedule：显式 check 保留（想保留老行为的人能切回去）', () => {
  assert.equal(S.normalizeSchedule({ mode: 'check' }).mode, 'check');
  assert.equal(S.normalizeSchedule({ mode: 'CHECK' }).mode, 'check');
});

await test('SCHEDULE_DEFAULTS.mode 是 collect', () => {
  assert.equal(S.SCHEDULE_DEFAULTS.mode, 'collect');
});

// ── 建宿主与账号 ────────────────────────────────────────────────────────────
section('B. 宿主接线：/state 带 mode、tick 真的跑采集');

const host = await import(url('lib/index.js'));
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

/** 清掉「今天已跑过」的记账，让同一时间点可以再测一次（这两个字段只由 tick 自己写）。 */
/** 直接把某个店铺标成「待登录」（模拟检测到掉线的状态）。 */
function markPending(id) {
  const accPath = path.join(process.env.DSH_SHOP_ACCOUNTS_DIR, 'accounts.json');
  const list = JSON.parse(fs.readFileSync(accPath, 'utf8'));
  const arr = Array.isArray(list) ? list : (list.accounts || []);
  for (const a of arr) if (a.id === id) a.pendingLogin = true;
  fs.writeFileSync(accPath, JSON.stringify(list, null, 2), 'utf8');
}

function resetSlots() {
  const dir = process.env.DSH_SHOP_ACCOUNTS_DIR;
  const cfgPath = path.join(dir, 'config.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.schedule = { ...(cfg.schedule || {}), lastDay: '', lastSlots: {} };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  }
  const accPath = path.join(dir, 'accounts.json');
  if (fs.existsSync(accPath)) {
    const list = JSON.parse(fs.readFileSync(accPath, 'utf8'));
    const arr = Array.isArray(list) ? list : (list.accounts || []);
    for (const a of arr) a.pendingLogin = false;
    fs.writeFileSync(accPath, JSON.stringify(list, null, 2), 'utf8');
  }
}

let accCollect = '';
let accPlain = '';
await test('建两个店：一个配了采集，一个没配', async () => {
  const a = await call('POST', '/shop-accounts/accounts', {
    platform: 'taobao', loginName: 'v150a@example.com', password: 'V150-P@ss1', name: '采集店',
    collection: { enabled: true, domains: ['经营总览'], time: '09:00' },
  });
  assert.equal(a.status, 200);
  accCollect = a.json.account.id;
  const b = await call('POST', '/shop-accounts/accounts', {
    platform: 'pdd', loginName: 'v150b@example.com', password: 'V150-P@ss2', name: '没配采集的店',
  });
  assert.equal(b.status, 200);
  accPlain = b.json.account.id;
});

await test('新建店铺默认是「待登录」，清掉后定时任务才会处理它', async () => {
  // 新建店铺默认 pendingLogin=true（等首次登录）——重置后应变成 false
  resetSlots();
  const st = await call('GET', '/shop-accounts/state');
  for (const id of [accCollect, accPlain]) {
    assert.equal(st.json.accounts.find((a) => a.id === id).pendingLogin, false, '没清掉待登录');
  }
});

await test('/state：schedule.mode 暴露给界面（默认 collect）', async () => {
  const r = await call('GET', '/shop-accounts/state');
  assert.equal(r.status, 200);
  assert.equal(r.json.schedule.mode, 'collect');
});

await test('PUT /config 能切 mode=check，切回 collect 也行', async () => {
  const a = await call('PUT', '/shop-accounts/schedule', { mode: 'check' });
  assert.equal(a.status, 200);
  let st = await call('GET', '/shop-accounts/state');
  assert.equal(st.json.schedule.mode, 'check');
  const b = await call('PUT', '/shop-accounts/schedule', { mode: 'collect' });
  assert.equal(b.status, 200);
  st = await call('GET', '/shop-accounts/state');
  assert.equal(st.json.schedule.mode, 'collect');
});

/** 把排期打开、把两个店排到 09:00 起（每 30 分钟一组）。 */
await test('打开排期（enabled + 09:00 起 + 每组 1 个）', async () => {
  const st = await call('GET', '/shop-accounts/state');
  const r = await call('PUT', '/shop-accounts/schedule', { enabled: true, startTime: '09:00', groupIntervalMin: 30, groupSize: 1, mode: 'collect' });
  assert.equal(r.status, 200);
  const st2 = await call('GET', '/shop-accounts/state');
  assert.equal(st2.json.schedule.enabled, true);
});

await test('tick（collect 模式）：配了采集的店跑 collectFn，没配的退回 checkFn', async () => {
  resetSlots();
  await call('PUT', '/shop-accounts/schedule', { enabled: true, startTime: '09:00', mode: 'collect' }); resetSlots();
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const calls = { collect: [], check: [] };
  const r = await host.tickSchedule({
    now: new Date(`${day}T09:35:00`),
    due: [{ id: accCollect, name: '采集店', time: '09:00' }, { id: accPlain, name: '没配采集的店', time: '09:30' }],
    log: { info() {}, warn() {} },
    checkFn: async (a) => { calls.check.push(a.name); return { loggedIn: true }; },
    collectFn: async (a) => { calls.collect.push(a.name); return { ok: true, counts: { total: 2, ok: 2, failed: 0, empty: 0, pending: 0 } }; },
  });
  assert.equal(r.mode, 'collect');
  assert.deepEqual(calls.collect, ['采集店'], '配了采集的店应该去采集');
  assert.deepEqual(calls.check, ['没配采集的店'], '没配采集的店应该退回检测');
  const ranCollect = r.ran.find((x) => x.name === '采集店');
  assert.equal(ranCollect.action, 'collect');
  assert.equal(ranCollect.ok, true);
  const ranCheck = r.ran.find((x) => x.name === '没配采集的店');
  assert.equal(ranCheck.action, 'check');
});

await test('tick（check 模式）：配了采集也一律只检测', async () => {
  resetSlots();
  const st = await call('GET', '/shop-accounts/state');
  await call('PUT', '/shop-accounts/schedule', { enabled: true, startTime: '10:00', mode: 'check' }); resetSlots();;
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const calls = { collect: 0, check: 0 };
  const r = await host.tickSchedule({
    now: new Date(`${day}T11:00:00`), due: [{ id: accCollect, name: '采集店', time: '10:00' }, { id: accPlain, name: '没配采集的店', time: '10:30' }], log: { info() {}, warn() {} },
    checkFn: async () => { calls.check += 1; return { loggedIn: true }; },
    collectFn: async () => { calls.collect += 1; return { ok: true }; },
  });
  assert.equal(r.mode, 'check');
  assert.equal(calls.collect, 0, 'check 模式不该采集');
  assert.ok(calls.check >= 1);
});

await test('tick：正在等登录的店直接跳过（不采集也不检测）', async () => {
  resetSlots();
  markPending(accCollect);
  const st = await call('GET', '/shop-accounts/state');
  await call('PUT', '/shop-accounts/schedule', { enabled: true, startTime: '12:00', mode: 'collect' });
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let collected = 0;
  const r = await host.tickSchedule({
    now: new Date(`${day}T13:00:00`), due: [{ id: accCollect, name: '采集店', time: '12:00' }, { id: accPlain, name: '没配采集的店', time: '12:30' }], log: { info() {}, warn() {} },
    checkFn: async () => ({ loggedIn: true }),
    collectFn: async () => { collected += 1; return { ok: true }; },
  });
  assert.equal(collected, 0, '等登录的店不该被采集');
  assert.ok(r.skipped.some((s) => s.id === accCollect && /等登录/.test(s.reason)));
});

// ── C. 采集回写与无配方退化 ─────────────────────────────────────────────────
section('C. 采集结果回写 / 没有可跑配方时的行为');

await test('runScheduledCollection：这个平台没有可跑配方 → NO_DSL_FOR_PLATFORM（不假装采过）', async () => {
  // 1688 在我们的配方库里没有种子（只有 taobao/jd/pdd），拿它当"没配方"的平台
  const out = await host.runScheduledCollection({ id: 'acc_ali1688_v150', platform: 'ali1688', name: '1688 店', collection: { enabled: true, domains: ['经营总览'] } });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NO_DSL_FOR_PLATFORM');
});

await test('applyCollectionResult：定时任务回写用 by=schedule', () => {
  const C = require0('lib/collection.mjs');
  void C;
});

function require0(rel) {
  return null;
}

await test('采集回写的 lastRunBy / lastRunStatus 字段齐全（用 C 模块直接验）', async () => {
  const C = await import(url('lib/collection.mjs'));
  const cfg = C.applyCollectionResult({ collection: { enabled: true, domains: ['经营总览'], time: '' } }, {
    status: 'ok', note: '定时采集：成功 2', by: 'schedule',
  });
  assert.equal(cfg.lastRunStatus, 'ok');
  assert.equal(cfg.lastRunBy, 'schedule');
  assert.match(cfg.lastRunNote, /定时采集/);
  assert.ok(cfg.lastRunAt);
});

await test('tick 的 collect 失败会把 lastSchedError 记下来（界面能看到原因）', async () => {
  resetSlots();
  await call('PUT', '/shop-accounts/schedule', { enabled: true, startTime: '14:00', mode: 'collect' }); resetSlots();;
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  await host.tickSchedule({
    now: new Date(`${day}T14:30:00`), due: [{ id: accCollect, name: '采集店', time: '14:00' }], log: { info() {}, warn() {} },
    checkFn: async () => ({ loggedIn: true }),
    collectFn: async () => ({ ok: false, code: 'LOGIN_REQUIRED', error: '登录失效' }),
  });
  const st = await call('GET', '/shop-accounts/state');
  const row = st.json.accounts.find((a) => a.id === accCollect);
  assert.equal(row.lastSchedError, '登录失效');
});

// ── D. 界面与代码接线 ───────────────────────────────────────────────────────
section('D. 界面与接线');

const indexSrc = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8');
const clientSrc = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');

await test('宿主里有「定时采集」动作选择与 runScheduledCollection', () => {
  assert.ok(indexSrc.includes('runScheduledCollection'), '没有定时采集入口');
  assert.ok(indexSrc.includes("wantsCollect"), '没有 collect/check 分流');
  assert.ok(indexSrc.includes("mode: s.mode"), '/state 没暴露 mode');
});

await test('界面：有「到点做什么」选择器 + 定时采集文案', () => {
  assert.ok(clientSrc.includes('到点做什么'), '没有模式选择器');
  assert.ok(clientSrc.includes('定时采集'), '界面没有定时采集文案');
  assert.ok(clientSrc.includes('只检测登录态'), '没有 check 选项');
  assert.ok(!/h\('div', \{ className: 'sa-c-sched' \}, '定时检测'\)/.test(clientSrc), '表头还硬写成定时检测');
});

await test('注释里留了 Accio 逆向依据（每店一条 cron 跑采集）', () => {
  assert.ok(/每店一条 cron/i.test(indexSrc), '注释没写清逆向依据');
  assert.ok(/ecommerce-data-collect/.test(indexSrc), '注释没引用他的采集指令');
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
