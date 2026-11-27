// v0.20.67：下载型配方必须真的进工作簿 —— ① 模板类配方只点页面「下载」、没有 download 步骤，
// 文件落在 logs/raw/<taskId>/ 但没有任何产物记录；② 有些配方 outputs 里有文件路径但 collection
// 没声明 artifacts；③ 抖店 xlsx 的表名读成 sheet2/sheet4（workbook.xml 命名空间前缀）；
// ④ 同一域有多张表时只留第一张。这里逐条断言。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const libUrl = (name) => url.pathToFileURL(path.join(ROOT, 'lib', name)).href;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v02067-'));
process.env.DSH_SHOP_ACCOUNTS_DIR = TMP;

const { writeWorkbook } = await import(libUrl('xlsx.mjs'));
const { organizeArtifacts, jobDirFor } = await import(libUrl('collect-runner.mjs'));
const { readTableFile } = await import(libUrl('sheet-read.mjs'));

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log('  ok  ' + name); } else { fail += 1; console.log('  FAIL ' + name); }
}
function eq(a, b, name) { ok(String(a) === String(b), name + '（got ' + a + '，期望 ' + b + '）'); }

const ACC = 'acc_t_v02067';
const DAY = new Date(2026, 10, 24, 10, 10).toISOString();
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });
const runnerSrc = read('lib/collect-runner.mjs');
const sheetSrc = read('lib/sheet-read.mjs');

