// v0.20.66：作业目录整理 —— json 当日志（logs/）、原始表不留（只留成品工作簿）
//
// 背景：作业目录里过程文件和成品混在一起（t_001.json 最大 16MB、t_001/ 是原始导出），
// 用户要求「json 算日志放 log 里，原始表不留，只要一个成品表」。这里断言：
// ① 下载目录与执行记录都落到 logs/；② 交付后原始导出被清掉、manifest 只列成品；
// ③ 同店同天的域补齐改成读对方的成品工作簿（不再依赖原始文件）；④ 迁移工具可整理老作业。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const libUrl = (name) => url.pathToFileURL(path.join(ROOT, 'lib', name)).href;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v02066-'));
process.env.DSH_SHOP_ACCOUNTS_DIR = TMP;

const { writeWorkbook } = await import(libUrl('xlsx.mjs'));
const { organizeArtifacts, writeJobWorkbook, jobDirFor } = await import(libUrl('collect-runner.mjs'));
const { readTableFile } = await import(libUrl('sheet-read.mjs'));

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log('  ok  ' + name); } else { fail += 1; console.log('  FAIL ' + name); }
}
function eq(a, b, name) { ok(String(a) === String(b), name + '（got ' + a + '）'); }

const ACC = 'acc_t_v02066';
const DAY = new Date(2026, 10, 24, 9, 40).toISOString();
const JOB_A = 'job_20261124-0940_aaa111_测试';
const JOB_B = 'job_20261124-1303_bbb222_测试';
const JOB_C = 'job_20261123-1200_ccc333_测试';
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });

