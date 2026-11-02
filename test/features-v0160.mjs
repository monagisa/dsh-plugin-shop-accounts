#!/usr/bin/env node
/**
 * features-v0160.mjs —— v0.16.0：采集开关与时间统一到排期（用户指出的重复）
 *
 * 用户原话 m02889：`为什么你数据采集那里还做了个勾选和设置采集时间，不是统一的吗`
 *
 * 病根：v0.9.0 时采集只是「配置」，所以每店给了 `collection.enabled` + `collection.time`；
 * v0.15.0 把定时任务改成定时采集后，真正的执行时间由**全局排期**（起跑时间 + 每组间隔 + 顺序）
 * 决定，那两个字段就成了摆设 —— 填了不生效，还和排期表的开关打架。
 *
 * v0.16.0 统一为：
 *   · 跑不跑   → 账号的 `schedEnabled`（排期表里的「开启 / 暂停」，详情页那个按钮也是同一个）
 *   · 几点跑   → 全局排期槽位（`/state` 的 `schedTime`）
 *   · 采什么   → `collection.domains`
 * 老字段 `collection.enabled` / `collection.time` 只留兼容（enabled===false 视为显式退出，time 彻底失效）。
 *
 * 本套覆盖：
 *   A. 判据：collectionReady / isCollectionDue 用排期槽位时间
 *   B. 迁移：老的「采集卡片里关掉」→ 排期里的暂停（幂等）
 *   C. tick：只看是否配了采集域，不再看 collection.enabled；domains 空 → 退回检测
 *   D. HTTP/工具：PUT collection 翻译 enabled、/state 字段、collect-prompt 带 schedTime
 *   E. 界面：采集卡片里不再有勾选与时间输入
 *
 * 零依赖、不起浏览器。跑法：node test/features-v0160.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-v0160-'));
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

const C = await import(url('lib/collection.mjs'));
const storeMod = await import(url('lib/store.mjs'));
const host = await import(url('lib/index.js'));

// ── A. 判据 ─────────────────────────────────────────────────────────────────
section('A. 判据：配了采集域就算配了采集；到期时间看排期槽位');

await test('collectionReady：有域 → true；没域 → false；老数据 enabled:false → false（显式退出仍尊重）', () => {
  assert.equal(C.collectionReady({ collection: { domains: ['经营总览'] } }), true);
  assert.equal(C.collectionReady({ collection: { domains: [] } }), false);
  assert.equal(C.collectionReady({}), false);
  assert.equal(C.collectionReady(null), false);
  // 老数据：显式关掉的不因为「有域」就复活（迁移会把它变成排期暂停）
  assert.equal(C.collectionReady({ collection: { enabled: false, domains: ['经营总览'] } }), false);
  assert.equal(C.collectionReady({ collection: { enabled: true, domains: ['经营总览'] } }), true);
});

await test('isCollectionDue：时间来自排期槽位（opts.time），不是 collection.time', () => {
  const now = new Date(2026, 10, 2, 12, 0, 0);
  const acc = { id: 'a', collection: { domains: ['经营总览'], time: '23:00' } };
  // collection.time 23:00 会说不该采；排期槽位 09:00 说该采 → 以排期为准
  assert.equal(C.isCollectionDue(acc, now, { time: '09:00' }), true);
  // 反过来：排期排到 23:00 → 还没到点
  assert.equal(C.isCollectionDue(acc, now, { time: '23:00' }), false);
  // 不传时间就退回老字段（兼容，不崩）
  assert.equal(C.isCollectionDue(acc, now), false);
});

await test('dueCollections：timeOf 注入排期槽位后，due 列表的 time 是槽位时间', () => {
  const now = new Date(2026, 10, 2, 12, 0, 0);
  const accounts = [
    { id: 'a', name: 'A店', platform: 'taobao', collection: { domains: ['经营总览'], time: '' } },
    { id: 'b', name: 'B店', platform: 'taobao', collection: { domains: [] } },
  ];
  const due = C.dueCollections(accounts, now, { timeOf: (x) => (x.id === 'a' ? '09:00' : '10:00') });
  assert.equal(due.length, 1, '只有配了域的 A 店到期');
  assert.equal(due[0].id, 'a');
  assert.equal(due[0].time, '09:00', '时间取自排期槽位');
});

// ── 宿主 ────────────────────────────────────────────────────────────────────
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
const dataDir = () => process.env.DSH_SHOP_ACCOUNTS_DIR;
function accountsFile() { return path.join(dataDir(), 'accounts.json'); }
function readAccountsRaw() {
  const raw = JSON.parse(fs.readFileSync(accountsFile(), 'utf8'));
  return Array.isArray(raw) ? raw : (raw.accounts || []);
}
function writeAccountsRaw(list) {
  const raw = JSON.parse(fs.readFileSync(accountsFile(), 'utf8'));
  if (Array.isArray(raw)) fs.writeFileSync(accountsFile(), JSON.stringify(list, null, 2), 'utf8');
  else { raw.accounts = list; fs.writeFileSync(accountsFile(), JSON.stringify(raw, null, 2), 'utf8'); }
}
function resetSlots() {
  const cfgPath = path.join(dataDir(), 'config.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.schedule = { ...(cfg.schedule || {}), lastDay: '', lastSlots: {} };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  }
  // 新建店铺默认 pendingLogin=true，tick 会直接跳过 —— 这里统一清掉（注意要改同一份数组再写回）
  const list = readAccountsRaw();
  for (const a of list) a.pendingLogin = false;
  writeAccountsRaw(list);
}

let idA = '';
let idB = '';
await test('建两个店：A 配采集域，B 不配', async () => {
  const r1 = await call('POST', '/shop-accounts/accounts', { platform: 'taobao', name: 'A店', loginName: 'a', password: 'pa' });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  idA = r1.json.account.id;
  const r2 = await call('POST', '/shop-accounts/accounts', { platform: 'taobao', name: 'B店', loginName: 'b', password: 'pb' });
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
  idB = r2.json.account.id;
  const up = await call('PUT', '/shop-accounts/accounts/' + idA + '/collection', { domains: ['经营总览'] });
  assert.equal(up.status, 200, JSON.stringify(up.json));
});

// ── B. 迁移 ─────────────────────────────────────────────────────────────────
section('B. 迁移：老的「采集卡片里关掉」→ 排期里的暂停');

await test('migrateCollectionSchedule：把 collection.enabled=false 的老账号改成 schedEnabled=false', () => {
  const list = readAccountsRaw();
  const a = list.find((x) => x.id === idA);
  a.collection = { ...(a.collection || {}), enabled: false, domains: ['经营总览'], time: '09:00' };
  a.schedEnabled = undefined;
  writeAccountsRaw(list);

  const r = host.migrateCollectionSchedule({ info() {}, warn() {} });
  assert.equal(r.changed, 1, '应该迁移 1 个');
  const after = readAccountsRaw().find((x) => x.id === idA);
  assert.equal(after.schedEnabled, false, '老的显式关闭变成了排期暂停');
  assert.equal(after.collection.time, '09:00', 'collection.time 留在数据里（降级回去还能看到）');
});

await test('迁移是幂等的：再跑一次 changed=0，不改数据', () => {
  const before = fs.readFileSync(accountsFile(), 'utf8');
  const r = host.migrateCollectionSchedule({ info() {}, warn() {} });
  assert.equal(r.changed, 0);
  assert.equal(fs.readFileSync(accountsFile(), 'utf8'), before, '文件一个字节都不该动');
});

await test('migrateCollectionSchedule 不动 enabled=true / 没有 collection 的账号', () => {
  const list = readAccountsRaw();
  const b = list.find((x) => x.id === idB);
  b.collection = { enabled: true, domains: ['商品供给'], time: '08:00' };
  b.schedEnabled = true;
  writeAccountsRaw(list);
  const r = host.migrateCollectionSchedule({ info() {}, warn() {} });
  assert.equal(r.changed, 0);
  assert.equal(readAccountsRaw().find((x) => x.id === idB).schedEnabled, true);
});

// ── C. tick ─────────────────────────────────────────────────────────────────
section('C. tick：只看「配了采集域没有」，不看 collection.enabled');

await test('tick：老字段 collection.enabled=true 但已经失效 —— 有域就采集', async () => {
  resetSlots();
  const list = readAccountsRaw();
  const a = list.find((x) => x.id === idA);
  a.collection = { enabled: true, domains: ['经营总览'], time: '23:00' }; // time 是假的，不该影响
  a.schedEnabled = true;
  writeAccountsRaw(list);
  const actions = [];
  const out = await host.tickSchedule({
    due: [{ id: idA, name: 'A店', time: '09:00' }],
    checkFn: async () => { actions.push('check'); return { loggedIn: true, reason: '' }; },
    collectFn: async () => { actions.push('collect'); return { ok: true, code: 'COLLECTED', counts: { ok: 1 } }; },
  });
  assert.deepEqual(actions, ['collect']);
  assert.equal(out.ran[0].action, 'collect');
});

await test('tick：选了 0 个采集域 → 不算配了采集，退回静默检测', async () => {
  resetSlots();
  const list = readAccountsRaw();
  const a = list.find((x) => x.id === idA);
  a.collection = { enabled: true, domains: [], time: '09:00' };
  writeAccountsRaw(list);
  const actions = [];
  const out = await host.tickSchedule({
    due: [{ id: idA, name: 'A店', time: '09:00' }],
    checkFn: async () => { actions.push('check'); return { loggedIn: true, reason: '' }; },
    collectFn: async () => { actions.push('collect'); return { ok: true }; },
  });
  assert.deepEqual(actions, ['check']);
  assert.equal(out.ran[0].action, 'check');
});

await test('tick：排期里暂停（schedEnabled=false）的店根本不会到点（dueRows 已过滤）', () => {
  const list = readAccountsRaw();
  const a = list.find((x) => x.id === idA);
  a.schedEnabled = false;
  writeAccountsRaw(list);
  const rows = host.scheduleView().rows;
  const row = rows.find((r) => r.id === idA);
  assert.ok(row, '排期表里仍有这一行（时间点照样占着）');
  assert.equal(row.enabled, false, '但它是关着的');
});

await test('tick：老数据 collection.enabled=false（未迁移）也当作不采，退回检测', async () => {
  resetSlots();
  const list = readAccountsRaw();
  const a = list.find((x) => x.id === idA);
  a.collection = { enabled: false, domains: ['经营总览'], time: '09:00' };
  a.schedEnabled = true;
  writeAccountsRaw(list);
  const actions = [];
  await host.tickSchedule({
    due: [{ id: idA, name: 'A店', time: '09:00' }],
    checkFn: async () => { actions.push('check'); return { loggedIn: true }; },
    collectFn: async () => { actions.push('collect'); return { ok: true }; },
  });
  assert.deepEqual(actions, ['check'], '显式关闭的老数据不采（迁移会把它变成排期暂停）');
});

// ── D. HTTP / 工具 ──────────────────────────────────────────────────────────
section('D. HTTP 面：PUT collection 翻译 enabled、/state 字段');

await test('PUT /collection 只传 domains：保存成功，且不再要求 time/enabled', async () => {
  const r = await call('PUT', '/shop-accounts/accounts/' + idA + '/collection', { domains: ['经营总览', '流量转化'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.account.collection.domains, ['经营总览', '流量转化']);
  assert.match(r.json.note, /定时任务/);
});

await test('PUT /collection {enabled:false}：翻译成排期暂停（老调用方不会被升级搞成"关不掉"）', async () => {
  const r = await call('PUT', '/shop-accounts/accounts/' + idA + '/collection', { enabled: false, domains: ['经营总览'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.schedEnabled, false);
  assert.equal(readAccountsRaw().find((x) => x.id === idA).schedEnabled, false);
});

await test('PUT /collection {enabled:true}：翻译成排期开启', async () => {
  const r = await call('PUT', '/shop-accounts/accounts/' + idA + '/collection', { enabled: true, domains: ['经营总览'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.schedEnabled, true);
});

await test('POST /accounts/:id/schedule 与采集卡片是同一个开关：改完 /state 的 schedEnabled 跟着变', async () => {
  const off = await call('POST', '/shop-accounts/accounts/' + idA + '/schedule', { enabled: false });
  assert.equal(off.status, 200, JSON.stringify(off.json));
  let st = await call('GET', '/shop-accounts/state');
  let row = st.json.accounts.find((x) => x.id === idA);
  assert.equal(row.schedEnabled, false);
  const on = await call('POST', '/shop-accounts/accounts/' + idA + '/schedule', { enabled: true });
  assert.equal(on.status, 200);
  st = await call('GET', '/shop-accounts/state');
  row = st.json.accounts.find((x) => x.id === idA);
  assert.equal(row.schedEnabled, true);
});

await test('/state：每账号有 collectionReady + schedTime（时间来自排期，不是 collection.time）', async () => {
  await call('PUT', '/shop-accounts/schedule', { enabled: true, startTime: '09:00', groupIntervalMin: 30, groupSize: 1, mode: 'collect' });
  const st = await call('GET', '/shop-accounts/state');
  const row = st.json.accounts.find((x) => x.id === idA);
  assert.equal(typeof row.collectionReady, 'boolean');
  assert.equal(typeof row.schedTime, 'string');
  assert.ok(row.schedTime, '排期里排到了就该有槽位时间');
});

// ── E. 界面 ─────────────────────────────────────────────────────────────────
section('E. 界面：采集卡片删掉勾选与时间输入，指向排期');

const clientSrc = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');

await test('client.js：采集卡片里不再有「开启采集」勾选与「每天 09:00」时间输入', () => {
  assert.equal(/开启采集（开启后至少要选一个采集域）/.test(clientSrc), false, '旧的勾选文案还在');
  assert.equal(/type: 'checkbox', checked: collEnabled/.test(clientSrc), false, '旧的勾选控件还在');
  assert.equal(/collTime/.test(clientSrc), false, 'collTime 状态/输入框还在');
  assert.equal(/placeholder: '09:00'/.test(clientSrc), false, '采集时间输入框还在');
});

await test('client.js：采集卡片显示排期状态 + 槽位时间，并提供同一个开关的按钮', () => {
  assert.match(clientSrc, /定时采集：已加入/);
  assert.match(clientSrc, /定时采集：已暂停/);
  assert.match(clientSrc, /a\.schedTime/);
  assert.match(clientSrc, /加入定时采集/);
  assert.match(clientSrc, /暂停定时采集/);
  assert.match(clientSrc, /和「定时任务」表里的开启\/暂停是同一个开关/);
});

await test('client.js：保存采集只提交 domains（不再把 enabled/time 当权威）', () => {
  assert.match(clientSrc, /body: \{ domains: collDomains \}/);
  assert.equal(/body: \{ enabled: collEnabled/.test(clientSrc), false);
});

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log('\n' + (failures.length ? '\u2717 失败 ' + failures.length + ' 项 / 共 ' + (passed + failures.length) : '\u2713 全部通过（' + passed + ' 项）'));
if (failures.length) {
  for (const f of failures) console.log('\n--- ' + f.name + '\n' + (f.err && f.err.stack ? f.err.stack : f.err));
  process.exit(1);
}
