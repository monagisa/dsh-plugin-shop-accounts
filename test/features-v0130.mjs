#!/usr/bin/env node
/**
 * features-v0130.mjs —— v0.13.0 声明式采集 DSL 引擎：
 *   1. 编译层：时间窗口（最近 30 个完整自然日）、占位符 bindings（{dateRange} → encoded）、残留占位符报错
 *   2. 执行层：goto / waitFor / readText / click / when 分支 / 登录守卫 → LOGIN_REQUIRED
 *   3. 产物声明：artifacts present/bytes；空产物 = 业务无数据（不重试）
 *   4. 真实 DSL：三份种子配方都能编译（不是玩具格式）
 *   5. 库存与 HTTP 面：GET /rpa/dsls、POST collect-run 的 404/400/501/409 边界
 *   6. ego 执行器源码与工具动作接线
 *
 * 零依赖、不启动浏览器（执行层用 makeMockDriver 全离线覆盖）。
 * 跑法：node test/features-v0130.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-v0130-'));
process.env.DSH_SHOP_ACCOUNTS_DIR = path.join(TMP, 'data');
process.env.SHOP_ACCOUNTS_DSL_DIR = ''; // 只用插件自带种子，避免被外部配方库影响

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

const R = await import(url('lib/rpa.mjs'));
const D = await import(url('lib/dsls.mjs'));

const SEED_DSLS = path.join(ROOT, 'lib', 'rpa', 'dsls');
const readSeed = (rel) => JSON.parse(fs.readFileSync(path.join(SEED_DSLS, rel), 'utf8'));

// ── 1. 编译层 ───────────────────────────────────────────────────────────────
section('1. 编译层：时间窗口 / 占位符 / 参数');

await test('trailingWindow：最近 30 个完整自然日（30 天前 ~ 昨天，不含今天）', () => {
  const win = R.trailingWindow(new Date(2026, 10, 2), 30); // 2026-11-02
  assert.equal(win.end, '2026-11-01');
  assert.equal(win.start, '2026-10-03');
  assert.equal(win.days, 30);
});

await test('conditions.bindings 把 {dateRange} 绑到 $condition.encoded', () => {
  const vars = R.conditionValues({
    conditions: { time: { kind: 'range', bindings: { '{dateRange}': '$condition.encoded' } } },
  }, { start: '2026-10-03', end: '2026-11-01' });
  assert.equal(vars.dateRange, '2026-10-03%7C2026-11-01');
  assert.equal(vars.start, '2026-10-03');
  assert.equal(vars.end, '2026-11-01');
});

await test('填参后残留占位符 → INVALID_DSL 并点名缺哪个', () => {
  const dsl = { id: 'x', template: { steps: [{ action: 'goto', url: 'https://x/?p={productId}' }] } };
  try {
    R.compileExecution(dsl, { start: '2026-10-03', end: '2026-11-01' });
    assert.fail('应该抛错');
  } catch (err) {
    assert.equal(err.code, 'INVALID_DSL');
    assert.deepEqual(err.unresolved, ['{productId}']);
  }
});

await test('传 params 就能填上；runId 自动生成', () => {
  const dsl = {
    id: 'x',
    template: { steps: [{ action: 'goto', url: 'https://x/?p={productId}&r={runId}' }] },
  };
  const one = R.compileExecution(dsl, { start: '2026-10-03', end: '2026-11-01', params: { productId: '123456' } });
  assert.match(one.ops[0].url, /p=123456/);
  assert.match(one.ops[0].url, /r=run_/);
  const two = R.compileExecution(dsl, { start: '2026-10-03', end: '2026-11-01', params: { productId: '1' } });
  assert.notEqual(one.ops[0].url, two.ops[0].url, '每次执行的 runId 不该相同');
});

await test('没声明 schedule.days 时默认 30 天窗口', () => {
  const dsl = R.parseDsl({ id: 'x', template: { steps: [{ action: 'waitTimeout', ms: 1 }] } });
  const win = R.dslWindow(dsl, new Date(2026, 10, 2));
  assert.equal(win.days, 30);
  assert.equal(win.end, '2026-11-01');
});

// ── 2. 真实 DSL 能编译 ──────────────────────────────────────────────────────
section('2. 真实配方能编译（不是玩具格式）');

const seeds = [
  ['taobao/tb_shop_overview.json', 'tb_shop_overview', 'taobao'],
  ['jd/jd_shop_overview.json', 'jd_shop_overview', 'jd'],
  ['pdd/pdd_shop_overview.json', 'pdd_shop_overview', 'pdd'],
];

await test('三份种子配方全部编译通过，淘宝/京东的带登录守卫分支', () => {
  for (const [rel, id, platform] of seeds) {
    const raw = readSeed(rel);
    const compiled = R.compileExecution(raw, { start: '2026-10-03', end: '2026-11-01' });
    assert.equal(compiled.dslId, id, rel + ' 的 id 不对');
    assert.equal(compiled.dsl.platform, platform);
    assert.ok(compiled.ops.length >= 5, rel + ' op 太少');
    assert.ok(compiled.ops.some((o) => o.op === 'goto'), rel + ' 没有 goto');
    // 拼多多的概览配方没有登录守卫分支（它用的是别的短路方式），淘宝/京东有
    if (platform !== 'pdd') assert.ok(compiled.ops.some((o) => o.op === 'branch'), rel + ' 没有登录守卫分支');
  }
});

await test('淘宝配方把 dateRange 填进了站内接口 URL（%7C 编码）', () => {
  const compiled = R.compileExecution(readSeed('taobao/tb_shop_overview.json'), { start: '2026-10-03', end: '2026-11-01' });
  const api = compiled.ops.find((o) => o.op === 'goto' && /\.json/.test(String(o.url)));
  assert.ok(api, '没找到 goto 站内接口那一步');
  assert.match(api.url, /dateRange=2026-10-03%7C2026-11-01/);
  assert.match(api.url, /dateType=day/);
});

await test('下载型 DSL 编译成 download op（v0.14.0 起支持落盘）', () => {
  const dsl = {
    id: 'dl',
    template: { steps: [{ action: 'goto', url: 'https://x/' }, { action: 'downloadFile', target: [{ by: 'css', value: '#dl' }], outputKey: 'file' }] },
    collection: { artifacts: [{ role: 'business', kind: 'download_ref', output_key: 'file' }] },
  };
  const compiled = R.compileExecution(dsl, { start: '2026-10-03', end: '2026-11-01' });
  const dl = compiled.ops.find((o) => o.op === 'download');
  assert.ok(dl, '没有编译出 download op');
  assert.equal(dl.outputKey, 'file');
  assert.ok(dl.timeoutMs >= 1000);
});

// ── 3. 执行层（mock driver，全离线）────────────────────────────────────────
section('3. 执行层：步骤语义 / 登录守卫 / 产物');

function jsonDsl(extraSteps = []) {
  return {
    id: 'demo_api',
    platform: 'taobao',
    conditions: { time: { kind: 'range', bindings: { '{dateRange}': '$condition.encoded' } } },
    template: {
      defaults: { timeoutMs: 2000 },
      steps: [
        { action: 'goto', url: 'https://sycm.taobao.com/portal/home.htm', id: 'entry' },
        ...extraSteps,
        {
          action: 'goto',
          url: 'https://sycm.taobao.com/api/trend.json?dateRange={dateRange}',
          id: 'api',
        },
        { action: 'waitFor', target: [{ by: 'css', value: 'pre' }], state: 'visible', timeoutMs: 2000, id: 'wait-json' },
        { action: 'readText', target: [{ by: 'css', value: 'pre' }], outputKey: 'response', id: 'read-json' },
      ],
    },
    collection: { artifacts: [{ role: 'business', kind: 'json_string', output_key: 'response' }] },
  };
}

await test('正常采集：goto → 读 pre → outputs 有值 → artifactStatus ok', async () => {
  const compiled = R.compileExecution(jsonDsl(), { start: '2026-10-03', end: '2026-11-01' });
  const driver = R.makeMockDriver({ pages: { '/api/trend.json': { elements: { pre: { visible: true, text: '{"data":42}' } } } } });
  const r = await R.runOps(compiled, driver);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.outputs.response, '{"data":42}');
  assert.equal(r.artifacts.length, 1);
  assert.equal(r.artifacts[0].present, true);
  assert.ok(r.artifacts[0].bytes > 0);
  assert.deepEqual(R.artifactStatus(r).ok, true);
  assert.ok(driver.calls.some((c) => c.op === 'goto' && /dateRange=2026-10-03%7C2026-11-01/.test(c.url)));
});

await test('登录守卫：命中登录框 → 断言不可见失败 → LOGIN_REQUIRED', async () => {
  const guard = {
    action: 'when',
    id: 'guard',
    condition: { kind: 'element', target: [{ by: 'css', value: '#fm-login-id' }], state: 'visible', timeoutMs: 500 },
    then: [{
      action: 'assertElement',
      id: 'guard:LOGIN_REQUIRED__未登录',
      state: 'hidden',
      onError: 'fail',
      target: [{ by: 'css', value: '#fm-login-id' }],
    }],
  };
  const compiled = R.compileExecution(jsonDsl([guard]), { start: '2026-10-03', end: '2026-11-01' });
  const driver = R.makeMockDriver({ pages: { '/portal/home.htm': { elements: { '#fm-login-id': { visible: true } } }, '*': { elements: { pre: { visible: true, text: '{}' } } } } });
  const r = await R.runOps(compiled, driver);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LOGIN_REQUIRED');
});

await test('登录守卫：没命中登录框就正常往下走', async () => {
  const guard = {
    action: 'when',
    id: 'guard',
    condition: { kind: 'element', target: [{ by: 'css', value: '#fm-login-id' }], state: 'visible', timeoutMs: 300 },
    then: [{ action: 'assertElement', id: 'g:LOGIN_REQUIRED', state: 'hidden', onError: 'fail', target: [{ by: 'css', value: '#fm-login-id' }] }],
  };
  const compiled = R.compileExecution(jsonDsl([guard]), { start: '2026-10-03', end: '2026-11-01' });
  const driver = R.makeMockDriver({ pages: { '*': { elements: { pre: { visible: true, text: '{"a":1}' } } } } });
  const r = await R.runOps(compiled, driver);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.outputs.response, '{"a":1}');
});

await test('空产物 = 业务无数据（empty_business_data），不是失败重采', async () => {
  const compiled = R.compileExecution(jsonDsl(), { start: '2026-10-03', end: '2026-11-01' });
  const driver = R.makeMockDriver({ pages: { '*': { elements: { pre: { visible: true, text: '' } } } } });
  const r = await R.runOps(compiled, driver);
  assert.equal(r.ok, true);
  const st = R.artifactStatus(r);
  assert.equal(st.ok, false);
  assert.equal(st.reason, 'empty_business_data');
});

await test('等不到元素且非 optional → STEP_TIMEOUT', async () => {
  const dsl = {
    id: 'timeout',
    template: { steps: [{ action: 'waitFor', target: [{ by: 'css', value: '#never' }], state: 'visible', timeoutMs: 300 }] },
  };
  const compiled = R.compileExecution(dsl, { start: '2026-10-03', end: '2026-11-01' });
  const driver = R.makeMockDriver({ pages: { '*': { elements: {} } } });
  const r = await R.runOps(compiled, driver);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'STEP_TIMEOUT');
});

await test('可选步骤失败不中断（onError=continue）', async () => {
  const dsl = {
    id: 'optional',
    template: {
      steps: [
        { action: 'click', target: [{ by: 'css', value: '#maybe-close' }], optional: true, id: 'close' },
        { action: 'readText', target: [{ by: 'css', value: 'pre' }], outputKey: 'o', id: 'read' },
      ],
    },
    collection: { artifacts: [{ role: 'business', kind: 'json_string', output_key: 'o' }] },
  };
  const compiled = R.compileExecution(dsl, { start: '2026-10-03', end: '2026-11-01' });
  const driver = R.makeMockDriver({ pages: { '*': { elements: { pre: { visible: true, text: 'ok' } } } } });
  const r = await R.runOps(compiled, driver);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.outputs.o, 'ok');
  assert.ok(r.steps.some((s) => s.status === 'skipped'));
});

await test('trace 记录每一步的 op/状态/耗时（可定位失败在哪一步）', async () => {
  const compiled = R.compileExecution(jsonDsl(), { start: '2026-10-03', end: '2026-11-01' });
  const driver = R.makeMockDriver({ pages: { '*': { elements: { pre: { visible: true, text: '{"z":1}' } } } } });
  const r = await R.runOps(compiled, driver);
  assert.ok(Array.isArray(r.steps) && r.steps.length >= 4);
  assert.ok(r.steps.every((s) => typeof s.op === 'string' && typeof s.ms === 'number'));
  assert.equal(r.steps[0].op, 'goto');
});

// ── 4. DSL 库存 ─────────────────────────────────────────────────────────────
section('4. DSL 库存（种子 + 外部配方库）');

await test('listDsls：自带 3 份种子可列出，且标了 hasDownload', () => {
  const { items, seedDir } = D.listDsls();
  assert.ok(seedDir.endsWith(path.join('lib', 'rpa', 'dsls')));
  const ids = items.map((d) => d.id);
  for (const [, id] of seeds) assert.ok(ids.includes(id), `库存里没有 ${id}`);
  assert.ok(items.every((d) => typeof d.hasDownload === 'boolean'));
});

await test('loadDsl：能按 id 读回原文；未知 id 返回 null', () => {
  const one = D.loadDsl('tb_shop_overview');
  assert.ok(one && one.raw && one.raw.template && Array.isArray(one.raw.template.steps));
  assert.equal(one.meta.platform, 'taobao');
  assert.equal(D.loadDsl('根本没有这个配方'), null);
});

await test('readMeta 能识别出「依赖下载」的配方', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'dsl-'));
  fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify({
    id: 'need_download', platform: 'jd', template: { steps: [{ action: 'goto', url: 'https://x/' }, { action: 'downloadFile', target: [{ by: 'css', value: '#a' }] }] },
  }), 'utf8');
  process.env.SHOP_ACCOUNTS_DSL_DIR = dir;
  const { items } = D.listDsls();
  const hit = items.find((d) => d.id === 'need_download');
  assert.ok(hit, '没读到外部目录里的配方');
  assert.equal(hit.hasDownload, true);
  assert.equal(hit.origin, 'external');
  process.env.SHOP_ACCOUNTS_DSL_DIR = '';
});

// ── 5. HTTP 面 ─────────────────────────────────────────────────────────────
section('5. HTTP：/rpa/dsls 与 collect-run 的边界');

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
function fakeReq(method, reqUrl, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = reqUrl;
  req.destroy = () => {};
  req.headers = {
    'x-dsh-shop-accounts': '1',
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
    host: '127.0.0.1:43120',
  };
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
async function call(method, p, body) {
  const { res, done } = fakeRes();
  handler(fakeReq(method, p, body), res);
  await done;
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* 非 JSON */ }
  return { status: res.statusCode, json };
}

