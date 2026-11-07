#!/usr/bin/env node
/**
 * features-v0110.mjs —— v0.11.0 本地采集数据层（plan → collect → import → query 契约）：
 *   1. 日期/区间/覆盖台账：合并、缺口计算、窗口上限
 *   2. plan：这个账号这个区间缺哪些天（COLLECTION_REQUIRED / NO_COLLECTION_REQUIRED）
 *   3. import：逐条校验 → content_hash 去重 → 追加落盘 → 记覆盖台账；**合法空结果也记台账**
 *   4. query：按域/指标/日期查询（给分析用，不用重采）
 *   5. HTTP 面 + /state 概览 + 删账号连带清数据 + 工具动作 + 界面展示
 *
 * 零依赖、不动真实数据（DSH_SHOP_ACCOUNTS_DIR 指到临时目录）、不启动浏览器。
 * 跑法：node test/features-v0110.mjs
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-v0110-'));
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

const D = await import(url('lib/datastore.mjs'));
const C = await import(url('lib/collection.mjs'));
const S = await import(url('lib/store.mjs'));

const ACC = 'acc_taobao_v110test';

// ── 1. 日期与区间 ───────────────────────────────────────────────────────────
section('1. 日期、区间合并、缺口计算');

await test('parseDay：严格要求 YYYY-MM-DD，不存在的日期要报错', () => {
  assert.equal(D.fmtDay(D.parseDay('2026-10-01')), '2026-10-01');
  assert.throws(() => D.parseDay('2026-10-1'), /YYYY-MM-DD/);
  assert.throws(() => D.parseDay('2026-13-01'), /日期不存在/);
  assert.throws(() => D.parseDay('2026-02-30'), /日期不存在/);
  assert.throws(() => D.parseDay(''), /YYYY-MM-DD/);
});

await test('daySpan 含头含尾；窗口超过 366 天要拒绝', () => {
  assert.equal(D.daySpan(D.parseDay('2026-10-01'), D.parseDay('2026-10-01')), 1);
  assert.equal(D.daySpan(D.parseDay('2026-10-01'), D.parseDay('2026-10-31')), 31);
  assert.throws(
    () => D.planCollection({ accountId: ACC, platform: 'taobao', domains: ['经营总览'], start: '2024-01-01', end: '2026-12-31' }),
    /最多/,
  );
});

await test('mergeRanges：重叠与相邻自动合并，分开的保持分开', () => {
  assert.deepEqual(D.mergeRanges([
    { start: '2026-10-01', end: '2026-10-03' },
    { start: '2026-10-03', end: '2026-10-05' },
  ]), [{ start: '2026-10-01', end: '2026-10-05' }]);
  assert.deepEqual(D.mergeRanges([
    { start: '2026-10-01', end: '2026-10-02' },
    { start: '2026-10-05', end: '2026-10-06' },
  ]), [{ start: '2026-10-01', end: '2026-10-02' }, { start: '2026-10-05', end: '2026-10-06' }]);
});

await test('coverageGaps：记了中间一段，两头都要算成缺口', () => {
  D.recordCoverage(ACC, { domain: '经营总览', start: '2026-10-05', end: '2026-10-07', by: 'test' });
  const gaps = D.coverageGaps(ACC, '经营总览', '2026-10-01', '2026-10-10');
  assert.deepEqual(gaps, [
    { start: '2026-10-01', end: '2026-10-04' },
    { start: '2026-10-08', end: '2026-10-10' },
  ]);
});

// ── 2. plan ─────────────────────────────────────────────────────────────────
section('2. plan：只采缺的那些天');

await test('有缺口时返回 COLLECTION_REQUIRED，带 domainId 与 missing 区间', () => {
  const plan = D.planCollection({ accountId: ACC, platform: 'taobao', domains: ['经营总览'], start: '2026-10-01', end: '2026-10-10' });
  assert.equal(plan.status, 'COLLECTION_REQUIRED');
  assert.equal(plan.awaitCollect.length, 1);
  const t = plan.awaitCollect[0];
  assert.equal(t.domain, '经营总览');
  assert.equal(t.label, '成交与客户');
  assert.equal(t.domainId, 'taobao-scheduler-经营总览');
  assert.equal(t.missingDays, 7);
  assert.deepEqual(t.missing, [{ start: '2026-10-01', end: '2026-10-04' }, { start: '2026-10-08', end: '2026-10-10' }]);
});

await test('采全之后返回 NO_COLLECTION_REQUIRED（不会再让人重采）', () => {
  D.recordCoverage(ACC, { domain: '经营总览', start: '2026-10-01', end: '2026-10-10', by: 'test' });
  const plan = D.planCollection({ accountId: ACC, platform: 'taobao', domains: ['经营总览'], start: '2026-10-01', end: '2026-10-10' });
  assert.equal(plan.status, 'NO_COLLECTION_REQUIRED');
  assert.deepEqual(plan.awaitCollect, []);
});

await test('plan 拒绝白名单外的域；域去重；抖店 domainId 用 doudian', () => {
  assert.throws(() => D.planCollection({ accountId: ACC, platform: 'taobao', domains: ['店铺装修'], start: '2026-10-01', end: '2026-10-02' }), /未知采集域/);
  const plan = D.planCollection({
    accountId: ACC, platform: 'douyin', domains: ['服务履约', '服务履约'],
    start: '2026-11-01', end: '2026-11-02',
  });
  assert.equal(plan.requested.domains.length, 1);
  assert.equal(plan.awaitCollect[0].domainId, 'doudian-scheduler-服务履约');
});

// ── 3. import ───────────────────────────────────────────────────────────────
section('3. import：校验、去重、覆盖台账');

await test('导入正常记录：落盘 + 记覆盖；同一条再导入只算重复', async () => {
  const r1 = D.importRecords({
    accountId: ACC, platform: 'taobao', domain: '流量转化',
    items: [
      { bizDate: '2026-10-01', metric: '店铺访客数', value: 1234 },
      { bizDate: '2026-10-01', values: { 支付金额: 5678.9, 支付买家数: 42 } },
    ],
    coverageStart: '2026-10-01', coverageEnd: '2026-10-02', by: 'test',
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.imported, 2);
  assert.equal(r1.duplicates, 0);
  assert.equal(r1.coverageRecorded, true);
  const file = D.recordsPath(ACC);
  assert.ok(fs.existsSync(file), '记录文件应存在');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) JSON.parse(line); // 每行都是合法 JSON（JSONL）

  const r2 = D.importRecords({
    accountId: ACC, platform: 'taobao', domain: '流量转化',
    items: [
      { bizDate: '2026-10-01', metric: '店铺访客数', value: 1234 },
      { bizDate: '2026-10-01', values: { 支付金额: 5678.9, 支付买家数: 42 } },
    ],
    coverageStart: '2026-10-01', coverageEnd: '2026-10-02',
  });
  assert.equal(r2.imported, 0);
  assert.equal(r2.duplicates, 2);
  // 值变了就是新记录（不是重复）
  const r3 = D.importRecords({
    accountId: ACC, platform: 'taobao', domain: '流量转化',
    items: [{ bizDate: '2026-10-01', metric: '店铺访客数', value: 999 }],
  });
  assert.equal(r3.ok, true);
  assert.equal(r3.imported, 1);
});

await test('非法记录逐条拒掉、好记录照常导入（一条坏数据不废整批）', () => {
  const r = D.importRecords({
    accountId: ACC, platform: 'taobao', domain: '商品供给',
    items: [
      { bizDate: '2026-13-01', metric: 'x', value: 1 },          // 日期不合法
      { bizDate: '2026-10-01', metric: '', value: 1 },           // metric 空
      { bizDate: '2026-10-01', metric: 'a', value: 'NaN' },      // value 不是数字
      { bizDate: '2026-10-01', metric: 'a\nb', value: 1 },       // 控制字符
      { bizDate: '2026-10-01', metric: 'a', value: 1, values: { b: 2 } }, // 两者互斥
      { bizDate: '2026-10-01', metric: '正常指标', value: 7 },   // 好记录
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.imported, 1);
  assert.equal(r.rejected.length, 5);
  for (const x of r.rejected) assert.ok(x.reason && typeof x.index === 'number');
});

await test('合法空结果：只记覆盖台账、不写记录（否则每天重采同一段）', () => {
  const before = D.readRecords(ACC).length;
  const r = D.importRecords({
    accountId: ACC, platform: 'taobao', domain: '服务履约',
    items: [], coverageStart: '2026-10-08', coverageEnd: '2026-10-10', by: 'test', note: '这三天确实没售后数据',
  });
  assert.equal(r.ok, true);
  assert.equal(r.imported, 0);
  assert.equal(r.coverageRecorded, true);
  assert.equal(D.readRecords(ACC).length, before);
  // 台账记上了 → 再 plan 同一段就"不缺"
  const plan = D.planCollection({ accountId: ACC, platform: 'taobao', domains: ['服务履约'], start: '2026-10-08', end: '2026-10-10' });
  assert.equal(plan.status, 'NO_COLLECTION_REQUIRED');
});

await test('空导入不带覆盖区间要报错（否则"没数据"和"没采"分不清）', () => {
  assert.throws(() => D.importRecords({ accountId: ACC, platform: 'taobao', domain: '服务履约', items: [] }), /覆盖区间/);
  assert.throws(() => D.importRecords({ accountId: ACC, domain: '服务履约', items: [], coverageStart: '2026-10-01' }), /成对/);
});

await test('导入上限与入参形状：items 必须数组、最多 5000 条、域必须在白名单', () => {
  assert.throws(() => D.importRecords({ accountId: ACC, domain: '服务履约', items: {} }), /数组/);
  assert.throws(() => D.importRecords({ accountId: ACC, domain: '服务履约', items: new Array(5001).fill({}) }), /最多导入/);
  assert.throws(() => D.importRecords({ accountId: ACC, domain: '店铺装修', items: [] }), /未知采集域/);
  // 账号 id 会进路径，坏 id 必须挡掉
  assert.throws(() => D.importRecords({ accountId: '../etc', domain: '服务履约', items: [] }), /不合法/);
});

// ── 4. query ────────────────────────────────────────────────────────────────
section('4. query：查已采的数据');

await test('按域/指标/日期过滤，并返回指标概要与截断标记', () => {
  const all = D.queryRecords({ accountId: ACC, domain: '流量转化' });
  assert.ok(all.count >= 3);
  assert.equal(all.rows[0].domain, '流量转化');
  const byMetric = D.queryRecords({ accountId: ACC, domain: '流量转化', metric: '店铺访客数' });
  assert.deepEqual(byMetric.metrics.map((m) => m.metric), ['店铺访客数']);
  assert.equal(byMetric.count, 2);
  // 多指标记录里也能按其中一个指标命中
  const inValues = D.queryRecords({ accountId: ACC, domain: '流量转化', metric: '支付金额' });
  assert.equal(inValues.count, 1);
  assert.equal(inValues.rows[0].values.支付金额, 5678.9);
  // 日期窗
  const windowed = D.queryRecords({ accountId: ACC, domain: '流量转化', start: '2026-10-02', end: '2026-10-31' });
  assert.equal(windowed.count, 0);
  // limit 截断
  const limited = D.queryRecords({ accountId: ACC, domain: '流量转化', limit: 1 });
  assert.equal(limited.rows.length, 1);
  assert.equal(limited.truncated, true);
});

await test('query 的坏参数要报错，而不是静默返回全部', () => {
  assert.throws(() => D.queryRecords({ accountId: ACC, start: '2026-10-01' }), /成对/);
  assert.throws(() => D.queryRecords({ accountId: ACC, domain: '店铺装修' }), /未知采集域/);
});

// ── 5. HTTP 面 ──────────────────────────────────────────────────────────────
section('5. 宿主 HTTP 面（plan / import / records）');

const host = await import(url('lib/index.js'));
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
  try { json = JSON.parse(res.body); } catch { /* 非 JSON */ }
  return { status: res.statusCode, json, body: res.body };
}

