/**
 * catalog.mjs —— 「平台 → 采集域 → 指标」知识层（v0.12.0）。
 *
 * 数据来源：Accio Work 的 commerce-domestic 插件目录库（`ecomctl` 0.4.5 用的 SQLite
 * `~/.accio/data/plugins/commerce-domestic/ecommerce.db`），逆向提取后只保留
 * **定时采集域（`<platform>-scheduler-<域>`）与其指标清单**：
 *   · 指标 id / 名称 / 所属域 / 度量类型（count|amount|ratio|people|…）
 *   · 时间粒度（day|snapshot|rolling_window|…）
 *   · 落库必需的记录字段（store_id / biz_date / product_id / …）
 * 刻意**不**收录它的 `value_path`、`auxiliary_path`、聚合规则、DSL id 与 RPA 加密资产：
 * 那些是 Accio 自己的采集实现细节，我们用自己的 skill/RPA 采，留着只会误导。
 *
 * 用途：
 *   1. 界面按平台展示真实存在的采集域与「这个域有多少项指标」（淘宝/天猫比其他多一个「竞争洞察」）；
 *   2. 校验：账号的采集域必须属于该平台目录；落库记录的 `metricId` 必须能在目录里查到；
 *   3. 给 agent 的采集提示词里带上指标规模，让它知道该域要采多少项。
 *
 * 没装目录（文件缺失/损坏）时**全部降级**为原来的 5 域行为，不影响插件其它功能。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COLLECTION_DOMAINS } from './collection.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = path.join(HERE, 'catalog', 'catalog.json');

/** 域在界面上的固定顺序（与 collection.mjs 的 5 域顺序一致，「竞争洞察」在最后）。 */
const DOMAIN_ORDER = ['经营总览', '流量转化', '运营推广', '商品供给', '服务履约', '竞争洞察'];

let cache = null; // { data, error }

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(CATALOG_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.platforms) throw new Error('不是合法的目录文件');
    cache = { data, error: null };
  } catch (err) {
    cache = { data: null, error: String((err && err.message) || err) };
  }
  return cache;
}

/** 目录是否可用（文件存在且能解析）。 */
export function catalogReady() {
  return Boolean(load().data);
}

/** 目录加载错误（未出错时为 null）。 */
export function catalogError() {
  return load().error;
}

function sortDomains(domains) {
  return (Array.isArray(domains) ? domains : []).slice().sort((a, b) => {
    const ia = DOMAIN_ORDER.indexOf(a.id);
    const ib = DOMAIN_ORDER.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

/** 某平台的目录条目（没有就 null）。 */
function platformEntry(platformId) {
  const data = load().data;
  if (!data) return null;
  const id = String(platformId || '').trim();
  const entry = data.platforms[id];
  return entry && Array.isArray(entry.domains) ? entry : null;
}

/**
 * 某平台可用的采集域：[{id, label, metricCount}]。
 * 目录里没有这个平台（或目录不可用）→ 回退到 5 域，`metricCount` 为 0。
 */
export function catalogDomains(platformId) {
  const entry = platformEntry(platformId);
  if (!entry) return COLLECTION_DOMAINS.map((id) => ({ id, label: id, metricCount: 0 }));
  return sortDomains(entry.domains).map((d) => ({ id: d.id, label: d.label || d.id, metricCount: Number(d.count) || 0 }));
}

/** 某平台可用的采集域 id 列表（校验用）。 */
export function catalogDomainIds(platformId) {
  return catalogDomains(platformId).map((d) => d.id);
}

/** 某平台所有指标（可带域过滤）：Map 的键是 metric_id。 */
export function catalogMetrics(platformId, domain) {
  const entry = platformEntry(platformId);
  if (!entry) return [];
  const wanted = domain ? String(domain).trim() : '';
  const out = [];
  for (const [id, m] of Object.entries(entry.metrics || {})) {
    if (wanted && m.domain !== wanted) continue;
    out.push({ id, ...m });
  }
  return out;
}

/** 按 metric_id 查指标（含所属域）；查不到返回 null。 */
export function catalogMetric(platformId, metricId) {
  const entry = platformEntry(platformId);
  if (!entry) return null;
  const id = String(metricId || '').trim();
  if (!id) return null;
  const m = (entry.metrics || {})[id];
  return m ? { id, ...m } : null;
}

/** 批量校验 metric_id：返回查不到的 id 列表（目录不可用时返回空数组 = 不拦）。 */
export function unknownMetricIds(platformId, ids) {
  if (!platformEntry(platformId)) return [];
  const bad = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const key = String(id || '').trim();
    if (key && !catalogMetric(platformId, key)) bad.push(key);
  }
  return [...new Set(bad)];
}

/** 某平台某域的指标数量。 */
export function metricCount(platformId, domain) {
  const entry = platformEntry(platformId);
  if (!entry) return 0;
  const d = (entry.domains || []).find((x) => x.id === domain);
  return d ? Number(d.count) || 0 : 0;
}

/** /state 与工具用的目录概览（不含指标明细，避免 state 过大）。 */
export function catalogInfo() {
  const { data, error } = load();
  if (!data) return { ready: false, error, version: 0, platforms: {} };
  const platforms = {};
  let total = 0;
  for (const [id, p] of Object.entries(data.platforms)) {
    const metrics = Object.keys(p.metrics || {}).length;
    total += metrics;
    platforms[id] = {
      label: p.label || id,
      metricCount: metrics,
      sourceCount: Object.keys(p.sources || {}).length,
      domains: sortDomains(p.domains).map((d) => ({ id: d.id, label: d.label || d.id, metricCount: Number(d.count) || 0 })),
    };
  }
  return { ready: true, version: Number(data.version) || 1, note: data.note || '', totalMetrics: total, platforms };
}

/** 测试用：丢掉缓存，下次重新读文件。 */
export function __resetCatalog() {
  cache = null;
}
