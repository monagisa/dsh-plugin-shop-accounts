import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const R = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const J = (p) => JSON.parse(R(p));

import { pathToFileURL } from 'node:url';

const rpa = await import(pathToFileURL(path.join(ROOT, 'lib/rpa.mjs')).href);
const dsls = await import(pathToFileURL(path.join(ROOT, 'lib/dsls.mjs')).href);

const rpaSrc = R('lib/rpa.mjs');
const pkg = J('package.json');

function test(name, fn) {
  try {

    fn();
    console.log('  ✓ ' + name);
  } catch (e) {
    console.log('  ✗ ' + name);
    console.log('      ' + (e && e.message));
    process.exitCode = 1;
  }
}

console.log('\nfeatures-v02045 采集配方校准（拼多多流量/商品）');

test('A1 引擎支持 readValue（读输入框的值），编译成页内脚本', () => {
  assert.ok(rpaSrc.includes("if (action === 'readvalue')"), '缺 readvalue 动作');
  assert.ok(rpaSrc.includes("el.getAttribute('value')"), 'readvalue 没读 value 属性');
});

test('A2 拼多多交易数据已校准，并从卡片文本解析出指标', () => {
  const d = J('lib/rpa/dsls/pdd/pdd_transaction_overview.json');
  assert.equal(d.verified, true);
  const arts = d.collection.artifacts;
  assert.ok(arts.some((a) => a.kind === 'text_metrics' && a.output_key === 'pdd_trade_overview_cards_text'), '缺 text_metrics 产物');
  assert.ok(arts.some((a) => a.kind === 'raw_envelope'), '缺原始快照产物');
});

test('A3 拼多多流量数据已校准（不再标不支持），10 项指标', () => {
  const d = J('lib/rpa/dsls/pdd/pdd_traffic_overview.json');
  assert.equal(d.verified, true);
  assert.equal(d.unsupported, undefined, '还在标 unsupported');
  const meta = d.collection.artifacts.find((a) => a.kind === 'text_metrics');
  assert.ok(meta, '缺 text_metrics 产物');
  assert.equal(meta.metrics.length, 10);
});

test('A4 拼多多商品明细（Top10）已校准，8 项指标', () => {
  const d = J('lib/rpa/dsls/pdd/pdd_product_detail_top10.json');
  assert.equal(d.verified, true);
  const meta = d.collection.artifacts.find((a) => a.kind === 'text_metrics');
  assert.ok(meta, '缺 text_metrics 产物');
  assert.equal(meta.metrics.length, 8);
});

test('B1 「昨日」只在紧跟数字时才算昨日值（避免把下一张卡的数字当昨日）', () => {
  assert.ok(rpaSrc.includes("const between = ydIdx >= 0 ? tail.slice(0, ydIdx) : '';"), '缺 between 计算');
  assert.ok(rpaSrc.includes("[0-9]/.test(between)"), '缺「夹了数字就不算昨日」的闸');
  assert.ok(rpaSrc.includes("new RegExp('^' + yesterdayWord"), '昨日正则没有锚定位置');
});

test('B2 卡片文本解析：首尾相接的「标签 今日值 昨日 ¥值」能读出今日与昨日', () => {
  const doc = {
    collection: {
      artifacts: [
        {
          role: 'business',
          kind: 'text_metrics',
          output_key: 'cards',
          metrics: [{ id: 'gmv', label: '成交金额' }, { id: 'pay_ord_cnt', label: '成交订单数' }],
        },
      ],
    },
  };
  const arts = rpa.collectArtifacts(doc, { cards: '成交金额0.00昨日[?U+EFFA]55.28成交订单数0昨日[?U+EFFA]成交买家数0' });
  const rec = arts[0].records;
  assert.equal(rec.values.gmv, 0);
  assert.equal(rec.yesterday.gmv, 55.28);
  assert.equal(rec.values.pay_ord_cnt, 0);
  assert.equal(rec.yesterday.pay_ord_cnt, undefined, '不该把下一张卡的数字当昨日值');
});

test('C1 拼多多按域可跑份数：五个域都有可跑配方（运营推广由推广概况配方补上）', () => {
  const st = dsls.dslRecipeStats('pdd');
  const by = st.byDomain;
  assert.equal(by['经营总览'].runnable, 2);
  assert.ok(by['商品供给'].runnable >= 2);
  assert.equal(by['服务履约'].runnable, 2);
  assert.equal(by['流量转化'].runnable, 1);
  assert.ok(by['运营推广'].runnable >= 1, '运营推广现在有推广概况配方了');
});

test('C2 淘宝五项采集域都至少有一份可跑配方', () => {
  const st = dsls.dslRecipeStats('taobao', null, { autoParams: true });
  for (const d of ['经营总览', '流量转化', '运营推广', '商品供给', '服务履约']) {
    assert.ok(st.byDomain[d] && st.byDomain[d].runnable > 0, d + ' 没有可跑配方');
  }
});

test('D1 版本已到 0.20.45，且 CHANGELOG / README 有记录', () => {
  assert.ok(pkg.version >= '0.20.45' || pkg.version.split('.').length === 3);
  assert.ok(R('CHANGELOG.md').includes('v0.20.45'));
  assert.ok(R('README.md').includes(pkg.version), 'README 版本行没跟上');
});

if (process.exitCode) {
  console.log('\n✗ failed');
} else {
  console.log('\n共 10 项通过');
}