let accId = '';
await test('建一个店铺并开启采集（后续 HTTP 用例都基于它）', async () => {
  const r = await call('POST', '/shop-accounts/accounts', {
    platform: 'taobao', loginName: 'v110@example.com', password: 'V110-P@ss1', name: 'v110 店',
    collection: { enabled: true, domains: ['经营总览', '流量转化'], time: '09:00' },
  });
  assert.equal(r.status, 200);
  accId = r.json.account.id;
});

await test('POST collect-plan：默认窗口 = 最近 30 个完整自然日，返回缺口', async () => {
  const r = await call('POST', `/shop-accounts/accounts/${accId}/collect-plan`, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'COLLECTION_REQUIRED');
  const range = C.collectionRangeText();
  assert.equal(r.json.requested.start, range.start);
  assert.equal(r.json.requested.end, range.end);
  assert.equal(r.json.awaitCollect.length, 2);
});

await test('POST collect-import：写入并回写账号的上次采集状态；非法域 400', async () => {
  const range = C.collectionRangeText();
  const r = await call('POST', `/shop-accounts/accounts/${accId}/collect-import`, {
    domain: '经营总览',
    items: [{ bizDate: range.start, metric: '支付金额', value: 100 }],
    coverageStart: range.start,
    coverageEnd: range.end,
    current: 'x',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.imported, 1);
  assert.equal(r.json.coverageRecorded, true);
  const st = await call('GET', '/shop-accounts/state');
  const row = st.json.accounts.find((a) => a.id === accId);
  assert.ok(row.collection.lastRunAt, '导入成功后应记上次采集时间');
  assert.equal(row.collection.lastRunStatus, 'ok');
  assert.ok(row.collectionCoverage, 'state 应带覆盖概览');
  assert.equal(row.collectionCoverage.records, 1);
  const covered = row.collectionCoverage.domains.find((d) => d.domain === '经营总览');
  assert.equal(covered.missingDays, 0);
  assert.equal(covered.coveredDays, row.collectionCoverage.window.days);
  const missing = row.collectionCoverage.domains.find((d) => d.domain === '流量转化');
  assert.equal(missing.coveredDays, 0);

  const bad = await call('POST', `/shop-accounts/accounts/${accId}/collect-import`, { domain: '店铺装修', items: [] });
  assert.equal(bad.status, 400);
});

await test('GET collect-records：查询与参数校验', async () => {
  const r = await call('GET', `/shop-accounts/accounts/${accId}/collect-records?domain=经营总览`);
  assert.equal(r.status, 200);
  assert.equal(r.json.count, 1);
  assert.equal(r.json.rows[0].metric, '支付金额');
  const bad = await call('GET', `/shop-accounts/accounts/${accId}/collect-records?domain=店铺装修`);
  assert.equal(bad.status, 400);
});

await test('plan 在采全之后变成 NO_COLLECTION_REQUIRED', async () => {
  const range = C.collectionRangeText();
  const one = await call('POST', `/shop-accounts/accounts/${accId}/collect-plan`, {
    domains: ['经营总览'], start: range.start, end: range.end,
  });
  assert.equal(one.json.status, 'NO_COLLECTION_REQUIRED');
  const two = await call('POST', `/shop-accounts/accounts/${accId}/collect-plan`, { domains: ['流量转化'] });
  assert.equal(two.json.status, 'COLLECTION_REQUIRED');
});

await test('删账号会连带删掉它的采集数据目录', async () => {
  assert.ok(fs.existsSync(D.collectionStoreDir(accId)));
  const r = await call('DELETE', `/shop-accounts/accounts/${accId}`, { deleteProfile: false });
  assert.equal(r.status, 200);
  assert.ok(!fs.existsSync(D.collectionStoreDir(accId)), '采集数据应随账号删除');
});

// ── 6. 工具与界面 ───────────────────────────────────────────────────────────
section('6. 工具动作、提示词与界面');

await test('工具 action 枚举里有 collect-plan / collect-import / collect-query', () => {
  const src = readServerSource(ROOT);
  for (const a of ['collect-plan', 'collect-import', 'collect-query']) {
    assert.ok(src.includes(`'${a}'`), '工具 action 缺少 ' + a);
  }
  assert.match(src, /planCollection\(/);
  assert.match(src, /importRecords\(/);
  assert.match(src, /queryRecords\(/);
});

await test('采集提示词把三步（plan → 采集 → import）写清楚了，并强调空结果也要导入', () => {
  const prompt = C.collectionPrompt({
    id: ACC, platform: 'taobao', name: 'x', accountType: 'seller',
    collection: { enabled: true, domains: ['经营总览'], time: '09:00' },
  });
  assert.match(prompt, /collect-plan/);
  assert.match(prompt, /collect-import/);
  assert.match(prompt, /空结果/);
  assert.match(prompt, /coverageStart/);
});

await test('界面会显示本地数据的覆盖情况', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');
  assert.match(src, /collectionCoverage/);
  assert.match(src, /本地数据（窗口/);
  assert.match(src, /缺 ' \+ d\.missingDays/);
});

await test('文档点名 v0.11.0（CHANGELOG / package.json 不早于它）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const log = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  // 版本只往后走：断言「>= 0.11.0」，免得每升一版就要改一次旧测试
  const [maj, min] = String(pkg.version).split('.').map((x) => Number(x));
  assert.ok(maj > 0 || min >= 11, `package.json 版本 ${pkg.version} 早于 0.11.0`);
  assert.match(log, /## v0\.11\.0/);
  assert.match(log, /覆盖台账|coverage/);
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
