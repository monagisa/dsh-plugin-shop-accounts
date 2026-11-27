#!/usr/bin/env node
/**
 * features-v0210.mjs —— v0.21.0：拼多多商品级推广花费与活动报名（表格型配方）
 *
 *   A. 引擎新增产物类型 `table_rows`：页面表格行直接解析成 columns/rows
 *   B. 采集工作簿把 `table_rows` 直接铺成工作表（不需要下载文件）
 *   C. 两条新配方：pdd_ads_goods_report / pdd_activity_records
 *   D. 配方清单能列出这两条，域是「运营推广」
 *
 * 全离线：不碰浏览器。
 * 跑法：node test/features-v0210.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-v0210-'));
process.env.DSH_SHOP_ACCOUNTS_DIR = path.join(TMP, 'data');
const url = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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
const section = (text) => console.log('\n' + text);
const versionAtLeast = (version, want) => {
  const a = String(version || '').split('.').map(Number);
  const b = String(want || '').split('.').map(Number);
  for (let i = 0; i < b.length; i += 1) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
};

const pkg = JSON.parse(read('package.json'));

section('A. 产物类型 table_rows');
const rpa = await import(url('lib/rpa.mjs'));

await test('table_rows：columns/rows 被解析进 artifact.table', () => {
  const dsl = {
    collection: {
      artifacts: [{ role: 'business', kind: 'table_rows', output_key: 'grid', tableName: '商品推广花费' }],
    },
  };
  const payload = JSON.stringify({ columns: ['日期', '商品ID', '成交营销花费(元)'], rows: [['2026-11-26', '950836759884', '0.01']] });
  const arts = rpa.collectArtifacts(dsl, { grid: payload });
  assert.equal(arts.length, 1);
  assert.equal(arts[0].kind, 'table_rows');
  assert.equal(arts[0].present, true);
  assert.equal(arts[0].table.columns.length, 3);
  assert.equal(arts[0].table.rows.length, 1);
  assert.equal(arts[0].table.rows[0][1], '950836759884');
});

await test('table_rows：空/坏 JSON 不进 table，但保持 present 语义', () => {
  const dsl = { collection: { artifacts: [{ kind: 'table_rows', output_key: 'grid' }] } };
  const arts = rpa.collectArtifacts(dsl, { grid: 'not-json' });
  assert.equal(arts[0].table, undefined);
  assert.equal(arts[0].present, true);
});

await test('table_rows：缺 columns 时为[]，值里的 null 变空串', () => {
  const dsl = { collection: { artifacts: [{ kind: 'table_rows', output_key: 'grid' }] } };
  const payload = JSON.stringify({ rows: [['a', null, 3]] });
  const arts = rpa.collectArtifacts(dsl, { grid: payload });
  assert.deepEqual(arts[0].table.columns, []);
  assert.deepEqual(arts[0].table.rows[0], ['a', '', 3]);
});

section('B. 工作簿把页面表格铺成工作表');

await test('collect-runner 认 a.table，落成 page-table 表', () => {
  const src = read('lib/collect-runner.mjs');
  assert.match(src, /if \(a\.table && Array\.isArray\(a\.table\.rows\)/);
  assert.match(src, /source: 'page-table'/);
  assert.match(src, /rows: \[a\.table\.columns \|\| \[\]\]\.concat\(a\.table\.rows\)/);
});

section('C. 两条新配方');

const adsPath = 'lib/rpa/dsls/pdd/pdd_ads_goods_report.json';
const actPath = 'lib/rpa/dsls/pdd/pdd_activity_records.json';

await test('pdd_ads_goods_report：元信息与产物声明', () => {
  const dsl = JSON.parse(read(adsPath));
  assert.equal(dsl.id, 'pdd_ads_goods_report');
  assert.equal(dsl.platform, 'pdd');
  assert.deepEqual(dsl.domains, ['运营推广']);
  assert.equal(dsl.verified, true);
  const art = (dsl.collection.artifacts || [])[0];
  assert.equal(art.kind, 'table_rows');
  assert.equal(art.output_key, 'pdd_ads_goods_rows');
  assert.equal(art.tableName, '商品推广花费');
  assert.equal(dsl.collection.schedule.mode, 'snapshot');
});

await test('pdd_ads_goods_report：切昨日 + 读表格两步都在', () => {
  const dsl = JSON.parse(read(adsPath));
  const click = dsl.steps.find((s) => s.id === '切到昨日');
  assert.ok(click, '缺少「切到昨日」步骤');
  assert.equal(click.action, 'click');
  assert.ok(click.target.some((t) => /DateAreaV2_item/.test(String(t.value))));
  const ev = dsl.steps.find((s) => s.action === 'evaluate');
  assert.ok(ev, '缺少 evaluate 步骤');
  assert.match(ev.expression, /anq-table-row/);
  assert.match(ev.expression, /商品ID/);
});

await test('pdd_activity_records：元信息与产物声明', () => {
  const dsl = JSON.parse(read(actPath));
  assert.equal(dsl.id, 'pdd_activity_records');
  assert.equal(dsl.platform, 'pdd');
  assert.deepEqual(dsl.domains, ['运营推广']);
  assert.equal(dsl.verified, true);
  const art = (dsl.collection.artifacts || [])[0];
  assert.equal(art.kind, 'table_rows');
  assert.equal(art.output_key, 'pdd_activity_rows');
  assert.equal(art.tableName, '活动报名');
});

await test('pdd_activity_records：直连报名记录页并解析活动/商品/状态', () => {
  const dsl = JSON.parse(read(actPath));
  const go = dsl.steps.find((s) => s.action === 'goto');
  assert.match(String(go.url), /act\/register_record/);
  const ev = dsl.steps.find((s) => s.action === 'evaluate');
  assert.match(ev.expression, /活动名称/);
  assert.match(ev.expression, /报名成功|活动状态/);
  assert.match(ev.expression, /ID\\s\*\[:：\]/);
});

section('D. 配方清单');

await test('listDsls 里能列出这两条拼多多配方', async () => {
  const dsls = await import(url('lib/dsls.mjs'));
  const list = await dsls.listDsls();
  const items = (list && list.items) || list || [];
  const ids = items.map((x) => String((x && x.id) || ''));
  assert.ok(ids.includes('pdd_ads_goods_report'), '缺少 pdd_ads_goods_report');
  assert.ok(ids.includes('pdd_activity_records'), '缺少 pdd_activity_records');
  for (const id of ['pdd_ads_goods_report', 'pdd_activity_records']) {
    const one = items.find((x) => String(x.id) === id);
    assert.deepEqual(one.domains, ['运营推广']);
  }
});

await test('版本号已升到 0.21.0 以上', () => {
  assert.ok(versionAtLeast(pkg.version, '0.21.0'), '当前版本 ' + pkg.version);
});

console.log('\n' + (failures.length ? 'FAIL ' : 'PASS ') + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  for (const f of failures) console.log(' - ' + f.name + ': ' + (f.err && f.err.stack ? f.err.stack.split('\n').slice(0, 3).join(' | ') : f.err));
  process.exitCode = 1;
}
