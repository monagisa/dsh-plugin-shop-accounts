import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const LIB = path.join(ROOT, 'lib');
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('OK   ' + name);
  } catch (e) {
    failed += 1;
    console.log('FAIL ' + name);
    console.log('     ' + String((e && e.message) || e).slice(0, 400));
  }
}

const params = await import(pathToFileURL(path.join(LIB, 'product-params.mjs')).href);
const dsls = await import(pathToFileURL(path.join(LIB, 'dsls.mjs')).href);
const support = await import(pathToFileURL(path.join(LIB, 'collect-support.mjs')).href);

await test('A1 只有淘宝 / 拼多多 / 抖音支持自动抓商品 ID', () => {
  assert.deepEqual(params.PRODUCT_PARAM_PLATFORMS, ['taobao', 'douyin']);
  assert.equal(params.productParamSupported('taobao'), true);
  assert.equal(params.productParamSupported('douyin'), true);
  assert.equal(params.productParamSupported('pdd'), false, '拼多多列表页在自动化下读不到 ID，先不开放');
  assert.equal(params.productParamSupported('jd'), false);
  assert.equal(params.productParamSupported('tmall'), false);
});

await test('A2 抓商品 ID 的脚本里有三个平台各自的商品列表页', () => {
  const src = fs.readFileSync(path.join(LIB, 'product-params.mjs'), 'utf8');
  assert.ok(src.includes('myseller.taobao.com/home.htm/SellManage/on_sale'), '淘宝在售商品页');
  assert.ok(src.includes('mms.pinduoduo.com/goods/goods_list'), '拼多多商品列表页');
  assert.ok(src.includes('fxg.jinritemai.com/ffa/g/list'), '抖店商品列表页');
  assert.ok(src.includes('collect-goods-ids'), '要有采集步骤');
});

await test('A3 缓存为空时 productParamHint 报 supported 但不 cached', () => {
  const acc = { id: 'acc_taobao_x', platform: 'taobao' };
  params._resetProductIdCache();
  const hint = params.productParamHint(acc);
  assert.equal(hint.supported, true);
  assert.equal(hint.cached, false);
  assert.equal(hint.count, 0);
});

await test('B1 selectRecipesForAccount：支持自动补参数的平台不再把 needsParams 配方跳过', () => {
  const inventory = dsls.listDsls().items;
  const acc = { platform: 'taobao', collection: { domains: ['商品供给'] } };
  // v0.20.63：同族未校准配方不再自动挑，这里显式带上 includeUnverified，只验「needsParams 不再被跳过」
  const r = support.selectRecipesForAccount(acc, inventory, { includeDownload: true, includeUnverified: true });
  assert.ok(r.pickedIds.includes('tb_product_roi'), '需要商品 ID 的配方应当被挑中');
  assert.equal(r.skipped.needsParams.length, 0, '淘宝不该再把 needsParams 配方跳过');
});

await test('B2 传 autoParams:false 时回到旧行为（需要参数的配方跳过）', () => {
  const inventory = dsls.listDsls().items;
  const acc = { platform: 'taobao', collection: { domains: ['商品供给'] } };
  const r = support.selectRecipesForAccount(acc, inventory, { includeDownload: true, autoParams: false, includeUnverified: true });
  assert.ok(r.skipped.needsParams.includes('tb_product_roi'), '关掉自动补参数后应当跳过');
});

await test('B3 没有商品 ID 抓取能力的平台仍然跳过 needsParams 配方', () => {
  const inventory = dsls.listDsls().items;
  const acc = { platform: 'jd', collection: { domains: ['经营总览'] } };
  const r = support.selectRecipesForAccount(acc, inventory, { includeDownload: true });
  assert.ok(r.skipped.needsParams.length > 0, '京东没有抓 ID 脚本，需要参数的配方继续跳过');
});

await test('C1 dslRecipeStats：淘宝「商品供给」有可跑配方了', () => {
  const stats = dsls.dslRecipeStats('taobao');
  const row = stats.byDomain['商品供给'];
  assert.ok(row && row.runnable > 0, '淘宝商品供给域应当有 runnable 配方');
  assert.ok(stats.runnable >= 1);
});

await test('C2 dslRecipeStats：抖音「服务履约」「商品供给」有可跑配方', () => {
  const stats = dsls.dslRecipeStats('douyin');
  assert.ok(stats.byDomain['服务履约'].runnable > 0, '抖音服务履约应当可跑');
  assert.ok(stats.byDomain['商品供给'].runnable > 0, '抖音商品供给应当可跑');
});

await test('C3 dslRecipeStats：拼多多「竞争洞察」依旧没有配方', () => {
  const stats = dsls.dslRecipeStats('pdd');
  assert.equal(stats.byDomain['竞争洞察'], undefined, '拼多多竞争洞察没有配方');
});

await test('D1 prepareJobForAccount 会先抓商品 ID 再把参数传给配方', () => {
  const src = fs.readFileSync(path.join(LIB, 'collect-support.mjs'), 'utf8');
  assert.ok(src.includes('fetchProductIds(account'), '要调用抓 ID');
  assert.ok(src.includes('params.productIdsLines'), '要填 productIdsLines');
  assert.ok(src.includes('PRODUCT_IDS_UNAVAILABLE'), '抓不到 ID 时要有明确错误码');
  assert.ok(src.includes('skipped.paramAuto'), '摘掉的配方要记录在 skipped');
});

await test('D2 界面：采集域是一排勾选项 + 「保存采集域」按钮（简洁样式）', () => {
  const src = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8');
  assert.ok(src.includes("h('input', { type: 'checkbox'"), '采集内容要能勾选');
  assert.ok(src.includes('保存采集域'), '缺保存按钮');
  assert.ok(src.includes('项配方'), '要标出每个域有几份配方');
  assert.ok(!src.includes('collOpen'), '不该再有详细配置弹窗');
  assert.ok(src.includes('collectionDomains'), '采集域勾选要读账号上的 collectionDomains');
});

await test('D3 /state 下发 productParams 能力位', () => {
  const src = fs.readFileSync(path.join(LIB, 'server', 'state.mjs'), 'utf8');
  assert.ok(src.includes('productParamHint'), 'state 要引入提示函数');
  assert.ok(src.includes('productParams:'), '要下发 productParams 字段');
});

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
await test('E1 版本号已到 0.20.41', () => {
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  const ok = major > 0 || minor > 20 || (minor === 20 && patch >= 41);
  assert.ok(ok, '版本应为 0.20.41 或更高，实际 ' + pkg.version);
});

await test('E2 CHANGELOG 写了这一条', () => {
  const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.ok(cl.includes('v0.20.41'), 'CHANGELOG 要有 v0.20.41');
  assert.ok(cl.includes('商品 ID') || cl.includes('商品ID'), '要写明商品 ID 自动补全');
});

await test('E3 README 自检清单里有这一套', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes('features-v02041.mjs'), 'README 自检块要列出这一套');
});

console.log('\n通过 ' + passed + ' / ' + (passed + failed));
if (failed) process.exit(1);
