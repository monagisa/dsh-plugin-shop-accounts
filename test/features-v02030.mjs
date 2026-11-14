import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { headerFor, parseSycmMetrics, SYCM_FIELD_LABELS } from '../lib/json-metrics.mjs';
import { collectArtifacts } from '../lib/rpa.mjs';
import { organizeArtifacts } from '../lib/collect-runner.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-acc-0230-'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const passed = [];
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed.push(name);
    console.log('  \u2713 ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  \u2717 ' + name);
    console.log('      ' + (err && err.message ? err.message : String(err)));
  }
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// 一份按生意参谋真实结构造出来的响应：self 里每个字段是一条 30 天日序列，statDate 是毫秒时间戳
function sampleResponse() {
  const dates = [];
  for (let i = 29; i >= 0; i -= 1) {
    dates.push(Date.UTC(2026, 9, 15) + (29 - i) * 24 * 3600 * 1000);
  }
  const series = (base, step) => dates.map((_, i) => base + i * step);
  return {
    content: {
      code: 0,
      message: '调用成功',
      data: {
        self: {
          statDate: dates,
          payAmt: series(0, 1),
          payOrdCnt: series(10, 1),
          uv: series(100, 5),
          pv: series(200, 7),
          unknownFieldXyz: series(1, 1),
          userId: 123456789,
          someText: ['a', 'b'],
        },
      },
    },
    hasError: false,
  };
}

console.log('\nv0.20.30 JSON 型配方的指标解析\n');

await test('A1 解析 self 里的数值字段，取最后一天与前一日', () => {
  const parsed = parseSycmMetrics(JSON.stringify(sampleResponse()));
  assert.ok(parsed, '应当解析成功');
  assert.equal(typeof parsed.values.payAmt, 'undefined', '收进字典的字段应当用中文名');
  assert.equal(parsed.values['成交金额'], 29);
  assert.equal(parsed.values['支付订单数'], 39);
  assert.equal(parsed.values['访客数'], 245);
  assert.equal(parsed.values['浏览量'], 403);
  assert.equal(parsed.yesterday['成交金额'], 28);
  assert.ok(Object.keys(parsed.values).length >= 4, '至少解析出四个指标');
});

