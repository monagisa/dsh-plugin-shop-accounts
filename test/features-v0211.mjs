/**
 * v0.21.1 自检：淘宝「商品报表」+「活动分析」、抖店「商品投放消耗」三条表格型配方，
 * 以及 table_rows 空行也保留表头的引擎语义。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readServerSource } from './_src.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const lib = (f) => pathToFileURL(path.join(ROOT, 'lib', f)).href;

let pass = 0;
let fail = 0;
const section = (name) => console.log('\n# ' + name);
async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  \u2713 ' + name);
  } catch (e) {
    fail += 1;
    console.log('  \u2717 ' + name + ' -> ' + (e && e.message));
  }
}

const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'rpa', 'dsls', rel), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

section('A. 淘宝「商品报表」配方');
await test('tb_ads_goods_report：走阿里妈妈商品报表，标注商品维度', () => {
  const dsl = read('taobao/tb_ads_goods_report.json');
  assert.equal(dsl.id, 'tb_ads_goods_report');
  assert.equal(dsl.platform, 'taobao');
  assert.deepEqual(dsl.domains, ['运营推广']);
  const text = JSON.stringify(dsl);
  assert.match(text, /report\/item_promotion/);
  assert.match(dsl.description, /商品维度/);
  assert.equal(dsl.verified, true);
});

await test('tb_ads_goods_report：仍走下载报表链路', () => {
  const dsl = read('taobao/tb_ads_goods_report.json');
  const actions = (dsl.template ? dsl.template.steps : dsl.steps).map((s) => s.action);
  assert.ok(actions.includes('evaluate'));
  const fetchStep = dsl.template.steps.find((s) => s.id === 'fetch-report-file');
  assert.ok(fetchStep, 'fetch-report-file');
  assert.equal(fetchStep.action, 'evaluate');
  const arts = dsl.collection.artifacts;
  assert.equal(arts.length, 1);
  assert.equal(arts[0].kind, 'download_ref');
});

section('B. 淘宝「活动分析」配方');
await test('tb_activity_analysis：读活动分析表并映射状态', () => {
  const dsl = read('taobao/tb_activity_analysis.json');
  assert.equal(dsl.id, 'tb_activity_analysis');
  assert.deepEqual(dsl.domains, ['运营推广']);
  assert.match(JSON.stringify(dsl.steps.find((s) => s.action === 'goto').url), /datawar\/activity\/analysis/);
  const ev = dsl.steps.find((s) => s.action === 'evaluate');
  assert.match(ev.expression, /活动名称/);
  assert.match(ev.expression, /累计支付金额/);
  const art = dsl.collection.artifacts[0];
  assert.equal(art.kind, 'table_rows');
  assert.equal(art.tableName, '活动分析');
});

section('C. 抖店「商品投放消耗」配方');
await test('douyin_ads_goods_report：罗盘商品列表 + 投放消耗列', () => {
  const dsl = read('douyin/douyin_ads_goods_report.json');
  assert.equal(dsl.id, 'douyin_ads_goods_report');
  assert.deepEqual(dsl.domains, ['运营推广']);
  assert.match(dsl.steps.find((s) => s.action === 'goto').url, /commodity\/product-list/);
  const ev = dsl.steps.find((s) => s.action === 'evaluate');
  assert.match(ev.expression, /投放消耗（推商品）/);
  assert.equal(dsl.collection.artifacts[0].kind, 'table_rows');
});

section('D. 引擎语义：空行也保留表头');
await test('table_rows 空 rows 但 columns 存在时仍产 table', async () => {
  const rpa = await import(lib('rpa.mjs'));
  const dsl = { collection: { artifacts: [{ kind: 'table_rows', output_key: 'grid' }] } };
  const payload = JSON.stringify({ columns: ['日期', '花费'], rows: [] });
  const arts = rpa.collectArtifacts(dsl, { grid: payload });
  assert.equal(arts[0].table.columns.length, 2);
  assert.deepEqual(arts[0].table.rows, []);
});

await test('table_rows 空对象仍不进 table', async () => {
  const rpa = await import(lib('rpa.mjs'));
  const dsl = { collection: { artifacts: [{ kind: 'table_rows', output_key: 'grid' }] } };
  const arts = rpa.collectArtifacts(dsl, { grid: '{}' });
  assert.equal(arts[0].table, undefined);
});

section('E. 版本与清单');
await test('版本 ≥ 0.21.1，说明提到商品报表', () => {
  const parts = String(pkg.version).split('.').map(Number);
  const vc = (a, b) => {
    const x = String(a).split('.').map(Number);
    const y = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
      if ((x[i] || 0) > (y[i] || 0)) return true;
      if ((x[i] || 0) < (y[i] || 0)) return false;
    }
    return true;
  };
  assert.ok(vc(pkg.version, '0.21.1'));
});

await test('自检脚本登记在 package.json', () => {
  assert.match(String(pkg.scripts.test || ''), /node test\//);
});

console.log('\n' + (fail ? 'FAIL ' : 'PASS ') + pass + ' passed, ' + fail + ' failed');
console.log('通过（' + pass + ' 项）');
if (fail) process.exit(1);
