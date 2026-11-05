/**
 * 公开商品监控（v0.19.0）—— 数据层。
 *
 * 买家账号（C 端）不做店铺后台的定时采集，但它的用途正是**公开商品页**：
 * 打开一个商品详情页，抓一轮价格 / 销量 / 评价数 / SKU / 主图快照，多轮之间做变化对比。
 * 这个模块只管「存什么、怎么比」；抓页面在 monitor-extract.mjs，跑页面在 ego.mjs 的 snapshot op。
 *
 * 目录布局（每个账号一份，和店铺后台采集的 collection/ 并列）：
 *   <dataDir>/monitor/<accountId>/targets.json          监控目标清单
 *   <dataDir>/monitor/<accountId>/snapshots/<targetId>.jsonl  一轮一行快照
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir, ensureDir, atomicWriteJson } from './store.mjs';

/** 公开商品页能抓的平台：淘宝 / 天猫 / 1688 / 京东（都是 PC 页面）。
 *  抖音 / 拼多多公开页要靠安卓 App，本版不做，等有手机链路再开。 */
export const MONITOR_PLATFORMS = ['taobao', 'tmall', 'ali1688', 'jd'];

export const MONITOR_PLATFORM_LABELS = {
  taobao: '淘宝', tmall: '天猫', ali1688: '1688', jd: '京东', douyin: '抖音', pdd: '拼多多',
};

/** 一条快照最多保留多少轮（老的丢掉，免得 jsonl 无限长）。 */
export const MAX_SNAPSHOTS = 200;
/** 目标清单上限。 */
export const MAX_TARGETS = 200;

export function monitorPlatformSupported(platformId) {
  return MONITOR_PLATFORMS.includes(String(platformId || ''));
}

/**
 * 一个账号（按其平台）能抓哪些平台的公开商品页 —— 取决于登录态落在哪些域名下：
 *   · 淘宝账号：淘宝 + 天猫（同一套账号与 cookie 域）
 *   · 天猫账号：天猫 + 淘宝
 *   · 1688 / 京东：只管自己
 *   · 抖音 / 拼多多：C 端页面要安卓 App，本版不支持
 */
export function monitorPlatformsForAccount(accountPlatform) {
  const p = String(accountPlatform || '');
  if (p === 'taobao' || p === 'tmall') return ['taobao', 'tmall'];
  if (p === 'ali1688') return ['ali1688'];
  if (p === 'jd') return ['jd'];
  return [];
}

function hostOf(url) {
  try { return String(new URL(url).host || '').toLowerCase(); } catch { return ''; }
}

/**
 * 解析一个公开商品页 URL：认平台、取商品 id、给出规范化地址。
 * 只认 PC 商品详情页（手机版 / 店铺页 / 搜索页一律拒绝 —— 抓它们没有意义）。
 */
export function parseProductUrl(raw) {
  const input = String(raw == null ? '' : raw).trim();
  if (!input) throw new Error('商品 URL 不能为空');
  let u;
  try { u = new URL(input); } catch { throw new Error('不是合法的 URL：' + input.slice(0, 200)); }
  if (!/^https?:/i.test(u.protocol)) throw new Error('只支持 http/https 地址');
  const host = u.host.toLowerCase();
  const idOf = (re) => { const m = re.exec(u.pathname + '?' + u.search); return m ? m[1] : ''; };
  let platform = '';
  let productId = '';
  if (/\.tmall\.com$/.test(host) || host === 'tmall.com') {
    platform = 'tmall';
    productId = u.searchParams.get('id') || idOf(/\/item\/(\d+)/);
  } else if (/\.taobao\.com$/.test(host) || host === 'taobao.com') {
    platform = 'taobao';
    productId = u.searchParams.get('id') || u.searchParams.get('itemId') || idOf(/\/item\/(\d+)/);
  } else if (/\.1688\.com$/.test(host) || host === '1688.com') {
    platform = 'ali1688';
    productId = idOf(/\/offer\/(\d+)/) || u.searchParams.get('offerId') || u.searchParams.get('id');
  } else if (/\.jd\.com$/.test(host) || host === 'jd.com') {
    platform = 'jd';
    productId = u.searchParams.get('sku') || idOf(/\/product\/(\d+)/) || idOf(/\/(\d+)\.html/);
  }
  if (!platform) {
    throw new Error('这个地址不是公开商品详情页（只支持淘宝 / 天猫 / 1688 / 京东的商品页）：' + input.slice(0, 200));
  }
  if (!/^\d{4,20}$/.test(String(productId || ''))) {
    throw new Error('认不出商品 id —— 请直接复制商品详情页的完整地址（带 id / offerId / sku 参数）');
  }
  if (!monitorPlatformSupported(platform)) {
    throw new Error(`${MONITOR_PLATFORM_LABELS[platform] || platform} 的公开商品页要靠安卓 App 抓，本版还不支持`);
  }
  return { platform, productId: String(productId), url: u.href, host };
}

