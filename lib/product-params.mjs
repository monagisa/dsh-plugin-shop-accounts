/**
 * v0.20.41：配方业务参数自动补全（商品 ID）。
 *
 * 背景：内置的一批配方声明了 `needsParams`（要 productIds / productId）：以前只能由调用方手工传入，
 * 现在改成「采集前先去店铺的商品列表页把 ID 抓出来自动填」，这样定时采集也能跑这些配方，用户不用手工给 ID。
 *
 * 只对有能力抓商品的平台开放（淘宝 / 抖音）；天猫、京东没有本机账号；拼多多的商品列表页在自动化环境下
 * 只渲染出后台外壳（读不到商品 ID，而它本来就有一份不需要参数的「商品概况」配方能跑），所以这三家不开放。
 */
import fs from 'node:fs';
import path from 'node:path';
import { egoRpa } from './ego.mjs';
import { egoSpaceName } from './ego-lifecycle.mjs';
import { collectionDirOf } from './collection-dir.mjs';
import { readTableFile } from './sheet-read.mjs';

/** 支持自动补商品 ID 的平台。 */
export const PRODUCT_PARAM_PLATFORMS = ['taobao', 'douyin'];

/** 每个平台的商品列表页（打开后用页内脚本抓 ID）。 */
const LIST_PAGES = {
  taobao: 'https://myseller.taobao.com/home.htm/SellManage/on_sale',
  pdd: 'https://mms.pinduoduo.com/goods/goods_list',
  douyin: 'https://fxg.jinritemai.com/ffa/g/list',
};

/** 页内脚本：从链接与属性里挑商品 ID（10–20 位数字串，排除明显是时间戳/资源哈希的短数字）。 */
const COLLECT_IDS_EXPR = `
(function () {
  var ids = [];
  function push(v) {
    var s = String(v == null ? '' : v).trim();
    if (!/^[0-9]{10,20}$/.test(s)) return;
    if (ids.indexOf(s) >= 0) return;
    ids.push(s);
  }
  var linkRe = /(?:id|itemId|goods_id|goodsId|productId)\\s*=\\s*([0-9]{10,20})/g;
  try {
    var as = document.querySelectorAll('a[href]');
    for (var i1 = 0; i1 < as.length; i1 += 1) {
      var href = String(as[i1].getAttribute('href') || '');
      var m = href.match(linkRe);
      if (m) for (var k1 = 0; k1 < m.length; k1 += 1) push(m[k1].replace(linkRe, '$1'));
      var tail = href.match(/[0-9]{10,20}/);
      if (tail && /item\.htm|goods|item|product/i.test(href)) push(tail[0]);
    }
    var nodes = document.querySelectorAll('[data-id],[data-item-id],[data-goods-id],[data-product-id],[data-rid],[data-tid]');
    for (var i2 = 0; i2 < nodes.length; i2 += 1) {
      var at = nodes[i2];
      push(at.getAttribute('data-id'));
      push(at.getAttribute('data-item-id'));
      push(at.getAttribute('data-goods-id'));
      push(at.getAttribute('data-product-id'));
      push(at.getAttribute('data-rid'));
      push(at.getAttribute('data-tid'));
    }
    var all = document.querySelectorAll('*');
    var limit = Math.min(all.length, 5000);
    for (var i3 = 0; i3 < limit; i3 += 1) {
      var el = all[i3];
      var attrs = el.attributes || [];
      for (var a3 = 0; a3 < attrs.length; a3 += 1) {
        var name = String(attrs[a3].name || '');
        if (!/^(data-|href|id|value)/i.test(name) && !/item|goods|product/i.test(name)) continue;
        var val = String(attrs[a3].value || '');
        if (!/[0-9]{10,20}/.test(val)) continue;
        var mm = val.match(/[0-9]{10,20}/g);
        if (mm) for (var k3 = 0; k3 < mm.length; k3 += 1) push(mm[k3]);
      }
      if (ids.length >= 30) break;
    }
  } catch (e) { /* 个别属性读不到就跳过 */ }
  return JSON.stringify({ href: location.href, ids: ids.slice(0, 30) });
})()
`;

/**
 * v0.20.67：优先用「商品供给」报表里的商品 ID 当采集参数。
 * 平台商品列表页抓到的 ID 与退款报表选中的 ID 常常不是同一批（新上架商品没有退款数据），
 * 所以先从本店已采集的「商品供给」工作簿里取 ID，取不到再退回抓列表页。
 */
export function productIdsFromArtifacts(account, limit = 10) {
  const shape = /^[0-9]{8,20}$/;
  let jobsDir = '';
  try { jobsDir = path.join(collectionDirOf(account), 'jobs'); } catch { return { ok: false, code: 'NO_ARTIFACTS' }; }
  let names = [];
  try { names = fs.readdirSync(jobsDir).filter((n) => n.startsWith('job_')).sort().reverse().slice(0, 6); } catch { return { ok: false, code: 'NO_ARTIFACTS' }; }
  for (const job of names) {
    const artDir = path.join(jobsDir, job, 'artifacts');
    let files = [];
    try { files = fs.readdirSync(artDir).filter((n) => /^采集数据_.*\.xlsx$/.test(n)).sort().reverse(); } catch { continue; }
    for (const file of files) {
      let read = null;
      try { read = readTableFile(path.join(artDir, file)); } catch { continue; }
      for (const sheet of (read && read.sheets) || []) {
        if (!/^商品供给/.test(String(sheet.name || ''))) continue;
        const rows = sheet.rows || [];
        if (rows.length < 2) continue;
        const header = (rows[0] || []).map((v) => String(v == null ? '' : v).trim());
        const col = header.findIndex((h) => /^商品.?ID$|^商品id$/i.test(h) || h === '商品ID' || h === '商品Id');
        if (col < 0) continue;
        const ids = [];
        for (const r of rows.slice(1)) {
          const v = String((r || [])[col] == null ? '' : r[col]).trim();
          if (shape.test(v) && ids.indexOf(v) < 0) ids.push(v);
        }
        if (ids.length) return { ok: true, ids: ids.slice(0, Math.max(1, Math.min(30, Number(limit) || 10))), source: 'artifacts', file };
      }
    }
  }
  return { ok: false, code: 'NO_ARTIFACTS' };
}

