#!/usr/bin/env node
/**
 * features-v0169.mjs —— v0.16.9：补齐天猫 / 抖音 / 京东的采集配方 + 登录页兜底判定
 *
 *   A. 配方清单：7 份种子，按平台分组（淘宝/天猫/拼多多各 1，京东 2，抖音 2）
 *   B. 天猫：与淘宝同口径（经营总览接口 + 单日锚点查询 + 登录守卫）
 *   C. 抖音：两份都是下载型（成交分析 / 收支分析），占位符已固化为近 30 天
 *   D. 京东：流量总览下载型新增，原经营概览保留
 *   E. 登录页兜底：失败时按「最终 URL 是否登录页」统一报 LOGIN_REQUIRED
 *   F. 文档与版本
 *
 * 全离线：只做配方解析/编译与源码断言，不碰浏览器、不发网络请求。
 * 跑法：node test/features-v0169.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-v0169-'));
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

const R = await import(url('lib/rpa.mjs'));
const D = await import(url('lib/dsls.mjs'));
const J = await import(url('lib/collect-runner.mjs'));
const P = await import(url('lib/platforms.mjs'));

const WINDOW = { start: '2026-10-04', end: '2026-11-02' };
const items = D.listDsls().items;
const byId = (id) => items.find((it) => it.id === id);
const rawOf = (id) => D.loadDsl(id).raw;

// ── A. 配方清单 ─────────────────────────────────────────────────────────────
section('A. 配方清单：7 份种子，覆盖 5 个平台');

await test('种子共 7 份，按平台分组符合预期', () => {
  assert.equal(items.length, 7, '种子数量应为 7，实际 ' + items.length);
  const groups = {};
  for (const it of items) (groups[it.platform] = groups[it.platform] || []).push(it.id);
  assert.deepEqual(groups.taobao.sort(), ['tb_shop_overview']);
  assert.deepEqual(groups.tmall.sort(), ['tmall_shop_overview']);
  assert.deepEqual(groups.pdd.sort(), ['pdd_shop_overview']);
  assert.deepEqual(groups.jd.sort(), ['jd_shop_overview', 'jd_traffic_overview']);
  assert.deepEqual(groups.douyin.sort(), ['douyin_shop_income_expense', 'douyin_shop_transaction']);
});

await test('每份种子都能编译，且都声明了产物', () => {
  for (const it of items) {
    const compiled = R.compileExecution(rawOf(it.id), { ...WINDOW, runId: 'seed' });
    assert.ok(compiled.ops.length > 0, it.id + ' 没有编译出任何步骤');
    assert.ok(compiled.declaredArtifacts.length > 0, it.id + ' 没有声明产物');
    assert.equal(compiled.dslId, it.id);
  }
});

await test('种子文件里不含上游/个人痕迹', () => {
  for (const it of items) {
    const raw = readText(path.join('lib', 'rpa', 'dsls', it.platform, it.id + '.json'));
    for (const bad of ['accio', 'C:\\Users\\', '用户原话']) assert.ok(!raw.includes(bad), it.id + ' 含 ' + bad);
  }
});

// ── B. 天猫 ─────────────────────────────────────────────────────────────────
section('B. 天猫：经营总览接口 + 单日锚点 + 登录守卫');

await test('天猫配方声明经营总览 JSON 产物', () => {
  const arts = rawOf('tmall_shop_overview').collection.artifacts;
  assert.equal(arts.length, 1);
  assert.equal(arts[0].kind, 'json_string');
  assert.equal(arts[0].output_key, 'overviewResponse');
});

await test('天猫配方的时间条件是 30 天回溯窗口，查询用单日锚点', () => {
  const exec = R.buildExecution(rawOf('tmall_shop_overview'), { ...WINDOW });
  assert.equal(exec.dsl.collection.schedule.mode, 'trailing_window');
  assert.equal(exec.dsl.collection.schedule.days, 30);
  assert.ok(exec.query && exec.query.singleDay === true, 'trailing_window 应为单日锚点查询');
  assert.equal(exec.query.start, WINDOW.end);
  const compiled = R.compileExecution(rawOf('tmall_shop_overview'), { ...WINDOW });
  const vars = JSON.stringify(compiled.ops);
  assert.ok(vars.includes(WINDOW.end + '%7C' + WINDOW.end), '日期参数应为同一锚点日，实际：' + vars.slice(0, 200));
});

await test('天猫配方带登录守卫（命中登录框就短路成 LOGIN_REQUIRED）', () => {
  const compiled = R.compileExecution(rawOf('tmall_shop_overview'), { ...WINDOW });
  const guardIdx = compiled.ops.findIndex((o) => /LOGIN_REQUIRED/i.test(JSON.stringify(o)));
  assert.ok(guardIdx >= 0, '没有找到登录守卫步骤');
});

// ── C. 抖音 ─────────────────────────────────────────────────────────────────
section('C. 抖音：成交分析 / 收支分析，下载型');

await test('抖音交易配方是下载型，产物是明细文件', () => {
  const it = byId('douyin_shop_transaction');
  assert.equal(it.hasDownload, true);
  assert.equal(it.platform, 'douyin');
  const arts = rawOf('douyin_shop_transaction').collection.artifacts;
  assert.equal(arts.length, 1);
  assert.equal(arts[0].kind, 'download_ref');
  assert.equal(arts[0].output_key, 'doudianTransactionFile');
});

await test('抖音收支配方同样是下载型，产物键不同', () => {
  const arts = rawOf('douyin_shop_income_expense').collection.artifacts;
  assert.equal(arts[0].kind, 'download_ref');
  assert.equal(arts[0].output_key, 'doudianIncomeExpenseFile');
});

await test('抖音配方的时间档位已固化成「近30天」，没有残留占位符', () => {
  for (const id of ['douyin_shop_transaction', 'douyin_shop_income_expense']) {
    const raw = readText(path.join('lib', 'rpa', 'dsls', 'douyin', id + '.json'));
    assert.ok(/近30天/.test(raw), id + ' 没有固化时间档位');
    assert.ok(!/\{period\}/.test(raw), id + ' 还留着 {period} 占位符');
    const compiled = R.compileExecution(rawOf(id), { ...WINDOW });
    assert.ok(compiled.ops.some((o) => /近30天/.test(JSON.stringify(o))), id + ' 编译后找不到时间档位');
  }
});

await test('抖音配方的时间条件是自然日区间（period），不是单日锚点', () => {
  const exec = R.buildExecution(rawOf('douyin_shop_transaction'), { ...WINDOW });
  assert.equal(exec.dsl.collection.schedule.mode, 'period');
  assert.equal(exec.query.singleDay, false);
});

// ── D. 京东 ─────────────────────────────────────────────────────────────────
section('D. 京东：新增流量总览下载型，原经营概览保留');

await test('京东流量总览是下载型', () => {
  const it = byId('jd_traffic_overview');
  assert.equal(it.hasDownload, true);
  const arts = rawOf('jd_traffic_overview').collection.artifacts;
  assert.equal(arts[0].kind, 'download_ref');
  assert.equal(arts[0].output_key, 'jdFlowSummaryFile');
});

await test('京东经营概览仍在，且是整份原始产物', () => {
  const arts = rawOf('jd_shop_overview').collection.artifacts;
  assert.equal(arts.length, 1);
  assert.equal(arts[0].kind, 'raw_envelope');
  assert.equal(arts[0].pointer, '');
});

// ── E. 登录页兜底判定 ───────────────────────────────────────────────────────
section('E. 登录页兜底：配方没写守卫时，按最终 URL 报 LOGIN_REQUIRED');

await test('executeOps 用平台定义的登录页判据做兜底', () => {
  const src = readText(path.join('lib', 'index.js'));
  assert.ok(src.includes('looksLikeLoginPage(res.finalUrl'), '没有按最终 URL 判登录页');
  assert.ok(src.includes("code: 'LOGIN_REQUIRED'"), '兜底没有统一成 LOGIN_REQUIRED');
  assert.ok(src.includes("platformOf(account.platform)"), '判据没有取平台定义');
});

await test('登录页判据对抖音/京东/淘宝成立，对业务页不成立', () => {
  const cases = [
    ['https://fxg.jinritemai.com/login/common', 'douyin', true],
    ['https://compass.jinritemai.com/shop/business-part', 'douyin', false],
    ['https://passport.shop.jd.com/login/index.action/jdm?ReturnUrl=x', 'jd', true],
    ['https://jdsz.jd.com/home.html', 'jd', false],
    ['https://loginmyseller.taobao.com/?from=taobaoindex', 'taobao', true],
    ['https://sycm.taobao.com/portal/home.htm', 'tmall', false],
  ];
  for (const [u, plat, want] of cases) {
    assert.equal(P.looksLikeLoginPage(u, P.platformOf(plat), 'seller'), want, u + ' 判错了');
  }
});

await test('只有「普通失败」才升级成 LOGIN_REQUIRED（能力/驱动类错误原样透出）', () => {
  const src = readText(path.join('lib', 'index.js'));
  assert.ok(src.includes("code === 'STEP_FAILED'") && src.includes("code === 'STEP_TIMEOUT'") && src.includes("code === 'TARGET_NOT_AVAILABLE'"));
  assert.ok(!src.includes("code === 'UNSUPPORTED_CAPABILITY'))"), '不该把能力类错误吞成登录问题');
});

// ── F. 编排层拿到这些配方 ───────────────────────────────────────────────────
section('F. 编排层：按平台挑到新配方');

await test('天猫账号 prepare 时挑到天猫配方', () => {
  const dsls = items.filter((it) => it.platform === 'tmall').map((it) => ({ meta: it, raw: rawOf(it.id) }));
  const out = J.prepareJob({
    account: { id: 'acc_tmall_v169', platform: 'tmall', name: 'v169 天猫店' },
    dsls,
    start: WINDOW.start,
    end: WINDOW.end,
    skipCovered: false,
  }, (raw, opts) => R.compileExecution(raw, opts));
  assert.equal(out.success, true, JSON.stringify(out.errors || out.plan && out.plan.failedToPrepare));
  assert.equal(out.data.next_action, 'native_calls');
  assert.equal(out.data.tasks[0].dslId, 'tmall_shop_overview');
});

await test('抖音账号 prepare 时挑到抖音配方（两份都在计划里）', () => {
  const dsls = items.filter((it) => it.platform === 'douyin').map((it) => ({ meta: it, raw: rawOf(it.id) }));
  const out = J.prepareJob({
    account: { id: 'acc_douyin_v169', platform: 'douyin', name: 'v169 抖音店' },
    dsls,
    start: WINDOW.start,
    end: WINDOW.end,
    skipCovered: false,
  }, (raw, opts) => R.compileExecution(raw, opts));
  assert.equal(out.success, true);
  assert.equal(out.data.tasks.length, 2);
  assert.deepEqual(out.data.tasks.map((t) => t.dslId).sort(), ['douyin_shop_income_expense', 'douyin_shop_transaction']);
});

await test('天猫账号拿到平台不匹配的配方会被拒（不许跨平台乱跑）', () => {
  const dsls = items.filter((it) => it.platform === 'douyin').map((it) => ({ meta: it, raw: rawOf(it.id) }));
  const out = J.prepareJob({
    account: { id: 'acc_tmall_v169b', platform: 'tmall', name: 'v169 天猫店' },
    dsls,
    start: WINDOW.start,
    end: WINDOW.end,
    skipCovered: false,
  }, (raw, opts) => R.compileExecution(raw, opts));
  assert.equal(out.success, false);
  assert.ok(out.errors.some((e) => /platform_mismatch/i.test(String(e.code || ''))), JSON.stringify(out.errors));
});

// ── G. 文档与版本 ───────────────────────────────────────────────────────────
section('G. 文档与版本');

await test('版本号与文档覆盖 v0.16.9', () => {
  const pkg = JSON.parse(readText('package.json'));
  const [maj, min, patch] = String(pkg.version).split('.').map(Number);
  assert.ok(maj === 0 && (min > 16 || (min === 16 && patch >= 9)), '版本号应 ≥0.16.9，实际 ' + pkg.version);
  assert.ok(readText('CHANGELOG.md').includes('0.16.9'), 'CHANGELOG 缺 v0.16.9');
  assert.ok(readText('README.md').includes('0.16.9'), 'README 缺 v0.16.9');
});

await test('README 的平台覆盖表已包含天猫/京东/抖音', () => {
  const md = readText('README.md');
  for (const name of ['天猫', '京东', '抖音']) {
    assert.ok(new RegExp(name + '[\\s\\S]{0,120}?tb_shop_overview|tmall_shop_overview|jd_traffic_overview|douyin_shop_transaction').test(md) || md.includes(name), name + ' 没出现在 README');
  }
  assert.ok(md.includes('tmall_shop_overview'), 'README 没有提到天猫配方');
  assert.ok(md.includes('douyin_shop_transaction'), 'README 没有提到抖音配方');
});

console.log('\n' + (failures.length ? 'FAILED: ' + failures.length : 'OK') + ' / ' + (passed + failures.length) + ' 项，通过 ' + passed);
if (failures.length) {
  for (const f of failures) console.error('\n✗ ' + f.name + '\n  ' + (f && f.err && f.err.stack ? f.err.stack : f.err));
  process.exit(1);
}
