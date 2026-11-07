#!/usr/bin/env node
/**
 * features-v0167.mjs —— v0.16.7：真实跑一次定时采集暴露出的四个问题
 *
 * 背景：把「定时采集」在真实店铺上跑起来，结果一家报失败、一家报「无数据」。
 * 复查后确认四个真问题，全部是「引擎把正常情况当成了坏结果」：
 *   A. `when` 条件里看不到元素（跨域 iframe）被当成致命错误 → 整条配方被打断；
 *   B. 配方声明的「采集后处理能力」（需要专用解密）没人检查 → 采到加密壳却报「业务无数据」；
 *   C. `trailing_window` 配方的接口只认「单日锚点」，传 30 天区间会被判参数错；
 *   D. 后端把产物写死成空数组 → 采到数据也判「空」；以及「一条都没准备好」被当成「今天已采过」。
 *
 * 本套覆盖：
 *   A. 条件不成立（blocked）不致命，配方继续往下走；两份执行器都改到了
 *   B. 缺后处理能力 → 明确报 UNSUPPORTED_CAPABILITY（编译期就拦，不是跑完才说）
 *   C. trailing_window / per_day / snapshot 用单日锚点查询，period 类仍用整段
 *   D. 产物按配方声明的 artifacts 归集；定时采集把失败原因透出到账号上
 *
 * 零依赖、不起浏览器。跑法：node test/features-v0167.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readServerSource } from './_src.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-v0167-'));
process.env.DSH_SHOP_ACCOUNTS_DIR = path.join(TMP, 'data');
process.env.SHOP_ACCOUNTS_DSL_DIR = '';

const url = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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

const rpa = await import(url('lib/rpa.mjs'));
const runner = await import(url('lib/collect-runner.mjs'));
const storeMod = await import(url('lib/store.mjs'));
const host = await import(url('lib/index.js'));

const tbSeed = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/rpa/dsls/taobao/tb_shop_overview.json'), 'utf8'));
const pddSeed = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/rpa/dsls/pdd/pdd_shop_overview.json'), 'utf8'));
const tbItem = { meta: { id: 'tb_shop_overview', platform: 'taobao' }, raw: tbSeed };
const pddItem = { meta: { id: 'pdd_shop_overview', platform: 'pdd' }, raw: pddSeed };

// ── A. 条件不成立不致命 ────────────────────────────────────────────────────
section('A. `when` 条件里看不到元素：跳过这一段，不要把整条配方打断');

function blockedDriver() {
  return {
    async goto(u) { return { url: u }; },
    async evaluate() { return { blocked: true, reason: '元素在跨域 iframe 里' }; },
    async find() { return { found: false }; },
    async click() { return { ok: true }; },
    async readText() { return { text: '' }; },
    async sleep() {},
    async currentUrl() { return 'about:blank'; },
  };
}

await test('blocked 的 wait 在条件里只记为 blocked，不再抛错', async () => {
  const ops = [
    { op: 'wait', stepId: 'guard-visible', expr: 'x', expect: 'visible', timeoutMs: 10, asCondition: true },
    { op: 'sleep', stepId: 'after-guard', ms: 1 },
  ];
  const res = await rpa.runOps({ ops }, blockedDriver(), {});
  assert.equal(res.ok, true, '条件不成立不该让整条配方失败');
  const guard = (res.steps || []).find((s) => s.id === 'guard-visible');
  assert.ok(guard, '要有这一步的记录');
  assert.equal(guard.blocked, true, '要记下「条件没成立」');
});

await test('不在条件里时，blocked 仍然算失败（不能把故障吞掉）', async () => {
  const ops = [{ op: 'wait', stepId: 'plain', expr: 'x', expect: 'visible', timeoutMs: 10 }];
  const res = await rpa.runOps({ ops }, blockedDriver(), {});
  assert.equal(res.ok, false, '不在条件里时 blocked 仍要报错');
  assert.equal(res.code, 'TARGET_NOT_AVAILABLE');
  assert.match(String(res.error || ''), /跨域 iframe/);
});

await test('两份执行器都改了（主执行器 + ego 注入的那份）', () => {
  const code = src('lib/rpa.mjs');
  const hits = code.match(/if \(o\.asCondition\)/g) || [];
  assert.ok(hits.length >= 2, '主执行器与 ego 执行器都要按条件处理 blocked，实际 ' + hits.length + ' 处');
  const egoPart = code.slice(code.indexOf('const EGO_EXECUTOR_SOURCE'));
  assert.match(egoPart, /asCondition/, 'ego 注入的那份执行器也要遵守 asCondition');
});

// ── B. 后处理能力门控 ──────────────────────────────────────────────────────
section('B. 配方要求本插件没有的后处理能力：编译期就明确拒绝');

await test('声明了本插件没有的后处理能力 → 编译期就 UNSUPPORTED_CAPABILITY', () => {
  assert.equal(Array.isArray(pddSeed.collection.capabilities.after), true);
  // v0.16.8 起 `pdd_decrypt` 已经支持（按需执行），所以「拒绝未知能力」要用一份合成配方来验
  const unsupportedSeed = JSON.parse(JSON.stringify(pddSeed));
  unsupportedSeed.collection.capabilities.after = ['pdd_decrypt', 'unknown_fancy_decrypt'];
  let err = null;
  try {
    rpa.compileExecution(unsupportedSeed, { start: '2026-10-04', end: '2026-11-02' });
  } catch (e) {
    err = e;
  }
  assert.ok(err, '缺能力必须拒绝，不能跑到一半才说');
  assert.equal(err.code, 'UNSUPPORTED_CAPABILITY');
  assert.deepEqual(err.unsupported, ['unknown_fancy_decrypt']);
  assert.match(err.message, /unknown_fancy_decrypt/);
});

await test('淘宝种子配方没有额外能力要求 → 正常编译出步骤', () => {
  const exec = rpa.compileExecution(tbSeed, { start: '2026-10-04', end: '2026-11-02' });
  assert.equal(exec.dslId, 'tb_shop_overview');
  assert.ok(Array.isArray(exec.ops) && exec.ops.length > 0);
  assert.ok(Array.isArray(exec.declaredArtifacts) && exec.declaredArtifacts.length > 0);
});

await test('prepareJob 把编译失败当成失败返回，而不是「已采过」', () => {
  storeMod.ensureDir(process.env.DSH_SHOP_ACCOUNTS_DIR);
  const account = { id: 'acc_pdd_test', platform: 'pdd', accountType: 'seller' };
  const brokenSeed = JSON.parse(JSON.stringify(pddSeed));
  brokenSeed.collection.capabilities.after = ['pdd_decrypt', 'unknown_fancy_decrypt'];
  const brokenItem = { meta: { id: 'pdd_shop_overview', platform: 'pdd' }, raw: brokenSeed };
  const out = runner.prepareJob({ account, dsls: [brokenItem], start: '2026-10-04', end: '2026-11-02', skipCovered: false }, rpa.compileExecution);
  assert.equal(out.success, false);
  assert.equal(out.errors[0].code, 'UNSUPPORTED_CAPABILITY');
  assert.equal(out.errors[0].dslId, 'pdd_shop_overview');
  assert.equal(out.data.summary.failedToPrepare, 1);
});

await test('能准备的配方照常进批次（不因上面那条被带坏）', () => {
  const account = { id: 'acc_tb_test', platform: 'taobao', accountType: 'seller' };
  const out = runner.prepareJob({ account, dsls: [tbItem], start: '2026-10-04', end: '2026-11-02', skipCovered: false }, rpa.compileExecution);
  assert.equal(out.success, true);
  assert.equal(out.data.tasks.length, 1);
  assert.equal(out.data.next_action, 'native_calls');
});

// ── C. 时间口径 ────────────────────────────────────────────────────────────
section('C. 时间口径：趋势类接口按单日锚点查询，区间类仍用整段');

await test('trailing_window：查询日是锚点单日，窗口仍是 30 天', () => {
  const exec = rpa.buildExecution(tbSeed, { start: '2026-10-04', end: '2026-11-02' });
  assert.equal(exec.window.start, '2026-10-04');
  assert.equal(exec.window.end, '2026-11-02');
  assert.equal(exec.query.singleDay, true);
  assert.equal(exec.query.start, '2026-11-02', 'query_anchor=end → 用窗口最后一天');
  assert.equal(exec.query.end, '2026-11-02');
});

await test('per_day / snapshot 同样是单日锚点', () => {
  const base = JSON.parse(JSON.stringify(tbSeed));
  base.collection.schedule = { mode: 'per_day', days: 30 };
  const exec = rpa.buildExecution(base, { start: '2026-10-04', end: '2026-11-02' });
  assert.equal(exec.query.singleDay, true);
  assert.equal(exec.query.start, exec.query.end);
});

await test('period 类配方仍用整段区间', () => {
  const base = JSON.parse(JSON.stringify(tbSeed));
  base.collection.schedule = { mode: 'period', days: 30 };
  const exec = rpa.buildExecution(base, { start: '2026-10-04', end: '2026-11-02' });
  assert.equal(exec.query.singleDay, false);
  assert.equal(exec.query.start, '2026-10-04');
  assert.equal(exec.query.end, '2026-11-02');
});

// ── D. 产物归集与失败原因透出 ──────────────────────────────────────────────
section('D. 产物按配方声明归集；定时采集把原因说到账号上');

await test('产物按配方里声明的 artifacts 收集（有值就是有数据）', () => {
  const artifacts = rpa.collectArtifacts(
    { collection: { artifacts: [{ role: 'business', kind: 'json_string', output_key: 'overviewResponse' }] } },
    { overviewResponse: '{"code":0}' },
  );
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].present, true);
  const st = rpa.artifactStatus({ artifacts });
  assert.equal(st.ok, true, '有声明产物且有值 → 不能被判成「业务无数据」');
});

await test('后端不再把产物写死成空数组（按任务声明的 artifacts 走）', () => {
  const code = readServerSource(ROOT);
  assert.equal(
    code.includes('collectArtifacts({ collection: { artifacts: [] } }, {})'),
    false,
    '这行死代码必须删掉',
  );
  assert.match(code, /declaredArtifacts/);
});

await test('定时采集遇到「缺后处理能力」：code 与账号上的说明都写清楚', async () => {
  const now = Date.now();
  storeMod.writeAccounts([
      {
        id: 'acc_tb_sched',
        platform: 'taobao',
        accountType: 'seller',
        name: '测试店铺',
        loginName: '测试;主账号',
        url: '',
        note: '',
        profileDir: path.join(process.env.DSH_SHOP_ACCOUNTS_DIR, 'profiles', 'acc_tb_sched'),
        pendingLogin: false,
        schedEnabled: true,
        createdAt: now,
        updatedAt: now,
        collection: { enabled: true, domains: ['经营总览'], lastRunAt: 0, lastRunStatus: '', lastRunNote: '' },
      },
  ]);
  const account = storeMod.readAccounts().accounts.find((a) => a.id === 'acc_tb_sched');
  const res = await host.runScheduledCollection(account, () => {}, {
    prepareFn: async () => ({
      success: false,
      errors: [{ code: 'UNSUPPORTED_CAPABILITY', message: '这条配方声明了本插件没有的采集后处理能力：pdd_decrypt' }],
    }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'UNSUPPORTED_CAPABILITY');
  assert.match(res.error, /本插件暂不支持/);
  const after = storeMod.readAccounts().accounts.find((a) => a.id === 'acc_tb_sched');
  assert.match(String(after.lastSchedError || ''), /本插件暂不支持/, '要把原因写到账号上');
  assert.equal(after.collection.lastRunStatus, 'failed', '不能留成 ok');
});

console.log('\n' + (failures.length ? 'FAILED' : 'OK') + '  passed=' + passed + ' failed=' + failures.length);
if (failures.length) process.exitCode = 1;
