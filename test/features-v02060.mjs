// v0.20.60：采集工作簿「同店同天按域归集」+ 读回平台导出的表格（xlsx / csv）
//
// 背景：原来一份工作簿只并「本次作业自己的产物」，所以先跑模板三域、再单独跑运营推广/服务履约时，
// 最后那份工作簿永远缺两个域。这里断言：① 表格文件能读回（xlsx / csv / 老式 xls 有明确原因）；
// ② 本次作业的下载型产物会进工作簿；③ 同店同一天的其它作业按域补齐；④ 工作表顺序固定为五域。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const libUrl = (name) => url.pathToFileURL(path.join(ROOT, 'lib', name)).href;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v02060-'));
process.env.DSH_SHOP_ACCOUNTS_DIR = TMP;

const { writeWorkbook } = await import(libUrl('xlsx.mjs'));
const { readTableFile, readDelimited } = await import(libUrl('sheet-read.mjs'));
const { writeJobWorkbook, jobDirFor } = await import(libUrl('collect-runner.mjs'));

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log('  ok  ' + name); } else { fail += 1; console.log('  FAIL ' + name); }
}

const ACC = 'acc_t1_v02060';
const DAY = new Date(2026, 10, 23, 9, 40).toISOString();
const JOB_A = 'job_20261123-0940_aaaaaa_测试';
const JOB_B = 'job_20261123-1216_bbbbbb_测试';

function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }

function tableFile(file, rows) {
  mkdir(path.dirname(file));
  writeWorkbook(file, [{ name: 'Sheet1', rows }]);
  return file;
}

// 现场：三个不同域的原始表格（模拟平台导出）
const dirA = jobDirFor(ACC, JOB_A);
const dirB = jobDirFor(ACC, JOB_B);
const fStore = tableFile(path.join(dirA, 'artifacts', '店铺经营核心日报.xlsx'), [
  ['统计日期', '店铺名称', '访客数', '支付金额'],
  ['2026-11-22', '测试店', '58', '0.00'],
  ['2026-11-21', '测试店', '61', '12.34'],
]);
const fFlow = tableFile(path.join(dirB, 'artifacts', '店铺流量来源构成日报.xlsx'), [
  ['统计日期', '来源', '访客数'],
  ['2026-11-22', '经营优势', '30'],
]);
const fAds = path.join(dirB, 'artifacts', '营销场景报表.csv');
fs.writeFileSync(fAds, '\ufeff日期,场景名字,花费\n2026-11-22,货品全站推广,12.33\n', 'utf8');

const jobA = {
  version: 1,
  jobId: JOB_A,
  accountId: ACC,
  accountName: '测试店',
  platform: 'taobao',
  createdAt: DAY,
  finishedAt: DAY,
  plan: { window: { start: '2026-11-22', end: '2026-11-22', days: 1 } },
  tasks: [
    { taskId: 't1', dslId: 'tb_store_core_daily', state: 'ok', artifacts: [{ outputKey: 'file', present: true, filePath: fStore }] },
    {
      taskId: 't2',
      dslId: 'tb_product_overall_metrics',
      state: 'ok',
      declaredArtifacts: [{ output_key: 'metrics', metrics: [{ id: 'pay', label: '支付金额' }] }],
      artifacts: [{ outputKey: 'metrics', records: { values: { pay: 662.71 } } }],
    },
  ],
};
const jobB = {
  version: 1,
  jobId: JOB_B,
  accountId: ACC,
  accountName: '测试店',
  platform: 'taobao',
  createdAt: DAY,
  finishedAt: DAY,
  plan: { window: { start: '2026-11-22', end: '2026-11-22', days: 1 } },
  tasks: [
    { taskId: 't1', dslId: 'tb_flow_source_consist', state: 'ok', artifacts: [{ outputKey: 'file', present: true, filePath: fFlow }] },
    { taskId: 't2', dslId: 'tb_ads_scene_report', state: 'ok', artifacts: [{ outputKey: 'file', present: true, filePath: fAds }] },
  ],
};
mkdir(dirA);
mkdir(dirB);
fs.writeFileSync(path.join(dirA, 'job.json'), JSON.stringify(jobA), 'utf8');
fs.writeFileSync(path.join(dirB, 'job.json'), JSON.stringify(jobB), 'utf8');

