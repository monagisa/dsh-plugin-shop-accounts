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

console.log('\nfeatures-v02048 抖音搜索流量概况配方（流量转化有配方了）');

test('A1 新增「搜索流量概况」配方：已校准、挂流量转化域、平台是抖音', () => {
  const d = J('lib/rpa/dsls/douyin/douyin_traffic_overview.json');
  assert.equal(d.id, 'douyin_traffic_overview');
  assert.equal(d.verified, true);
  assert.ok(d.domains.includes('流量转化'), '没挂到流量转化域');
  assert.equal(d.platform, 'douyin');
});

test('A2 打开的是「搜索-流量概况」页，不是首页壳', () => {
  const d = J('lib/rpa/dsls/douyin/douyin_traffic_overview.json');
  const gotos = d.template.steps.filter((s) => s.action === 'goto');
  assert.ok(
    gotos.some((s) => String(s.url).includes('/shop/search/traffic-analysis')),
    '没打开搜索流量概况页',
  );
  assert.ok(!gotos.some((s) => /^https:\/\/compass\.jinritemai\.com\/shop\/?$/.test(String(s.url))), '仍从首页壳进');
});

test('A3 读取搜索渠道指标，并把结果当 JSON 产物交出', () => {
  const d = J('lib/rpa/dsls/douyin/douyin_traffic_overview.json');
  const ev = d.template.steps.find((s) => s.action === 'evaluate');
  assert.ok(ev, '缺读取指标的一步');
  assert.equal(ev.outputKey, 'douyinTrafficOverview');
  assert.ok(ev.expression.includes('搜索用户支付金额'), '表达式里没有搜索成交金额');
  assert.ok(ev.expression.includes('搜索曝光人数'), '表达式里没有曝光人数');
  const arts = d.collection.artifacts;
  assert.ok(arts.some((a) => a.kind === 'json_string' && a.output_key === 'douyinTrafficOverview'), '缺 JSON 产物声明');
});

test('A4 能编译，且带产物', () => {
  const d = J('lib/rpa/dsls/douyin/douyin_traffic_overview.json');
  const c = rpa.compileExecution(d, { start: '2026-11-19', end: '2026-11-19' });
  assert.ok(c.ops.length >= 4, '编译出来的步骤太少');
  assert.ok(c.declaredArtifacts.some((a) => a.kind === 'json_string'), '编译后没有产物');
});

test('A5 页面文本进来后能解析成指标（搜索成交金额/曝光人数）', () => {
  const d = J('lib/rpa/dsls/douyin/douyin_traffic_overview.json');
  const payload = JSON.stringify({
    asOf: '2026-11-20',
    items: [
      { label: '搜索用户支付金额', today: '159.7', yesterday: '' },
      { label: '搜索结果曝光人数', today: '1200', yesterday: '' },
    ],
  });
  const arts = rpa.collectArtifacts(d, { douyinTrafficOverview: payload });
  const rec = arts.find((a) => a.records && a.records.values);
  assert.ok(rec, '没解析出指标');
  assert.equal(rec.records.values['搜索用户支付金额'], 159.7);
  assert.equal(rec.records.values['搜索结果曝光人数'], 1200);
});

test('A6 抖音流量转化域从「没有配方」变成「有可跑配方」', () => {
  const st = dsls.dslRecipeStats('douyin');
  assert.ok(st.byDomain['流量转化'], '缺流量转化域统计');
  assert.equal(st.byDomain['流量转化'].total, 1, '流量转化配方数量不对');
  assert.ok(st.byDomain['流量转化'].runnable >= 1, '流量转化仍没有可跑配方');
});

test('A7 其它平台的流量转化统计不受影响', () => {
  for (const p of ['taobao', 'pdd']) {
    const st = dsls.dslRecipeStats(p);
    assert.ok(st.byDomain['流量转化'].runnable >= 1, p + ' 流量转化不该被这次改动影响');
  }
});

test('B1 版本已到 0.20.48，且 CHANGELOG / README 有记录', () => {
  assert.ok(pkg.version >= '0.20.48');
  assert.ok(fs.readFileSync(R('CHANGELOG.md'), 'utf8').includes('v0.20.48'));
  assert.ok(fs.readFileSync(R('README.md'), 'utf8').includes(pkg.version));
});

if (failed) {
  console.log('\n✗ failed');
} else {
  console.log('\n通过 ' + (8 - failed) + ' 项');
}