export function monitorStoreDir(accountId) {
  const id = String(accountId || '');
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(id)) throw new Error('账号 id 不合法');
  return path.join(dataDir(), 'monitor', id);
}
export function targetsPath(accountId) { return path.join(monitorStoreDir(accountId), 'targets.json'); }
export function snapshotPath(accountId, targetId) {
  const t = String(targetId || '');
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(t)) throw new Error('监控 id 不合法');
  return path.join(monitorStoreDir(accountId), 'snapshots', t + '.jsonl');
}

export function readTargets(accountId) {
  const file = targetsPath(accountId);
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { doc = null; }
  const targets = (doc && Array.isArray(doc.targets)) ? doc.targets : [];
  return { version: 1, targets: targets.filter((t) => t && t.id && t.url) };
}

function writeTargets(accountId, doc) {
  ensureDir(monitorStoreDir(accountId));
  atomicWriteJson(targetsPath(accountId), { version: 1, targets: doc.targets || [] });
}

export function findTarget(accountId, targetId) {
  return readTargets(accountId).targets.find((t) => t.id === String(targetId)) || null;
}

/** 加一个监控目标；同一个账号下同一个商品只留一条（重复添加返回已有那条）。 */
export function addMonitorTarget(accountId, rawUrl, now = new Date()) {
  const parsed = parseProductUrl(rawUrl);
  const doc = readTargets(accountId);
  const existing = doc.targets.find((t) => t.platform === parsed.platform && t.productId === parsed.productId);
  if (existing) return { target: existing, existing: true };
  if (doc.targets.length >= MAX_TARGETS) throw new Error(`一个账号最多 ${MAX_TARGETS} 个监控目标，先删掉一些再加`);
  const target = {
    id: 'mon_' + crypto.randomBytes(4).toString('hex'),
    platform: parsed.platform,
    productId: parsed.productId,
    url: parsed.url,
    title: '',
    createdAt: now.toISOString(),
    lastSnapshotAt: '',
    lastStatus: '',
    lastError: '',
  };
  doc.targets.unshift(target);
  writeTargets(accountId, doc);
  return { target, existing: false };
}

export function removeMonitorTarget(accountId, targetId) {
  const doc = readTargets(accountId);
  const before = doc.targets.length;
  doc.targets = doc.targets.filter((t) => t.id !== String(targetId));
  if (doc.targets.length === before) return false;
  writeTargets(accountId, doc);
  try { fs.rmSync(snapshotPath(accountId, targetId), { force: true }); } catch { /* 删不掉就算了 */ }
  return true;
}

