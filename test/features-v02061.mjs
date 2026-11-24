// v0.20.61：① 退款域（服务履约）真正取到数据：选商品改用上游的「批量搜索」+ 真实键盘换行；
//          ② 新建店铺时可以自己挑 ego 用户配置（同一平台同身份不能共用一份）。
//
// 背景：
//   · 退款报表一直只有表头，根因是我们移植时自己编的「搜索单个商品 + 一键全选」——一键全选只勾当前
//     搜索结果（1 个商品），报表自然空；上游用的是「批量搜索」面板一次粘 10 个 ID。
//   · 批量搜索粘 10 个 ID 需要换行，而我们的 typereal 把 '\n' 当普通字符发（浏览器不认）→ 10 个 ID
//     粘成一行、面板显示 10/10 但确认后已选 0。真实键盘要把换行发成 Enter（keyDown 带 text:'\r'）。
//   · 配置选择：以前插件按规则自动分配 profile，用户看不见；现在列出 ego 真实存在的配置让用户自己选，
//     并沿用「同一平台 + 同一身份必须分开」这条硬规则（共用会互相覆盖 cookie）。

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const libUrl = (name) => url.pathToFileURL(path.join(ROOT, 'lib', name)).href;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const { egoProfileChoices, judgeEgoProfileChoice } = await import(libUrl('ego-lifecycle.mjs'));
const { EGO_EXECUTOR_SOURCE } = await import(libUrl('rpa.mjs'));

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log('  ok  ' + name); } else { fail += 1; console.log('  FAIL ' + name); }
}

const rpaSrc = read('lib/rpa.mjs');

// ── A 组：真实键盘的换行 → Enter（批量搜索粘多行 ID 的前提）
const typeCharAt = rpaSrc.indexOf('async typeChar(ch)');
const typeCharSeg = typeCharAt >= 0 ? rpaSrc.slice(typeCharAt, typeCharAt + 1200) : '';
ok(typeCharSeg.includes("key: 'Enter'"), 'A1 本地驱动的 typeChar 把换行发成 Enter');
ok(typeCharSeg.includes('windowsVirtualKeyCode: 13'), 'A2 换行键带 windowsVirtualKeyCode 13（页面才认 keypress）');
ok(typeCharSeg.includes("text: '\\r'"), 'A3 换行键带 text:\\r');
ok(EGO_EXECUTOR_SOURCE.includes("key: 'Enter'"), 'A4 ego 执行器同样把换行发成 Enter');
const newlineGuard = EGO_EXECUTOR_SOURCE.includes("ch === '\\n'") || EGO_EXECUTOR_SOURCE.includes("ch === '\\r'");
ok(newlineGuard, 'A5 ego 执行器有换行分支（\n / \r 都认）');
let compiles = false;
try { new Function(EGO_EXECUTOR_SOURCE); compiles = true; } catch { compiles = false; }
ok(compiles, 'A6 生成出来的 ego 执行器源码可编译');

// ── B 组：退款配方改用上游的批量搜索
const refundRecipes = [
  'lib/rpa/dsls/taobao/tb_product_refund_overall.json',
  'lib/rpa/dsls/taobao/tb_product_refund_reason.json',
  'lib/rpa/dsls/taobao/tb_product_refund_completed.json',
  'lib/rpa/dsls/taobao/tb_product_refund_by_sku.json',
  'lib/rpa/dsls/tmall/tmall_product_refund_overall.json',
  'lib/rpa/dsls/tmall/tmall_product_refund_reason.json',
  'lib/rpa/dsls/tmall/tmall_product_refund_completed.json',
  'lib/rpa/dsls/tmall/tmall_product_refund_by_sku.json',
];
const recipes = refundRecipes.map((rel) => ({ rel, raw: read(rel) }));
ok(recipes.length === 8 && recipes.every((r) => r.raw.includes(':open-batch-search')), 'B1 八份退款配方都有 open-batch-search');
ok(recipes.every((r) => r.raw.includes(':confirm-batch-search')), 'B2 八份退款配方都有 confirm-batch-search');
ok(recipes.every((r) => !r.raw.includes('pick-search-items')), 'B3 旧的「搜索商品单选」步骤已移除');
ok(recipes.every((r) => r.raw.includes('batch-search-dropdown-overlay') && r.raw.includes('{productIds}')), 'B4 批量搜索面板按 {productIds} 填商品 ID');
ok(recipes.every((r) => r.raw.includes("'确') and contains(normalize-space(.),'定'") || r.raw.includes('dt-oui-btn-primary')), 'B5 确认按钮有「确 定」（字间空格）与 primary 两种回退');
const waitTimeouts = recipes.every((r) => {
  const at = r.raw.indexOf(':wait-download-report-ready');
  const seg = at >= 0 ? r.raw.slice(at, at + 2000) : '';
  const m = seg.match(/"timeoutMs":\s*(\d+)/);
  return m && Number(m[1]) >= 120000;
});
ok(waitTimeouts, 'B6 「等下载报表出现」的超时 ≥ 120 秒（生成报表本身要几十秒）');
const dlTimeouts = recipes.every((r) => {
  const at = r.raw.indexOf(':click-download-report');
  const seg = at >= 0 ? r.raw.slice(at, at + 1200) : '';
  const m = seg.match(/"timeoutMs":\s*(\d+)/);
  return m && Number(m[1]) >= 90000;
});
ok(dlTimeouts, 'B7 下载动作的超时 ≥ 90 秒（并写入 outputKey）');