await test('GET /rpa/dsls：列出配方并标注是否需要下载', async () => {
  const r = await call('GET', '/shop-accounts/rpa/dsls');
  assert.equal(r.status, 200);
  assert.ok(r.json.count >= 3);
  assert.ok(Array.isArray(r.json.items));
  assert.ok(r.json.items.some((i) => i.id === 'tb_shop_overview'));
  assert.ok(r.json.items.every((i) => typeof i.hasDownload === 'boolean'));
});

let taobaoId = '';
let jdId = '';
await test('建淘宝店 + 京东店（用于平台不匹配用例）', async () => {
  const a = await call('POST', '/shop-accounts/accounts', {
    platform: 'taobao', loginName: 'v130tb@example.com', password: 'V130-P@ss1', name: 'v130 淘宝店',
  });
  assert.equal(a.status, 200);
  taobaoId = a.json.account.id;
  const b = await call('POST', '/shop-accounts/accounts', {
    platform: 'jd', loginName: 'v130jd@example.com', password: 'V130-P@ss2', name: 'v130 京东店',
  });
  assert.equal(b.status, 200);
  jdId = b.json.account.id;
});

await test('POST collect-run：缺 dslId → 400；未知配方 → 404', async () => {
  const a = await call('POST', `/shop-accounts/accounts/${taobaoId}/collect-run`, {});
  assert.equal(a.status, 400);
  assert.equal(a.json.code, 'DSL_ID_REQUIRED');
  const b = await call('POST', `/shop-accounts/accounts/${taobaoId}/collect-run`, { dslId: '没有这个' });
  assert.equal(b.status, 404);
  assert.equal(b.json.code, 'DSL_NOT_FOUND');
});