// ── A. 接线：下载与日志都进 logs/ ────────────────────────────────────────────
console.log('A. 作业目录布局接线');
const runnerSrc = read('lib/collect-runner.mjs');
ok(/downloadDir: path\.join\(dir, 'logs', 'raw',/.test(runnerSrc), 'A1 下载目录在 logs/raw 下');
ok(/path\.join\(logDir, `\$\{tid\}\.json`\)/.test(runnerSrc), 'A2 任务执行记录写 logs/<tid>.json');
ok(/export function organizeArtifacts\(jobDir, job, opts = \{\}\)/.test(runnerSrc), 'A3 organizeArtifacts 支持 opts');
ok(/rawFiles: rawPurged \? \[\] : rawFiles/.test(runnerSrc), 'A4 manifest 的 rawFiles 随清理状态变化');
ok(/layout: \{ artifacts:/.test(runnerSrc), 'A5 manifest 标出目录布局');
ok(/function tableSheetsOfWorkbook\(/.test(runnerSrc), 'A6 新增从成品工作簿读表');
ok(/tableSheetsOfWorkbook\(other\)\.concat\(tableSheetsOfJob\(other\)\)/.test(runnerSrc), 'A7 同店同天补齐优先读成品工作簿');
ok(/organizeArtifacts\(jobDirFor\(accountId, job\.jobId\), job, \{ keepRaw: opts\.keepRaw === true \}\)/.test(runnerSrc), 'A8 advanceJob 透传 keepRaw');
ok(fs.existsSync(path.join(ROOT, 'tools', 'reorganize-job-artifacts.mjs')), 'A9 旧作业整理工具在仓库里');
const toolSrc = read('tools/reorganize-job-artifacts.mjs');
ok(/--dry/.test(toolSrc) && /--keep-raw/.test(toolSrc), 'A10 整理工具支持 --dry / --keep-raw');

// ── B. 交付：只留成品表，原始导出清掉 ───────────────────────────────────────
console.log('B. organizeArtifacts：成品留在 artifacts，过程留在 logs');
const dirB = jobDirFor(ACC, JOB_B);
const rawB = path.join(dirB, 'logs', 'raw', 't_001');
mkdir(rawB);
const origB = path.join(rawB, '商品整体效果日报.csv');
fs.writeFileSync(origB, '\ufeff统计日期,商品ID,支付金额\n2026-11-22,1001,12.34\n', 'utf8');
function writeJobFile(job) {
  const dir = jobDirFor(job.accountId, job.jobId);
  mkdir(dir);
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job, null, 2), 'utf8');
}
function sheetNamesOf(job) {
  const dir = path.join(jobDirFor(job.accountId, job.jobId), 'artifacts');
  const f = fs.readdirSync(dir).find((n) => /^采集数据_.*\.xlsx$/.test(n));
  if (!f) return '';
  const read = readTableFile(path.join(dir, f));
  return (read.sheets || []).map((s) => String(s.name || '')).join('|');
}
const mkJob = (jobId, tasks, createdAt) => ({
  version: 1, jobId, accountId: ACC, accountName: '示例店铺', platform: 'taobao',
  createdAt, finishedAt: '', plan: { window: { start: '2026-10-25', end: '2026-11-24' } }, tasks,
});
const jobB = mkJob(JOB_B, [{
  taskId: 't_001', dslId: 'tb_product_overall_tpl', state: 'ok',
  artifacts: [{ present: true, kind: 'download_ref', outputKey: 'file', bytes: 60, filePath: origB }],
}], DAY);

writeJobFile(jobB);
const kept = organizeArtifacts(dirB, jobB, { keepRaw: true });
ok(kept.rawFiles.length === 1, 'B1 keepRaw 时 rawFiles 记下了原始文件');
ok(fs.existsSync(jobB.tasks[0].artifacts[0].filePath), 'B2 keepRaw 时原始文件还在');
ok(Array.isArray(kept.files) && kept.files.length >= 1, 'B3 manifest 至少列出成品工作簿');

const purged = organizeArtifacts(dirB, jobB);
ok(purged.rawFiles.length === 0, 'B4 默认交付后 rawFiles 为空');
ok(jobB.tasks[0].artifacts[0].purged === true, 'B5 原始文件标记为已清理');
ok(jobB.tasks[0].artifacts[0].filePath === '', 'B6 清理后不再保留文件路径');
ok(!fs.existsSync(path.join(dirB, 'logs', 'raw')), 'B7 logs/raw 目录被删掉');
const artEntries = fs.readdirSync(path.join(dirB, 'artifacts'));
ok(artEntries.includes('manifest.json'), 'B8 manifest.json 留在 artifacts');
ok(artEntries.filter((n) => /^采集数据_.*\.xlsx$/.test(n)).length === 1, 'B9 成品工作簿留在 artifacts');

// ── C. 同店同天的域补齐改读对方的成品工作簿 ────────────────────────────────
console.log('C. 同店同天补齐：读成品工作簿（原始文件已清理）');
const dirA = jobDirFor(ACC, JOB_A);
const rawA = path.join(dirA, 'logs', 'raw', 't_001');
mkdir(rawA);
const origA = path.join(rawA, '店铺经营核心日报.xlsx');
writeWorkbook(origA, [{ name: 'Sheet1', rows: [['统计日期', '访客数', '支付金额'], ['2026-11-22', '58', '0.00']] }]);
const jobA = mkJob(JOB_A, [{
  taskId: 't_001', dslId: 'tb_store_core_daily', state: 'ok',
  artifacts: [{ present: true, kind: 'download_ref', outputKey: 'file', bytes: 100, filePath: origA }],
}], DAY);
writeJobFile(jobA);
organizeArtifacts(dirA, jobA);
const bookA = fs.readdirSync(path.join(dirA, 'artifacts')).find((n) => /^采集数据_/.test(n));
ok(!!bookA, 'C1 作业 A 生成了成品工作簿');
ok(!fs.existsSync(path.join(dirA, 'logs', 'raw')), 'C2 作业 A 的原始导出已清理');

const dirB2 = jobDirFor(ACC, JOB_B);
const rawB2 = path.join(dirB2, 'logs', 'raw', 't_002');
mkdir(rawB2);
const origFlow = path.join(rawB2, '店铺流量来源构成日报.csv');
fs.writeFileSync(origFlow, '\ufeff统计日期,来源,访客数\n2026-11-22,经营优势,30\n', 'utf8');
const jobB2 = mkJob(JOB_B, [{
  taskId: 't_002', dslId: 'tb_flow_source_consist', state: 'ok',
  artifacts: [{ present: true, kind: 'download_ref', outputKey: 'file', bytes: 40, filePath: origFlow }],
}], DAY);
writeJobFile(jobB2);
organizeArtifacts(dirB2, jobB2);
const name2 = sheetNamesOf(jobB2);
ok(/经营总览/.test(name2), 'C3 作业 A 的经营总览被并进作业 B 的工作簿');
ok(/流量转化/.test(name2), 'C4 作业 B 自己的流量转化也在');
ok(name2.split('|').filter(Boolean).length >= 2, 'C5 合并后至少两张数据表');

// 跨天不并
const dirC = jobDirFor(ACC, JOB_C);
const rawC = path.join(dirC, 'logs', 'raw', 't_001');
mkdir(rawC);
const origC = path.join(rawC, '营销场景报表.csv');
fs.writeFileSync(origC, '\ufeff日期,场景名字,花费\n2026-11-22,货品全站推广,12.33\n', 'utf8');
const jobC = mkJob(JOB_C, [{
  taskId: 't_001', dslId: 'tb_ads_scene_report', state: 'ok',
  artifacts: [{ present: true, kind: 'download_ref', outputKey: 'file', bytes: 40, filePath: origC }],
}], new Date(2026, 10, 23, 12, 0).toISOString());
writeJobFile(jobC);
organizeArtifacts(dirC, jobC);
const nameC = sheetNamesOf(jobC);
ok(!/经营总览/.test(nameC), 'C6 跨天的作业不会被并进来');
ok(/运营推广/.test(nameC), 'C7 跨天作业自己的域照常出表');

// ── D. 旧作业整理工具 ───────────────────────────────────────────────────────
console.log('D. 旧作业整理工具 reorganize-job-artifacts');
const OLD_ACC = 'acc_old_v02066';
const OLD_JOB = 'job_20261120-1000_old111_测试';
const oldDir = path.join(TMP, 'collection', OLD_ACC, 'jobs', OLD_JOB);
mkdir(path.join(oldDir, 'artifacts', 't_001'));
mkdir(path.join(oldDir, 'artifacts', 't_002'));
fs.writeFileSync(path.join(oldDir, 'artifacts', 't_001.json'), '{"taskId":"t_001","steps":[]}', 'utf8');
fs.writeFileSync(path.join(oldDir, 'artifacts', 't_002.json'), '{"taskId":"t_002","steps":[]}', 'utf8');
fs.writeFileSync(path.join(oldDir, 'artifacts', 't_001', '原始导出.csv'), 'a,b\n1,2\n', 'utf8');
fs.writeFileSync(path.join(oldDir, 'artifacts', 't_002', '原始导出.csv'), 'a,b\n1,2\n', 'utf8');
fs.writeFileSync(path.join(oldDir, 'job.json'), JSON.stringify({ version: 1, jobId: OLD_JOB, accountId: OLD_ACC, tasks: [] }), 'utf8');
// 老作业里必须有成品工作簿，整理工具才敢删原始导出（没有成品就会保留，防丢数据）
writeWorkbook(path.join(oldDir, 'artifacts', '采集数据_20261120-1000_示例店铺.xlsx'), [{ name: '经营总览', rows: [['统计日期', '访客数'], ['2026-11-19', '12']] }]);
fs.writeFileSync(path.join(oldDir, 'artifacts', 'manifest.json'), JSON.stringify({
  version: 1, jobId: OLD_JOB,
  files: [
    { kind: 'xlsx', fileName: '采集数据_20261120-1000_示例店铺.xlsx', bytes: 100 },
    { taskId: 't_001', fileName: '抖店-成交分析_20261120-1000_示例店铺_原始导出.csv', bytes: 10 },
  ],
  items: [],
}, null, 2), 'utf8');

const runTool = (args) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'reorganize-job-artifacts.mjs'), ...args], {
  cwd: ROOT, env: { ...process.env, DSH_SHOP_ACCOUNTS_DIR: TMP }, encoding: 'utf8',
});
const dry = runTool(['--dry']);
ok(dry.status === 0, 'D1 整理工具 --dry 正常退出');
ok(/扫描作业/.test(dry.stdout || ''), 'D2 --dry 输出扫描结果');
ok(fs.existsSync(path.join(oldDir, 'artifacts', 't_001.json')), 'D3 --dry 不动文件');
ok(fs.existsSync(path.join(oldDir, 'artifacts', 't_001', '原始导出.csv')), 'D4 --dry 不动原始目录');