/** 记一轮快照：只有 ok 的才写历史（失败轮次记在 target 的 lastStatus 上，免得把曲线画歪）。 */
export function appendSnapshot(accountId, targetId, snapshot) {
  const doc = readTargets(accountId);
  const target = doc.targets.find((t) => t.id === String(targetId));
  if (!target) throw new Error('监控目标不存在');
  if (snapshot && snapshot.ok) {
    ensureDir(path.dirname(snapshotPath(accountId, targetId)));
    fs.appendFileSync(snapshotPath(accountId, targetId), JSON.stringify(snapshot) + '\n', 'utf8');
    trimSnapshots(accountId, targetId);
  }
  target.lastSnapshotAt = String((snapshot && snapshot.at) || new Date().toISOString());
  target.lastStatus = String((snapshot && snapshot.ok) ? 'ok' : ((snapshot && snapshot.status) || 'failed'));
  target.lastError = String((snapshot && snapshot.ok) ? '' : ((snapshot && snapshot.error) || '').slice(0, 400));
  if (snapshot && snapshot.title) target.title = String(snapshot.title).slice(0, 200);
  writeTargets(accountId, doc);
  return target;
}

function trimSnapshots(accountId, targetId) {
  const file = snapshotPath(accountId, targetId);
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return; }
  if (lines.length <= MAX_SNAPSHOTS) return;
  fs.writeFileSync(file, lines.slice(lines.length - MAX_SNAPSHOTS).join('\n') + '\n', 'utf8');
}

export function readSnapshots(accountId, targetId, limit = MAX_SNAPSHOTS) {
  const file = snapshotPath(accountId, targetId);
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const out = [];
  for (const line of lines.slice(-Math.max(1, Number(limit) || MAX_SNAPSHOTS))) {
    try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
  }
  return out;
}

removeMonitorTarget.cleanup = null; // 占位，防止误用

/** 数字口径：'1.2万' → 12000，'2,345' → 2345；认不出来返回 null。 */
export function parseCountText(value) {
  const s = String(value == null ? '' : value).replace(/[,，\s]/g, '');
  const m = /^([0-9]+(?:\.[0-9]+)?)(万|w|W)?(\+)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.round(m[2] ? n * 10000 : n);
}