await test('POST collect-run：配方平台不匹配 → 400', async () => {
  const r = await call('POST', `/shop-accounts/accounts/${jdId}/collect-run`, { dslId: 'tb_shop_overview' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'DSL_PLATFORM_MISMATCH');
});

await test('POST collect-run：下载型配方不再被 501 挡（会尝试真的跑，浏览器没开则 409）', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'dl-'));
  fs.writeFileSync(path.join(dir, 'need_dl.json'), JSON.stringify({
    id: 'need_dl', platform: 'taobao',
    template: { steps: [{ action: 'goto', url: 'https://x/' }, { action: 'downloadFile', target: [{ by: 'css', value: '#a' }], outputKey: 'f' }] },
    collection: { artifacts: [{ role: 'business', kind: 'download_ref', output_key: 'f' }] },
  }), 'utf8');
  process.env.SHOP_ACCOUNTS_DSL_DIR = dir;
  try {
    const r = await call('POST', `/shop-accounts/accounts/${taobaoId}/collect-run`, { dslId: 'need_dl' });
    assert.notEqual(r.status, 501, 'v0.14.0 起不再用 501 拒绝下载型配方');
    // 浏览器没开时：给一个明确的 4xx + 原因（Chrome 后端 BROWSER_NOT_RUNNING / ego 后端 ego_not_running/NO_SPACE）
    assert.ok(r.status >= 400 && r.status < 500, '应该是 4xx，实际 ' + r.status);
    assert.ok(r.json && (r.json.code || r.json.error), '要给出原因，不能空手');
  } finally {
    process.env.SHOP_ACCOUNTS_DSL_DIR = '';
  }
});

