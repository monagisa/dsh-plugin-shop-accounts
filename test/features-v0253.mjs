import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { organizeArtifacts } from '../lib/collect-runner.mjs';
import { writeWorkbook } from '../lib/xlsx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v0253-'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed += 1;
    console.log('  ✗ ' + name);
    console.log('       ' + String((err && err.message) || err).split('\n').slice(0, 5).join('\n       '));
  }
}

function fakeJob(name, tasks, extra = {}) {
  return {
    version: 1,
    jobId: 'job_20261120-1200_abc123_' + name,
    accountId: 'acc_taobao_mw05dt23d7jw',
    accountName: '测试铺',
    platform: 'taobao',
    createdAt: '2026-11-20T04:00:00Z',
    tasks,
    ...extra,
  };
}

await test('A1 writeWorkbook 写出多个工作表', () => {
  const file = path.join(TMP, 'multi-a1.xlsx');
  writeWorkbook(file, [
    { name: '经营总览', rows: [['日期', '成交金额'], ['2026-11-19', 12]] },
    { name: '流量转化', rows: [['日期', '访客数'], ['2026-11-19', 30]] },
  ]);
  const raw = fs.readFileSync(file, 'latin1');
  const zh = (t) => Buffer.from(t, 'utf8').toString('latin1');
  assert.ok(raw.includes('xl/worksheets/sheet1.xml'), '缺第 1 个表');
  assert.ok(raw.includes('xl/worksheets/sheet2.xml'), '缺第 2 个表');
  assert.ok((raw.match(/<sheet /g) || []).length === 2, '工作表数量应为 2');
  assert.ok(raw.includes(zh('经营总览')) && raw.includes(zh('流量转化')), '工作表名不对');
});

await test('B1 一份作业只生成一个工作簿（不再每份配方一个文件）', () => {
  const jobDir = path.join(TMP, 'job-b1');
  fs.mkdirSync(path.join(jobDir, 'artifacts'), { recursive: true });
  const job = fakeJob('b1', [
    { taskId: 't_001', dslId: 'tb_shop_overview', state: 'ok', artifacts: [{ role: 'business', kind: 'json_string', outputKey: 'overviewResponse', present: true, records: { values: { 成交金额: 12, 访客数: 30 }, asOf: '2026-11-19' } }], declaredArtifacts: [{ output_key: 'overviewResponse', metrics: [{ id: '成交金额', label: '成交金额' }, { id: '访客数', label: '访客数' }] }] },
    { taskId: 't_002', dslId: 'tb_product_traffic_source', state: 'ok', artifacts: [{ role: 'business', kind: 'json_string', outputKey: 'traffic', present: true, records: { values: { 访客数: 31 }, asOf: '2026-11-19' } }], declaredArtifacts: [{ output_key: 'traffic', metrics: [{ id: '访客数', label: '访客数' }] }] },
  ]);
  const manifest = organizeArtifacts(jobDir, job);
  const files = fs.readdirSync(path.join(jobDir, 'artifacts'));
  const books = files.filter((f) => f.endsWith('.xlsx'));
  assert.equal(books.length, 1, '只该有一个工作簿：' + files.join(','));
  assert.ok(books[0].startsWith('采集数据_20261120-1200_测试铺'), '工作簿命名没带店名与时间：' + books[0]);
  assert.ok(files.every((f) => !f.includes('_表格.xlsx')), '不该再产出每配方一份的表格');
  const xlsxEntry = (manifest.files || []).find((f) => f.kind === 'xlsx');
  assert.ok(xlsxEntry, 'manifest 没有记录工作簿');
  assert.ok(Array.isArray(xlsxEntry.sheets) && xlsxEntry.sheets.length >= 2, 'manifest 该记下各工作表');
});

