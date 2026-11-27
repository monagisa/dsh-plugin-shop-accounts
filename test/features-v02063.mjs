// v0.20.63：配方时间窗的归档延迟（T+2）+ 停用/校准标记的真实化。
//
// 背景：
//   · 退款类报表的数据是 T+2 归档的，截止日填「昨天」时页面日历格是 disabled，日期填不进去，
//     报表只回表头；之前 `prepareJob` 还把整批统一窗口硬塞给每份配方，把配方自己的窗口覆盖掉，
//     结果 4 份退款报表长期是空表。现在：配方可以声明 `collection.schedule.t_minus`，准备层不再
//     硬塞窗口。
//   · 淘宝那批 14 个配方里有 2 个真机跑不通（`tb_product_lost_to_competitor` 12 分钟不返回、
//     `tb_ads_product_promotion` 175 秒下载超时），但它们一直挂着 `verified: true`，定时采集会
//     反复挑它们；反过来，真正跑通的模板类配方（`tb_store_core_daily` 等）是 `verified: false`，
//     按域挑选时永远挑不到。现在收口：能跑的标校准、跑不通的显式 `disabled`，挑选时跳过。

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const libUrl = (name) => url.pathToFileURL(path.join(ROOT, 'lib', name)).href;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const { listDsls, loadDsl } = await import(libUrl('dsls.mjs'));
const { dslWindow, compileExecution } = await import(libUrl('rpa.mjs'));
const { selectRecipesForAccount } = await import(libUrl('collect-support.mjs'));

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log('  ok  ' + name); } else { fail += 1; console.log('  FAIL ' + name); }
}

const rpaSrc = read('lib/rpa.mjs');
const dslSrc = read('lib/dsls.mjs');
const runnerSrc = read('lib/collect-runner.mjs');
const supportSrc = read('lib/collect-support.mjs');

// ── A 组：dslWindow 支持 t_minus（T+2）
const refund = loadDsl('tb_product_refund_overall');
ok(!!refund && !!refund.raw, 'A1 种子里有 tb_product_refund_overall');
const refundWin = dslWindow(refund.raw, new Date(2026, 10, 24));
ok(refundWin.end === '2026-11-21', 'A2 退款配方窗口截止日 = 今天往前 3 天（T+3 归档安全边界）');
ok(refundWin.start === '2026-10-23' && refundWin.days === 30, 'A3 退款配方窗口 = 截止日往前 29 天（区间 30 天）');
const shopDaily = loadDsl('tb_store_core_daily');
const shopWin = dslWindow(shopDaily.raw, new Date(2026, 10, 24));
ok(shopWin.end === '2026-11-23', 'A4 没声明 t_minus 的配方窗口不变（截止到昨天）');
ok(/t_minus/.test(rpaSrc), 'A5 rpa.mjs 里 dslWindow 读 collection.schedule.t_minus');
ok(dslWindow(refund.raw, new Date(2026, 0, 3)).end === '2025-12-31', 'A6 跨年也不出错（1 月 3 日 → 去年 12 月 31 日）');

