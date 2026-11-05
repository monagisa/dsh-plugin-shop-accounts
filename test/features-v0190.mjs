/**
 * v0.19.0 自检：买家账号的「公开商品监控」。
 *
 * 背买家账号不参与店铺定时采集（那边读的是商家后台报表），它的用途是采「公开商品页 / 竞品监控」：
 * 公开页面用买家账号、商家后台报表用卖家账号。这一版把这条链路的第一段做出来：
 * 加商品链接 → 按需采一轮公开商品页（价格 / 销量 / 评价数 / SKU / 主图）→ 本地落库 → 和上一轮比变化。
 * 覆盖淘宝 / 天猫 / 1688 / 京东的 PC 商品详情页；抖音 / 拼多多公开页要安卓 App，本版不做。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 数据目录指到临时目录：AppendSnapshot 那几项会写盘，不能碰真实数据。
const TMP = path.join(os.tmpdir(), 'dsh-monitor-test-' + process.pid);
process.env.DSH_SHOP_ACCOUNTS_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });

const M = await import(pathToFileURL(path.join(ROOT, 'lib/monitor.mjs')).href);
const X = await import(pathToFileURL(path.join(ROOT, 'lib/monitor-extract.mjs')).href);
const indexSrc = read('lib/index.js');
const clientSrc = read('lib/client.js');
const pkg = JSON.parse(read('package.json'));

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n    ' + (err && err.message));
  }
}

function versionAtLeast(actual, floor) {
  const a = String(actual).split('.').map(Number);
  const b = String(floor).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

function sliceOf(src, startMark, endMark) {
  const s = src.indexOf(startMark);
  assert.ok(s >= 0, '找不到片段起点：' + startMark.slice(0, 40));
  const e = src.indexOf(endMark, s);
  assert.ok(e > s, '找不到片段终点：' + endMark.slice(0, 40));
  return src.slice(s, e);
}
const slice = (startMark, endMark) => sliceOf(indexSrc, startMark, endMark);

const ACCOUNT = 'acc_test_buyer_1';
const URLS = {
  taobao: 'https://item.taobao.com/item.htm?id=123456789',
  tmall: 'https://detail.tmall.com/item.htm?spm=a1z10&id=987654321',
  ali1688: 'https://detail.1688.com/offer/612345678.html',
  jd: 'https://item.jd.com/100012043978.html',
};

// ── A. 数据层（lib/monitor.mjs）───────────────────────────────────────────────

test('A1 支持四个平台的商品链接，解析出 platform / productId 与干净 url', () => {
  for (const [platform, url] of Object.entries(URLS)) {
    const p = M.parseProductUrl(url);
    assert.equal(p.platform, platform, url + ' 的 platform 认错了：' + p.platform);
    assert.ok(/^\d{4,20}$/.test(p.productId), url + ' 的 productId 不干净：' + p.productId);
    assert.ok(p.url.indexOf('http') === 0, url + ' 没回一个可采的 url');
  }
  assert.deepEqual(M.parseProductUrl(URLS.taobao).productId, '123456789');
});

test('A2 站根 / 缺 id / 不支持的平台（douyin）→ 抛中文错误', () => {
  const bad = ['https://www.taobao.com/', 'https://item.taobao.com/item.htm?spm=1', 'https://www.douyin.com/jingxuan'];
  for (const url of bad) {
    assert.throws(() => M.parseProductUrl(url), (err) => {
      assert.ok(err instanceof Error);
      assert.ok(/商品|id|平台/.test(err.message), url + ' 的错误不够具体：' + err.message);
      return true;
    });
  }
});

test('A3 账号平台决定能抓哪些平台的商品页（登录态在哪个域名下）', () => {
  assert.deepEqual(M.monitorPlatformsForAccount('taobao'), ['taobao', 'tmall']);
  assert.deepEqual(M.monitorPlatformsForAccount('tmall'), ['taobao', 'tmall']);
  assert.deepEqual(M.monitorPlatformsForAccount('ali1688'), ['ali1688']);
  assert.deepEqual(M.monitorPlatformsForAccount('jd'), ['jd']);
  assert.deepEqual(M.monitorPlatformsForAccount('douyin'), []);
  assert.deepEqual(M.monitorPlatformsForAccount('pdd'), []);
  assert.equal(M.monitorPlatformSupported('taobao'), true);
  assert.equal(M.monitorPlatformSupported('douyin'), false);
  assert.equal(M.MONITOR_PLATFORM_LABELS.ali1688, '1688');
});

test('A4 计数 / 价格区间 / 主图身份的小工具', () => {
  assert.equal(M.parseCountText('1.2万'), 12000);
  assert.equal(M.parseCountText('2,345'), 2345);
  assert.equal(M.parseCountText('8+'), 8);
  assert.equal(M.parseCountText('没有'), null);
  assert.deepEqual(M.parsePriceRange('¥9.9-19.9'), { min: 9.9, max: 19.9 });
  assert.deepEqual(M.parsePriceRange('￥128.50'), { min: 128.5, max: 128.5 });
  assert.equal(M.imageKey('https://img.alicdn.com/imgextra/i1/a_800x800.jpg'), 'img.alicdn.com/imgextra/i1/a.jpg');
});

test('A5 normalizeSnapshot 与上一轮快照能比出「降价 / 涨销量 / 加 SKU / 换主图」', () => {
  const raw = {
    platform: 'taobao', title: '短袖T恤', price: 128.5, priceRange: { min: 99.9, max: 199.8 },
    priceText: '¥ 129.00', priceSlots: ['¥ 129.00'], sales: 12000, salesText: '已售 1.2万+',
    reviewTotal: 3456, reviewText: '用户评价·3456', skuLabels: ['红色', 'S', 'XL'], skuStatus: 'partial',
    images: [{ url: 'https://img.alicdn.com/imgextra/i1/a_800x800.jpg', width: 800 }],
    fieldStatus: { price: 'captured', sales: 'captured', reviews: 'captured', sku: 'partial', images: 'captured' },
    cues: { login: false, blocked: false },
  };
  const at = '2026-11-05T10:00:00.000Z';
  const snap = M.normalizeSnapshot(raw, { at, platform: 'taobao', productId: '123456789', url: URLS.taobao, finalUrl: URLS.taobao });
  assert.equal(snap.at, at);
  assert.equal(snap.price, 128.5);
  assert.equal(snap.priceRange.min, 99.9);
  assert.equal(snap.priceRange.max, 199.8);
  assert.equal(snap.sales, 12000);
  assert.equal(snap.reviewTotal, 3456);
  assert.equal(snap.skuLabels.length, 3);
  assert.equal(snap.images[0].key, 'img.alicdn.com/imgextra/i1/a.jpg');
  assert.equal(snap.fieldStatus.price, 'captured');

  const next = JSON.parse(JSON.stringify(snap));
  next.at = '2026-11-06T10:00:00.000Z';
  next.price = 99.9;
  next.priceRange = { min: 99.9, max: 99.9 };
  next.sales = 15000;
  next.skuLabels.push('L');
  next.images = [snap.images[0], { url: 'https://img.alicdn.com/imgextra/i3/c_1000x1000.jpg', key: M.imageKey('https://img.alicdn.com/imgextra/i3/c_1000x1000.jpg') }];
  const d = M.diffSnapshots(snap, next);
  assert.equal(d.price.from.min, 99.9, '上一次的最低价没进 diff');
  assert.equal(d.price.to.min, 99.9, '这一次的最低价没进 diff');
  assert.equal(d.sales.delta, 3000);
  assert.deepEqual(d.sku.added, ['L']);
  assert.equal(d.images.added, 1, '换了主图但没算出来');
  assert.equal(d.images.removed, 0, '上一轮只有一张主图，不该算「移除」');
  assert.ok(!M.diffSnapshots(snap, snap).price, '没变化却比出了变化');
});

test('A6 同一商品重复加不重复建条目；快照只写成功的轮次；移除会连历史一起删', () => {
  const first = M.addMonitorTarget(ACCOUNT, URLS.taobao);
  assert.equal(first.existing, false);
  const again = M.addMonitorTarget(ACCOUNT, URLS.taobao + '&spm=other');
  assert.equal(again.existing, true);
  assert.equal(again.target.id, first.target.id, '同一个商品建了两条');
  const other = M.addMonitorTarget(ACCOUNT, URLS.jd);
  assert.equal(other.target.platform, 'jd');
  assert.equal(M.readTargets(ACCOUNT).targets.length, 2);

  const okSnap = M.normalizeSnapshot({ platform: 'taobao', price: 128.5, priceRange: { min: 128.5, max: 128.5 }, sales: 12000 }, {
    at: '2026-11-05T10:00:00.000Z', platform: 'taobao', productId: '123456789', url: URLS.taobao,
  });
  okSnap.ok = true;
  M.appendSnapshot(ACCOUNT, first.target.id, okSnap);
  M.appendSnapshot(ACCOUNT, first.target.id, { at: '2026-11-05T11:00:00.000Z', ok: false, status: 'blocked', error: '验证码' });
  const snaps = M.readSnapshots(ACCOUNT, first.target.id, 10);
  assert.equal(snaps.length, 1, '失败的轮次不该写进历史');
  assert.equal(M.findTarget(ACCOUNT, first.target.id).lastStatus, 'blocked', '失败原因没写回条目');
  const view = M.summarizeTarget(ACCOUNT, M.findTarget(ACCOUNT, first.target.id));
  assert.equal(view.rounds, 1);
  assert.ok(view.latest && view.latest.price === 128.5);

  assert.equal(M.removeMonitorTarget(ACCOUNT, first.target.id), true);
  assert.equal(M.readTargets(ACCOUNT).targets.length, 1);
  assert.equal(M.readSnapshots(ACCOUNT, first.target.id, 10).length, 0, '删条目时历史没删');
});

// ── B. 提取层（lib/monitor-extract.mjs）───────────────────────────────────────

const el = (t) => ({ innerText: t, textContent: t });

function fakePage(opts) {
  const o = opts || {};
  const priceNodes = (o.priceTexts || ['¥ 129.00', '￥99.9 - 199.8', '已售 1.2万+']).map(el);
  const skuNodes = (o.skuTexts || ['红色', 'S', 'XL', '¥128.5']).map(el);
  const ldNodes = o.ld === false ? [] : [{
    textContent: JSON.stringify({
      '@type': 'Product', name: o.name || '夏季短袖 T 恤',
      offers: o.offers === false ? undefined : { price: '128.50', lowPrice: '99.90', highPrice: '199.80', priceCurrency: 'CNY' },
    }),
  }];
  const doc = {
    title: o.title || '短袖T恤-淘宝网',
    body: { innerText: o.bodyText || '红色 S XL 用户评价·3456 条评价 累计评价 1.2万+', getElementsByTagName: () => new Array(500) },
    querySelectorAll(sel) {
      if (/price|Price|sold|sales/.test(sel)) return priceNodes;
      if (/sku|spec|property/i.test(sel)) return skuNodes;
      if (/ld\+json/.test(sel)) return ldNodes;
      return [];
    },
    images: o.images === false ? [] : [
      { src: 'https://img.alicdn.com/imgextra/i1/a_800x800.jpg', naturalWidth: 800, naturalHeight: 800 },
      { src: 'https://img.alicdn.com/imgextra/i1/a_60x60.jpg', naturalWidth: 60, naturalHeight: 60 },
      { src: 'https://img.alicdn.com/imgextra/i2/b_1000x1000.jpg', naturalWidth: 1000, naturalHeight: 1000 },
    ],
  };
  return { doc, location: { href: o.href || URLS.taobao }, window: {} };
}

test('B1 表达式能直接编译执行（页面里跑的就是这一段）', () => {
  for (const platform of M.MONITOR_PLATFORMS) {
    const expr = X.buildMonitorExpression(platform);
    assert.equal(typeof expr, 'string');
    assert.ok(expr.includes('__monCollect') && expr.includes('__monParse'), platform + ' 的表达式缺函数');
    assert.ok(expr.includes(JSON.stringify(platform)), platform + ' 的表达式没带平台');
    assert.equal(typeof X.monitorExtractFn(platform), 'function');
  }
});

test('B2 假淘宝商品页：价格优先 JSON-LD、销量从「已售」、SKU 去重、主图按面积排序', () => {
  const raw = X.monitorExtractFn('taobao')(fakePage().doc, fakePage().location, {});
  assert.equal(raw.platform, 'taobao');
  assert.equal(raw.price, 128.5, '价格没优先用 JSON-LD 的当前价');
  assert.deepEqual(raw.priceRange, { min: 99.9, max: 199.8 });
  assert.equal(raw.sales, 12000, '「已售 1.2万+」没解析出来');
  assert.equal(raw.reviewTotal, 3456, '「用户评价·3456」没解析出来');
  assert.deepEqual(raw.skuLabels, ['红色', 'S', 'XL'], 'SKU 没去重或把价格混进去了');
  assert.equal(raw.skuStatus, 'partial');
  assert.ok(raw.images.length >= 2, '主图没抓到');
  assert.equal(raw.images[0].width, 1000, '主图没按面积从大到小排');
  assert.equal(raw.fieldStatus.price, 'captured');
  assert.ok(raw.cues.login === false || raw.cues.login === true);
});

test('B3 撞验证码 / 登录墙：抓不到就标失败，不当成「0 元」', () => {
  const page = fakePage({ ld: false, offers: false, images: false, priceTexts: ['请先登录后查看价格'], bodyText: '安全验证 访问受限 请先登录' });
  const raw = X.monitorExtractFn('taobao')(page.doc, page.location, {});
  assert.equal(raw.cues.blocked, true);
  assert.equal(raw.cues.login, true);
  assert.equal(raw.price, null, '没抓到价格却给了个价');
  assert.equal(raw.sales, null);
});

// ── C. 服务端路由（源码切片）──────────────────────────────────────────────────

test('C1 只有买家账号能用公开商品监控', () => {
  const seg = slice('const mMonitorRoot = p.match(', 'if (mAction) {');
  assert.ok(seg.includes('MONITOR_BUYER_ONLY'), '没有「仅买家」错误码');
  assert.ok(seg.includes('if (!isBuyerAccount(account))'), '没按身份拦卖家账号');
  assert.ok(seg.includes('公开商品监控用买家账号'), '错误文案没解释清楚');
});

test('C2 商品链接要跟账号平台对得上（抖音买家不能抓淘宝链接）', () => {
  const seg = slice('const mMonitorRoot = p.match(', 'if (mAction) {');
  assert.ok(seg.includes('parseProductUrl'), '没解析商品链接');
  assert.ok(seg.includes('monitorPlatformsForAccount(account.platform)'), '没按账号平台限制');
  assert.ok(seg.includes('MONITOR_URL_PLATFORM_MISMATCH'), '平台不匹配时没拦');
  assert.ok(seg.includes('MONITOR_BAD_URL'), '链接不合法时没单独的码');
});

test('C3 采一轮：串行锁 + ego 快照 + 失败也记一轮 + 撞验证码作废', () => {
  const seg = slice('const mMonitorRoot = p.match(', 'if (mAction) {');
  assert.ok(seg.includes('acquireAccountLock(account.id)'), '没串行锁');
  assert.ok(seg.includes('ensureEgoProfile(account, { launch: false })'), '没准备 ego 配置');
  assert.ok(seg.includes('egoSnapshot({'), '没走 ego 快照 op');
  assert.ok(seg.includes('buildMonitorExpression(target.platform)'), '没用提取表达式');
  assert.ok(seg.includes("code: 'MONITOR_NEEDS_EGO'"), '没有「要 ego lite 后端」的提示');
  assert.ok(seg.includes("'MONITOR_BLOCKED'") && seg.includes("'MONITOR_EMPTY'"), '风控 / 空数据没有单独的码');
  assert.ok(seg.includes('appendSnapshot('), '没写落下快照');
  assert.match(seg, /ok: false, status:.*appendSnapshot|appendSnapshot\([\s\S]{0,200}ok: false/, '失败那轮没记录');
  assert.ok(seg.includes("appendDebug('monitor-run'"), '没写调试日志');
});

test('C4 有「历史快照」只读接口与移除接口', () => {
  const seg = slice('const mMonitorRoot = p.match(', 'if (mAction) {');
  assert.ok(seg.includes('readSnapshots(account.id, target.id, limit)'), '没有读历史快照');
  assert.ok(seg.includes('removeMonitorTarget(account.id, target.id)'), '没有移除');
  assert.ok(/limit\s*>\s*200/.test(seg) || seg.includes('Math.min'), 'limit 没上限');
});

// ── D. 界面 / 文档 ───────────────────────────────────────────────────────────

test('D1 买家账号的详情页渲染「公开商品监控」，卖家仍是「数据采集」', () => {
  assert.ok(clientSrc.includes("isBuyer ? renderMonitor() : h('div', { className: 'sa-dsec' },"), '详情页没按身份切卡片');
  assert.ok(clientSrc.includes('function renderMonitor()'), '没有 renderMonitor');
  assert.ok(clientSrc.includes("'公开商品监控'"), '卡片标题不对');
  assert.ok(clientSrc.includes('手动触发，不进定时任务'), '没说明不进定时任务');
  assert.ok(clientSrc.includes("'加入监控'") && clientSrc.includes("'采一轮'"), '缺少加链接 / 采一轮按钮');
  assert.ok(clientSrc.includes('function fmtPriceRange('), '没有价格区间格式化');
});

test('D2 买家账号可以「采一轮」并显示与上一轮的变化', () => {
  assert.ok(clientSrc.includes('function monitorDiffChips('), '没有变化 chips');
  assert.ok(clientSrc.includes('d.price') && clientSrc.includes('d.sku') && clientSrc.includes('d.images'), '变化没覆盖价格 / SKU / 主图');
  assert.ok(clientSrc.includes("/monitor/' + encodeURIComponent(t.id) + '/run'"), '没有「采一轮」请求');
  assert.ok(clientSrc.includes("method: 'DELETE'"), '没有移除请求');
});

// ── E. 版本与文档 ─────────────────────────────────────────────────────────────

test('E1 版本号已到 0.19.0', () => {
  assert.ok(versionAtLeast(pkg.version, '0.19.0'), '版本还停在 ' + pkg.version);
});

test('E2 CHANGELOG / README 写了公开商品监控', () => {
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.includes('v0.19.0'), 'CHANGELOG 没写 v0.19.0');
  assert.ok(changelog.includes('公开商品监控'), 'CHANGELOG 没提公开商品监控');
  const readme = read('README.md');
  assert.ok(readme.includes(pkg.version), 'README 没跟上 ' + pkg.version);
  assert.ok(readme.includes('公开商品监控'), 'README 没写公开商品监控');
});

console.log('');
fs.rmSync(TMP, { recursive: true, force: true });
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败`);
  for (const f of failures) console.log('  - ' + f.name + ': ' + (f.err && f.err.message));
  process.exit(1);
}
console.log(`✓ 全部通过（${passed} 项）`);
