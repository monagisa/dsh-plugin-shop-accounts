// v0.20.62：淘宝「运营推广」域固化成配方 —— 阿里妈妈「营销场景报表」自动导出。
//
// 背景：
//   · 阿里妈妈报表页只有「下载报表 → 确定」，任务会挂到「下载管理」异步生成，浏览器下载事件在 ego
//     里不稳（probe98 跑了 685 秒直接 ego_user_in_control），所以走接口取字节：
//     下载管理行里的 taskId → getDownloadUrl.json 拿 OSS 直链 → 页内同步 XHR 逐字节 hex。
//   · 平台给的下载产物是 ZIP（里面一份 GBK 的 CSV），执行器落盘时要自动解包，否则下游读表只能拿到
//     一个 .zip。
//   · 这类配方没有 downloadFile 步骤，但用「带 outputKey 的 evaluate」产出字节；采集门禁（声明了
//     download_ref 却没有产文件步骤就跳过）必须把这种也认成「有下载」。

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const libUrl = (name) => url.pathToFileURL(path.join(ROOT, 'lib', name)).href;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const { listDsls, loadDsl } = await import(libUrl('dsls.mjs'));
const { compileExecution, writeFetchFile } = await import(libUrl('rpa.mjs'));

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log('  ok  ' + name); } else { fail += 1; console.log('  FAIL ' + name); }
}

const rpaSrc = read('lib/rpa.mjs');
const dslSrc = read('lib/dsls.mjs');

// ── A 组：配方本身
const loaded = loadDsl('tb_ads_scene_report');
const dsl = (loaded && loaded.raw) || null;
const meta0 = (loaded && loaded.meta) || null;
ok(!!dsl, 'A1 种子里有 tb_ads_scene_report');
const steps = (dsl && dsl.template && dsl.template.steps) || [];
ok((dsl && dsl.platform) === 'taobao' && meta0 && meta0.platform === 'taobao', 'A2 平台是淘宝');
ok(Array.isArray(dsl && dsl.domains) && dsl.domains.includes('运营推广'), 'A3 覆盖「运营推广」域');
ok(dsl && dsl.verified === true, 'A4 已校准');
ok(steps.length >= 12 && String(steps[0].action) === 'goto', 'A5 首步是 goto（进阿里妈妈报表页）');
ok(String(steps[steps.length - 1].action) === 'evaluate' && steps[steps.length - 1].outputKey === 'tbAdsSceneFile', 'A6 末步是取字节的 evaluate，outputKey = tbAdsSceneFile');
const dslText = JSON.stringify(dsl);
ok(dslText.includes('getDownloadUrl.json'), 'A7 走 getDownloadUrl 接口拿直链');
ok(dslText.includes('#!/report/download-list'), 'A8 有「下载管理」页的 hash 回退（父菜单点不动）');
ok(dslText.includes("normalize-space(.)='下载报表'"), 'A9 点的是报表页的「下载报表」按钮');
ok(dslText.includes('dialog-footer'), 'A10 弹窗里点「确定」才生成任务');
ok(!steps.some((s) => String(s.action).toLowerCase() === 'downloadfile'), 'A11 不依赖浏览器下载事件（ego 里不稳）');

// ── B 组：采集门禁要认「带 outputKey 的 evaluate」也算产文件
const metas = listDsls().items;
const meta = metas.find((m) => m.id === 'tb_ads_scene_report');
ok(!!meta, 'B1 清单里能列出这份配方');
ok(meta && meta.declaresDownload === true, 'B2 声明了 download_ref 产物');
ok(meta && meta.hasDownload === true, 'B3 hasDownload 认得出 evaluate 产物（否则会被门禁跳过）');
ok(dslSrc.includes("action === 'evaluate' && outputKey && artifactKeys.has(outputKey)"), 'B4 门禁判定含 evaluate 分支');
ok(dslSrc.includes('artifactKeys'), 'B5 门禁按声明的 output_key 匹配，不是见 evaluate 就算');

// ── C 组：ZIP 自动解包（平台给的是 zip 里一份 CSV）
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(name, text) {
  const data = Buffer.from(text, 'utf8');
  const comp = zlib.deflateRawSync(data);
  const crc = crc32(data);
  const nameBuf = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  const lho = 0;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(lho, 42);
  const cdOffset = local.length + nameBuf.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([local, nameBuf, comp, central, nameBuf, eocd]);
}
const tmpDir = path.join(ROOT, 'test', '.tmp-v02062');
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });
try {
  ok(rpaSrc.includes('function firstZipTextEntry'), 'C1 执行器里有 ZIP 头解析');
  ok(rpaSrc.includes('zlib.inflateRawSync'), 'C2 有 deflate 解压');
  ok(rpaSrc.includes("bytes.readUInt32LE(0) === 0x04034b50"), 'C3 落盘前按 PK\\x03\\x04 判 ZIP');
  const zip = makeZip('营销场景报表_20261124_111841.csv', '日期,展现量\n2026-11-23,1208\n');
  const got = writeFetchFile(tmpDir, { hex: zip.toString('hex'), filename: 'attachment; filename="x.zip"' }, { base: 'tbAdsSceneFile', ext: '.xls' });
  ok(fs.existsSync(got), 'C4 ZIP 落盘后文件存在');
  ok(got.endsWith('.csv'), 'C5 解包后扩展名是 .csv（不是 .zip/.xls）');
  const text = fs.readFileSync(got, 'utf8');
  ok(text.includes('2026-11-23') && text.includes('展现量'), 'C6 解包出来的就是 CSV 内容');
  ok(path.basename(got) === '营销场景报表_20261124_111841.csv', 'C7 文件名用 ZIP 内的条目名');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── D 组：编译链路能跑（不访问网络，只验证 op 形状）
const compiled = compileExecution(dsl, { params: {} });
ok(compiled.ops.length >= 12, 'D1 编译出来的 op 数量正常');
ok(compiled.ops[0].op === 'goto' && String(compiled.ops[0].url || '').includes('one.alimama.com'), 'D2 首个 op 是跳阿里妈妈');
const evalOp = compiled.ops.find((o) => String(o.stepId || '').startsWith('fetch-report-file')) || {};
ok(evalOp.op === 'eval', 'D3 取字节那步编译成页内求值');
ok(String(evalOp.expr || '').includes('getDownloadUrl'), 'D4 求值表达式里带取直链逻辑');
ok(!String(evalOp.expr || '').includes('{startDate}') && !String(evalOp.expr || '').includes('{productIds}'), 'D5 没有未替换的占位符');

// ── E 组：版本与文档
const pkg = JSON.parse(read('package.json'));
const parts = String(pkg.version || '').split('.').map((n) => Number(n));
ok(parts[0] > 0 || parts[1] > 20 || (parts[1] === 20 && parts[2] >= 62), 'E1 版本 ≥ 0.20.62');
ok(read('CHANGELOG.md').includes('## v0.20.62'), 'E2 CHANGELOG 有 0.20.62 段');
ok(pkg.scripts && pkg.scripts.features74, 'E3 package.json 有 features74 脚本');

console.log(`features-v02062: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exitCode = 1;
