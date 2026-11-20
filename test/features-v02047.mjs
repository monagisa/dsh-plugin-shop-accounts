import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const J = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const R = (rel) => path.join(ROOT, rel);

const rpa = await import(pathToFileURL(R('lib/rpa.mjs')).href);
const dsls = await import(pathToFileURL(R('lib/dsls.mjs')).href);
const pkg = J('package.json');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (e) {
    failed += 1;
    console.log('  ✗ ' + name);
    console.log('      ' + (e && e.message));
    process.exitCode = 1;
  }
}

console.log('\nfeatures-v02047 拼多多推广概况配方（运营推广有可跑配方了）');

test('A1 新增「推广概况」配方：已校准、挂在运营推广域', () => {
  const d = J('lib/rpa/dsls/pdd/pdd_ads_overview.json');
  assert.equal(d.id, 'pdd_ads_overview');
  assert.equal(d.verified, true);
  assert.ok(Array.isArray(d.domains) && d.domains.includes('运营推广'), '没挂到运营推广域');
  assert.equal(d.platform, 'pdd');
});

test('A2 配方读的是推广概况页，且把指标当 JSON 产物交出', () => {
  const d = J('lib/rpa/dsls/pdd/pdd_ads_overview.json');
  const gotos = d.template.steps.filter((s) => s.action === 'goto');
  assert.ok(gotos.some((s) => String(s.url).includes('yingxiao.pinduoduo.com/mains/promotionOverview')), '没打开推广概况页');
  const ev = d.template.steps.find((s) => s.action === 'evaluate');
  assert.ok(ev, '缺读取指标的一步');
  assert.equal(ev.outputKey, 'pddAdsOverview');
  assert.ok(ev.expression.includes('推广花费'), '表达式里没有指标名');
  const arts = d.collection.artifacts;
  assert.ok(arts.some((a) => a.kind === 'json_string' && a.output_key === 'pddAdsOverview'), '缺 JSON 产物声明');
});

test('A3 能编译，且带产物', () => {
  const d = J('lib/rpa/dsls/pdd/pdd_ads_overview.json');
  const c = rpa.compileExecution(d, { start: '2026-11-19', end: '2026-11-19' });
  assert.ok(c.ops.length >= 4, '编译出来的步骤太少');
  assert.ok(c.declaredArtifacts.some((a) => a.kind === 'json_string'), '编译后没有产物');
});

test('A4 页面文本进来后能解析成指标（推广花费/余额/推广中商品数）', () => {
  const d = J('lib/rpa/dsls/pdd/pdd_ads_overview.json');
  const payload = JSON.stringify({
    asOf: '2026-11-20',
    items: [
      { label: '推广花费', today: '1.56', yesterday: '' },
      { label: '推广余额', today: '29.82', yesterday: '' },
      { label: '推广中商品数', today: '27', yesterday: '' },
    ],
  });
  const arts = rpa.collectArtifacts(d, { pddAdsOverview: payload });
  const rec = arts.find((a) => a.records && a.records.values);
  assert.ok(rec, '没解析出指标');
  assert.equal(rec.records.values['推广花费'], 1.56);
  assert.equal(rec.records.values['推广中商品数'], 27);
});

test('A5 拼多多运营推广域从「没有可跑配方」变成「有」', () => {
  const st = dsls.dslRecipeStats('pdd');
  assert.ok(st.byDomain['运营推广'], '缺运营推广域统计');
  assert.ok(st.byDomain['运营推广'].runnable >= 1, '运营推广仍然没有可跑配方（实际 ' + st.byDomain['运营推广'].runnable + '）');
});

test('A6 淘宝与抖音的运营推广统计不受影响', () => {
  const tb = dsls.dslRecipeStats('taobao');
  assert.ok(tb.byDomain['运营推广'].runnable >= 1, '淘宝运营推广不该变化');
  const dy = dsls.dslRecipeStats('douyin');
  assert.ok(dy.byDomain['运营推广'].total >= 1, '抖音运营推广配方还在，只是没有千川账户');
});

test('B1 版本已到 0.20.47，且 CHANGELOG / README 有记录', () => {
  assert.ok(pkg.version >= '0.20.47');
  assert.ok(fs.readFileSync(R('CHANGELOG.md'), 'utf8').includes('v0.20.47'));
  assert.ok(fs.readFileSync(R('README.md'), 'utf8').includes(pkg.version));
});

if (failed) {
  console.log('\n✗ failed');
} else {
  console.log('\n通过 ' + (8 - failed) + ' 项');
}