await test('A2 statDate 的毫秒时间戳换成 YYYY-MM-DD', () => {
  const parsed = parseSycmMetrics(sampleResponse());
  assert.match(parsed.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(parsed.prevDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(parsed.asOf, parsed.prevDate);
});

await test('A3 没收录的字段保留原名，非数值字段跳过', () => {
  const parsed = parseSycmMetrics(sampleResponse());
  assert.equal(parsed.values.unknownFieldXyz, 30, '未收录字段的值也要取最后一天');
  assert.ok(!Object.prototype.hasOwnProperty.call(parsed.values, 'someText'), '文本字段不应变成指标');
  assert.ok(!Object.prototype.hasOwnProperty.call(parsed.values, 'userId'), 'userId 是标识不是指标');
});

await test('A4 不认识的响应返回 null，不瞎猜', () => {
  assert.equal(parseSycmMetrics('not json'), null);
  assert.equal(parseSycmMetrics('{"content":{"code":0}}'), null);
  assert.equal(parseSycmMetrics({ content: { data: { self: {} } } }), null);
});

await test('A5 表头带上数据日期', () => {
  assert.deepEqual(headerFor('2026-11-13', '2026-11-12'), ['指标', '2026-11-13 值', '2026-11-12 值']);
  assert.deepEqual(headerFor('', ''), ['指标', '今日值', '昨日值']);
});

await test('B1 采集产物里 json_string 也会带 records', () => {
  const dsl = { collection: { artifacts: [{ role: 'business', kind: 'json_string', output_key: 'overviewResponse' }] } };
  const arts = collectArtifacts(dsl, { overviewResponse: JSON.stringify(sampleResponse()) });
  assert.equal(arts.length, 1);
  assert.equal(arts[0].kind, 'json_string');
  assert.ok(arts[0].records && arts[0].records.values, '应当解析出 records');
  assert.equal(arts[0].records.values['成交金额'], 29);
  assert.equal(arts[0].asOf, arts[0].records.asOf, '产物上也要带数据日期');
});

await test('B2 表格里写成「指标 + 数据日期」两列', () => {
  const jobDir = path.join(TMP, 'job');
  fs.mkdirSync(path.join(jobDir, 'artifacts'), { recursive: true });
  const dsl = { collection: { artifacts: [{ role: 'business', kind: 'json_string', output_key: 'overviewResponse' }] } };
  const arts = collectArtifacts(dsl, { overviewResponse: JSON.stringify(sampleResponse()) });
  const job = {
    jobId: 'job_20261114-1200_abc123_淘宝-店铺概览',
    accountId: 'acc_test',
    createdAt: '2026-11-14T04:00:00Z',
    tasks: [{ taskId: 't_001', dslId: 'tb_shop_overview', state: 'ok', artifacts: arts, outputs: { overviewResponse: JSON.stringify(sampleResponse()) } }],
  };
  organizeArtifacts(jobDir, job);
  const dir = path.join(jobDir, 'artifacts', 't_001');
  const xlsx = fs.readdirSync(dir).find((f) => f.endsWith('.xlsx'));
  assert.ok(xlsx, '应当生成表格');
  const raw = fs.readFileSync(path.join(dir, xlsx), 'latin1');
  assert.ok(raw.includes('xl/worksheets/sheet1.xml'), '是 xlsx 包');
  assert.ok(raw.includes('2026-11-13'), '表头应当写数据日期');
  const zh = (t) => Buffer.from(t, 'utf8').toString('latin1');
  assert.ok(raw.includes(zh('成交金额')), '应当有中文指标名');
 // 表格里不该再出现兜底文案
  assert.ok(!raw.includes('没有解析出指标'));
});

await test('B3 表格的行号是 1 基（Excel 打开才看得到数据行）', () => {
  const jobDir = path.join(TMP, 'job-rows');
  fs.mkdirSync(path.join(jobDir, 'artifacts'), { recursive: true });
  const dsl = { collection: { artifacts: [{ role: 'business', kind: 'json_string', output_key: 'overviewResponse' }] } };
  const arts = collectArtifacts(dsl, { overviewResponse: JSON.stringify(sampleResponse()) });
  const job = {
    jobId: 'job_20261114-1200_def456_淘宝-店铺概览',
    createdAt: '2026-11-14T04:00:00Z',
    tasks: [{ taskId: 't_001', dslId: 'tb_shop_overview', state: 'ok', artifacts: arts, outputs: { overviewResponse: JSON.stringify(sampleResponse()) } }],
  };
  organizeArtifacts(jobDir, job);
  const dir = path.join(jobDir, 'artifacts', 't_001');
  const xlsx = fs.readdirSync(dir).find((f) => f.endsWith('.xlsx'));
  const raw = fs.readFileSync(path.join(dir, xlsx), 'latin1');
  assert.ok(raw.includes('<row r="1">'), '第一行必须是 r="1"');
  assert.ok(!raw.includes('<row r="0">'), '不能出现 0 基行号（Excel 会丢掉整张表的数据行）');
  const rowNums = [...raw.matchAll(/<row r="([0-9]+)"/g)].map((m) => Number(m[1]));
  assert.equal(rowNums[0], 1, '第一行是 1');
  assert.equal(rowNums[rowNums.length - 1], rowNums.length, '行号 1 基连续');
});

await test('C1 版本号已到 0.20.30', () => {
  const parts = pkg.version.split('.').map(Number);
  assert.ok(parts[0] > 0 || parts[1] > 20 || (parts[1] === 20 && parts[2] >= 30), '版本 ' + pkg.version);
});

await test('C2 CHANGELOG 与 README 讲清了 JSON 型指标', () => {
  const changelog = read('CHANGELOG.md');
  const readme = read('README.md');
  assert.ok(changelog.includes('v0.20.30'), 'CHANGELOG 缺 v0.20.30');
  assert.ok(changelog.includes('json_string') || changelog.includes('JSON 型'), 'CHANGELOG 没讲 JSON 型解析');
  assert.ok(readme.includes(pkg.version), 'README 版本没跟上 ' + pkg.version);
});

await test('D1 字典与导出齐全', () => {
  assert.ok(Object.keys(SYCM_FIELD_LABELS).length >= 40, '字段字典至少四十条');
  assert.equal(SYCM_FIELD_LABELS.payAmt, '成交金额');
  assert.equal(typeof headerFor, 'function');
});

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
 /* ignore */
}

console.log('\n' + (failures.length ? '\u2717 失败 ' + failures.length + ' / 通过 ' + passed.length : '\u2713 全部通过（' + passed.length + ' 项）'));
process.exit(failures.length ? 1 : 0);