await test('B2 工作表按采集域分（经营总览 / 流量转化 两张表）', () => {
  const jobDir = path.join(TMP, 'job-b2');
  fs.mkdirSync(path.join(jobDir, 'artifacts'), { recursive: true });
  const job = fakeJob('b2', [
    { taskId: 't_001', dslId: 'tb_shop_overview', state: 'ok', artifacts: [{ kind: 'json_string', outputKey: 'ov', present: true, records: { values: { 成交金额: 5 }, asOf: '2026-11-19' } }], declaredArtifacts: [{ output_key: 'ov', metrics: [{ id: '成交金额', label: '成交金额' }] }] },
    { taskId: 't_002', dslId: 'tb_product_traffic_source', state: 'ok', artifacts: [{ kind: 'json_string', outputKey: 'tr', present: true, records: { values: { 访客数: 9 }, asOf: '2026-11-19' } }], declaredArtifacts: [{ output_key: 'tr', metrics: [{ id: '访客数', label: '访客数' }] }] },
  ]);
  const manifest = organizeArtifacts(jobDir, job);
  const book = path.join(jobDir, 'artifacts', fs.readdirSync(path.join(jobDir, 'artifacts')).find((f) => f.endsWith('.xlsx')));
  const raw = fs.readFileSync(book, 'latin1');
  const zh = (t) => Buffer.from(t, 'utf8').toString('latin1');
  const xlsxEntry = manifest.files.find((f) => f.kind === 'xlsx');
  assert.ok(xlsxEntry.sheets.some((s) => s.name === '经营总览'), '缺经营总览表');
  assert.ok(xlsxEntry.sheets.some((s) => s.name === '流量转化'), '缺流量转化表');
  assert.ok(raw.includes(zh('成交金额')) && raw.includes(zh('访客数')), '两张表的数据都在');
});

await test('B3 没解析出指标的作业写一张「采集情况」表，而不是静默跳过', () => {
  const jobDir = path.join(TMP, 'job-b3');
  fs.mkdirSync(path.join(jobDir, 'artifacts'), { recursive: true });
  const job = fakeJob('b3', [
    { taskId: 't_001', dslId: 'tb_shop_overview', state: 'ok', artifacts: [{ kind: 'json_string', outputKey: 'ov', present: true, records: null }], declaredArtifacts: [], finalUrl: 'https://sycm.taobao.com/portal/login.htm', code: 'LOGIN_REQUIRED' },
  ]);
  const manifest = organizeArtifacts(jobDir, job);
  const xlsxEntry = manifest.files.find((f) => f.kind === 'xlsx');
  assert.ok(xlsxEntry, '没有生成工作簿');
  assert.ok(xlsxEntry.sheets.some((s) => s.name === '采集情况'), '缺采集情况表：' + JSON.stringify(xlsxEntry.sheets));
});

await test('C1 下载型产物仍然单独保留（平台导出文件不合并）', () => {
  const jobDir = path.join(TMP, 'job-c1');
  fs.mkdirSync(path.join(jobDir, 'artifacts', 't_001'), { recursive: true });
  const src = path.join(jobDir, 'artifacts', 't_001', '抖音电商罗盘-成交分析.xlsx');
  fs.writeFileSync(src, 'x', 'utf8');
  const job = fakeJob('c1', [{ taskId: 't_001', dslId: 'douyin_shop_transaction', state: 'ok', artifacts: [{ role: 'business', kind: 'download_ref', present: true, filePath: src, bytes: 1 }] }], { platform: 'douyin' });
  const manifest = organizeArtifacts(jobDir, job);
  const downloads = manifest.files.filter((f) => f.kind !== 'xlsx');
  assert.equal(downloads.length, 1, '下载型产物该保留');
  assert.ok(downloads[0].fileName.includes('douyin_shop_transaction') || downloads[0].fileName.includes('抖店-成交分析'), '下载产物没按采集项改名');
});

await test('D1 运行期代码：工作簿按域分组、面板按五项域命名', () => {
  const src = read('lib/collect-runner.mjs');
  assert.ok(src.includes('writeJobWorkbook'), '缺工作簿入口');
  assert.ok(src.includes("dslDomainOf(t.dslId) || '采集数据'"), '缺域回退');
  assert.ok(src.includes("'采集情况'"), '缺采集情况表名');
  assert.ok(!src.includes('writeTaskSheets'), '旧的每配方一份表格该删掉');
});

await test('E1 版本与文档写清了这次的表格变化', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.version >= '0.20.53', '版本落后：' + pkg.version);
  assert.ok(read('CHANGELOG.md').includes('## v0.20.53'), 'CHANGELOG 缺 v0.20.53');
  assert.ok(read('CHANGELOG.md').includes('工作簿'), 'CHANGELOG 没提工作簿');
});

console.log('\n全部通过（' + passed + ' 项）');
if (failed > 0) {
  console.log('失败 ' + failed + ' 项');
  process.exit(1);
}
