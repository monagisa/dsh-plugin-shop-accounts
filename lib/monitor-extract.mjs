/**
 * 公开商品监控（v0.19.0）—— 页面提取。
 *
 * 一段在浏览器里执行的表达式：先采集原始线索（标题 / 正文 / 价格候选 / SKU 文案 / JSON-LD / 主图），
 * 再解析成快照字段。分两步是为了同一段代码能被「真实页面」和自检里的假 DOM 复用。
 *
 * 解析口径照公开商品页的通用惯例：价格 / 销量 / 评价 / SKU / 主图 各记 fieldStatus，
 * 抓不到就标 not_exposed，不编数字；页面丢登录态或撞验证码时给 cues，由上层把这一轮判失败。
 */

/** 各平台的价格 / SKU / 主图线索落点（只做提示，解析本身有通用兜底）。 */
export const MONITOR_HINTS = {
  taobao: { priceSelectors: ['[class*="highlightPrice"]', '[class*="Price--"]', '[class*="priceText"]'], skuSelectors: ['[class*="skuItem"]', '[class*="Sku"] li'] },
  tmall: { priceSelectors: ['[class*="highlightPrice"]', '[class*="Price--"]', '[class*="priceText"]'], skuSelectors: ['[class*="skuItem"]', '[class*="Sku"] li'] },
  ali1688: { priceSelectors: ['[class*="price-component"]', '[class*="od-main-price"]', '[class*="price-item"]'], skuSelectors: ['[class*="sku-item"]', '[class*="sku"] li'] },
  jd: { priceSelectors: ['[class*="product-price"]', '[class*="price"]'], skuSelectors: ['[class*="spec"] li', '[class*="sku"] li'] },
};

const SEED_FN = String.raw`
function __monText(el) {
  if (!el) return '';
  var t = el.innerText;
  if (t === undefined || t === null) t = el.textContent;
  return String(t || '').replace(/[\s\u3000]+/g, ' ').trim();
}
function __monCollect() {
  var doc = document;
  var bodyText = '';
  try {
    bodyText = __monText(doc.body).slice(0, 20000);
  } catch (e) { bodyText = ''; }
  var out = {
    url: String((location && location.href) || ''),
    title: String((doc && doc.title) || ''),
    text: bodyText,
    priceTexts: [],
    skuTexts: [],
    jsonld: [],
    images: [],
    marks: { login: /(请登录|登录后查看|亲，请登录|请先登录)/.test(bodyText), blocked: /(安全验证|验证码|访问受限|异常流量|访问频繁|稍后再试)/.test(bodyText) },
  };
  var selectors = [
    '[class*="price" i]', '[class*="Price"]', '[data-price]', '[class*="sold"]', '[class*="sales"]',
    '[class*="sku" i] li', '[class*="Sku"] li', '[class*="spec" i] li', '[class*="skuItem"]', '[class*="property"] li',
  ];
  for (var s = 0; s < selectors.length; s++) {
    var nodes = [];
    try { nodes = doc.querySelectorAll(selectors[s]); } catch (e) { nodes = []; }
    var limit = Math.min(nodes.length, 40);
    for (var i = 0; i < limit; i++) {
      var t = __monText(nodes[i]);
      if (!t || t.length > 60) continue;
      if (/price|Price|data-price/.test(selectors[s]) || /sold|sales/.test(selectors[s])) {
        if (out.priceTexts.length < 20) out.priceTexts.push(t);
      } else if (out.skuTexts.length < 60) {
        if (!/[0-9]{2,}/.test(t) || t.length <= 20) out.skuTexts.push(t);
      }
    }
  }
  try {
    var scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (var j = 0; j < Math.min(scripts.length, 4); j++) {
      var raw = String(scripts[j].textContent || '').trim();
      if (raw) out.jsonld.push(raw.slice(0, 4000));
    }
  } catch (e) { /* 没有就没 */ }
  try {
    var imgs = doc.images || [];
    for (var k = 0; k < Math.min(imgs.length, 40); k++) {
      var im = imgs[k];
      var w = Number(im.naturalWidth || im.width || 0);
      var h = Number(im.naturalHeight || im.height || 0);
      if (w >= 200 && h >= 200 && out.images.length < 20) {
        var src = String(im.currentSrc || im.src || '');
        if (!src) { try { src = String(im.getAttribute('data-src') || im.getAttribute('data-lazy-src') || im.getAttribute('data-lazyload') || ''); } catch (e2) { src = ''; } }
        if (src) out.images.push({ url: src, width: w, height: h });
      }
    }
  } catch (e) { /* 没有就没 */ }
  try { out.nodeCount = doc.body ? doc.body.getElementsByTagName('*').length : 0; } catch (e) { out.nodeCount = 0; }
  return out;
}
`;