// ── C 组：ego 用户配置列表与冲突判定
const profiles = [
  { id: 'Profile 1', name: 'nagisa', isDefault: true },
  { id: 'Profile 2', name: '用户配置 2', isDefault: false },
  { id: 'Profile 3', name: '用户配置 3', isDefault: false },
];
const accounts = [
  { id: 'acc_taobao_a', name: '淘宝店A', platform: 'taobao', accountType: 'seller', egoProfile: 'Profile 3' },
  { id: 'acc_pdd_b', name: '拼多多店B', platform: 'pdd', accountType: 'seller', egoProfile: 'Profile 3' },
];
const chTaobao = egoProfileChoices({ profiles, accounts, platform: 'taobao', accountType: 'seller' });
ok(chTaobao.length === 3, 'C1 列表列出 ego 里全部配置（默认配置也在，供界面说明）');
const p3 = chTaobao.find((c) => c.id === 'Profile 3');
ok(p3 && p3.conflict === true, 'C2 同一平台 + 同一身份占用 → 标为冲突');
ok(p3 && p3.usedBy.length === 2, 'C3 冲突项带出占用它的店铺名');
const p2 = chTaobao.find((c) => c.id === 'Profile 2');
ok(p2 && p2.conflict === false && p2.usedBy.length === 0, 'C4 空配置不算冲突');
const chTaobaoBuyer = egoProfileChoices({ profiles, accounts, platform: 'taobao', accountType: 'buyer' });
ok(!chTaobaoBuyer.find((c) => c.id === 'Profile 3').conflict, 'C5 同一平台的买家与卖家可以共用（不算冲突）');

const judgeConflict = judgeEgoProfileChoice({ choices: chTaobao, profileId: 'Profile 3', platformLabel: '淘宝' });
ok(judgeConflict.ok === false && judgeConflict.code === 'EGO_PROFILE_CONFLICT', 'C6 选到冲突配置 → EGO_PROFILE_CONFLICT');
const judgeDefault = judgeEgoProfileChoice({ choices: chTaobao, profileId: 'Profile 1' });
ok(judgeDefault.ok === false && judgeDefault.code === 'EGO_PROFILE_DEFAULT', 'C7 选默认配置 → EGO_PROFILE_DEFAULT（默认留给自己）');
const judgeUnknown = judgeEgoProfileChoice({ choices: chTaobao, profileId: 'Profile 9' });
ok(judgeUnknown.ok === false && judgeUnknown.code === 'EGO_PROFILE_UNKNOWN', 'C8 选不存在的配置 → EGO_PROFILE_UNKNOWN');
ok(judgeEgoProfileChoice({ choices: chTaobao, profileId: '' }).ok === true, 'C9 不选（自动分配）直接放行');
const judgeEmpty = judgeEgoProfileChoice({ choices: chTaobao, profileId: 'Profile 2' });
ok(judgeEmpty.ok === true, 'C10 空闲配置可选');

// ── D 组：接口与界面接进这道闸
const routeSrc = read('lib/server/routes.mjs');
ok(routeSrc.includes("p === '/ego-profiles'"), 'D1 新增 GET /ego-profiles');
ok(routeSrc.includes('egoProfileChoices({'), 'D2 接口按平台 + 身份算出冲突');
const createSeg = routeSrc.slice(routeSrc.indexOf("p === '/accounts'"), routeSrc.indexOf('saveAccounts([...loadAccounts(), account])'));
ok(createSeg.includes('judgeEgoProfileChoice'), 'D3 新建店铺时校验用户选的配置');
const patchIdx = routeSrc.indexOf('if (typeof body.egoProfile');
const patchSeg = patchIdx >= 0 ? routeSrc.slice(patchIdx, patchIdx + 900) : '';
ok(patchSeg.includes('judgeEgoProfileChoice'), 'D4 改店铺配置时同样校验');
const clientSrc = read('lib/client.js');
ok(clientSrc.includes("api('/ego-profiles')"), 'D5 新建店铺的表单会读 ego 配置列表');
ok(clientSrc.includes("label: 'ego 用户配置'"), 'D6 表单有「ego 用户配置」选择项');
ok(clientSrc.includes('egoChoiceConflicts') && clientSrc.includes('disabled: busy'), 'D7 冲突配置在下拉里禁用');
ok(clientSrc.includes('egoProfile: (!editing && egoProfile) ? egoProfile : undefined'), 'D8 选择结果随创建请求一起提交');

// ── E 组：版本与文档
const pkg = JSON.parse(read('package.json'));
ok(typeof pkg.version === 'string' && pkg.version >= '0.20.61', 'E1 版本 ≥ 0.20.61');
const changelog = read('CHANGELOG.md');
ok(changelog.includes('0.20.61'), 'E2 CHANGELOG 有 0.20.61 段');

console.log(`\nfeatures-v02061: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