// ── B 组：编译出来的窗口 = 配方自己的窗口（不会被外部统一窗口覆盖成默认值）
const compiled = compileExecution(refund.raw, { now: new Date(2026, 10, 24), params: { productIdsLines: '1\n2', productIds: '1\n2' } });
ok(compiled.window && compiled.window.end === '2026-11-21', 'B1 编译产物 window.end = 2026-11-21（T+3）');
ok(compiled.window && compiled.window.start === '2026-10-23', 'B2 编译产物 window.start = 2026-10-23');
ok(compiled.ops.length > 10, 'B3 退款配方仍能编译出完整 ops 序列');
ok(/start: opts\.start \|\| undefined,/.test(runnerSrc) && /end: opts\.end \|\| undefined,/.test(runnerSrc), 'B4 prepareJob 不再把整批统一窗口硬塞给配方');
ok(/request\.window|window: trailingWindow|trailingWindow\(/ .test(runnerSrc), 'B5 准备层只把统一窗口记进作业台账');

// ── C 组：9 份退款配方的排期声明
const refundIds = [
  'lib/rpa/dsls/taobao/tb_product_refund_overall.json',
  'lib/rpa/dsls/taobao/tb_product_refund_reason.json',
  'lib/rpa/dsls/taobao/tb_product_refund_completed.json',
  'lib/rpa/dsls/taobao/tb_product_refund_by_sku.json',
  'lib/rpa/dsls/taobao/lingyang_refund_overall.json',
  'lib/rpa/dsls/tmall/tmall_product_refund_overall.json',
  'lib/rpa/dsls/tmall/tmall_product_refund_reason.json',
  'lib/rpa/dsls/tmall/tmall_product_refund_completed.json',
  'lib/rpa/dsls/tmall/tmall_product_refund_by_sku.json',
];
const badSched = refundIds.filter((rel) => {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const sched = (j.collection && j.collection.schedule) || {};
  return !(sched.days === 30 && sched.t_minus === 3);
});
ok(badSched.length === 0, 'C1 9 份退款配方都声明 days:30 + t_minus:3' + (badSched.length ? ' → ' + badSched.join(',') : ''));
ok(refundIds.length === 9, 'C2 退款配方清单是 9 份（淘宝 5 + 天猫 4）');

// ── D 组：坏配方已删除 / 校准标记
const inv = listDsls().items;
const byId = (id) => inv.find((m) => m.id === id);
ok(/disabled: raw\.disabled === true/.test(dslSrc), 'D1 readMeta 仍支持 disabled（留给以后停用把不稳的配方）');
ok(/disabledReason/.test(dslSrc), 'D2 readMeta 仍暴露 disabledReason');
ok(!byId('tb_product_lost_to_competitor'), 'D3 lost_to_competitor 已从种子里删除（12 分钟不返回）');
ok(!byId('tb_ads_product_promotion'), 'D4 ads_product_promotion 已删除（下载超时）');
ok(!byId('ads_marketing'), 'D5 旧 ads_marketing 已删除（被 tb_ads_scene_report 取代）');
ok(!byId('tmall_product_lost_to_competitor'), 'D6 天猫同族坏配方一起删了');
ok(!fs.existsSync(path.join(ROOT, 'lib/rpa/dsls/taobao/tb_product_lost_to_competitor.json')) && !fs.existsSync(path.join(ROOT, 'lib/rpa/dsls/taobao/tb_ads_product_promotion.json')) && !fs.existsSync(path.join(ROOT, 'lib/rpa/dsls/taobao/ads_marketing.json')), 'D7 文件确实不在盘上');
ok(byId('tb_product_roi').verified !== true && byId('tb_product_sku_metrics').verified !== true, 'D8 没真机跑过的同族配方仍是未校准（不会自动挑）');
ok(byId('tb_store_core_daily').verified === true, 'D9 真机跑通的模板配方是已校准（否则按域挑选永远挑不到）');
ok(byId('tb_flow_source_consist').verified === true, 'D10 流量来源构成日报已校准');
ok(byId('tb_product_overall_tpl').verified === true, 'D11 商品整体效果日报已校准');
ok(byId('tb_traffic_source_excel').verified === true, 'D12 流量来源 Excel 已校准');
// ── E 组：挑选时跳过停用配方
const acc = { id: 'acc_t1_v02063', platform: 'taobao', accountType: 'seller', collection: { domains: ['经营总览', '流量转化', '运营推广', '商品供给', '服务履约'] } };
const filtered = selectRecipesForAccount(acc, inv, { includeDownload: true });
ok(filtered.skipped.disabled.length === 0, 'E1 现在种子里没有停用配方（坏配方已删除）');
ok(filtered.pickedIds.length >= 10, 'E2 已校准配方仍能正常挑出（≥10 份）');
ok(!filtered.pickedIds.some((id) => id.includes('lost_to_competitor') || id === 'ads_marketing'), 'E3 坏配方不在挑选结果里');
ok(filtered.pickedIds.includes('tb_store_core_daily') && filtered.pickedIds.includes('tb_flow_source_consist'), 'E4 已校准的模板配方现在能被挑中');
ok(filtered.pickedIds.includes('tb_ads_scene_report') && filtered.pickedIds.includes('tb_product_refund_overall'), 'E5 运营推广/服务履约配方在清单里');
ok(!filtered.pickedIds.includes('tb_product_roi'), 'E6 未校准配方仍不自动挑');
ok(filtered.skipped.unverified.includes('tb_product_roi'), 'E7 未校准配方进 skipped.unverified');
ok(/meta\.disabled === true/.test(supportSrc), 'E8 collect-support 里挑选逻辑有 disabled 分支');
ok(/body\.allowDisabled !== true/.test(supportSrc), 'E9 显式 dslIds 也要 allowDisabled 才跑停用配方');

// ── F 组：版本与变更记录
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
ok(vcAtLeast(pkg.version, '0.20.63'), 'F1 package.json 版本 ≥ 0.20.63（当前 ' + pkg.version + '）');
const changelog = read('CHANGELOG.md');
ok(changelog.includes('## v0.20.63'), 'F2 CHANGELOG 有 v0.20.63 段');
ok(changelog.includes('t_minus'), 'F3 CHANGELOG 说明 t_minus 归档延迟修复');
ok(changelog.includes('停用'), 'F4 CHANGELOG 说明配方停用/校准收口');
ok(typeof pkg.scripts.features75 === 'string', 'F5 package.json 有 features75 别名');

console.log(`\nfeatures-v02063: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