const PARSE_FN = String.raw`
function __monNum(v) {
  if (typeof v === 'number') return isFinite(v) && v > 0 ? v : null;
  var s = String(v == null ? '' : v).replace(/[,，\s]/g, '');
  var m = /^([0-9]+(?:\.[0-9]+)?)$/.exec(s);
  if (!m) return null;
  var n = Number(m[1]);
  return isFinite(n) && n > 0 ? n : null;
}
function __monCount(v) {
  var s = String(v == null ? '' : v).replace(/[,，\s]/g, '');
  var m = /^([0-9]+(?:\.[0-9]+)?)(万|w|W)?(\+)?$/.exec(s);
  if (!m) return null;
  var n = Number(m[1]);
  if (!isFinite(n)) return null;
  return Math.round(m[2] ? n * 10000 : n);
}
function __monJson(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function __monParse(seed, platform) {
  var text = String((seed && seed.text) || '');
  var res = {
    platform: platform,
    url: String((seed && seed.url) || ''),
    title: String((seed && seed.title) || ''),
    price: null, priceText: '', priceRange: null, priceSlots: [],
    sales: null, salesText: '', reviewTotal: null, reviewText: '',
    skuLabels: [], skuStatus: 'not_exposed', images: [],
    fieldStatus: {}, cues: { login: false, blocked: false },
  };
  var cues = (seed && seed.marks) || {};
  res.cues = { login: !!cues.login, blocked: !!cues.blocked };
  var priceTexts = (seed && seed.priceTexts) || [];
  var skuTexts = (seed && seed.skuTexts) || [];
  // 销量/评价常常挂在价格旁边的「已售」「评价数」小标签上，正文里反而没有 → 一起扫
  var scanText = text + ' ' + priceTexts.join(' ');
  // 1) 结构化数据优先：JSON-LD 的 Product.offers 最准
  var blocks = (seed && seed.jsonld) || [];
  var ldPrice = null, ldLow = null, ldHigh = null, ldTitle = '';
  for (var b = 0; b < blocks.length; b++) {
    var obj = __monJson(blocks[b]);
    if (!obj) continue;
    var list = Array.isArray(obj) ? obj : [obj];
    for (var q = 0; q < list.length; q++) {
      var prod = list[q];
      if (!prod || typeof prod !== 'object') continue;
      if (!ldTitle && typeof prod.name === 'string') ldTitle = prod.name;
      var offers = prod.offers;
      if (Array.isArray(offers)) offers = offers[0];
      if (!offers || typeof offers !== 'object') continue;
      if (ldPrice == null) ldPrice = __monNum(offers.price);
      if (ldLow == null) ldLow = __monNum(offers.lowPrice);
      if (ldHigh == null) ldHigh = __monNum(offers.highPrice);
    }
  }
  // 2) 价格：JSON-LD 的当前价 → DOM 价格候选（去重、排掉「已售 / 评价 / 月销」这类数字）
  var range = null;
  if (ldLow != null) range = { min: ldLow, max: ldHigh != null && ldHigh >= ldLow ? ldHigh : ldLow };
  else if (ldPrice != null) range = { min: ldPrice, max: ldPrice };
  var seenPriceText = {};
  var domRange = null;
  for (var p = 0; p < priceTexts.length; p++) {
    var pt = String(priceTexts[p] || '').trim();
    if (!pt || seenPriceText[pt]) continue;
    if (!/(¥|￥|价格|price|RMB)/i.test(pt)) continue;
    if (/(已售|月销|销量|成交|评价|付款|件已抢|人付款)/.test(pt)) continue;
    seenPriceText[pt] = 1;
    var mRange = /([0-9]+(?:\.[0-9]+)?)\s*(?:-|~|—|至)\s*([0-9]+(?:\.[0-9]+)?)/.exec(pt);
    if (mRange) {
      var a = Number(mRange[1]), c = Number(mRange[2]);
      if (isFinite(a) && isFinite(c) && a > 0 && c > 0) {
        var r2 = { min: Math.min(a, c), max: Math.max(a, c) };
        if (!range) range = r2;
        if (!domRange) domRange = r2;
        res.priceSlots.push({ label: '', text: pt.slice(0, 60), price: r2.min });
        continue;
      }
    }
    var one = /([0-9]+(?:\.[0-9]+)?)/.exec(pt);
    if (!one) continue;
    var n = Number(one[1]);
    if (!isFinite(n) || n <= 0) continue;
    if (!range) range = { min: n, max: n };
    if (!domRange) domRange = { min: n, max: n };
    if (res.priceSlots.length < 6) res.priceSlots.push({ label: '', text: pt.slice(0, 60), price: n });
  }
  if (range) {
    res.priceRange = range;
    // 当前价优先 JSON-LD 的 offers.price（它和 lowPrice/highPrice 的区间语义分开）
    res.price = ldPrice != null ? ldPrice : range.min;
    var bestSlot = null;
    for (var ps = 0; ps < res.priceSlots.length; ps++) {
      if (res.priceSlots[ps].price === res.price) { bestSlot = res.priceSlots[ps]; break; }
    }
    res.priceText = String(bestSlot ? bestSlot.text : (priceTexts[0] || ('¥' + res.price))).slice(0, 120);
    res.fieldStatus.price = 'captured';
  } else {
    res.fieldStatus.price = res.cues.login ? 'failed' : 'not_exposed';
  }
  // 3) 销量
  var salesRe = [
    /已售\s*([0-9]+(?:\.[0-9]+)?\s*万?\+?)/, /月销\s*([0-9]+(?:\.[0-9]+)?\s*万?\+?)/,
    /销量\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?\s*万?\+?)/, /成交\s*([0-9]+(?:\.[0-9]+)?\s*万?\+?)/,
    /([0-9]+(?:\.[0-9]+)?\s*万?)\+?\s*人付款/,
  ];
  for (var s = 0; s < salesRe.length; s++) {
    var ms = salesRe[s].exec(scanText);
    if (!ms) continue;
    var sv = __monCount(ms[1]);
    if (sv == null) continue;
    res.sales = sv;
    res.salesText = String(ms[0]).slice(0, 80);
    break;
  }
  res.fieldStatus.sales = res.sales != null ? 'captured' : (res.cues.login ? 'failed' : 'not_exposed');
  // 4) 评价总数
  var reviewRe = [
    /([0-9]+(?:\.[0-9]+)?\s*万?\+?)\s*条评价/, /用户评价[·:：\s]*([0-9]+(?:\.[0-9]+)?\s*万?\+?)/,
    /(?:买家评价|累计评价)\s*[（(]?\s*([0-9]+(?:\.[0-9]+)?\s*万?\+?)/,
    /评价\s*[（(]\s*([0-9]+(?:\.[0-9]+)?\s*万?\+?)\s*[)）]/,
  ];
  for (var rv = 0; rv < reviewRe.length; rv++) {
    var mr = reviewRe[rv].exec(scanText);
    if (!mr) continue;
    var rn = __monCount(mr[1]);
    if (rn == null) continue;
    res.reviewTotal = rn;
    res.reviewText = String(mr[0]).slice(0, 80);
    break;
  }
  res.fieldStatus.reviews = res.reviewTotal != null ? 'captured' : (res.cues.login ? 'failed' : 'not_exposed');
  // 5) SKU 文案（只当「有这些选项」的证据，不追件数/价格矩阵）
  var seen = {};
  for (var sk = 0; sk < skuTexts.length && res.skuLabels.length < 60; sk++) {
    var label = String(skuTexts[sk] || '').trim();
    if (!label || label.length > 24) continue;
    if (/^(¥|￥)/.test(label)) continue;
    if (seen[label]) continue;
    seen[label] = 1;
    res.skuLabels.push(label);
  }
  res.skuStatus = res.skuLabels.length ? 'partial' : 'not_exposed';
  res.fieldStatus.sku = res.skuLabels.length ? 'partial' : 'not_exposed';
  // 6) 主图（按面积挑，最多 12 张；key 由调用侧按 URL 归一）
  var imgs = (seed && seed.images) || [];
  var byArea = imgs.slice(0).sort(function (x, y) { return (y.width * y.height) - (x.width * x.height); });
  for (var im = 0; im < byArea.length && res.images.length < 12; im++) {
    var url = String(byArea[im].url || '');
    if (!url || url.indexOf('data:') === 0) continue;
    res.images.push({ url: url, width: byArea[im].width, height: byArea[im].height });
  }
  res.fieldStatus.images = res.images.length ? 'captured' : 'not_exposed';
  if (!res.title && ldTitle) res.title = ldTitle;
  if (ldTitle && res.title.indexOf(ldTitle) < 0) res.title = (res.title + ' ' + ldTitle).trim().slice(0, 200);
  return res;
}
`;

/**
 * 生成在页面里执行的表达式：`(function(){ 采集 + 解析 })()`。
 * 平台只影响「先看哪些选择器」，解析逻辑本身通用。
 */
export function buildMonitorExpression(platform) {
  const p = String(platform || '');
  const hints = MONITOR_HINTS[p] || {};
  void hints; // v1 通用选择器已覆盖，保留表给以后补平台专用落点
  return '(function(){' + SEED_FN + PARSE_FN + ' return __monParse(__monCollect(), ' + JSON.stringify(p) + '); })()';
}

/** 给自检用：把表达式变成可调用的函数（注入假 document / location / window）。 */
export function monitorExtractFn(platform) {
  const expr = buildMonitorExpression(platform);
  // eslint-disable-next-line no-new-func
  return new Function('document', 'location', 'window', 'return ' + expr);
}