/** 价格区间：'¥9.9-19.9' → {min:9.9,max:19.9}。 */
export function parsePriceRange(text) {
  const s = String(text == null ? '' : text);
  const m = /([0-9]+(?:\.[0-9]+)?)\s*(?:-|~|—|至)\s*([0-9]+(?:\.[0-9]+)?)/.exec(s);
  if (m) {
    const a = Number(m[1]); const b = Number(m[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const one = /([0-9]+(?:\.[0-9]+)?)/.exec(s);
  if (!one) return null;
  const n = Number(one[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { min: n, max: n };
}

/** 把抓回来的原始数据归一成一条快照（存储与展示都用这个形状）。 */
export function normalizeSnapshot(raw, ctx = {}) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const at = String(ctx.at || new Date().toISOString());
  const price = Number(d.price);
  const range = d.priceRange && typeof d.priceRange === 'object'
    ? { min: Number(d.priceRange.min), max: Number(d.priceRange.max) }
    : (Number.isFinite(price) && price > 0 ? { min: price, max: price } : null);
  const skuLabels = Array.isArray(d.skuLabels) ? d.skuLabels.map((s) => String(s).slice(0, 60)).filter(Boolean).slice(0, 80) : [];
  const images = Array.isArray(d.images) ? d.images
    .map((im) => (typeof im === 'string' ? { url: im, key: imageKey(im) } : { url: String(im && im.url || ''), key: String(im && im.key || imageKey(im && im.url)) }))
    .filter((im) => im.url) : [];
  return {
    at,
    ok: true,
    platform: String(ctx.platform || d.platform || ''),
    productId: String(ctx.productId || d.productId || ''),
    url: String(ctx.url || d.url || ''),
    finalUrl: String(ctx.finalUrl || d.url || ''),
    title: String(d.title || '').slice(0, 200),
    price: Number.isFinite(price) && price > 0 ? price : null,
    priceRange: range,
    priceText: String(d.priceText || '').slice(0, 120),
    priceSlots: Array.isArray(d.priceSlots) ? d.priceSlots.slice(0, 6).map((s) => ({
      label: String((s && s.label) || '').slice(0, 40),
      text: String((s && s.text) || '').slice(0, 60),
      price: Number.isFinite(Number(s && s.price)) ? Number(s.price) : null,
    })) : [],
    sales: parseCountTextOrNull(d.sales),
    salesText: String(d.salesText || '').slice(0, 80),
    reviewTotal: parseCountTextOrNull(d.reviewTotal),
    reviewText: String(d.reviewText || '').slice(0, 80),
    skuLabels,
    skuStatus: String(d.skuStatus || (skuLabels.length ? 'partial' : 'not_exposed')),
    images,
    fieldStatus: d.fieldStatus && typeof d.fieldStatus === 'object' ? d.fieldStatus : {},
    cues: d.cues && typeof d.cues === 'object' ? d.cues : {},
  };
}

function parseCountTextOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  return parseCountText(value);
}

/** 主图身份：淘宝/天猫/1688 的图片地址带尺寸后缀与追踪参数，只取「同一张图」的部分。 */
export function imageKey(url) {
  const s = String(url == null ? '' : url).trim();
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { return s.slice(0, 200); }
  const base = u.host + u.pathname;
  return base.replace(/_(\d+)x(\d+)([a-z0-9]*)?\.(jpg|jpeg|png|webp)$/i, '.$4');
}

/**
 * 两轮快照的差异（存储层是纯数据，界面直接拿它渲染变化标签）。
 * 只比「前后都有值」的字段：缺数据不当成变化（和采集侧 field_status 同一口径）。
 */
export function diffSnapshots(prev, next) {
  const out = { price: null, sales: null, reviews: null, sku: { added: [], removed: [] }, images: { added: [], removed: [] }, title: null };
  if (!prev || !next) return out;
  const pv = prev.priceRange || (prev.price == null ? null : { min: prev.price, max: prev.price });
  const nv = next.priceRange || (next.price == null ? null : { min: next.price, max: next.price });
  if (pv && nv) {
    if (pv.min !== nv.min || pv.max !== nv.max) out.price = { from: pv, to: nv, fromText: prev.priceText, toText: next.priceText };
  }
  if (typeof prev.sales === 'number' && typeof next.sales === 'number' && prev.sales !== next.sales) {
    out.sales = { from: prev.sales, to: next.sales, delta: next.sales - prev.sales };
  }
  if (typeof prev.reviewTotal === 'number' && typeof next.reviewTotal === 'number' && prev.reviewTotal !== next.reviewTotal) {
    out.reviews = { from: prev.reviewTotal, to: next.reviewTotal, delta: next.reviewTotal - prev.reviewTotal };
  }
  const pSku = new Set((prev.skuLabels || []).map((s) => String(s)));
  const nSku = new Set((next.skuLabels || []).map((s) => String(s)));
  out.sku.added = [...nSku].filter((s) => !pSku.has(s)).slice(0, 20);
  out.sku.removed = [...pSku].filter((s) => !nSku.has(s)).slice(0, 20);
  const pImg = new Set((prev.images || []).map((i) => i.key || imageKey(i.url)).filter(Boolean));
  const nImg = new Set((next.images || []).map((i) => i.key || imageKey(i.url)).filter(Boolean));
  out.images.added = [...nImg].filter((k) => !pImg.has(k)).length;
  out.images.removed = [...pImg].filter((k) => !nImg.has(k)).length;
  if (String(prev.title || '') && String(next.title || '') && String(prev.title) !== String(next.title)) {
    out.title = { from: prev.title, to: next.title };
  }
  return out;
}

/** 给界面用：目标 + 最近一轮 + 与上一轮的差异 + 历史轮数。 */
export function summarizeTarget(accountId, target) {
  const snaps = readSnapshots(accountId, target.id, 2);
  const latest = snaps.length ? snaps[snaps.length - 1] : null;
  const prev = snaps.length > 1 ? snaps[snaps.length - 2] : null;
  const diff = (latest && prev) ? diffSnapshots(prev, latest) : null;
  return {
    ...target,
    latest,
    previousAt: prev ? prev.at : '',
    diff,
    rounds: readSnapshots(accountId, target.id, MAX_SNAPSHOTS).length,
  };
}