await test('POST collect-run：浏览器没开 → 409（不偷偷拉起浏览器）', async () => {
  const r = await call('POST', `/shop-accounts/accounts/${taobaoId}/collect-run`, { dslId: 'tb_shop_overview' });
  assert.ok(r.status >= 400 && r.status < 500, '浏览器没开应是 4xx，实际 ' + r.status);
  assert.ok(r.json && (r.json.code || r.json.error), '要给出原因，不能空手');
});

// ── 6. 接线与文档 ───────────────────────────────────────────────────────────
section('6. 工具/ego 接线与文档');

const indexSrc = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8');
const egoSrc = fs.readFileSync(path.join(ROOT, 'lib', 'ego.mjs'), 'utf8');

await test('工具：action 枚举含 collect-run 与 rpa-dsls，且有对应分支', () => {
  assert.ok(/enum: \['list'[\s\S]*?'rpa-dsls'/.test(indexSrc), '枚举里没有 rpa-dsls');
  assert.ok(indexSrc.includes("action === 'collect-run'"), '没有 collect-run 分支');
  assert.ok(indexSrc.includes("action === 'rpa-dsls'"), '没有 rpa-dsls 分支');
});

await test('ego 运行时里有采集执行器（一次任务空间进出跑完整条配方）', () => {
  assert.ok(egoSrc.includes('__rpaRunOps'), 'ego.mjs 里没有注入执行器');
  assert.ok(egoSrc.includes("op === 'rpa'"), 'ego.mjs 里没有 rpa 操作');
  assert.ok(egoSrc.includes('EGO_EXECUTOR_SOURCE'), '没有引用 rpa.mjs 的执行器源码');
});

await test('原始产物会落盘留证（失败也存，便于查配方）', () => {
  assert.ok(indexSrc.includes("'collection'") || indexSrc.includes("'collection', account.id, 'raw'"));
  assert.ok(indexSrc.includes('rawPath'));
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