// A 组：表格读回
const rt = readTableFile(fStore);
ok(rt.kind === 'xlsx' && rt.sheets.length === 1, 'A1 xlsx 能读回（1 个表）');
ok(rt.sheets[0].rows.length === 3, 'A2 xlsx 行数正确（表头 + 2 行）');
ok(rt.sheets[0].rows[1][1] === '测试店', 'A3 xlsx 读到中文单元格');
const csvRead = readTableFile(fAds);
ok(csvRead.kind === 'csv' && csvRead.sheets[0].rows.length === 2, 'A4 csv 能读回（表头 + 1 行）');
ok(csvRead.sheets[0].rows[0][1] === '场景名字', 'A5 UTF-8 BOM 的 csv 表头正常');
// GBK：生意参谋/阿里妈妈导出的旧文件
const gbkFile = path.join(TMP, 'gbk.csv');
fs.writeFileSync(gbkFile, Buffer.concat([Buffer.from([0xc8, 0xd5, 0xc6, 0xda]), Buffer.from(',A\n2026-11-22,1\n')]));
const gbkRead = readDelimited(gbkFile);
ok(gbkRead && gbkRead[0].rows[0][0] === '日期', 'A6 GBK 编码的 csv 能读回');
// 老式 .xls：明确给出原因，不抛错
const xlsFile = path.join(TMP, 'old.xls');
fs.writeFileSync(xlsFile, Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(64)]));
const xlsRead = readTableFile(xlsFile);
ok(xlsRead.kind === 'xls' && xlsRead.sheets.length === 0 && /xls/.test(xlsRead.reason), 'A7 老式 xls 返回原因而不是崩');

// B 组：一个作业里，下载型产物 + 指标型产物都进工作簿
const book = writeJobWorkbook(dirA, jobA, '20261123-0940');
const names = book.sheets.map((s) => s.name);
ok(names.includes('经营总览'), 'B1 下载型产物成为「经营总览」工作表');
ok(names.includes('商品供给'), 'B2 指标型产物成为「商品供给」工作表');
ok(names.indexOf('经营总览') < names.indexOf('商品供给'), 'B3 工作表按五域顺序排（经营总览在前）');
ok(names[names.length - 1] === '采集情况', 'B4 「采集情况」永远在最后');

// C 组：同店同天的其它作业按域补齐
const namesC = names;
ok(namesC.includes('流量转化'), 'C1 补进同一天的「流量转化」');
ok(namesC.includes('运营推广'), 'C2 补进同一天的「运营推广」');
const back = readTableFile(path.join(dirA, 'artifacts', book.fileName));
ok(back.sheets.length === namesC.length, 'C3 生成的 xlsx 表数与预期一致');
const issueRows = back.sheets[back.sheets.length - 1].rows;
ok(issueRows.some((r) => r.join('').includes('并入同一天的其它作业') && r.join('').includes(JOB_B)), 'C4 「采集情况」标出并入来源作业');
ok(issueRows.some((r) => r.join('').includes('流量转化')), 'C5 并入行写明补的是哪个域');
const storeSheet = back.sheets.find((s) => s.name === '经营总览');
ok(storeSheet && storeSheet.rows.length === 3, 'C6 表格数据原样保留（表头 + 2 行）');

// D 组：跨天不并（不同天的作业各自成册）
const jobOld = { ...jobB, jobId: 'job_20261122-1200_cccccc_测试', createdAt: new Date(2026, 10, 22, 12, 0).toISOString() };
const dirOld = jobDirFor(ACC, jobOld.jobId);
mkdir(dirOld);
fs.writeFileSync(path.join(dirOld, 'job.json'), JSON.stringify(jobOld), 'utf8');
const bookOld = writeJobWorkbook(dirOld, jobOld, '20261122-1200');
ok(!bookOld.sheets.some((s) => s.name === '经营总览' || s.name === '商品供给'), 'D1 别的一天作业不会把前一天的表并进来');

// E 组：版本与文档
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
ok(String(pkg.version) >= '0.20.60', 'E1 版本 ≥ 0.20.60');
ok(changelog.includes('0.20.60'), 'E2 CHANGELOG 有 0.20.60 段');
const runnerSrc = fs.readFileSync(path.join(ROOT, 'lib/collect-runner.mjs'), 'utf8');
ok(runnerSrc.includes("const DOMAIN_SHEET_ORDER = ['经营总览', '流量转化', '运营推广', '商品供给', '服务履约'];"), 'E3 工作表顺序常量与五域一致');
ok(runnerSrc.includes('siblingJobsOf(job)'), 'E4 工作簿归集会扫同店同天的其它作业');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结论 */ }

console.log(`\nfeatures-v02060: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