/** 这个平台能不能自动补商品 ID。 */
export function productParamSupported(platform) {
  return PRODUCT_PARAM_PLATFORMS.includes(String(platform || ''));
}

/** 进程内缓存（10 分钟），避免同一轮采集里反复打开列表页。 */
/** 各平台商品 ID 的真实格式（实测）：淘宝 13 位、拼多多 12 位、抖音 18–19 位。 */
const PLATFORM_ID_RE = {
  taobao: /^1[0-9]{12}$/,
  pdd: /^1[0-9]{10}$|^1[0-9]{11}$/, // 拼多多协议层 12 位（列表页暂不可用，保留格式）
  douyin: /^[0-9]{16,20}$/,
};

const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;

/** 读缓存（只读，不触发抓取）。 */
export function cachedProductIds(account) {
  const hit = cache.get(String((account && account.id) || ''));
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_MS) { cache.delete(String(account.id)); return null; }
  return hit;
}

/** 给界面/自检用的状态。 */
export function productParamHint(account) {
  const platform = String((account && account.platform) || '');
  const supported = productParamSupported(platform);
  const hit = supported ? cachedProductIds(account) : null;
  return {
    supported,
    cached: Boolean(hit),
    count: hit ? hit.ids.length : 0,
    at: hit ? new Date(hit.at).toISOString() : '',
  };
}

/**
 * 打开店铺商品列表页，抓最多 limit 个商品 ID（并写进进程内缓存）。
 * 不抛异常：失败时返回 { ok: false, error }，调用方按「这份配方这轮先不跑」处理。
 */
export async function fetchProductIds(account, opts = {}) {
  const platform = String((account && account.platform) || '');
  if (!productParamSupported(platform)) {
    return { ok: false, code: 'UNSUPPORTED_PLATFORM', error: '这个平台没有商品 ID 自动抓取' };
  }
  const hit = cachedProductIds(account);
  if (hit && !opts.refresh) return { ok: true, ids: hit.ids, cached: true };
  const fromArtifacts = productIdsFromArtifacts(account, Math.max(1, Math.min(30, Number(opts.limit) || 10)));
  if (fromArtifacts.ok && !opts.refresh) {
    cache.set(String(account.id), { ids: fromArtifacts.ids, at: Date.now(), platform });
    return { ok: true, ids: fromArtifacts.ids, cached: false, source: 'artifacts' };
  }
  const url = LIST_PAGES[platform];
  const limit = Math.max(1, Math.min(30, Number(opts.limit) || 10));
  const ops = [
    { op: 'goto', url, waitUntil: 'domcontentloaded', stepId: 'goto-goods-list' },
    { op: 'sleep', ms: Number(opts.waitMs) || 10000, stepId: 'wait-goods-list' },
    { op: 'eval', outputKey: 'goodsIdsRaw', expr: COLLECT_IDS_EXPR, stepId: 'collect-goods-ids' },
    { op: 'url', outputKey: 'goodsListUrl', stepId: 'read-goods-url' },
  ];
  let res = null;
  try {
    const space = String((account && account.egoSpace) || '') || egoSpaceName(account);
    res = await egoRpa({ account, space }, { ops }, { timeoutMs: Number(opts.timeoutMs) || 120000 });
  } catch (err) {
    return { ok: false, code: 'PRODUCT_IDS_FAILED', error: String((err && err.message) || err) };
  }
  if (!res || res.ok !== true) {
    const code = (res && res.code) || 'PRODUCT_IDS_FAILED';
    const failed = ((res && res.steps) || []).find((s) => s && s.status && s.status !== 'ok');
    const detail = (failed && (failed.error || failed.id)) || (res && res.error) || '';
    return { ok: false, code, error: detail ? String(detail).slice(0, 200) : '打开商品列表页失败' };
  }
  const raw = (res.outputs && res.outputs.goodsIdsRaw) || '';
  let ids = [];
  try {
    const parsed = JSON.parse(String(raw));
    ids = Array.isArray(parsed.ids) ? parsed.ids.map((x) => String(x)) : [];
  } catch {
    ids = [];
  }
  const shape = PLATFORM_ID_RE[platform] || /^[0-9]{10,20}$/;
  ids = ids.filter((x) => shape.test(x)).slice(0, limit);
  if (!ids.length) {
    return { ok: false, code: 'NO_PRODUCT_IDS', error: '商品列表页里没找到商品 ID（页面可能没加载完或该店没有在售商品）' };
  }
  cache.set(String(account.id), { ids, at: Date.now(), platform });
  return { ok: true, ids, page: (res.outputs && res.outputs.goodsListUrl) || url };
}

/** 仅测试用：清空缓存。 */
export function _resetProductIdCache() {
  cache.clear();
}