const real = runTool([]);
ok(real.status === 0, 'D5 整理工具正常退出');
ok(fs.existsSync(path.join(oldDir, 'logs', 't_001.json')), 'D6 执行记录挪到 logs/');
ok(!fs.existsSync(path.join(oldDir, 'artifacts', 't_001.json')), 'D7 artifacts 里不再有 t_*.json');
ok(!fs.existsSync(path.join(oldDir, 'artifacts', 't_001')), 'D8 原始导出目录被删');
ok(!fs.existsSync(path.join(oldDir, 'artifacts', 't_002')), 'D9 第二个原始目录也被删');
const mf = JSON.parse(fs.readFileSync(path.join(oldDir, 'artifacts', 'manifest.json'), 'utf8'));
ok((mf.files || []).length === 1 && /采集数据_/.test(mf.files[0].fileName), 'D10 manifest 只留成品工作簿');
ok(Array.isArray(mf.rawFiles) && mf.rawFiles.length === 0, 'D11 manifest 的 rawFiles 清空');
ok(!!(mf.layout && mf.layout.artifacts), 'D12 manifest 标出目录布局');

// ── E. 版本与文档 ───────────────────────────────────────────────────────────
console.log('E. 版本与文档');
const pkg = JSON.parse(read('package.json'));
ok(/^0\.20\.(6[6-9]|7\d)$/.test(pkg.version) || /^0\.2[1-9]\./.test(pkg.version), 'E1 版本已到 0.20.66 之后（' + pkg.version + '）');
const changelog = read('CHANGELOG.md');
ok(/## v0\.20\.6[6-9]/.test(changelog), 'E2 CHANGELOG 有 0.20.66 段');
const readme = read('README.md');
ok(new RegExp('当前版本 \\*\\*' + pkg.version.replace(/\//g, '') + '\\*\\*').test(readme), 'E3 README 版本行与 package.json 一致');

console.log('features-v02066: ' + pass + ' pass, ' + fail + ' fail');
if (fail) process.exitCode = 1;
