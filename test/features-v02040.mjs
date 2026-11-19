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

const jsonMetrics = await import(pathToFileURL(path.join(LIB, 'json-metrics.mjs')).href);
const rpa = await import(pathToFileURL(path.join(LIB, 'rpa.mjs')).href);
const dslDir = path.join(LIB, 'rpa', 'dsls', 'pdd');

await test('A1 parseLabeledPairs：items 形式取今日与昨日', () => {
  const r = jsonMetrics.parseLabeledPairs({
    asOf: '2026-11-19',
    items: [
      { label: '商品访客数', today: '12', yesterday: '27' },
      { label: '成交金额', today: '155.28', yesterday: '0.0' },
    ],
  });
  assert.ok(r, '应当解析成功');
  assert.equal(r.values['商品访客数'], 12);
  assert.equal(r.values['成交金额'], 155.28);
  assert.equal(r.yesterday['商品访客数'], 27);
  assert.equal(r.asOf, '2026-11-19');
});

await test('A2 parseLabeledPairs：百分号 / 千分位 / -- 都能处理', () => {
  const r = jsonMetrics.parseLabeledPairs({
    items: [
      { label: '成交转化率', today: '9.09%', yesterday: '0.00%' },
      { label: '金额', today: '1,234.5', yesterday: '--' },
      { label: '空值', today: '', yesterday: '' },
    ],
  });
  assert.equal(r.values['成交转化率'], 9.09);
  assert.equal(r.values['金额'], 1234.5);
  assert.ok(!('空值' in r.values), '空值不应进指标');
  assert.ok(!('金额' in r.yesterday), '-- 不应进昨日值');
});

await test('A3 parseLabeledPairs：平铺对象与数组也能解析', () => {
  assert.equal(jsonMetrics.parseLabeledPairs({ 访客数: '8', 浏览量: 12 }).values['浏览量'], 12);
  const arr = jsonMetrics.parseLabeledPairs([{ label: '访客数', today: '8' }]);
  assert.equal(arr.values['访客数'], 8);
});

await test('A4 parseLabeledPairs：不是指标结构时返回 null', () => {
  assert.equal(jsonMetrics.parseLabeledPairs('not json'), null);
  assert.equal(jsonMetrics.parseLabeledPairs({ items: [] }), null);
});

await test('B1 json_string 解析在生意参谋失败后回退到通用指标对', async () => {
  const src = fs.readFileSync(path.join(LIB, 'rpa.mjs'), 'utf8');
  assert.ok(src.includes('parseSycmMetrics(value) || parseLabeledPairs(value)'), '两条解析要串起来');
  assert.ok(src.includes("import { parseSycmMetrics, parseLabeledPairs }"), '两个解析都要导入');
});

await test('B2 拼多多商品概览配方：已校准 + json_string 产物 + 读卡片脚本', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(dslDir, 'pdd_product_overview.json'), 'utf8'));
  assert.equal(doc.verified, true);
  assert.equal(doc.collection.artifacts.length, 1);
  assert.equal(doc.collection.artifacts[0].kind, 'json_string');
  assert.equal(doc.collection.artifacts[0].output_key, 'pddOverview');
  const evalStep = doc.steps.find((s) => s.action === 'evaluate');
  assert.ok(evalStep, '要有读取卡片的 evaluate 步骤');
  assert.ok(String(evalStep.expression).includes('card_cardItem'), '读的是当前页面的卡片类名');
  assert.ok(String(evalStep.expression).includes('昨日'), '要同时取昨日值');
  const gotoStep = doc.steps.find((s) => s.action === 'goto');
  assert.ok(gotoStep && String(gotoStep.url).includes('mms.pinduoduo.com/sycm/goods_effect'), '要打开商品数据页');
});

await test('B3 编译：配方能编译出 evaluate 与产物声明', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(dslDir, 'pdd_product_overview.json'), 'utf8'));
  const compiled = rpa.compileExecution(doc, { start: '2026-10-20', end: '2026-11-18' });
  assert.ok(compiled.ops.some((o) => o.op === 'eval'), '应当有 eval 步骤');
  assert.ok(compiled.ops.some((o) => o.op === 'goto' && String(o.url).includes('goods_effect'), '应当先打开页面'));
  assert.equal(compiled.declaredArtifacts.length, 1);
});

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
await test('C1 版本号已到 0.20.40', () => {
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  const ok = major > 0 || minor > 20 || (minor === 20 && patch >= 40);
  assert.ok(ok, '版本应为 0.20.40 或更高，实际 ' + pkg.version);
});

await test('C2 CHANGELOG 写了这一条', () => {
  const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.ok(cl.includes('v0.20.40'), 'CHANGELOG 要有 v0.20.40');
  assert.ok(cl.includes('pdd_product_overview') || cl.includes('商品概况'), '要写明拼多多商品概览');
});

console.log('\n通过 ' + passed + ' / ' + (passed + failed));
if (failed) process.exit(1);
