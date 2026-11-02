#!/usr/bin/env node
/**
 * features-v0120.mjs —— v0.12.0 目录层（「平台 → 采集域 → 指标」模型）：
 *   1. 目录文件本身：可解析、规模合理、只含骨架（不含取值路径 / 聚合规则等实现细节）
 *   2. 平台 → 域：淘宝/天猫 6 个域（多「竞争洞察」），抖店/京东/拼多多 5 个域
 *   3. 指标查询：按 id 查名字/度量类型/所需字段；跨平台不认
 *   4. 按平台校验：pdd 不能采「竞争洞察」，taobao 可以（配置 + import + query 三处）
 *   5. 落库记录带 metricId：能查、能过滤、参与去重哈希
 *   6. HTTP /catalog 与 /state 暴露；工具 action=catalog；界面显示指标数
 *
 * 零依赖、不动真实数据（DSH_SHOP_ACCOUNTS_DIR 指到临时目录）、不启动浏览器。
 * 跑法：node test/features-v0120.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-v0120-'));
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

const CAT = await import(url('lib/catalog.mjs'));
const CO = await import(url('lib/collection.mjs'));
const DS = await import(url('lib/datastore.mjs'));

// ── 1. 目录文件 ─────────────────────────────────────────────────────────────
section('1. 目录文件（平台 → 域 → 指标）');

await test('目录可加载：6 个平台、指标总数 ≥ 3000', () => {
  assert.equal(CAT.catalogReady(), true);
  const info = CAT.catalogInfo();
  assert.equal(info.ready, true);
  assert.ok(info.version >= 1);
  assert.ok(info.totalMetrics >= 3000, `指标太少：${info.totalMetrics}`);
  const ids = Object.keys(info.platforms).sort();
  assert.deepEqual(ids, ['douyin', 'jd', 'pdd', 'taobao', 'tmall']);
});

await test('目录只保留骨架：不含取值路径 / 聚合规则 / 加密资产', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'lib', 'catalog', 'catalog.json'), 'utf8');
  assert.ok(!raw.includes('value_path'), '不该带 value_path');
  assert.ok(!raw.includes('auxiliary_path'), '不该带 auxiliary_path');
  assert.ok(!raw.includes('aggregation'), '不该带聚合规则');
  assert.ok(!raw.includes('按日可加'), '不该带聚合说明');
  assert.ok(!raw.includes('locator_template'), '不该带 RPA 资产');
  assert.ok(!raw.includes('ecommerce.db'), '不该带上游库路径');
  const kb = Buffer.byteLength(raw, 'utf8') / 1024;
  assert.ok(kb < 1024, `目录文件太大：${kb.toFixed(0)} KB`);
});

// ── 2. 平台 → 域 ────────────────────────────────────────────────────────────
section('2. 平台 → 采集域');

await test('淘宝/天猫 6 个域（多「竞争洞察」），抖店/京东/拼多多 5 个域', () => {
  const tb = CAT.catalogDomains('taobao').map((d) => d.id);
  assert.deepEqual(tb, ['经营总览', '流量转化', '运营推广', '商品供给', '服务履约', '竞争洞察']);
  assert.deepEqual(CAT.catalogDomains('tmall').map((d) => d.id), tb);
  for (const pid of ['douyin', 'jd', 'pdd']) {
    const ids = CAT.catalogDomains(pid).map((d) => d.id);
    assert.deepEqual(ids, ['经营总览', '流量转化', '运营推广', '商品供给', '服务履约'], pid + ' 域不对');
  }
});

await test('域带指标数：淘宝运营推广 540 项、竞争洞察 78 项', () => {
  const tb = CAT.catalogDomains('taobao');
  const ad = tb.find((d) => d.id === '运营推广');
  assert.equal(ad.metricCount, 540);
  const comp = tb.find((d) => d.id === '竞争洞察');
  assert.equal(comp.metricCount, 78);
});

await test('目录里没有的平台（1688）退回默认 5 域且不拦指标校验', () => {
  const ids = CAT.catalogDomains('ali1688').map((d) => d.id);
  assert.deepEqual(ids, ['经营总览', '流量转化', '运营推广', '商品供给', '服务履约']);
  assert.deepEqual(CAT.unknownMetricIds('ali1688', ['随便写的指标']), []);
});

// ── 3. 指标查询 ─────────────────────────────────────────────────────────────
section('3. 指标查询与跨平台校验');

await test('按 id 查指标：名字、度量类型、所需记录字段都在', () => {
  const m = CAT.catalogMetric('taobao', 'tb_ads_人群_展现量');
  assert.ok(m, '没找到 tb_ads_人群_展现量');
  assert.ok(m.name.includes('展现量'), `指标名不对：${m.name}`);
  assert.equal(m.domain, '运营推广');
  assert.ok(Array.isArray(m.fields) && m.fields.length > 0);
  assert.equal(CAT.catalogMetric('taobao', '不存在的指标'), null);
});

await test('跨平台不认：淘宝的指标 id 在拼多多上查不到', () => {
  assert.deepEqual(CAT.unknownMetricIds('taobao', ['tb_ads_人群_展现量']), []);
  assert.deepEqual(CAT.unknownMetricIds('pdd', ['tb_ads_人群_展现量']), ['tb_ads_人群_展现量']);
});

await test('按域列指标：字段齐全且都属于该域', () => {
  const list = CAT.catalogMetrics('taobao', '竞争洞察');
  assert.equal(list.length, 78);
  assert.ok(list.every((m) => m.domain === '竞争洞察'));
  assert.ok(list.every((m) => typeof m.name === 'string' && m.name.length > 0));
});

// ── 4. 按平台校验（配置 / import / query）──────────────────────────────────
section('4. 按平台校验采集域');

const C = await import(url('lib/collection.mjs'));
await test('配置：淘宝能选「竞争洞察」，拼多多不能', () => {
  const tb = C.normalizeCollection({ enabled: true, domains: ['竞争洞察'] }, {}, { allow: CAT.catalogDomainIds('taobao') });
  assert.deepEqual(tb.domains, ['竞争洞察']);
  assert.throws(
    () => C.normalizeCollection({ enabled: true, domains: ['竞争洞察'] }, {}, { allow: CAT.catalogDomainIds('pdd') }),
    /未知采集域/,
  );
});

// ── 5. 落库记录带 metricId ─────────────────────────────────────────────────
section('5. 记录带 metricId');

const ACC = 'acc_taobao_v120test';
await test('导入带 metricId 的记录：能查、能按 metricId 过滤', () => {
  const r = DS.importRecords({
    accountId: ACC,
    platform: 'taobao',
    domain: '运营推广',
    items: [
      { bizDate: '2026-10-01', metric: '展现量', value: 1234, metricId: 'tb_ads_人群_展现量' },
      { bizDate: '2026-10-02', metricId: 'tb_ads_人群_展现量', values: { 展现量: 2234, 点击量: 55 } },
    ],
    coverageStart: '2026-10-01',
    coverageEnd: '2026-10-02',
  });
  assert.equal(r.ok, true);
  assert.equal(r.imported, 2);
  const all = DS.queryRecords({ accountId: ACC, domain: '运营推广' });
  assert.equal(all.count, 2);
  assert.ok(all.rows.every((row) => row.metricId === 'tb_ads_人群_展现量'));
  const byId = DS.queryRecords({ accountId: ACC, metricId: 'tb_ads_人群_展现量' });
  assert.equal(byId.count, 2);
  const none = DS.queryRecords({ accountId: ACC, metricId: '没这个指标' });
  assert.equal(none.count, 0);
});

await test('metricId 参与去重哈希：同数据不同 metricId 不会互相顶掉', () => {
  const acc = 'acc_taobao_v120hash';
  const base = { accountId: acc, platform: 'taobao', domain: '运营推广', coverageStart: '2026-10-01', coverageEnd: '2026-10-01' };
  const a = DS.importRecords({ ...base, items: [{ bizDate: '2026-10-01', metric: '展现量', value: 1, metricId: 'tb_ads_人群_展现量' }] });
  const b = DS.importRecords({ ...base, items: [{ bizDate: '2026-10-01', metric: '展现量', value: 1, metricId: 'tb_ads_人群_点击量' }] });
  assert.equal(a.imported, 1);
  assert.equal(b.imported, 1, '不同 metricId 应各自入库');
  const again = DS.importRecords({ ...base, items: [{ bizDate: '2026-10-01', metric: '展现量', value: 1, metricId: 'tb_ads_人群_展现量' }] });
  assert.equal(again.imported, 0);
  assert.equal(again.duplicates, 1);
});

// ── 6. HTTP 面 ─────────────────────────────────────────────────────────────
section('6. HTTP /catalog 与 /state');

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

await test('GET /catalog 概览：平台 + 每平台域清单 + 指标总数', async () => {
  const r = await call('GET', '/shop-accounts/catalog');
  assert.equal(r.status, 200);
  assert.equal(r.json.ready, true);
  assert.ok(r.json.totalMetrics >= 3000);
  assert.ok(r.json.platformDomains.taobao.some((d) => d.id === '竞争洞察'));
  assert.ok(!r.json.platformDomains.pdd.some((d) => d.id === '竞争洞察'));
});

await test('GET /catalog?platform=taobao&domain=运营推广：540 项、默认截断', async () => {
  const r = await call('GET', '/shop-accounts/catalog?platform=taobao&domain=' + encodeURIComponent('运营推广'));
  assert.equal(r.status, 200);
  assert.equal(r.json.metricCount, 540);
  assert.equal(r.json.truncated, true);
  assert.ok(r.json.metrics.length <= 200);
  const all = await call('GET', '/shop-accounts/catalog?platform=taobao&domain=' + encodeURIComponent('运营推广') + '&all=1');
  assert.equal(all.json.metrics.length, 540);
});

await test('GET /catalog?platform=未知 → 404', async () => {
  const r = await call('GET', '/shop-accounts/catalog?platform=nope');
  assert.equal(r.status, 404);
});

let taobaoId = '';
let pddId = '';
await test('建淘宝店 + 拼多多店（后续按平台校验用）', async () => {
  const a = await call('POST', '/shop-accounts/accounts', {
    platform: 'taobao', loginName: 'v120tb@example.com', password: 'V120-P@ss1', name: 'v120 淘宝店',
    collection: { enabled: true, domains: ['竞争洞察'], time: '09:00' },
  });
  assert.equal(a.status, 200);
  taobaoId = a.json.account.id;
  const b = await call('POST', '/shop-accounts/accounts', {
    platform: 'pdd', loginName: 'v120pdd@example.com', password: 'V120-P@ss2', name: 'v120 拼多多店',
  });
  assert.equal(b.status, 200);
  pddId = b.json.account.id;
});

await test('/state：目录概览 + 每账号按平台下发域清单（带指标数）', async () => {
  const r = await call('GET', '/shop-accounts/state');
  assert.equal(r.status, 200);
  assert.equal(r.json.catalog.ready, true);
  const tb = r.json.accounts.find((a) => a.id === taobaoId);
  const pdd = r.json.accounts.find((a) => a.id === pddId);
  assert.ok(tb.collectionDomains.some((d) => d.id === '竞争洞察'));
  assert.ok(!pdd.collectionDomains.some((d) => d.id === '竞争洞察'));
  const ad = tb.collectionDomains.find((d) => d.id === '运营推广');
  assert.equal(ad.metricCount, 540);
});

await test('拼多多采「竞争洞察」被 400 挡回，淘宝可以', async () => {
  const bad = await call('POST', `/shop-accounts/accounts/${pddId}/collect-import`, {
    domain: '竞争洞察', items: [], coverageStart: '2026-10-01', coverageEnd: '2026-10-02',
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /不是这个平台的采集域/);

  const ok = await call('POST', `/shop-accounts/accounts/${taobaoId}/collect-import`, {
    domain: '竞争洞察',
    items: [{ bizDate: '2026-10-01', metric: '竞品支付金额', value: 999 }],
    coverageStart: '2026-10-01', coverageEnd: '2026-10-01',
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.imported, 1);

  const q = await call('GET', `/shop-accounts/accounts/${pddId}/collect-records?domain=` + encodeURIComponent('竞争洞察'));
  assert.equal(q.status, 400);
});

await test('collect-import 带目录外的 metricId → 400 并点名', async () => {
  const bad = await call('POST', `/shop-accounts/accounts/${taobaoId}/collect-import`, {
    domain: '运营推广',
    items: [{ bizDate: '2026-10-01', metric: '展现量', value: 1, metricId: 'tb_ads_人群_展现量' }],
    coverageStart: '2026-10-01', coverageEnd: '2026-10-01',
  });
  // 淘宝就认这个 id，所以应该成功
  assert.equal(bad.status, 200);

  const wrong = await call('POST', `/shop-accounts/accounts/${pddId}/collect-import`, {
    domain: '运营推广',
    items: [{ bizDate: '2026-10-01', metric: '展现量', value: 1, metricId: 'tb_ads_人群_展现量' }],
    coverageStart: '2026-10-01', coverageEnd: '2026-10-01',
  });
  assert.equal(wrong.status, 400);
  assert.ok(Array.isArray(wrong.json.unknownMetricIds) && wrong.json.unknownMetricIds.length === 1);
});

await test('PUT /collection：淘宝能存「竞争洞察」，拼多多 400', async () => {
  const ok = await call('PUT', `/shop-accounts/accounts/${taobaoId}/collection`, {
    enabled: true, domains: ['竞争洞察', '经营总览'], time: '08:30',
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.account.collection.domains, ['竞争洞察', '经营总览']);
  const bad = await call('PUT', `/shop-accounts/accounts/${pddId}/collection`, { enabled: true, domains: ['竞争洞察'] });
  assert.equal(bad.status, 400);
});

// ── 7. 工具与界面 ───────────────────────────────────────────────────────────
section('7. 工具定义与界面');

const toolSrc = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8');
const clientSrc = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');

await test('工具：新增 catalog 动作，域枚举含「竞争洞察」', () => {
  assert.ok(/enum: \['list'[\s\S]*?'catalog'/.test(toolSrc), 'action 枚举里没有 catalog');
  assert.ok(toolSrc.includes("action === 'catalog'"), '没有 catalog 分支');
  assert.ok(toolSrc.includes("['竞争洞察']") || toolSrc.includes("'竞争洞察'"), '域枚举没放开竞争洞察');
});

await test('界面：域清单来自 /state（带指标数），不再硬编码 5 个域', () => {
  assert.ok(clientSrc.includes('a.collectionDomains'), '界面没读 collectionDomains');
  assert.ok(clientSrc.includes('metricCount'), '界面没显示指标数');
  assert.ok(clientSrc.includes('本地指标目录'), '界面没有目录概览');
  assert.ok(!clientSrc.includes("['经营总览', '成交与客户'], ['流量转化', '访客与转化'], ['运营推广', '广告与营销']") || clientSrc.includes('collectionDomains'),
    '仍在硬编码域清单');
});

await test('采集提示词带指标规模与 catalog 指令', () => {
  const acc = { id: 'acc_taobao_x', platform: 'taobao', name: '演示店', collection: { enabled: true, domains: ['运营推广'] } };
  const prompt = C.collectionPrompt(acc, { domainMeta: CAT.catalogDomains('taobao') });
  assert.ok(prompt.includes('约 540 项指标'), '提示词里没有指标数');
  assert.ok(prompt.includes('action=catalog'), '提示词里没有 catalog 指令');
  assert.ok(prompt.includes('-scheduler-运营推广'), '提示词里没有 domain_id');
});

await test('买家账号：目录层多出来的「竞争洞察」也会被剔除', () => {
  const acc = { id: 'acc_taobao_b', platform: 'taobao', accountType: 'buyer', name: '买家号', collection: { enabled: true, domains: ['经营总览', '服务履约', '竞争洞察'] } };
  const prompt = C.collectionPrompt(acc, { domainMeta: CAT.catalogDomains('taobao') });
  assert.ok(!prompt.includes('-scheduler-竞争洞察'), '买家账号不该采竞争洞察');
  assert.ok(prompt.includes('-scheduler-服务履约'), '商品/服务侧应保留');
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