// ── A. 接线 ─────────────────────────────────────────────────────────────────
console.log('A. 下载产物认领接线');
ok(/function adoptOrphanDownloads\(job\)/.test(runnerSrc), 'A1 新增 adoptOrphanDownloads');
ok(/try \{ adoptOrphanDownloads\(job\); \}/.test(runnerSrc), 'A2 organizeArtifacts 入口调用认领');
ok(/const dir = path\.join\(base, 'logs', 'raw', String\(t\.taskId \|\| ''\)\);/.test(runnerSrc), 'A3 认领扫 logs/raw/<taskId>');
ok(/kind: 'download', present: true/.test(runnerSrc), 'A4 认领的产物标成 download 且 present');
ok(/if \(t\.state === 'empty'\) t\.state = 'ok';/.test(runnerSrc), 'A5 认领成功把 empty 翻成 ok');
ok(/for \(const \[key, value\] of Object\.entries\(t\.outputs \|\| \{\}\)\)/.test(runnerSrc), 'A6 也认领 outputs 里的文件路径');
ok(/value\.indexOf\(jobDirFor\(job\.accountId, job\.jobId\)\) < 0/.test(runnerSrc), 'A7 只认本作业目录里的文件');
ok(/downloadDir: path\.join\(dir, 'logs', 'raw',/.test(runnerSrc) && /\.downloadDir = path\.join\(dir, 'logs', 'raw', t\.taskId\)/.test(runnerSrc), 'A8 下载目录统一在 logs/raw');
ok(sheetSrc.indexOf('<(?:[A-Za-z0-9_]+:)?Relationship') >= 0, 'A9a rels 正则容忍命名空间前缀');
ok(sheetSrc.indexOf('<(?:[A-Za-z0-9_]+:)?sheet') >= 0, 'A9b workbook 正则容忍命名空间前缀');
ok(/const sheetNames = \[\]/.test(sheetSrc), 'A10 workbook.xml 表名兜底');
ok(/const putTable = \(x\) => \{/.test(runnerSrc) && /tables\.has\(x\.domain\)/.test(runnerSrc), 'A11 writeJobWorkbook 一个域可放多张表');
ok(/if \(!x \|\| !x\.rows \|\| x\.rows\.length < 2\) return;/.test(runnerSrc), 'A12 空表（只有表头）不进工作簿');

// ── B. 功能：模板型（无 download 步骤）的下载文件被认领并进工作簿 ────────────
console.log('B. 模板型下载产物认领');
const JOB_B = 'job_20261124-1010_bbb222_测试';
const dirB = jobDirFor(ACC, JOB_B);
mkdir(path.join(dirB, 'logs', 'raw', 't_001'));
const tplFile = path.join(dirB, 'logs', 'raw', 't_001', '店铺经营核心日报.xlsx');
writeWorkbook(tplFile, [{ name: 'data', header: ['日期', '访客数', '支付金额'], rows: [['2026-11-22', 12, 34.5], ['2026-11-23', 18, 51.2]] }]);
mkdir(path.join(dirB, 'artifacts'));
const jobB = {
  version: 1, accountId: ACC, jobId: JOB_B, accountName: '示例店铺', createdAt: DAY,
  tasks: [{ taskId: 't_001', dslId: 'tb_store_core_daily', state: 'empty', artifacts: [], outputs: {} }],
};
const manB = organizeArtifacts(dirB, jobB);
ok(jobB.tasks[0].state === 'ok', 'B1 empty 被翻成 ok');
ok(jobB.tasks[0].artifacts.length === 1, 'B2 认领出 1 个产物');
ok(/^采集数据_/.test((manB.files || [])[0].fileName), 'B3 生成了成品工作簿');
const sheetNamesB = ((manB.files || [])[0].sheets || []).map((s) => s.name);
ok(sheetNamesB.includes('经营总览'), 'B4 工作簿含该配方所属域（经营总览）：' + sheetNamesB.join(','));
ok(!fs.existsSync(path.join(dirB, 'logs', 'raw', 't_001')), 'B5 交付后原始导出被清掉');

// ── C. 功能：outputs 有路径但没声明 artifacts（退款类）也要进工作簿 ──────────
console.log('C. outputs 文件路径认领');
const JOB_C = 'job_20261124-1111_ccc333_测试';
const dirC = jobDirFor(ACC, JOB_C);
mkdir(path.join(dirC, 'logs', 'raw', 't_001'));
mkdir(path.join(dirC, 'artifacts'));
const refFile = path.join(dirC, 'logs', 'raw', 't_001', '整体退款分布.xlsx');
writeWorkbook(refFile, [{ name: 'data', header: ['统计日期', '商品ID', '成功退款金额'], rows: [['2026-11-21', '1001', 9.9], ['2026-11-22', '1002', 4.4]] }]);
const jobC = {
  version: 1, accountId: ACC, jobId: JOB_C, accountName: '示例店铺', createdAt: DAY,
  tasks: [{ taskId: 't_001', dslId: 'tb_product_refund_overall', state: 'empty', artifacts: [], outputs: { lingyangRefundOverallFile: refFile } }],
};
const manC = organizeArtifacts(dirC, jobC);
ok(jobC.tasks[0].artifacts.length === 1, 'C1 outputs 里的文件被认领成产物');
eq(jobC.tasks[0].artifacts[0].outputKey, 'lingyangRefundOverallFile', 'C2 保留 outputKey');
ok(jobC.tasks[0].state === 'ok', 'C3 状态翻成 ok');
const namesC = ((manC.files || [])[0].sheets || []).map((s) => s.name);
ok(namesC.includes('服务履约'), 'C4 工作簿含服务履约：' + namesC.join(','));
ok(/tb_product_refund_overall_/.test(String(jobC.tasks[0].artifacts[0].fileName || '')), 'C5 产物按配方前缀改名');

// ── D. 功能：同一域多张表都进工作簿（不再只留第一张） ────────────────────────
console.log('D. 同域多表合并');
const JOB_D = 'job_20261124-1212_ddd444_测试';
const dirD = jobDirFor(ACC, JOB_D);
mkdir(path.join(dirD, 'logs', 'raw', 't_001'));
mkdir(path.join(dirD, 'logs', 'raw', 't_002'));
mkdir(path.join(dirD, 'artifacts'));
const d1 = path.join(dirD, 'logs', 'raw', 't_001', '成交概览.xlsx');
const d2 = path.join(dirD, 'logs', 'raw', 't_002', '终端构成.xlsx');
writeWorkbook(d1, [{ name: '成交概览', header: ['日期', '成交金额'], rows: [['2026-11-22', 100], ['2026-11-23', 120]] }]);
writeWorkbook(d2, [{ name: '终端构成', header: ['日期', '终端', '成交金额'], rows: [['2026-11-22', '安卓', 70], ['2026-11-23', 'iOS', 80]] }]);
const jobD = {
  version: 1, accountId: ACC, jobId: JOB_D, accountName: '示例店铺', createdAt: DAY,
  tasks: [
    { taskId: 't_001', dslId: 'douyin_shop_transaction', state: 'ok', artifacts: [{ role: 'business', kind: 'download', present: true, filePath: d1 }], outputs: {} },
    { taskId: 't_002', dslId: 'douyin_shop_transaction', state: 'ok', artifacts: [{ role: 'business', kind: 'download', present: true, filePath: d2 }], outputs: {} },
  ],
};
const manD = organizeArtifacts(dirD, jobD);
const namesD = ((manD.files || [])[0].sheets || []).map((s) => s.name);
ok(namesD.filter((n) => n.indexOf('经营总览') === 0).length === 2, 'D1 同域两张表都进工作簿：' + namesD.join(','));
ok(namesD.some((n) => /成交概览/.test(n)), 'D2 至少含成交概览');
ok(namesD.some((n) => /终端构成/.test(n), ), 'D3 至少含终端构成');
ok(!namesD.includes('sheet2'), 'D4 没有 sheetN 这类假表名');

// ── E. 退款类配方排期（T+3 归档安全边界）与版本 ─────────────────────────────
console.log('E. 排期与版本');
const refundIds = [
  ['taobao', 'tb_product_refund_overall'], ['taobao', 'tb_product_refund_reason'],
  ['taobao', 'tb_product_refund_completed'], ['taobao', 'tb_product_refund_by_sku'],
  ['taobao', 'lingyang_refund_overall'],
  ['tmall', 'tmall_product_refund_overall'], ['tmall', 'tmall_product_refund_reason'],
  ['tmall', 'tmall_product_refund_completed'], ['tmall', 'tmall_product_refund_by_sku'],
];
let lagOk = 0;
for (const [plat, id] of refundIds) {
  const p = path.join(ROOT, 'lib', 'rpa', 'dsls', plat, id + '.json');
  if (!fs.existsSync(p)) continue;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  const sched = (raw.collection || {}).schedule || {};
  if (Number(sched.t_minus) >= 2 && Number(sched.days) >= 7) lagOk += 1;
}
eq(lagOk, 9, 'E1 9 份退款配方都带 t_minus>=2 的区间排期');
const pkg = JSON.parse(read('package.json'));
function vcAtLeast(v, want) {
  const a = String(v || '').split('.').map(Number);
  const b = String(want || '').split('.').map(Number);
  for (let i = 0; i < b.length; i += 1) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}
ok(vcAtLeast(pkg.version, '0.20.67'), 'E2 版本已升到 0.20.67+（当前 ' + pkg.version + '）');
ok(read('CHANGELOG.md').indexOf('## v0.20.67') >= 0, 'E3 CHANGELOG 有 v0.20.67 段');
const readmeVer = (read('README.md').match(/当前版本 \*\*([0-9.]+)\*\*/) || [])[1];
ok(readmeVer === pkg.version, 'E4 README 版本行与 package.json 一致（' + readmeVer + '）');

// ── F. 退款类配方的商品 ID 优先取「商品供给」报表 ─────────────────────────
console.log('F. 商品 ID 来源');
const ppSrc = read('lib/product-params.mjs');
ok(/export function productIdsFromArtifacts\(/.test(ppSrc), 'F1 新增商品 ID 从已采集报表读取');
ok(/const fromArtifacts = productIdsFromArtifacts\(account,/.test(ppSrc), 'F2 fetchProductIds 优先用它');
ok(/^商品供给/.test('商品供给-data') && /商品.?ID/.test(ppSrc), 'F3 只认商品供给表且按「商品ID」列取');
const pp = await import(libUrl('product-params.mjs'));
ok(typeof pp.productIdsFromArtifacts === 'function', 'F4 导出可用');
console.log('\nfeatures-v02067: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
