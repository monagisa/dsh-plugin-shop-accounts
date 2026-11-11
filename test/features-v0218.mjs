#!/usr/bin/env node
/**
 * features-v0218.mjs —— v0.20.18：采集数据的命名规范
 *
 *   A. 作业目录用可读 id（job_<YYYYMMDD-HHmm>_<随机 6 位>），目录名 = jobId
 *   B. 下载产物改名成 <采集项>_<YYYYMMDD-HHmm>_<原始文件名>，并写 artifacts/manifest.json
 *   C. 保留上限：有数据的留最近 20 次、只有失败/空数据的留最近 3 次
 *   D. 旧目录（旧随机 id）仍然读得出来；仓库里不再生成旧的 base36 id
 *   E. 迁移工具在 tools/ 里，能按 job.json 的 createdAt 换算目录名
 *
 * 全离线：临时数据目录 + 假配方，不碰浏览器。
 * 跑法：node test/features-v0218.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-v0218-'));
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
  const a = String(version || '').split('.').map((n) => Number(n) || 0);
  const b = String(want || '').split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
};

const J = await import(url('lib/collect-runner.mjs'));
const XLSX = await import(url('lib/xlsx.mjs'));
const R = await import(url('lib/rpa.mjs'));
const pkg = JSON.parse(read('package.json'));

const MATCH = (raw, opts) => R.compileExecution(raw, opts);
const fakeAccount = () => ({ id: 'acc_taobao_v218a', platform: 'taobao', name: 'v218a' });
const fakeDsl = (id) => ({
  id,
  meta: { id, platform: 'taobao' },
  raw: { id, platform: 'taobao', template: { steps: [{ action: 'goto', url: 'https://example.com/item' }] } },
});

// ── A. 可读 id ──────────────────────────────────────────────────────────────
section('A. 作业目录名带上时间');

await test('runStamp / readableJobId 按本地时间拼出可读 id', () => {
  assert.equal(typeof J.runStamp, 'function', 'runStamp 没导出');
  assert.equal(typeof J.readableJobId, 'function', 'readableJobId 没导出');
  assert.equal(J.runStamp(new Date('2026-11-11T12:30:00')), '20261111-1230');
  assert.equal(J.readableJobId(new Date('2026-11-11T12:30:00'), 'abc123'), 'job_20261111-1230_abc123');
  assert.equal(J.readableJobId(new Date('2026-11-11T12:30:00'), 'abc123', '抖店-成交分析'), 'job_20261111-1230_abc123_抖店-成交分析');
});

await test('prepare：目录名带时间与采集项，目录名就是 jobId', () => {
  const out = J.prepareJob({ account: fakeAccount(), dsls: [fakeDsl('tb_shop_overview')], skipCovered: false }, MATCH);
  assert.equal(out.success, true);
  assert.match(out.data.job_id, /^job_(\d{8}-\d{4})_[a-z0-9]{3,12}_[^\s]+$/, 'jobId 不是「时间 + 采集项」格式：' + out.data.job_id);
  assert.ok(out.data.job_id.endsWith('_淘宝-店铺概览'), '目录名没标出采集项：' + out.data.job_id);
  assert.equal(path.basename(out.data.job_dir), out.data.job_id, '目录名应与 jobId 一致');
  assert.ok(fs.existsSync(out.data.job_dir), '作业目录应真实存在');
});

// ── B. 产物命名 + manifest ─────────────────────────────────────────────────
section('B. 下载产物按配方与时间命名，并写 manifest');

await test('organizeArtifacts：文件改成 <采集项>_<时间>_<原名>，manifest 记清文件名与字节', () => {
  const jobDir = path.join(TMP, 'artifacts-job');
  fs.mkdirSync(jobDir, { recursive: true });
  const artSub = path.join(jobDir, 'artifacts', 't_001');
  fs.mkdirSync(artSub, { recursive: true });
  const origName = '抖音电商罗盘-成交分析-20261005-20261103.xlsx';
  const file = path.join(artSub, origName);
  fs.writeFileSync(file, 'xlsx-bytes', 'utf8');
  const job = {
    jobId: 'job_20261111-1230_abc123',
    accountId: 'acc_taobao_v218a',
    accountName: 'v218a',
    platform: 'taobao',
    createdAt: '2026-11-11T04:30:00.000Z',
    finishedAt: '',
    plan: { window: { start: '2026-10-05', end: '2026-11-03' } },
    tasks: [{ taskId: 't_001', dslId: 'douyin_shop_transaction', state: 'ok', artifacts: [{ present: true, kind: 'download_ref', outputKey: 'xlsx', bytes: 11, filePath: file }] }],
  };
  const manifest = J.organizeArtifacts(jobDir, job);
  const name = path.basename(job.tasks[0].artifacts[0].filePath);
  assert.ok(name.startsWith('抖店-成交分析_20261111-1230_'), '产物名没带采集项与时间：' + name);
  assert.ok(name.endsWith(origName), '原始文件名要留在后缀里');
  const downloads = manifest.files.filter((x) => x.kind !== 'xlsx');
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].fileName, name);
  assert.equal(downloads[0].item, '抖店-成交分析');
  assert.equal(manifest.naming, '<采集项>_<YYYYMMDD-HHmm>_<原始文件名>');
  assert.ok((manifest.items || []).some((i) => i.name === '抖店-成交分析'), 'manifest 没标采集项名');
  const manifestFile = path.join(jobDir, 'artifacts', 'manifest.json');
  assert.ok(fs.existsSync(manifestFile), 'manifest.json 没落盘');
  assert.equal(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).jobId, 'job_20261111-1230_abc123');
});

// ── C. 保留上限 ─────────────────────────────────────────────────────────────
section('C. 作业目录按保留上限清理');

await test('pruneJobs：只留有数据的最新 keepOk 次，只有失败的最多 keepFailed 次', () => {
  assert.equal(typeof J.pruneJobs, 'function', 'pruneJobs 没导出');
  const accountId = 'acc_taobao_v218b';
  const root = path.join(process.env.DSH_SHOP_ACCOUNTS_DIR, 'collection', accountId, 'jobs');
  fs.mkdirSync(root, { recursive: true });
  const make = (tail, day, okTask) => {
    const jobId = 'job_2026110' + day + '-1200_' + tail;
    const dir = path.join(root, jobId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'job.json'),
      JSON.stringify({ version: 1, jobId, accountId, createdAt: '2026-11-0' + day + 'T04:00:00.000Z', finished: true, plan: { window: { start: '', end: '' } }, tasks: [{ taskId: 't_001', dslId: 'x', state: okTask ? 'ok' : 'failed' }] }, null, 2),
      'utf8'
    );
    return dir;
  };
  const okA = make('aaa1', 1, true);
  const okB = make('bbb2', 2, true);
  const okC = make('ccc3', 3, true);
  const badA = make('ddd4', 4, false);
  const badB = make('eee5', 5, false);
  const out = J.pruneJobs(accountId, { keepOk: 2, keepFailed: 1, keepPerDay: 9, dedupe: false });
  const left = fs.readdirSync(root);
  assert.equal(out.removed, 2, '应删掉 2 个（1 个旧的成功 + 1 个旧的失败）');
  assert.equal(left.length, 3, '留 2 个成功 + 1 个失败：' + left.join(','));
  assert.ok(fs.existsSync(okC), '最新的成功作业不该被删');
  assert.ok(fs.existsSync(okB), '第二新的成功作业不该被删');
  assert.ok(!fs.existsSync(okA), '最旧的成功作业应被删');
  assert.ok(fs.existsSync(badB), '最新的失败作业不该被删');
  assert.ok(!fs.existsSync(badA), '最旧的失败作业应被删');
});


await test('pruneJobs：同一窗口同一配方只留最新一次，且每天最多保留 keepPerDay 次', () => {
  const accountId = 'acc_taobao_v218c';
  const root = path.join(process.env.DSH_SHOP_ACCOUNTS_DIR, 'collection', accountId, 'jobs');
  fs.mkdirSync(root, { recursive: true });
  const make = (name, createdAt, dslId, start) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'job.json'),
      JSON.stringify({ version: 1, jobId: name, accountId, createdAt, finished: true, plan: { window: { start, end: '2026-11-10' } }, tasks: [{ taskId: 't_001', dslId, state: 'ok' }] }, null, 2),
      'utf8'
    );
    return dir;
  };
  const d1a = make('job_20261101-0100_aaaaaa', '2026-11-01T01:00:00.000Z', 'tb_shop_overview', '2026-10-03');
  const d1b = make('job_20261101-0200_bbbbbb', '2026-11-01T02:00:00.000Z', 'tb_shop_overview', '2026-10-03');
  const d1c = make('job_20261101-0300_cccccc', '2026-11-01T03:00:00.000Z', 'tb_shop_overview', '2026-10-04');
  const d2a = make('job_20261102-0200_dddddd', '2026-11-02T02:00:00.000Z', 'tb_shop_overview', '2026-10-03');
  const out = J.pruneJobs(accountId, { keepOk: 9, keepFailed: 9 });
  assert.equal(out.removed, 2, '应删掉同一天重复的那两份：' + JSON.stringify(out));
  const left = fs.readdirSync(root).sort();
  assert.deepEqual(left, ['job_20261101-0300_cccccc', 'job_20261102-0200_dddddd'], '每天保留最新，同窗口同配方只留最新：' + left.join(','));
  assert.ok(!fs.existsSync(d1a) && !fs.existsSync(d1b), '旧的重复作业应被删');
  assert.ok(fs.existsSync(d1c) && fs.existsSync(d2a), '当天唯一与后一天的那份应留下');
});

// ── D. 兼容旧目录 ───────────────────────────────────────────────────────────
section('D. 旧目录还能读');

await test('jobDirFor 仍接受旧的随机 id，listJobs 能读到它', () => {
  const accountId = 'acc_taobao_v218c';
  const oldId = 'job_mw1k5t79_s9l6vh';
  const dir = J.jobDirFor(accountId, oldId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'job.json'),
    JSON.stringify({ version: 1, jobId: oldId, accountId, createdAt: '2026-11-04T03:29:00.000Z', finished: true, plan: { window: { start: '', end: '' } }, tasks: [] }, null, 2),
    'utf8'
  );
  const list = J.listJobs(accountId);
  assert.ok(list.data.jobs.some((j) => j.jobId === oldId), '旧 id 的作业没被列出来');
});

await test('仓库里不再生成旧的 base36 作业 id，目录名带上采集项', () => {
  const src = read('lib/collect-runner.mjs');
  assert.ok(!src.includes('Date.now().toString(36)'), '还在用 base36 时间戳拼 job id');
  assert.ok(src.includes('readableJobId(new Date())'), '新建作业没用可读 id');
  assert.ok(src.includes('jobItemsLabel(tasks.map((t) => t.dslId))'), '目录名没按任务里的采集项拼标签');
  assert.ok(src.includes('fs.renameSync(dir, nextDir)'), '任务确定后没有把采集项补进目录名');
});

// ── E. 迁移工具 ─────────────────────────────────────────────────────────────
section('E. 迁移工具');

await test('tools/migrate-collect-naming.mjs 能换算目录名、补 manifest、按上限清理', () => {
  const tool = read('tools/migrate-collect-naming.mjs');
  assert.ok(tool.includes('readableJobId('), '迁移工具没有按 createdAt 换算 job id');
  assert.ok(tool.includes('fs.renameSync('), '迁移工具没有改名动作');
  assert.ok(tool.includes('writeManifest('), '迁移工具没有补 manifest');
  assert.ok(tool.includes('pruneJobs('), '迁移工具没有按保留上限清理');
  assert.ok(tool.includes("'--dry'") || tool.includes('--dry'), '迁移工具缺 --dry 预览');
  assert.ok(tool.includes('jobItemsLabel('), '迁移工具没有把采集项补进老作业的目录名');
  assert.ok(tool.includes('READABLE_WITH_LABEL'), '迁移工具分不清「带采集项」与「不带采集项」的可读 id');
  assert.ok(tool.includes("'无采集项'"), '迁移工具没给没有任务的空作业一个名字');
  assert.ok(fs.existsSync(path.join(ROOT, 'tools', 'migrate-collect-naming.mjs')));
});

await test('jobItemsLabel：多个采集项用 + 连接，重复的只留一次', async () => {
  const DN = await import(url('lib/dsl-names.mjs'));
  assert.equal(typeof DN.jobItemsLabel, 'function', 'jobItemsLabel 没导出');
  assert.equal(DN.jobItemsLabel(['douyin_shop_transaction', 'douyin_shop_income_expense']), '抖店-成交分析+抖店-收支分析');
  assert.equal(DN.jobItemsLabel(['douyin_shop_transaction', 'douyin_shop_transaction']), '抖店-成交分析');
  assert.equal(DN.jobItemsLabel([]), '');
});

// ── F. 版本与文档 ────────��────────────────────────────────────────────────────
section('G. 指标型配方也落一份表格（v0.20.20）');

await test('writeXlsx：写出来的是能打开的 xlsx（zip 头 + 工作表 + inline 字符串）', () => {
  const file = path.join(TMP, 'sheet-test.xlsx');
  XLSX.writeXlsx(file, [['指标', '今日值', '昨日值'], ['gmv', 12345, 11000], ['uv', '88', '']], { sheetName: 'pdd_shop_overview' });
  const st = fs.statSync(file);
  assert.ok(st.size > 1000, 'xlsx 太小：' + st.size);
  const raw = fs.readFileSync(file).toString('latin1');
  assert.ok(raw.startsWith('PK'), '不是 zip 头');
  assert.ok(raw.includes('xl/worksheets/sheet1.xml'), '没有工作表');
  assert.ok(raw.includes('xl/workbook.xml'), '没有 workbook');
  assert.ok(raw.includes('inlineStr'), '字符串不是 inlineStr');
});

await test('flattenRows：对象拍平成「字段 / 值」两列', () => {
  const rows = XLSX.flattenRows({ a: 1, b: { c: 2 }, d: [3, 4] });
  const text = rows.map((r) => r.join('=')).join('|');
  assert.ok(text.includes('a=1'), text);
  assert.ok(text.includes('b.c=2'), text);
  assert.ok(text.includes('d[0]=3'), text);
});

await test('organizeArtifacts：指标型作业也生成表格并写进 manifest', () => {
  const accountId = 'acc_taobao_v218d';
  const jobId = 'job_20261101-0900_gggggg';
  const dir = path.join(process.env.DSH_SHOP_ACCOUNTS_DIR, 'collection', accountId, 'jobs', jobId);
  fs.mkdirSync(dir, { recursive: true });
  const job = {
    version: 1,
    jobId,
    accountId,
    accountName: '测试铺',
    platform: 'pdd',
    createdAt: '2026-11-01T01:00:00.000Z',
    finished: true,
    finishedAt: '2026-11-01T01:05:00.000Z',
    plan: { window: { start: '2026-10-02', end: '2026-10-31' } },
    tasks: [
      {
        taskId: 't_001',
        dslId: 'pdd_shop_overview',
        state: 'ok',
        outputs: { home_text: '成交金额 12345 昨日 11000' },
        declaredArtifacts: [{ kind: 'text_metrics', output_key: 'home_text', metrics: [{ id: 'gmv', label: '成交金额' }] }],
        artifacts: [{ kind: 'text_metrics', outputKey: 'home_text', present: true, records: { values: { gmv: 12345 }, yesterday: { gmv: 11000 }, missing: [] } }],
      },
    ],
  };
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job, null, 2), 'utf8');
  const manifest = J.organizeArtifacts(dir, job);
  const files = manifest.files.map((f) => f.fileName);
  assert.ok(files.includes('拼多多-店铺概览_20261101-0900_表格.xlsx'), '没生成表格：' + files.join(','));
  assert.ok(fs.existsSync(path.join(dir, 'artifacts', 't_001', '拼多多-店铺概览_20261101-0900_表格.xlsx')), '表格文件不在产物目录');
  assert.ok((manifest.items || []).some((i) => i.name === '拼多多-店铺概览'), 'manifest 没标采集项名');
  assert.ok(manifest.files.some((f) => f.kind === 'xlsx'), 'manifest 没记表格');
});

await test('下载型作业不再重复生成表格（平台已经给了 xlsx）', () => {
  const dir = path.join(TMP, 'download-job', 'artifacts', 't_001');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'douyin_shop_transaction_20261101-0900_抖音电商罗盘-成交分析.xlsx');
  fs.writeFileSync(file, 'xlsx-bytes', 'utf8');
  const jobDir = path.join(TMP, 'download-job');
  const job = {
    jobId: 'job_20261101-0900_hhhhhh',
    accountId: 'acc_x',
    accountName: 'x',
    platform: 'douyin',
    createdAt: '2026-11-01T01:00:00.000Z',
    tasks: [{ taskId: 't_001', dslId: 'douyin_shop_transaction', state: 'ok', outputs: {}, artifacts: [{ present: true, kind: 'download_ref', outputKey: 'xlsx', bytes: 10, filePath: file }] }],
  };
  const manifest = J.organizeArtifacts(jobDir, job);
  assert.ok(!manifest.files.some((f) => f.kind === 'xlsx'), '下载型不该再生成表格：' + JSON.stringify(manifest.files));
  assert.ok(!fs.existsSync(path.join(jobDir, 'artifacts', 't_001', '抖店-成交分析_20261101-0900_表格.xlsx')), '不该有表格文件');
});

// ── H. 采集项的中文名（v0.20.21）────────────────────────────────────────────
section('H. 采集项的中文名（文件名 / manifest / 界面都标出来）');

await test('dslItemName：已知配方给采集项中文名，未知配方退回 id，空 id 给「采集项」', async () => {
  const NAMES = await import(url('lib/dsl-names.mjs'));
  assert.equal(NAMES.dslItemName('douyin_shop_transaction'), '抖店-成交分析');
  assert.equal(NAMES.dslItemName('tb_shop_overview'), '淘宝-店铺概览');
  assert.equal(NAMES.dslItemName('tmall_shop_overview'), '天猫-店铺概览');
  assert.equal(NAMES.dslItemName('some_vendor_dsl'), 'some_vendor_dsl');
  assert.equal(NAMES.dslItemName(''), '采集项');
  assert.equal(NAMES.dslItemName(null), '采集项');
});

await test('dslItemFileSafe 去掉 Windows 非法字符；sheetNameSafe 不超过 31 字', async () => {
  const NAMES = await import(url('lib/dsl-names.mjs'));
  assert.equal(NAMES.dslItemFileSafe('pdd_shop_overview'), '拼多多-店铺概览');
  assert.equal(NAMES.sheetNameSafe('pdd_shop_overview'), '拼多多-店铺概览');
  assert.ok(!/[\\/:*?"<>|]/.test(NAMES.dslItemFileSafe('a/b:c*d?e"f<g>h|i')), '文件名还有非法字符');
  for (const id of ['douyin_shop_transaction', 'jd_traffic_overview']) {
    const s = NAMES.sheetNameSafe(id);
    assert.ok(s.length <= 31, '工作表名太长：' + s);
    assert.ok(!/[\[\]:*?/\\]/.test(s), '工作表名有 Excel 禁用字符：' + s);
  }
});

await test('prepare 结果与作业状态里带采集项名，界面「上次采集」列出采集项', () => {
  const runner = read('lib/collect-runner.mjs');
  const state = read('lib/server/state.mjs');
  const client = read('lib/client.js');
  assert.ok(runner.includes('name: dslItemName(id)'), 'prepare 没给任务加采集项名');
  assert.ok(runner.includes('export function lastJobItems'), '没有 lastJobItems');
  assert.ok(state.includes('lastJobItems(a.id)'), '状态没带上次采集项');
  assert.ok(client.includes("' · 采集项：'"), '界面没列出采集项名');
});

await test('迁移工具按采集项名改名并补 items', () => {
  const tool = read('tools/migrate-collect-naming.mjs');
  assert.ok(tool.includes('dslItemFileSafe(dslId)'), '迁移工具没按采集项名改名');
  assert.ok(tool.includes('item: dslItemName(dslId)'), '迁移工具的 manifest 没标采集项');
});

await test('迁移工具把 job.json 里的产物路径改回实际文件（旧目录名 + 旧文件名）', () => {
  const tool = read('tools/migrate-collect-naming.mjs');
  assert.ok(tool.includes('function syncJobPaths(jobDir, job)'), '迁移工具没有 syncJobPaths');
  assert.ok(tool.includes('a.filePath = next;'), 'syncJobPaths 没写回 filePath');
  assert.ok(tool.includes("writeJson(path.join(jobDir, 'job.json'), job)"), 'syncJobPaths 没写回 job.json');
  assert.ok(tool.includes('syncJobPaths(moved.jobDir, moved.job)'), '主流程没调用 syncJobPaths');
});

section('F. 版本与文档');

await test('版本号已到 0.20.23', () => {
  assert.ok(versionAtLeast(pkg.version, '0.20.23'), '版本应 ≥ 0.20.23：' + pkg.version);
});

await test('CHANGELOG 与 README 写清了采集数据命名', () => {
  const changelog = read('CHANGELOG.md');
  const readme = read('README.md');
  assert.ok(changelog.includes('v0.20.23'), 'CHANGELOG 缺 v0.20.23');
  assert.ok(changelog.includes('采集项'), 'CHANGELOG 没讲采集项名');
  assert.ok(readme.includes(pkg.version), 'README 版本没跟上 ' + pkg.version);
  assert.ok(readme.includes('_抖店-成交分析'), 'README 没写清作业目录名带采集项');
});

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch { /* ignore */ }

console.log('\n' + (failures.length ? '\u2717 失败 ' + failures.length + ' / 通过 ' + passed : '\u2713 全部通过（' + passed + ' 项）'));
process.exit(failures.length ? 1 : 0);
