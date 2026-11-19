import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const lib = (name) => pathToFileURL(path.join(ROOT, 'lib', name)).href;
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const dsls = await import(lib('dsls.mjs'));
const support = await import(lib('collect-support.mjs'));

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
function versionAtLeast(actual, min) {
  const a = String(actual).split('.').map(Number);
  const b = String(min).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}
const inventory = dsls.listDsls().items;
const fakeAccount = (platform, domains) => ({ id: 'acc_test_' + platform, name: '测试店', platform, accountType: 'seller', collection: { enabled: true, domains } });

await test('A1 配方元信息里读得到 domains / verified / needsParams / unsupported', () => {
  const seed = inventory.find((m) => m.id === 'tb_shop_overview');
  assert.ok(seed, '找不到 tb_shop_overview');
  assert.ok(Array.isArray(seed.domains) && seed.domains.length, '老配方没有补上 domains');
  assert.equal(seed.verified, true, '已校准的配方没有标 verified');
  const pddUnsupported = inventory.filter((m) => m.unsupported === true).map((m) => m.id);
  assert.ok(pddUnsupported.length >= 1, '没有识别出引擎不支持的配方（readvalue 那两份）');
  assert.ok(inventory.some((m) => m.needsParams === true), '没有识别出需要业务参数的配方');
});

await test('A2 所有内置配方都声明了采集域（界面才能标「暂无配方」）', () => {
  const noDomains = inventory.filter((m) => !m.error && !(m.domains || []).length).map((m) => m.id);
  assert.deepEqual(noDomains, [], '这些配方没有 domains：' + noDomains.join(', '));
});

await test('A3 移植进来的新配方一律标成未校准（verified:false）', () => {
  const verifiedIds = inventory.filter((m) => m.verified === true).map((m) => m.id).sort();
  assert.deepEqual(verifiedIds, [
    'douyin_shop_income_expense', 'douyin_shop_transaction', 'jd_shop_overview', 'jd_traffic_overview',
    'pdd_shop_overview', 'tb_shop_overview', 'tmall_shop_overview',
  ].sort(), '已校准清单变了：' + verifiedIds.join(', '));
});

await test('B1 按店铺勾选的采集域挑配方（域外的不要）', () => {
  const acc = fakeAccount('taobao', ['服务履约']);
  const r = support.selectRecipesForAccount(acc, inventory, { includeDownload: true, includeUnverified: true, allowNeedsParams: true });
  assert.ok(r.pickedIds.length >= 2, '服务履约域下应该有淘宝退款/服务类配方，实际 ' + r.pickedIds.join(', '));
  assert.ok(r.pickedIds.every((id) => id.startsWith('tb_')), '挑到了别的平台的配方：' + r.pickedIds.join(', '));
  for (const id of r.pickedIds) {
    const meta = inventory.find((m) => m.id === id);
    assert.ok((meta.domains || []).includes('服务履约'), id + ' 不属于服务履约域');
  }
  assert.ok(r.skipped.domain.length >= 3, '域外配方没有被跳过');
});

await test('B2 定时采集只跑已校准的配方（未校准的不进计划）', () => {
  const acc = fakeAccount('jd', ['经营总览', '流量转化']);
  const r = support.selectRecipesForAccount(acc, inventory, { includeDownload: true });
  assert.deepEqual(r.pickedIds.sort(), ['jd_shop_overview', 'jd_traffic_overview'], '定时计划里混进了未校准配方：' + r.pickedIds.join(', '));
  assert.ok(r.skipped.unverified.length >= 5, '未校准配方没被跳过');
});

await test('B3 需要业务参数的配方默认跳过（传 allowNeedsParams 才进）', () => {
  const acc = fakeAccount('jd', ['商品供给']);
  const def = support.selectRecipesForAccount(acc, inventory, { includeDownload: true, includeUnverified: true });
  assert.ok(def.skipped.needsParams.includes('jd_product_core_metrics'), '缺参配方没被跳过');
  const allow = support.selectRecipesForAccount(acc, inventory, { includeDownload: true, includeUnverified: true, allowNeedsParams: true });
  assert.ok(allow.pickedIds.includes('jd_product_core_metrics') || allow.skipped.unverified.includes('jd_product_core_metrics'), '传了 allowNeedsParams 仍被挡在缺参关');
});

await test('B4 引擎不支持的动作（readvalue）直接跳过，不塞进计划充数', () => {
  const acc = fakeAccount('pdd', ['流量转化']);
  const r = support.selectRecipesForAccount(acc, inventory, { includeDownload: true, includeUnverified: true });
  assert.ok(r.skipped.unsupported.includes('pdd_traffic_overview'), 'readvalue 配方没被标成不支持');
  assert.ok(!r.pickedIds.includes('pdd_traffic_overview'), '不支持的配方进了计划');
});

await test('B5 勾的域一个配方都没有时，报「没有已校准的配方」而不是跑空', async () => {
  const acc = fakeAccount('pdd', ['竞争洞察']);
  const r = await support.prepareJobForAccount(acc, { start: '2026-10-20', end: '2026-11-18' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_DSL_FOR_DOMAINS');
  assert.ok(String(r.error).includes('没有已校准'), '错误提示没讲清原因：' + r.error);
});

await test('C1 界面按域的配方数下发，没有配方的域标「暂无配方」', () => {
  const state = read('lib/server/state.mjs');
  assert.ok(state.includes('dslRecipeStats'), 'state 没有统计配方分布');
  assert.ok(state.includes('collectionRecipes'), 'state 没把配方分布下发给界面');
  const client = read('lib/client.js');
  assert.ok(client.includes('a.collectionRecipes'), '界面没读配方分布');
  assert.ok(client.includes('暂无配方'), '界面没标「暂无配方」');
});

await test('C2 配方统计按域聚合（已校准数单独计）', () => {
  const s = dsls.dslRecipeStats('jd', inventory);
  assert.ok(s.total >= 10, 'jd 配方数偏少：' + s.total);
  assert.ok(s.byDomain['经营总览'] && s.byDomain['经营总览'].verified >= 1, 'jd 经营总览的已校准数不对');
  const tb = dsls.dslRecipeStats('taobao', inventory);
  assert.ok(tb.byDomain['服务履约'].total >= 2, '淘宝服务履约版块没有统计到配方');
});

await test('D1 版本号已到 0.20.37', () => {
  assert.ok(versionAtLeast(pkg.version, '0.20.37'), 'package.json 版本还是 ' + pkg.version);
});

await test('D2 CHANGELOG 与 README 写清「采集域决定跑哪些配方」', () => {
  const cl = read('CHANGELOG.md');
  assert.ok(cl.includes('v0.20.37'), 'CHANGELOG 缺 v0.20.37');
  assert.ok(cl.includes('采集域') && cl.includes('配方'), 'CHANGELOG 没说明域与配方的关系');
  const rm = read('README.md');
  assert.ok(rm.includes('采集域') && (rm.includes('配方') || rm.includes('采集项')), 'README 没同步说明');
});

if (failures.length) {
  console.log('\n' + failures.length + ' 项失败');
  for (const f of failures) {
    if (f.err && f.err.stack) console.log(f.err.stack);
  }
  process.exitCode = 1;
} else {
  console.log('\n\u2713 全部通过（' + passed.length + ' 项）');
}
